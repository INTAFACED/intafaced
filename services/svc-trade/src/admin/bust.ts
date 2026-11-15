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

/** What one operator reconcile sweep did (admin.orders.startReconcileSweep). Each order is in at most one list. */
export interface SweepResult {
  /** Orders looked at. */
  readonly checked: number;
  /** Orders whose hold was released, once each. */
  readonly released: number;
  readonly releasedOrderIds: readonly string[];
  /** Missing from the book, seen missing for the first time by this sweep: a later sweep a floor on may release them. */
  readonly firstSightedOrderIds: readonly string[];
  /** Missing from the book, first seen by an earlier sweep less than the floor ago: still waiting. */
  readonly waitingOrderIds: readonly string[];
  /** Missing from the book, but trade.fills could not prove no fill: their holds stay. */
  readonly failedClosedOrderIds: readonly string[];
  /** Missing from the book with no hold left: terminalized, nothing released (no hold was invented). */
  readonly terminalizedNoHoldOrderIds: readonly string[];
  /** Any other reconcile action, named in each order's audit row. */
  readonly otherActionOrderIds: readonly string[];
  /** The book or the row could not be read: nothing was done to them. */
  readonly unreadableOrderIds: readonly string[];
  /** The reconcile threw after it had acted on the order (its row is no longer open): read it before anything else. */
  readonly erroredAfterActingOrderIds: readonly string[];
  readonly limit: number;
  readonly minAgeSeconds: number;
  readonly ranAt: string;
}

/** The sweep's working lists, one per outcome. */
export interface SweepLists {
  released: string[];
  firstSighted: string[];
  waiting: string[];
  keptUnprovenFills: string[];
  terminalizedNoHold: string[];
  otherActions: string[];
  unreadable: string[];
  erroredAfterActing: string[];
}

/** One structured line per sweep error, with the order or market it was about (never swallowed). */
export function sweepLog(event: string, fields: Record<string, unknown> & { error?: unknown }): void {
  const { error, ...rest } = fields;
  const message = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
  console.error(
    JSON.stringify({ service: 'svc-trade', event: `reconcile_sweep.${event}`, ...rest, ...(message ? { error: message } : {}) }),
  );
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

/** The sweep's kill switch: on only for 1, true, on or yes. Anything else, blank included, is off. */
export function parseSweepEnabled(raw: string | undefined): boolean {
  const text = raw?.trim().toLowerCase() ?? '';
  return text === '1' || text === 'true' || text === 'on' || text === 'yes';
}
