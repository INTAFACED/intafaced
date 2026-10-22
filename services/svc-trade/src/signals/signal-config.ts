/**
 * Owner values for signal intake (CB-bots-api-signal-01). The spec leaves all three as `owner-decision`, so none has a
 * default and none is invented here. A blank or malformed value refuses every alert with its named code:
 *   TRADE_SIGNAL_LATENCY_MAX_MS   whole milliseconds, >= 1          -> `trade.signal_latency_unset`
 *   TRADE_SIGNAL_BODY_CAP_BYTES   whole bytes, >= 1                 -> `trade.signal_body_cap_unset`
 *   TRADE_SIGNAL_RATE_LIMIT       `<count>/<seconds>`, both >= 1    -> `trade.signal_rate_limit_unset`
 * svc-edge enforces the body cap and rate limit at the door (PR 3); svc-trade enforces the same values again on intake, so a
 * second caller path cannot skip them.
 */
import type { TradeSignalErrorCode } from '@intafaced/contracts';

export class TradeSignalError extends Error {
  constructor(
    readonly code: TradeSignalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TradeSignalError';
  }
}

export interface SignalLimits {
  readonly latencyMaxMs: number | null;
  readonly bodyCapBytes: number | null;
  readonly rateLimit: { readonly count: number; readonly windowSeconds: number } | null;
}

function positiveInt(raw: string | undefined): number | null {
  const v = (raw ?? '').trim();
  if (!/^[1-9]\d{0,9}$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** Parses the three owner values. A blank or malformed value is `null` (refuses), never a default. */
export function parseSignalLimits(raw: {
  TRADE_SIGNAL_LATENCY_MAX_MS?: string;
  TRADE_SIGNAL_BODY_CAP_BYTES?: string;
  TRADE_SIGNAL_RATE_LIMIT?: string;
}): SignalLimits {
  const rate = (raw.TRADE_SIGNAL_RATE_LIMIT ?? '').trim().split('/');
  const count = rate.length === 2 ? positiveInt(rate[0]) : null;
  const windowSeconds = rate.length === 2 ? positiveInt(rate[1]) : null;
  return {
    latencyMaxMs: positiveInt(raw.TRADE_SIGNAL_LATENCY_MAX_MS),
    bodyCapBytes: positiveInt(raw.TRADE_SIGNAL_BODY_CAP_BYTES),
    rateLimit: count !== null && windowSeconds !== null ? { count, windowSeconds } : null,
  };
}

/** Throws the first unset owner value's refusal. Called before any lookup, so a blank value refuses every alert alike. */
export function requireSignalLimits(limits: SignalLimits): {
  latencyMaxMs: number;
  bodyCapBytes: number;
  rateLimit: { count: number; windowSeconds: number };
} {
  if (limits.latencyMaxMs === null) throw new TradeSignalError('trade.signal_latency_unset', 'signal latency max is not set');
  if (limits.bodyCapBytes === null) throw new TradeSignalError('trade.signal_body_cap_unset', 'signal body size cap is not set');
  if (limits.rateLimit === null) throw new TradeSignalError('trade.signal_rate_limit_unset', 'signal rate limit is not set');
  return { latencyMaxMs: limits.latencyMaxMs, bodyCapBytes: limits.bodyCapBytes, rateLimit: { ...limits.rateLimit } };
}
