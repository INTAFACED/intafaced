import { z } from 'zod';
import { AuthError, requireMfa } from '@intafaced/auth';
import {
  kybApplicationChangeTypeInputSchema,
  kybApplicationCurrentInputSchema,
  kybApplicationRestartInputSchema,
  kybApplicationSaveSectionInputSchema,
  kybApplicationStartInputSchema,
  kybApplicationSubmitInputSchema,
  kybApplicationViewSchema,
  kybDocumentChecklistViewSchema,
  kybDocumentsChecklistInputSchema,
  kybDocumentsUploadInputSchema,
  kybDocumentsUploadResultSchema,
  kybDecisionBindingSchema,
  kybEntityTypesViewSchema,
  kybRequirementsReadInputSchema,
  kybRequirementsViewSchema,
  router,
  scopedProcedure,
  TRPCError,
} from '@intafaced/contracts';
import { DualControlError } from './dual-control.js';
import {
  ActionApprovalConsumeError,
  consumePayApproval,
  readApprovalIds,
  type ActionApprovalConsumer,
  unwiredApprovalConsumer,
} from './action-approval-consume.js';
import { pspEnableModeFields, pspSetPricingFields } from './approval-bindings.js';
import { PAY_KYB_DECIDE, kybApprovalFields, kybDecisionBindingView } from './kyb-decision-binding.js';
import { KybError, KYB_STATUSES, type KybService } from './kyb-service.js';
import { KybEntityTypeService } from './kyb-entity-types.js';
import type { KybApplicationService } from './kyb-application.js';
import type { KybDocumentService } from './kyb-documents.js';
import { assertMerchantOwnership, type MerchantOwnerLookup } from './merchant-ownership.js';
import { PayError } from './payment-service.js';
import { PspModeError, type PspModeService } from './psp-mode.js';
import { MAX_FEE_BPS } from './fee-bps-bound.js';

/**
 * DIGITAL KYB + PSP PRICING / MODE — operator + merchant surfaces (`pay.psp`).
 *
 * Separate router (merged in `index.ts`) so we stay path-disjoint from
 * settlement (#1694) and fraud (#1657), and do not dual-edit `router.ts`.
 *
 * Scopes:
 *   · `pay:onboard` — merchant submits a dossier
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
  id: z.string().guid(),
  seq: z.string(),
  merchantId: z.string().guid(),
  fromStatus: kybStatusSchema,
  toStatus: kybStatusSchema,
  kybRef: z.string().nullable(),
  reason: z.string(),
  actorId: z.string(),
  actorScope: z.string(),
  createdAt: z.string(),
});

const pricingEventView = z.object({
  id: z.string().guid(),
  seq: z.string(),
  merchantId: z.string().guid(),
  fromFeeBps: z.number().int(),
  toFeeBps: z.number().int(),
  reason: z.string(),
  actorId: z.string(),
  actorScope: z.string(),
  createdAt: z.string(),
});

function toTrpcError(err: unknown): unknown {
  if (err instanceof TRPCError) return err;
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
    if (
      err.code === 'pay.kyb_history_limit_unset' ||
      err.code === 'pay.psp_pricing_history_limit_unset' ||
      err.code === 'pay.kyb_requirements_unset' ||
      err.code === 'pay.kyb_upload_rules_unset' ||
      err.code === 'pay.kyb_doc_key_unset'
    ) {
      return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
    }
    if (
      err.code === 'pay.kyb_identity_changed' ||
      err.code === 'pay.kyb_section_version_conflict' ||
      err.code === 'pay.kyb_application_exists' ||
      err.code === 'pay.kyb_application_changed'
    ) {
      return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
    if (err.code === 'pay.kyb_application_not_found') {
      return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
    }
    if (
      err.code === 'pay.kyb_incomplete' ||
      err.code === 'pay.kyb_documents_missing' ||
      err.code === 'pay.kyb_application_submitted' ||
      err.code === 'pay.kyb_application_unwired'
    ) {
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
  /** Unwired means the owner's entity-type data cannot be read: nothing is offered. */
  entityTypes: Pick<KybEntityTypeService, 'list' | 'requirements'> = {
    list: async () => [],
    requirements: async (entityType) => {
      throw new KybError(`Requirements for ${entityType} are not published.`, 'pay.kyb_requirements_unset', { entityType });
    },
  },
  /** Unwired means no application can be kept: every call refuses. */
  applications?: Pick<KybApplicationService, 'merchantOf' | 'start' | 'current' | 'saveSection' | 'restart' | 'changeType' | 'submit'>,
  documents?: Pick<KybDocumentService, 'checklist' | 'upload'>,
) {
  const applicationService = () => {
    if (!applications) throw new KybError('Business applications are not wired in this build', 'pay.kyb_application_unwired');
    return applications;
  };
  const documentService = () => {
    if (!documents) throw new KybError('Business documents are not wired in this build', 'pay.kyb_application_unwired');
    return documents;
  };
  /** The caller must own the merchant the application belongs to. An unknown id and someone else's refuse alike. */
  const ownedApplication = async (userId: string, applicationId: string): Promise<{ merchantId: string }> => {
    const merchantId = await applicationService().merchantOf(applicationId);
    if (merchantId === null) throw new PayError('Merchant not found', 'pay.merchant_not_found');
    await assertMerchantOwnership(merchants, userId, merchantId);
    return { merchantId };
  };

  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw toTrpcError(err);
    }
  };

  return router({
    kyb: router({
      entityTypes: router({
        /**
         * The entity types the owner has published, each with the documents, people roles and questionnaires it
         * requires and the countries it is offered in. Empty when none are published. The door is `pay:onboard`
         * because a business reads this before it has a merchant row; nothing here names a merchant.
         */
        read: scopedProcedure('pay:onboard', { module: 'pay' })
          .output(kybEntityTypesViewSchema)
          .query(() => wrap(async () => ({ entityTypes: await entityTypes.list() }))),
      }),

      application: router({
        /** Start the merchant's draft for a published entity type and a country it is offered in. Same type again returns the same draft. */
        start: scopedProcedure('pay:onboard', { module: 'pay' })
          .input(kybApplicationStartInputSchema)
          .output(kybApplicationViewSchema)
          .mutation(({ ctx, input }) =>
            wrap(async () => {
              await assertMerchantOwnership(merchants, ctx.principal.userId, input.merchantId);
              return applicationService().start({ ...input, actorId: ctx.principal.userId });
            }),
          ),

        /** The merchant's open draft, or its latest submitted application; null when none was started. */
        current: scopedProcedure('pay:onboard', { module: 'pay' })
          .input(kybApplicationCurrentInputSchema)
          .output(kybApplicationViewSchema.nullable())
          .query(({ ctx, input }) =>
            wrap(async () => {
              await assertMerchantOwnership(merchants, ctx.principal.userId, input.merchantId);
              return applicationService().current(input.merchantId);
            }),
          ),

        /** Save one section; names the version it read. A stale version is a conflict. */
        saveSection: scopedProcedure('pay:onboard', { module: 'pay' })
          .input(kybApplicationSaveSectionInputSchema)
          .output(kybApplicationViewSchema)
          .mutation(({ ctx, input }) =>
            wrap(async () => {
              await ownedApplication(ctx.principal.userId, input.applicationId);
              return applicationService().saveSection({ ...input, actorId: ctx.principal.userId });
            }),
          ),

        /** Clear the draft's sections (needs `confirm: true`). The history of earlier saves is kept. */
        restart: scopedProcedure('pay:onboard', { module: 'pay' })
          .input(kybApplicationRestartInputSchema)
          .output(kybApplicationViewSchema)
          .mutation(({ ctx, input }) =>
            wrap(async () => {
              await ownedApplication(ctx.principal.userId, input.applicationId);
              return applicationService().restart({ applicationId: input.applicationId, actorId: ctx.principal.userId });
            }),
          ),

        /** Change the draft's entity type or country: the sections clear and what is needed is listed again for the new type. */
        changeType: scopedProcedure('pay:onboard', { module: 'pay' })
          .input(kybApplicationChangeTypeInputSchema)
          .output(kybApplicationViewSchema)
          .mutation(({ ctx, input }) =>
            wrap(async () => {
              await ownedApplication(ctx.principal.userId, input.applicationId);
              return applicationService().changeType({ ...input, actorId: ctx.principal.userId });
            }),
          ),

        /** Submit once every required section is complete (`pay.kyb_incomplete` names the rest). Moves KYB to pending. */
        submit: scopedProcedure('pay:onboard', { module: 'pay' })
          .input(kybApplicationSubmitInputSchema)
          .output(kybApplicationViewSchema)
          .mutation(({ ctx, input }) =>
            wrap(async () => {
              const { merchantId } = await ownedApplication(ctx.principal.userId, input.applicationId);
              return applicationService().submit({ applicationId: input.applicationId, merchantId, actorId: ctx.principal.userId });
            }),
          ),
      }),

      documents: router({
        /** What the application's type requires, each document's state, the owner's upload rules, and the automatic check (`vendor.kyc`, not connected). */
        checklist: scopedProcedure('pay:onboard', { module: 'pay' })
          .input(kybDocumentsChecklistInputSchema)
          .output(kybDocumentChecklistViewSchema)
          .query(({ ctx, input }) =>
            wrap(async () => {
              await ownedApplication(ctx.principal.userId, input.applicationId);
              return documentService().checklist(input.applicationId);
            }),
          ),

        /** Upload one required document to an open draft. Refuses without published upload rules or an encryption key, a wrong type, or an oversize file. */
        upload: scopedProcedure('pay:onboard', { module: 'pay' })
          .input(kybDocumentsUploadInputSchema)
          .output(kybDocumentsUploadResultSchema)
          .mutation(({ ctx, input }) =>
            wrap(async () => {
              await ownedApplication(ctx.principal.userId, input.applicationId);
              return { row: await documentService().upload({ ...input, actorId: ctx.principal.userId }) };
            }),
          ),
      }),

      requirements: router({
        /**
         * One entity type's published requirements for a country. Refuses `pay.kyb_requirements_unset` when the type
         * is not published and `pay.kyb_country_not_served` when the country is not on its list.
         */
        read: scopedProcedure('pay:onboard', { module: 'pay' })
          .input(kybRequirementsReadInputSchema)
          .output(kybRequirementsViewSchema)
          .query(({ input }) => wrap(() => entityTypes.requirements(input.entityType, input.country))),
      }),

      /**
       * Merchant submits a dossier reference. Durable — writes history.
       * Does not invent a partner decision.
       *
       * The body names the merchant. The caller must own that row
       * (`pay.merchant_forbidden`). The stored actor is still the caller.
       */
      submit: scopedProcedure('pay:onboard', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().guid(),
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
       * Identity a compliance proposer reads before filing the approval that
       * `kyb.decide` consumes. Same scope as that door. Returns the identity
       * fields and `identityHash` only: a website or support-email edit does
       * not change this binding.
       */
      decisionBinding: scopedProcedure('admin:compliance', { module: 'pay' })
        .input(z.object({ merchantId: z.string().guid() }))
        .output(kybDecisionBindingSchema)
        .query(({ ctx, input }) =>
          wrap(async () => {
            requireMfa(ctx.principal);
            const binding = await kyb.decisionBinding(input.merchantId);
            if (!binding) throw new KybError(`No merchant ${input.merchantId}`, 'pay.merchant_not_found');
            return kybDecisionBindingView(binding);
          }),
        ),

      /**
       * Operator decide — works under live-only. Replaces the invent gap the
       * stub refuses with `pay.kyb_operator_required`.
       *
       * Identity consume is the second person. Missing approval ids refuse —
       * one operator cannot unlock acquiring with a typed-in name.
       *
       * The approval hash is the live identity hash and the reason. A proposer
       * reads `kyb.decisionBinding`, then files that hash (`kybApprovalFields`
       * then `kybDecisionPayloadHash`). An older identity does not consume.
       * The consume runs under the merchant row lock, after the live identity
       * still matches, and before the status write.
       */
      decide: scopedProcedure('admin:compliance', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().guid(),
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
            readApprovalIds(input);
            const binding = await kyb.decisionBinding(input.merchantId);
            if (!binding) throw new KybError(`No merchant ${input.merchantId}`, 'pay.merchant_not_found');
            let confirmOperatorId = '';
            const result = await kyb.decide({
              merchantId: input.merchantId,
              decision: input.decision,
              reason: input.reason,
              actorId: ctx.principal.userId,
              actorScope: 'admin:compliance',
              identityHash: binding.identityHash,
              beforeWrite: async () => {
                confirmOperatorId = await consumePayApproval(
                  approvals,
                  input,
                  PAY_KYB_DECIDE,
                  kybApprovalFields({
                    merchantId: binding.merchantId,
                    decision: input.decision,
                    identityHash: binding.identityHash,
                    reason: input.reason,
                  }),
                );
              },
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
            merchantId: z.string().guid(),
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
        .input(z.object({ merchantId: z.string().guid() }))
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
            merchantId: z.string().guid(),
            feeBps: z.number().int().min(0).max(MAX_FEE_BPS),
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
            const confirmOperatorId = await consumePayApproval(
              approvals,
              input,
              'pay.psp_set_pricing',
              pspSetPricingFields({ merchantId: input.merchantId, feeBps: input.feeBps, reason: input.reason }),
            );
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
            merchantId: z.string().guid(),
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
            merchantId: z.string().guid(),
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
            const confirmOperatorId = await consumePayApproval(
              approvals,
              input,
              'pay.psp_enable_mode',
              pspEnableModeFields({ merchantId: input.merchantId, reason: input.reason }),
            );
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
