import { PayError, type PayService } from './payment-service.js';
import { logIsolationDenial } from './isolation-log.js';
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
 * tRPC maps it to NOT_FOUND, REST to 404.
 *
 * A merchant that exists but is not yours is refused EXACTLY like one that does
 * not exist (`merchantNotFound`), so the answer is not an existence oracle. The
 * lookup runs before the comparison in both cases; the real reason is logged
 * for operators (isolation-log.ts) and never reaches a response.
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
  const merchant = await lookupMerchant(pay, merchantId);

  /**
   * `undefined !== undefined` is false, so an anonymous principal must never
   * reach a merchant row whose `userId` is also absent. It cannot today —
   * `scopedProcedure` and the REST scope check both refuse before this — but
   * the guard is one comparison and the failure it prevents is silent.
   */
  if (merchant === null) {
    logIsolationDenial({ reason: 'absent', merchantId, ...(principalUserId === undefined ? {} : { principalUserId }) });
    throw merchantNotFound(merchantId);
  }
  if (principalUserId === undefined || merchant.userId !== principalUserId) {
    logIsolationDenial({
      reason: principalUserId === undefined ? 'anonymous' : 'not_owner',
      merchantId,
      ...(principalUserId === undefined ? {} : { principalUserId }),
    });
    throw merchantNotFound(merchantId);
  }
}

/**
 * THE ONE REFUSAL FOR "NOT YOURS" AND "NOT THERE".
 *
 * Byte-identical to what `PayService.getMerchant` throws for a missing row
 * (same code, same message), so tRPC and REST render both the same: NOT_FOUND
 * and 404. A caller can never learn that someone else's id is real. The
 * authorization check itself is unchanged; only the words of the refusal are.
 */
export function merchantNotFound(merchantId: string): PayError {
  return new PayError(`Merchant ${merchantId} not found`, 'pay.merchant_not_found');
}

/**
 * CHILD RESOURCES (payments, settlements) — the same rule one level down.
 *
 * Those procedures read the row first to learn its merchant, then fence on that
 * merchant. A ghost id fails the read (`pay.payment_not_found`); somebody else's
 * id would fail the fence (`pay.merchant_not_found`) — a different code and
 * message, so the pair would still be an oracle. A fence refusal that is "not
 * yours" is re-worded as the child's own not-found. A real permission refusal
 * inside the caller's own tree (`pay.submerchant_permission_denied`) passes
 * through untouched: that caller already knows the subtree exists.
 */
export async function refuseAsMissing<T>(check: Promise<T>, missing: () => PayError): Promise<T> {
  try {
    return await check;
  } catch (err) {
    if (err instanceof PayError && err.code === 'pay.merchant_not_found') throw missing();
    throw err;
  }
}

/** `getMerchant`, with "no such row" turned into `null` so absence and foreignness share one path. */
async function lookupMerchant<T>(pay: { getMerchant(merchantId: string): Promise<T> }, merchantId: string): Promise<T | null> {
  try {
    return await pay.getMerchant(merchantId);
  } catch (err) {
    if (err instanceof PayError && err.code === 'pay.merchant_not_found') return null;
    throw err;
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
 * tree. Without a fence, non-self is refused as not-found (`pay.merchant_not_found`) — the pre-tree
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
  const merchant = await lookupMerchant(pay, merchantId);

  const deny = (reason: 'absent' | 'anonymous' | 'not_owner' | 'no_actor_merchant' | 'out_of_scope', actorMerchantId?: string): never => {
    logIsolationDenial({
      reason,
      merchantId,
      area,
      ...(principalUserId === undefined ? {} : { principalUserId }),
      ...(actorMerchantId === undefined ? {} : { actorMerchantId }),
    });
    throw merchantNotFound(merchantId);
  };

  if (principalUserId === undefined) return deny(merchant === null ? 'absent' : 'anonymous');

  // Own node: every area, no grant required.
  if (merchant !== null && merchant.userId === principalUserId) return;

  // No tree wired → strangers stay refused (ownership-only era).
  if (!trees) return deny(merchant === null ? 'absent' : 'not_owner');

  /*
   * From here a real foreign merchant and a missing one run the same queries:
   * resolve the principal's node, then walk the tree toward the subject (for a
   * missing id the walk finds no row). One round trip shape for both, so the
   * time a refusal takes is not an existence oracle.
   */
  const actor = await pay.getMerchantByUserId(principalUserId);
  if (!actor) return deny(merchant === null ? 'absent' : 'no_actor_merchant');

  try {
    await trees.assertHolds(actor.id, merchantId, area);
  } catch (err) {
    if (err instanceof SubMerchantError) {
      if (merchant !== null && err.code === 'pay.submerchant_permission_denied') {
        throw new PayError(`Merchant holds no "${area}" permission over this merchant`, 'pay.submerchant_permission_denied', { area });
      }
      // Out of scope / missing / cycle / not onboarded: same as a stranger or
      // a nonexistent id — do not confirm the subject id sits in some other tree.
      return deny(merchant === null ? 'absent' : 'out_of_scope', actor.id);
    }
    throw err;
  }
  // The subject row must exist for any grant to stand. A walk that "succeeds"
  // over a row we could not read is refused, never allowed.
  if (merchant === null) return deny('absent', actor.id);
}
