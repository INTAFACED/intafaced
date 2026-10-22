/**
 * Promise: the three signal owner values have no default; blank or malformed refuses with its named code.
 * Break: a blank value becomes a number; a malformed rate limit is half-read.
 */
import { describe, expect, it } from 'vitest';
import { parseSignalLimits, requireSignalLimits, TradeSignalError } from './signal-config.js';

const full = { TRADE_SIGNAL_LATENCY_MAX_MS: '5000', TRADE_SIGNAL_BODY_CAP_BYTES: '2048', TRADE_SIGNAL_RATE_LIMIT: '10/60' };

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof TradeSignalError ? err.code : 'other';
  }
}

describe('signal owner values', () => {
  it('all blank -> every value null, no default', () => {
    expect(parseSignalLimits({})).toEqual({ latencyMaxMs: null, bodyCapBytes: null, rateLimit: null });
  });

  it('parses the documented shapes', () => {
    expect(requireSignalLimits(parseSignalLimits(full))).toEqual({
      latencyMaxMs: 5000,
      bodyCapBytes: 2048,
      rateLimit: { count: 10, windowSeconds: 60 },
    });
  });

  it.each([
    ['TRADE_SIGNAL_LATENCY_MAX_MS', 'trade.signal_latency_unset'],
    ['TRADE_SIGNAL_BODY_CAP_BYTES', 'trade.signal_body_cap_unset'],
    ['TRADE_SIGNAL_RATE_LIMIT', 'trade.signal_rate_limit_unset'],
  ] as const)('blank %s refuses %s', (key, code) => {
    expect(codeOf(() => requireSignalLimits(parseSignalLimits({ ...full, [key]: '' })))).toBe(code);
  });

  it.each(['0', '-1', '1.5', 'abc', ' ', '10/', '/60', '10/0', '10/60/1', '0/60'])('malformed value %j refuses', (bad) => {
    const limits = parseSignalLimits({ ...full, TRADE_SIGNAL_LATENCY_MAX_MS: bad, TRADE_SIGNAL_RATE_LIMIT: bad });
    expect(limits.latencyMaxMs).toBeNull();
    expect(limits.rateLimit).toBeNull();
  });
});
