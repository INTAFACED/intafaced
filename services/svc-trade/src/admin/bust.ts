/**
 * Trade bust (J-cex-spot-18 #4): what the two operators approve, and the typed refusal while no reversal recipe exists.
 *
 * The proposer asks identity for an action approval of `trade.bust` on one order, with targetService `svc-trade`,
 * expectedVersion the order's fill count when it was read, and payloadHash = `payloadHash(bustApprovalBody(...))`. The
 * founder console computes the same hash (apps/admin/src/lib/trade-ops/bust-hash.ts): a change to the body here is a
 * change there. svc-trade consumes the approval, then refuses `trade_bust_recipe_missing`: reversing a fill needs a
 * ledger-client recipe, and none exists, so nothing moves.
 */
import { createHash } from 'node:crypto';

export const BUST_ACTION_TYPE = 'trade.bust' as const;
export const BUST_TARGET_SERVICE = 'svc-trade' as const;
export const BUST_POLICY_VERSION = 'trade-bust-v1' as const;
export const TRADE_BUST_RECIPE_MISSING = 'trade_bust_recipe_missing' as const;

/** The approved body: the action, the order, its fill count when read, and the reason the proposer wrote. */
export function bustApprovalBody(input: { orderId: string; expectedVersion: string; reason: string }) {
  return { actionType: BUST_ACTION_TYPE, orderId: input.orderId, expectedVersion: input.expectedVersion, reason: input.reason };
}

/** One audit row per bust request: a retry under the same clientRequestId writes no second row. */
export function bustAuditId(clientRequestId: string): string {
  const bytes = createHash('sha256').update(`orders.bust|${clientRequestId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** What one operator reconcile sweep did (admin.orders.startReconcileSweep). */
export interface SweepResult {
  /** Orders looked at. */
  readonly checked: number;
  /** Orders whose hold was released, once each. */
  readonly released: number;
  readonly releasedOrderIds: readonly string[];
  /** Orders the book no longer has whose fills could not prove no fill: their holds stay. */
  readonly failedClosedOrderIds: readonly string[];
  /** Orders whose book or ledger read failed: nothing was done to them. */
  readonly unreadableOrderIds: readonly string[];
  readonly limit: number;
  readonly minAgeSeconds: number;
  readonly ranAt: string;
}

/** Parses the owner's sweep size (1 to 10000 orders). Blank or anything else is unset: null, and the sweep refuses. */
export function parseSweepLimit(raw: string | undefined): number | null {
  const text = raw?.trim() ?? '';
  if (!/^[1-9]\d{0,4}$/.test(text)) return null;
  const limit = Number(text);
  return limit <= 10_000 ? limit : null;
}

/** Parses the owner's sweep age floor (1 s to 1 day). Blank or anything else is unset: null, and the sweep refuses. */
export function parseSweepMinAgeSeconds(raw: string | undefined): number | null {
  const text = raw?.trim() ?? '';
  if (!/^[1-9]\d{0,4}$/.test(text)) return null;
  const seconds = Number(text);
  return seconds <= 86_400 ? seconds : null;
}
