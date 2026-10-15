import { z } from 'zod';
import { PayGuardRefusal } from './seams/guards.js';
import { AuthError, requireMfa } from '@intafaced/auth';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { DualControlError } from './dual-control.js';
import {
  ActionApprovalConsumeError,
  consumePayApproval,
  type ActionApprovalConsumer,
  unwiredApprovalConsumer,
} from './action-approval-consume.js';
import { KybError, KYB_STATUSES, type KybService } from './kyb-service.js';
import { assertMerchantOwnership, type MerchantOwnerLookup } from './merchant-ownership.js';
import { PayError } from './payment-service.js';
import { PspModeError, type PspModeService } from './psp-mode.js';

/**
 * DIGITAL KYB + PSP PRICING / MODE — operator + merchant surfaces (`pay.psp`).
 *
 * Separate router (merged in `index.ts`) so we stay path-disjoint from
 * settlement (#1694) and fraud (#1657), and do not dual-edit `router.ts`.
 *
 * Scopes:
 *   · `pay:write` — merchant submits a dossier
 *   · `admin:compliance` — operator decides KYB (the live path)
 *   · `admin:read` — read KYB / pricing history
 *   · `admin:write` — set pricing / enable PSP mode (commercial, not compliance)
 *
 * Operator mutates (`kyb.decide`, `psp.setPricing`, `psp.enableMode`) consume
 * identity action-bound approval. Typed-in `confirmOperatorId` is not authority.
 * `admin:compliance` / `admin:write` are not INTERACTIVE_ONLY, so MFA is
 * required locally (same as `merchantState.set`). History stays single-operator.
 */

const kybStatusSchema = z.enum(KYB_STATUSES as unknown as [string, ...string[]]);

const kybEventView = z.object({
  id: z.string().uuid(),
  seq: z.string(),
  merchantId: z.string().uuid(),
  fromStatus: kybStatusSchema,
  toStatus: kybStatusSchema,
  kybRef: z.string().nullable(),
  reason: z.string(),
  actorId: z.string(),
  actorScope: z.string(),
  createdAt: z.string(),
});

const pricingEventView = z.object({
  id: z.string().uuid(),
  seq: z.string(),
  merchantId: z.string().uuid(),
  fromFeeBps: z.number().int(),
  toFeeBps: z.number().int(),
  reason: z.string(),
  actorId: z.string(),
  actorScope: z.string(),
  createdAt: z.string(),
});

function toTrpcError(err: unknown): unknown {
  if (err instanceof TRPCError) return err;
  if (err instanceof PayGuardRefusal) {
    return new TRPCError({ code: err.kind === 'unavailable' ? 'SERVICE_UNAVAILABLE' : 'FORBIDDEN', message: err.code, cause: err });
  }
  if (err instanceof AuthError) {
    return new TRPCError({
      code: err.code === 'mfa.required' ? 'UNAUTHORIZED' : 'FORBIDDEN',
      message: err.message,
      cause: err,
    });
  }
  if (err instanceof DualControlError || err instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  if (err instanceof PayError) {
    const code = err.code === 'pay.merchant_not_found' ? 'NOT_FOUND' : err.code === 'pay.merchant_forbidden' ? 'FORBIDDEN' : 'BAD_REQUEST';
    return new TRPCError({ code, message: `${err.code}: ${err.message}`, cause: err });
  }
  if (err instanceof KybError || err instanceof PspModeError) {
    if (err.code === 'pay.merchant_not_found') {
      return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
    }
    if (err.code === 'pay.kyb_history_limit_unset' || err.code === 'pay.psp_pricing_history_limit_unset') {
      return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
    }
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  return err;
}

export function createKybPspRouter(
  kyb: KybService,
  psp: PspModeService,
  approvals: ActionApprovalConsumer = unwiredApprovalConsumer(),
  merchants: MerchantOwnerLookup = {
    async getMerchant() {
      throw new PayError('Merchant ownership lookup is unavailable', 'pay.merchant_forbidden');
    },
  },
) {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw toTrpcError(err);
    }
  };

  return router({
    kyb: router({
      /**
       * Merchant submits a dossier reference. Durable — writes history.
       * Does not invent a partner decision.
       *
       * The body names the merchant. The caller must own that row
       * (`pay.merchant_forbidden`). The stored actor is still the caller.
       */
      submit: scopedProcedure('pay:write', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().uuid(),
            kybRef: z.string().trim().min(1).max(128),
            reason: z.string().trim().min(3).max(500).optional(),
          }),
        )
        .output(
          z.object({
            changed: z.boolean(),
            kybStatus: kybStatusSchema,
            kybRef: z.string(),
            event: kybEventView.nullable(),
          }),
        )
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            await assertMerchantOwnership(merchants, ctx.principal.userId, input.merchantId);
            const result = await kyb.submit({
              merchantId: input.merchantId,
              kybRef: input.kybRef,
              actorId: ctx.principal.userId,
              actorScope: 'pay:write',
              reason: input.reason,
            });
            return {
              ...result,
              event: result.event === null ? null : { ...result.event, createdAt: result.event.createdAt.toISOString() },
            };
          }),
        ),

      /**
       * Operator decide — works under live-only. Replaces the invent gap the
       * stub refuses with `pay.kyb_operator_required`.
       *
       * Identity consume is the second person. Missing approval ids refuse —
       * one operator cannot unlock acquiring with a typed-in name.
       */
      decide: scopedProcedure('admin:compliance', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().uuid(),
            decision: z.enum(['approved', 'rejected']),
            reason: z.string().trim().min(3).max(500),
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .output(
          z.object({
            changed: z.boolean(),
            kybStatus: kybStatusSchema,
            event: kybEventView.nullable(),
            confirmOperatorId: z.string(),
          }),
        )
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            requireMfa(ctx.principal);
            const confirmOperatorId = await consumePayApproval(approvals, input, 'pay.kyb_decide', {
              merchantId: input.merchantId,
              decision: input.decision,
              reason: input.reason,
            });
            const result = await kyb.decide({
              merchantId: input.merchantId,
              decision: input.decision,
              reason: input.reason,
              actorId: ctx.principal.userId,
              actorScope: 'admin:compliance',
            });
            return {
              ...result,
              event: result.event === null ? null : { ...result.event, createdAt: result.event.createdAt.toISOString() },
              confirmOperatorId,
            };
          }),
        ),

      history: scopedProcedure('admin:read', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().uuid(),
            /**
             * Page size. Optional so omit reaches `pay.kyb_history_limit_unset`.
             * Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          }),
        )
        .output(z.array(kybEventView))
        .query(({ input }) =>
          wrap(async () =>
            (await kyb.history(input.merchantId, input.limit)).map((e) => ({
              ...e,
              createdAt: e.createdAt.toISOString(),
            })),
          ),
        ),

      current: scopedProcedure('admin:read', { module: 'pay' })
        .input(z.object({ merchantId: z.string().uuid() }))
        .output(
          z.object({
            kybStatus: kybStatusSchema,
            kybRef: z.string().nullable(),
            mode: z.enum(['gateway', 'psp', 'payfac']),
          }),
        )
        .query(({ input }) => wrap(() => kyb.currentStatus(input.merchantId))),
    }),

    psp: router({
      setPricing: scopedProcedure('admin:write', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().uuid(),
            feeBps: z.number().int().min(0).max(10_000),
            reason: z.string().trim().min(3).max(500),
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .output(
          z.object({
            changed: z.boolean(),
            feeBps: z.number().int(),
            event: pricingEventView.nullable(),
            confirmOperatorId: z.string(),
          }),
        )
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            requireMfa(ctx.principal);
            const confirmOperatorId = await consumePayApproval(approvals, input, 'pay.psp_set_pricing', {
              merchantId: input.merchantId,
              feeBps: String(input.feeBps),
              reason: input.reason,
            });
            const result = await psp.setPricing({
              merchantId: input.merchantId,
              feeBps: input.feeBps,
              reason: input.reason,
              actorId: ctx.principal.userId,
              actorScope: 'admin:write',
            });
            return {
              ...result,
              event: result.event === null ? null : { ...result.event, createdAt: result.event.createdAt.toISOString() },
              confirmOperatorId,
            };
          }),
        ),

      pricingHistory: scopedProcedure('admin:read', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().uuid(),
            /**
             * Page size. Optional so omit reaches `pay.psp_pricing_history_limit_unset`.
             * Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          }),
        )
        .output(z.array(pricingEventView))
        .query(({ input }) =>
          wrap(async () =>
            (await psp.pricingHistory(input.merchantId, input.limit)).map((e) => ({
              ...e,
              createdAt: e.createdAt.toISOString(),
            })),
          ),
        ),

      enableMode: scopedProcedure('admin:write', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().uuid(),
            reason: z.string().trim().min(3).max(500),
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .output(
          z.object({
            mode: z.literal('psp'),
            feeBps: z.number().int(),
            changed: z.boolean(),
            reason: z.string(),
            actorId: z.string(),
            confirmOperatorId: z.string(),
          }),
        )
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            requireMfa(ctx.principal);
            const confirmOperatorId = await consumePayApproval(approvals, input, 'pay.psp_enable_mode', {
              merchantId: input.merchantId,
              reason: input.reason,
            });
            const result = await psp.enablePspMode({
              merchantId: input.merchantId,
              reason: input.reason,
              actorId: ctx.principal.userId,
              actorScope: 'admin:write',
            });
            return { ...result, confirmOperatorId };
          }),
        ),
    }),
  });
}

export type KybPspRouter = ReturnType<typeof createKybPspRouter>;
