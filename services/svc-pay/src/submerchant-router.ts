import type { Sql } from 'postgres';
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { PERMISSION_AREAS, SubMerchantError, refuseSubMerchantWithoutConsent, type SubMerchantService } from './submerchants.js';
import { readSubMerchantSummary } from './merchant-portal/summary.js';
import {
  PAY_SUBMERCHANT_LIST,
  PAY_SUBMERCHANT_GET,
  PAY_SUBMERCHANT_CREATE,
  PAY_SUBMERCHANT_SUMMARY,
} from '@intafaced/contracts/pay-submerchant-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { payRefusal } from './record-refusal.js';
import {
  PAY_SUBMERCHANT_PERMISSION_AREAS,
  PAY_SUBMERCHANT_PERMISSION_LIST,
  PAY_SUBMERCHANT_PERMISSION_HISTORY,
  PAY_SUBMERCHANT_PERMISSION_GRANT,
  PAY_SUBMERCHANT_PERMISSION_REVOKE,
} from '@intafaced/contracts/pay-submerchant-permission-procedures';

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
  'pay.submerchant_consent_required': 'FORBIDDEN',
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
  'pay.submerchant_summary_limit_unset': 'PRECONDITION_FAILED',
  'pay.submerchant_summary_grants_limit_unset': 'PRECONDITION_FAILED',
  'pay.list_cursor_invalid': 'BAD_REQUEST',
  'pay.submerchant_summary_unavailable': 'PRECONDITION_FAILED',
};

function toTrpcError(err: unknown): unknown {
  if (err instanceof SubMerchantError) {
    const code = CALLER_FAULT[err.code];
    if (code) return new TRPCError({ code, message: `${err.code}: ${err.message}`, cause: err });
  }
  return err;
}

export function createSubMerchantRouter(subMerchants: SubMerchantService, merchants: ActorMerchantLookup, sql?: Sql) {
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
      create: mountRecord(
        PAY_SUBMERCHANT_CREATE,
        ({ ctx, input }) =>
          wrap(async () => {
            refuseSubMerchantWithoutConsent();
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
        payRefusal,
      ),

      /** Direct children of a node the caller can reach. Requires `submerchant`. */
      list: mountRecord(
        PAY_SUBMERCHANT_LIST,
        ({ ctx, input }) =>
          wrap(async () => {
            const actorMerchantId = await actor(ctx.principal?.userId);
            const rows = await subMerchants.listSubMerchants(actorMerchantId, input.merchantId, input.limit);
            return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
          }),
        payRefusal,
      ),

      /** One node's record. Requires `merchant.profile`, not `submerchant`. */
      get: mountRecord(
        PAY_SUBMERCHANT_GET,
        ({ ctx, input }) =>
          wrap(async () => {
            const actorMerchantId = await actor(ctx.principal?.userId);
            const record = await subMerchants.getSubMerchant(actorMerchantId, input.merchantId);
            return { ...record, createdAt: record.createdAt.toISOString() };
          }),
        payRefusal,
      ),

      /**
       * Child summary for `/pay/network/:child`. Same subtree fence as `get`.
       * Volume and recent payments are present only with `payment`. Grants are
       * present only with `permission`. A missing area is null.
       */
      summary: mountRecord(
        PAY_SUBMERCHANT_SUMMARY,
        ({ ctx, input }) =>
          wrap(async () => {
            if (!sql) {
              throw new SubMerchantError('Sub-merchant summary has no database', 'pay.submerchant_summary_unavailable');
            }
            const actorMerchantId = await actor(ctx.principal?.userId);
            return readSubMerchantSummary(sql, subMerchants, actorMerchantId, input);
          }),
        payRefusal,
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
      grant: mountRecord(
        PAY_SUBMERCHANT_PERMISSION_GRANT,
        ({ ctx, input }) =>
          wrap(async () => {
            refuseSubMerchantWithoutConsent();
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
        payRefusal,
      ),

      /** Take it back — a new journal row, never an edit. Same authority as `grant`. */
      revoke: mountRecord(
        PAY_SUBMERCHANT_PERMISSION_REVOKE,
        ({ ctx, input }) =>
          wrap(async () => {
            refuseSubMerchantWithoutConsent();
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
        payRefusal,
      ),

      /** The live grants over one node. Implicit authority is not listed — it is not a grant. */
      list: mountRecord(
        PAY_SUBMERCHANT_PERMISSION_LIST,
        ({ ctx, input }) =>
          wrap(async () => {
            const actorMerchantId = await actor(ctx.principal?.userId);
            const rows = await subMerchants.listPermissions(actorMerchantId, input.subjectMerchantId, input.limit);
            return rows.map((r) => ({ ...r, grantedAt: r.grantedAt.toISOString() }));
          }),
        payRefusal,
      ),

      /** Grants AND revokes, newest first — the answer to "who could do this, and when". */
      history: mountRecord(
        PAY_SUBMERCHANT_PERMISSION_HISTORY,
        ({ ctx, input }) =>
          wrap(async () => {
            const actorMerchantId = await actor(ctx.principal?.userId);
            const rows = await subMerchants.permissionHistory(actorMerchantId, input.subjectMerchantId, input.limit);
            return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
          }),
        payRefusal,
      ),

      /**
       * The area vocabulary, so a console does not hard-code its own copy.
       *
       * A second list in a UI is a list that goes stale, and a stale one renders
       * a checkbox for an area nothing enforces. `pay:read` rather than public:
       * the areas describe what this platform lets a facilitator delegate, which
       * is not something an anonymous caller needs.
       */
      areas: mountRecord(PAY_SUBMERCHANT_PERMISSION_AREAS, () => [...PERMISSION_AREAS], payRefusal),
    }),
  });
}

export type SubMerchantRouter = ReturnType<typeof createSubMerchantRouter>;
