import { PayError, type PayService } from './payment-service.js';
import { SubMerchantError, type PermissionArea } from './submerchants.js';

/** The ownership rule reads `userId` only. */
export interface MerchantOwnerLookup {
  getMerchant(merchantId: string): Promise<{ userId: string }>;
}

/**
 * DOES THIS PRINCIPAL OWN THIS MERCHANT? — asked in exactly one place.
 *
 * The rule is three lines and it is the only thing standing between a merchant
 * id in a query string and somebody else's payment history. It used to live
 * inside `router.ts` as a private helper that threw a `TRPCError`, which was
 * correct while tRPC was the only way in.
 *
 * `pay.public-api` adds a second way in (docs/adr/2026-08-07-pay-public-api-law.md),
 * and the ADR's rule for it is that REST is a TRANSLATION: "any behaviour that
 * differs between REST and tRPC is a defect in the REST layer". A rule copied
 * into two files is a rule with two futures — so it moved here, and both
 * surfaces call it. The transports differ only in how they render the refusal:
 * tRPC maps it to FORBIDDEN, REST to 403.
 *
 * Throws `PayError` rather than a transport error for the same reason: a domain
 * refusal that already knows about HTTP cannot be reused by anything that is
 * not HTTP.
 */
export async function assertMerchantOwnership(
  pay: MerchantOwnerLookup,
  principalUserId: string | undefined,
  merchantId: string,
): Promise<void> {
  const merchant = await pay.getMerchant(merchantId);

  /**
   * `undefined !== undefined` is false, so an anonymous principal must never
   * reach a merchant row whose `userId` is also absent. It cannot today —
   * `scopedProcedure` and the REST scope check both refuse before this — but
   * the guard is one comparison and the failure it prevents is silent.
   */
  if (principalUserId === undefined || merchant.userId !== principalUserId) {
    throw new PayError('This merchant belongs to another user', 'pay.merchant_forbidden');
  }
}

/**
 * The narrow tree fence the gateway surface needs for area checks.
 *
 * Structural rather than the full `SubMerchantService` so unit tests can prove
 * the money-path map without a recursive CTE behind them.
 */
export interface MerchantAreaFence {
  assertHolds(actorMerchantId: string, subjectMerchantId: string, area: PermissionArea): Promise<void>;
}

/**
 * DOES THIS PRINCIPAL HOLD `area` OVER THIS MERCHANT?
 *
 * Self still wins with no tree walk: a merchant holds every area over its own
 * node (submerchants.ts). When the principal is NOT the merchant's user, and a
 * PayFac fence is wired, we resolve the principal's merchant node and ask the
 * tree. Without a fence, non-self stays `pay.merchant_forbidden` — the pre-tree
 * rule, so tests that never built a tree keep working.
 *
 * README residual (PayFac §): nine areas named procedures that still authorized
 * with ownership alone. This is the one place those paths check area.
 */
export async function assertMerchantAreaAccess(
  pay: Pick<PayService, 'getMerchant' | 'getMerchantByUserId'>,
  principalUserId: string | undefined,
  merchantId: string,
  area: PermissionArea,
  trees: MerchantAreaFence | null | undefined,
): Promise<void> {
  const merchant = await pay.getMerchant(merchantId);

  if (principalUserId === undefined) {
    throw new PayError('This merchant belongs to another user', 'pay.merchant_forbidden');
  }

  // Own node: every area, no grant required.
  if (merchant.userId === principalUserId) return;

  // No tree wired → strangers stay forbidden (ownership-only era).
  if (!trees) {
    throw new PayError('This merchant belongs to another user', 'pay.merchant_forbidden');
  }

  const actor = await pay.getMerchantByUserId(principalUserId);
  if (!actor) {
    throw new PayError('This merchant belongs to another user', 'pay.merchant_forbidden');
  }

  try {
    await trees.assertHolds(actor.id, merchantId, area);
  } catch (err) {
    if (err instanceof SubMerchantError) {
      if (err.code === 'pay.submerchant_permission_denied') {
        throw new PayError(`Merchant holds no "${area}" permission over this merchant`, 'pay.submerchant_permission_denied', { area });
      }
      // Out of scope / cycle / not onboarded: same as a stranger — do not
      // confirm the subject id sits in some other tree.
      throw new PayError('This merchant belongs to another user', 'pay.merchant_forbidden');
    }
    throw err;
  }
}
