/**
 * Operator halt of one market. Dual-control: operatorId + distinct confirmOperatorId.
 * New submits refuse. Cancels stay. Resume is a second explicit door.
 * No duration, no SLO, no all-markets kill. Missing/same confirm refuses — no invented second caller.
 */
import type { AmendResult, MarketId, RejectReason, SubmitResult } from './types.js';

export const MARKET_HALTED = 'market_halted' as const;
export const MISSING_OPERATOR = 'missing_operator' as const;

export type HaltRefuse = typeof MARKET_HALTED | typeof MISSING_OPERATOR;

export function readOperatorId(cmd: { readonly operatorId?: string | null }): string | null {
  const raw = cmd.operatorId;
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function readConfirmOperatorId(cmd: { readonly confirmOperatorId?: string | null }): string | null {
  const raw = cmd.confirmOperatorId;
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function operatorRefuse(operatorId: string | null): { readonly code: typeof MISSING_OPERATOR; readonly message: string } | null {
  if (operatorId !== null) return null;
  return {
    code: MISSING_OPERATOR,
    message: 'operator identity is required; the engine does not invent a caller',
  };
}

/** Two distinct operator identities. Missing/blank/same-as-operator refuses — the engine does not invent a second caller. */
export function dualControlRefuse(
  operatorId: string | null,
  confirmOperatorId: string | null,
): { readonly code: typeof MISSING_OPERATOR; readonly message: string } | null {
  const actor = readOperatorId({ operatorId });
  const confirm = readConfirmOperatorId({ confirmOperatorId });
  const missing = operatorRefuse(actor);
  if (missing) return missing;
  if (confirm === null) {
    return {
      code: MISSING_OPERATOR,
      message: 'confirming operator identity is required; the engine does not invent a second caller',
    };
  }
  if (confirm === actor) {
    return {
      code: MISSING_OPERATOR,
      message: 'confirming operator must be a distinct identity; the engine does not invent a second caller',
    };
  }
  return null;
}

export function marketHaltedRefuse(marketId: MarketId): RejectReason {
  return {
    code: MARKET_HALTED,
    message: `market ${marketId} is halted — new submits are refused`,
  };
}

export function haltedSubmitResult(marketId: MarketId, orderId: string): SubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: { ...marketHaltedRefuse(marketId), message: `market ${marketId} is halted — order ${orderId} not processed` },
    cancellations: [],
    triggered: [],
  };
}

export function haltedAmendResult(marketId: MarketId, orderId: string): AmendResult {
  return {
    accepted: false,
    orderId,
    sequence: null,
    version: null,
    priority: null,
    fills: [],
    resting: null,
    rejected: { ...marketHaltedRefuse(marketId), message: `market ${marketId} is halted — order ${orderId} not processed` },
    cancellations: [],
    triggered: [],
  };
}

/** When each still-halted market's halt began: its first halt record's `at` since its last resume. */
export function replayHaltedSince(
  records: readonly { readonly kind: string; readonly marketId?: MarketId; readonly at?: string }[],
): ReadonlyMap<MarketId, string> {
  const since = new Map<MarketId, string>();
  for (const record of records) {
    if (record.marketId === undefined) continue;
    if (record.kind === 'halt' && !since.has(record.marketId) && record.at) since.set(record.marketId, record.at);
    else if (record.kind === 'resume') since.delete(record.marketId);
  }
  return since;
}

/** Last halt/resume per market wins. Halt is not a book — replay does not invent one. Venue halt-all is a different door. */
export function replayHaltedMarkets(records: readonly { readonly kind: string; readonly marketId?: MarketId }[]): ReadonlySet<MarketId> {
  const halted = new Set<MarketId>();
  for (const record of records) {
    if (record.marketId === undefined) continue;
    if (record.kind === 'halt') halted.add(record.marketId);
    else if (record.kind === 'resume') halted.delete(record.marketId);
  }
  return halted;
}
