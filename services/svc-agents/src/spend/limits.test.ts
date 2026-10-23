import { describe, expect, it } from 'vitest';
import { AgentError } from '../errors.js';
import { decideReservation, parseSpendLimitInput, periodStart } from './limits.js';

const LIMIT = {
  assetId: 'IFC',
  perCall: '1.50',
  perSession: '3',
  perPeriod: '10',
  period: 'day',
  idempotencyKey: 'set-1',
};

describe('parseSpendLimitInput', () => {
  it('refuses a blank cap, asset, or period and does not invent one', () => {
    for (const field of ['perCall', 'perSession', 'perPeriod', 'assetId', 'period'] as const) {
      expect(() => parseSpendLimitInput({ ...LIMIT, [field]: '  ' })).toThrow(AgentError);
      try {
        parseSpendLimitInput({ ...LIMIT, [field]: null });
      } catch (err) {
        expect(err).toBeInstanceOf(AgentError);
        expect((err as AgentError).code).toBe('agents.spend_limit_unset');
      }
    }
  });

  it('refuses a negative amount, a junk amount, and an unknown period', () => {
    expect(() => parseSpendLimitInput({ ...LIMIT, perCall: '-1' })).toThrow(
      expect.objectContaining({ code: 'agents.spend_limit_invalid' }),
    );
    expect(() => parseSpendLimitInput({ ...LIMIT, perSession: '1e2' })).toThrow(
      expect.objectContaining({ code: 'agents.spend_limit_invalid' }),
    );
    expect(() => parseSpendLimitInput({ ...LIMIT, period: 'year' })).toThrow(
      expect.objectContaining({ code: 'agents.spend_limit_invalid' }),
    );
  });

  it('keeps an explicit zero and a decimal string as scaled bigint', () => {
    const parsed = parseSpendLimitInput({ ...LIMIT, perCall: '0', perSession: '0.5', perPeriod: '2.0' });
    expect(parsed.perCall).toBe(0n);
    expect(typeof parsed.perSession).toBe('bigint');
    expect(parsed.perPeriod).toBe(2n * 10n ** 18n);
    expect(parsed.period).toBe('day');
  });
});

describe('periodStart', () => {
  it('uses UTC day, Monday week, and calendar month — no invented zone', () => {
    const friday = new Date('2026-10-23T15:04:00Z');
    expect(periodStart('day', friday).toISOString()).toBe('2026-10-23T00:00:00.000Z');
    expect(periodStart('week', friday).toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(periodStart('month', friday).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(periodStart('week', new Date('2026-10-18T23:00:00Z')).toISOString()).toBe('2026-10-12T00:00:00.000Z');
  });
});

describe('decideReservation', () => {
  const cap = { perCall: 10n, perSession: 15n, perPeriod: 20n, sessionUsed: 0n, periodUsed: 0n };

  it('allows a call that lands on each cap', () => {
    expect(decideReservation({ ...cap, amount: 10n })).toEqual({ ok: true });
    expect(decideReservation({ ...cap, sessionUsed: 5n, amount: 10n })).toEqual({ ok: true });
    expect(decideReservation({ ...cap, periodUsed: 10n, amount: 10n })).toEqual({ ok: true });
  });

  it('names the cap that would be exceeded', () => {
    expect(decideReservation({ ...cap, amount: 11n })).toEqual({ ok: false, scope: 'call', cap: 10n });
    expect(decideReservation({ ...cap, sessionUsed: 6n, amount: 10n })).toEqual({ ok: false, scope: 'session', cap: 15n });
    expect(decideReservation({ ...cap, periodUsed: 11n, amount: 10n })).toEqual({ ok: false, scope: 'period', cap: 20n });
  });
});
