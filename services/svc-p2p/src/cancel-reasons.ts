import { p2pCancelReasonAllowed, type P2pCancelReason, type P2pCancelledBy } from '@intafaced/contracts/p2p-cancel';

/**
 * P-trade-orders-19: why an order was cancelled, from a fixed list per side (`@intafaced/contracts/p2p-cancel`).
 *
 * A coded cancel is stored as `<actor>.reason:<code>`, which no free-text reason can produce (free text is stored as
 * `<actor>.<text>`, and `reason:` is the marker), so the buyer-cancel count (`BUYER_CANCEL_REASON_PREFIX`), the order's
 * display status and `resolvedByOf` all read it unchanged.
 */
const CODE_MARKER = 'reason:';

export function codedCancelReason(side: 'buyer' | 'seller', code: P2pCancelReason): string {
  return `${side}.${CODE_MARKER}${code}`;
}

/** Free text that would read back as a coded reason; `cancelTrade` refuses it. */
export function isCodedCancelText(text: string): boolean {
  return text.trimStart().startsWith(CODE_MARKER);
}

/** Who ended a trade, from its stored resolution reason. A reason with no actor prefix is the seller's (as it always was). */
export function resolvedByOf(reason: string | null): P2pCancelledBy {
  if (!reason) return 'seller';
  if (reason.startsWith('moderator:')) return 'moderator';
  if (reason.startsWith('timeout.')) return 'timeout';
  if (reason.startsWith('buyer')) return 'buyer';
  return 'seller';
}

/**
 * On an order a party or the clock cancelled, who did and the code they chose (null for free text through the API, or
 * a cancel from before codes existed). Null for any other order, and for a void: an escrow that never locked was not
 * cancelled by anyone.
 */
export function cancelReasonOf(trade: {
  status: string;
  resolution: string | null;
  resolutionReason: string | null;
}): { by: P2pCancelledBy; code: P2pCancelReason | null } | null {
  if (trade.status !== 'cancelled' || trade.resolution === 'voided') return null;
  const by = resolvedByOf(trade.resolutionReason);
  const marker = `${by}.${CODE_MARKER}`;
  const reason = trade.resolutionReason ?? '';
  const code = (by === 'buyer' || by === 'seller') && reason.startsWith(marker) ? reason.slice(marker.length) : null;
  return { by, code: code !== null && p2pCancelReasonAllowed(by as 'buyer' | 'seller', code) ? code : null };
}
