import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { PERMISSION_AREAS, SubMerchantError, type SubMerchantService } from './submerchants.js';

/**
 * THE PAYFAC SURFACE (§6.1) — sub-merchant trees and the permissions over them.
 *
 * ══ AUTHORIZATION IS ENFORCED HERE, NOT DOCUMENTED HERE ══════════════════════
 *
 * Every procedure below does the same three things in the same order, and none
 * of them is optional:
 *
 *   1. `scopedProcedure(…, { module: 'pay' })` — the caller holds a pay scope and
 *      passes the §22 jurisdiction matrix, exactly like every other procedure in
 *      this service.
 *   2. `actor()` — the caller's OWN merchant node, resolved from the
 *      authenticated principal. There is no `actorMerchantId` on the wire, so
 *      there is nothing to forge; a caller who is not a merchant is refused
 *      before any tree is walked.
 *   3. The service's subtree fence and permission check, which throw
 *      `pay.submerchant_out_of_scope` / `pay.submerchant_permission_denied`.
 *
 * Step 2 is the one that would be easy to get wrong. `pay:write` is a MERCHANT'S
 * scope, held by every merchant on the platform — so if the merchant node came
 * from the request body, any merchant could name any other merchant as the node
 * they were "acting as" and the tree fence would be measuring the wrong actor
 * entirely. The scope says what kind of caller this is; the tree says what they
 * can reach; and only the principal decides which node they are.
 *
 * ══ WHY ITS OWN ROUTER FILE ══════════════════════════════════════════════════
 *
 * Merged into the pay router with `mergeRouters` in `index.ts`, the same way
 * `merchant-state-router.ts` is, so there is still one wire surface and the edge
 * still forwards `/api/pay` to a single router. `router.ts` is already a
 * thousand lines covering the gateway surface; the payfac surface has a
 * different reader and a different authorization model, and keeping it separate
 * is what stops the second from being read as a footnote to the first.
 */

const areaSchema = z.enum(PERMISSION_AREAS);

const subMerchantView = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  parentMerchantId: z.string().uuid().nullable(),
  mode: z.enum(['gateway', 'psp', 'payfac']),
  status: z.enum(['pending', 'active', 'suspended', 'closed']),
  kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
  settlingParty: z.string(),
  /**
   * Nullable, and NOT defaulted to zero. A sub-merchant onboarded by some other
   * path may carry no `feeBps`, and rendering that as `0` would tell an operator
   * the merchant is processed free of charge. `settleWindow` already refuses to
   * settle rather than assume a rate; a read surface must not assume one either.
   */
  feeBps: z.number().int().nullable(),
  depth: z.number().int(),
  createdAt: z.string().datetime({ offset: true }),
});

const grantView = z.object({
  granteeMerchantId: z.string().uuid(),
  subjectMerchantId: z.string().uuid(),
  area: areaSchema,
  reason: z.string(),
  actorId: z.string(),
  actorMerchantId: z.string().uuid(),
  grantedAt: z.string().datetime({ offset: true }),
});

const permissionEventView = z.object({
  id: z.string().uuid(),
  /** A `bigserial` ordering key. A string, never arithmetic. */
  seq: z.string(),
  granteeMerchantId: z.string().uuid(),
  subjectMerchantId: z.string().uuid(),
  area: z.string(),
  action: z.enum(['grant', 'revoke']),
  reason: z.string(),
  actorId: z.string(),
  actorMerchantId: z.string().uuid(),
  actorScope: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});

/**
 * The narrow slice of `PayService` this router needs: the principal's own
 * merchant. Structural rather than the whole class so the boundary suite can
 * exercise the authorization path without a database behind it.
 */
export interface ActorMerchantLookup {
  getMerchantByUserId(userId: string): Promise<{ id: string } | null>;
}

/**
 * Codes a CALLER caused, and how each is rendered. Everything not listed is a
 * server fault and keeps tRPC's default — a refusal a merchant's engineer cannot
 * tell apart from an outage costs them an afternoon (`router.ts` makes the same
 * distinction for rail failures).
 */
const CALLER_FAULT: Readonly<Record<string, 'FORBIDDEN' | 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED'>> = {
  'pay.merchant_not_found': 'NOT_FOUND',
  'pay.submerchant_not_onboarded': 'FORBIDDEN',
  'pay.submerchant_out_of_scope': 'FORBIDDEN',
  'pay.submerchant_permission_denied': 'FORBIDDEN',
  'pay.submerchant_grant_lateral': 'FORBIDDEN',
  'pay.submerchant_grant_self': 'BAD_REQUEST',
  'pay.submerchant_grant_redundant': 'BAD_REQUEST',
  'pay.submerchant_revoke_redundant': 'BAD_REQUEST',
  'pay.submerchant_area_unknown': 'BAD_REQUEST',
  'pay.submerchant_too_deep': 'BAD_REQUEST',
  'pay.submerchant_reason_required': 'BAD_REQUEST',
  'pay.submerchant_pricing_invalid': 'BAD_REQUEST',
  'pay.submerchant_settling_party_unsupported': 'BAD_REQUEST',
  'pay.submerchant_user_already_merchant': 'CONFLICT',
  /**
   * NOT the caller's fault, and deliberately not an INTERNAL_SERVER_ERROR: tRPC
   * redacts that message, and this one names the corrupted node an operator has
   * to go and look at.
   */
  'pay.submerchant_cycle': 'CONFLICT',
  'pay.submerchant_list_limit_unset': 'PRECONDITION_FAILED',
  'pay.submerchant_permission_list_limit_unset': 'PRECONDITION_FAILED',
  'pay.submerchant_permission_history_limit_unset': 'PRECONDITION_FAILED',
  'pay.identity_admission_unavailable': 'PRECONDITION_FAILED',
};

function toTrpcError(err: unknown): unknown {
  if (err instanceof SubMerchantError) {
    const code = CALLER_FAULT[err.code];
    if (code) return new TRPCError({ code, message: err.message, cause: err });
  }
  return err;
}

export function createSubMerchantRouter(subMerchants: SubMerchantService, merchants: ActorMerchantLookup) {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw toTrpcError(err);
    }
  };

  /**
   * WHICH NODE IS THIS CALLER? — from the token, and only from the token.
   *
   * A principal with a pay scope but no merchant row is refused here rather than
   * further down. It is not an authentication failure (they are who they say)
   * and not a not-found (nothing was addressed yet) — they simply have no
   * standing in any tree, and every later check would be comparing against
   * `undefined`.
   */
  const actor = async (userId: string | undefined): Promise<string> => {
    if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Principal required' });
    const merchant = await merchants.getMerchantByUserId(userId);
    if (!merchant) {
      throw new SubMerchantError(
        'This account is not a merchant, so it holds no position in any sub-merchant tree.',
        'pay.submerchant_not_onboarded',
      );
    }
    return merchant.id;
  };

  return router({
    submerchant: router({
      /**
       * Onboard a sub-merchant under a node inside the caller's own subtree.
       *
       * `userId` IS AN INPUT HERE, and that is the one place in this router it
       * is. A sub-merchant is a sovereign account that is NOT the caller's —
       * that is the whole point of a tree — so the account being onboarded has
       * to be named. What stops it being an escalation is that naming an account
       * that already has a merchant is refused (`pay.submerchant_user_already_merchant`)
       * rather than adopting their existing row: onboarding creates a node, it
       * never captures one.
       *
       * `mode` is not an input. A node under a parent is `payfac` by
       * construction, and letting a caller choose would let them create a
       * sub-merchant that claims to be a standalone gateway merchant.
       */
      create: scopedProcedure('pay:write', { module: 'pay' })
        .input(
          z.object({
            parentMerchantId: z.string().uuid(),
            userId: z.string().min(1).max(128),
            pricing: z.object({ feeBps: z.number().int().min(0).max(10_000) }),
            /**
             * Optional, and `'self'` is the only accepted value today. It is on
             * the wire rather than hidden so a caller that needs a sponsor gets
             * the honest refusal by name instead of silently being settled to
             * themselves. See `SETTLING_PARTY_SELF`.
             */
            settlingParty: z.string().min(1).max(64).optional(),
            settlementPrefs: z.record(z.unknown()).optional(),
          }),
        )
        .output(subMerchantView)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const actorMerchantId = await actor(ctx.principal?.userId);
            const record = await subMerchants.createSubMerchant({
              actorMerchantId,
              parentMerchantId: input.parentMerchantId,
              userId: input.userId,
              pricing: input.pricing,
              settlingParty: input.settlingParty,
              settlementPrefs: input.settlementPrefs,
              // From the principal, never the body — the journal records who
              // onboarded this node, not who the request said had.
              actorId: ctx.principal?.userId ?? '',
              actorScope: 'pay:write',
            });
            return { ...record, createdAt: record.createdAt.toISOString() };
          }),
        ),

      /** Direct children of a node the caller can reach. Requires `submerchant`. */
      list: scopedProcedure('pay:read', { module: 'pay' })
        .input(
          z.object({
            merchantId: z.string().uuid(),
            /**
             * Page size. Optional so omit reaches `pay.submerchant_list_limit_unset`.
             * Blank is not 100; pass 100 explicitly.
             */
            limit: z.number().int().min(1).max(500).optional(),
          }),
        )
        .output(z.array(subMerchantView))
        .query(({ ctx, input }) =>
          wrap(async () => {
            const actorMerchantId = await actor(ctx.principal?.userId);
            const rows = await subMerchants.listSubMerchants(actorMerchantId, input.merchantId, input.limit);
            return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
          }),
        ),

      /** One node's record. Requires `merchant.profile`, not `submerchant`. */
      get: scopedProcedure('pay:read', { module: 'pay' })
        .input(z.object({ merchantId: z.string().uuid() }))
        .output(subMerchantView)
        .query(({ ctx, input }) =>
          wrap(async () => {
            const actorMerchantId = await actor(ctx.principal?.userId);
            const record = await subMerchants.getSubMerchant(actorMerchantId, input.merchantId);
            return { ...record, createdAt: record.createdAt.toISOString() };
          }),
        ),
    }),

    submerchantPermission: router({
      /**
       * Delegate an area the caller already holds to a node between them and the
       * subject.
       *
       * `reason` is required and stored. "Why does this node hold refund
       * authority over that one" has to be answerable from the database — the
       * same rule merchant status changes carry, and a stronger one here,
       * because a permission is what a later incident is reconstructed from.
       */
      grant: scopedProcedure('pay:write', { module: 'pay' })
        .input(
          z.object({
            granteeMerchantId: z.string().uuid(),
            subjectMerchantId: z.string().uuid(),
            area: areaSchema,
            /** `min(3)`: one character satisfies "not blank" and answers nothing. */
            reason: z.string().trim().min(3).max(500),
          }),
        )
        .output(permissionEventView)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const actorMerchantId = await actor(ctx.principal?.userId);
            const event = await subMerchants.grantPermission({
              actorMerchantId,
              granteeMerchantId: input.granteeMerchantId,
              subjectMerchantId: input.subjectMerchantId,
              area: input.area,
              reason: input.reason,
              actorId: ctx.principal?.userId ?? '',
              actorScope: 'pay:write',
            });
            return { ...event, createdAt: event.createdAt.toISOString() };
          }),
        ),

      /** Take it back — a new journal row, never an edit. Same authority as `grant`. */
      revoke: scopedProcedure('pay:write', { module: 'pay' })
        .input(
          z.object({
            granteeMerchantId: z.string().uuid(),
            subjectMerchantId: z.string().uuid(),
            area: areaSchema,
            reason: z.string().trim().min(3).max(500),
          }),
        )
        .output(permissionEventView)
        .mutation(({ ctx, input }) =>
          wrap(async () => {
            const actorMerchantId = await actor(ctx.principal?.userId);
            const event = await subMerchants.revokePermission({
              actorMerchantId,
              granteeMerchantId: input.granteeMerchantId,
              subjectMerchantId: input.subjectMerchantId,
              area: input.area,
              reason: input.reason,
              actorId: ctx.principal?.userId ?? '',
              actorScope: 'pay:write',
            });
            return { ...event, createdAt: event.createdAt.toISOString() };
          }),
        ),

      /** The live grants over one node. Implicit authority is not listed — it is not a grant. */
      list: scopedProcedure('pay:read', { module: 'pay' })
        .input(
          z.object({
            subjectMerchantId: z.string().uuid(),
            /**
             * Page size. Optional so omit reaches `pay.submerchant_permission_list_limit_unset`.
             * Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          }),
        )
        .output(z.array(grantView))
        .query(({ ctx, input }) =>
          wrap(async () => {
            const actorMerchantId = await actor(ctx.principal?.userId);
            const rows = await subMerchants.listPermissions(actorMerchantId, input.subjectMerchantId, input.limit);
            return rows.map((r) => ({ ...r, grantedAt: r.grantedAt.toISOString() }));
          }),
        ),

      /** Grants AND revokes, newest first — the answer to "who could do this, and when". */
      history: scopedProcedure('pay:read', { module: 'pay' })
        .input(
          z.object({
            subjectMerchantId: z.string().uuid(),
            /**
             * Page size. Optional so omit reaches `pay.submerchant_permission_history_limit_unset`.
             * Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          }),
        )
        .output(z.array(permissionEventView))
        .query(({ ctx, input }) =>
          wrap(async () => {
            const actorMerchantId = await actor(ctx.principal?.userId);
            const rows = await subMerchants.permissionHistory(actorMerchantId, input.subjectMerchantId, input.limit);
            return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
          }),
        ),

      /**
       * The area vocabulary, so a console does not hard-code its own copy.
       *
       * A second list in a UI is a list that goes stale, and a stale one renders
       * a checkbox for an area nothing enforces. `pay:read` rather than public:
       * the areas describe what this platform lets a facilitator delegate, which
       * is not something an anonymous caller needs.
       */
      areas: scopedProcedure('pay:read', { module: 'pay' })
        .output(z.array(areaSchema))
        .query(() => [...PERMISSION_AREAS]),
    }),
  });
}

export type SubMerchantRouter = ReturnType<typeof createSubMerchantRouter>;
