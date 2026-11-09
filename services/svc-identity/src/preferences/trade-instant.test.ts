import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { Context } from '@intafaced/contracts';
import { TRADE_INSTANT_AGREEMENT, tradeInstantRequestId } from '@intafaced/contracts/trade-instant-preferences';
import { setPreferences } from './preferences.js';
import { TRADE_INSTANT_NAMESPACE, parseTradeInstant } from './trade-instant.js';

const context = { principal: { userId: 'U-1' }, service: null } as unknown as Context;
/** Anything that reaches the database fails the test: these paths must refuse first. */
const noDatabase = new Proxy(() => undefined, {
  apply() {
    throw new Error('the database was reached');
  },
}) as unknown as Sql;
const AT = '2026-11-09T01:02:03.456Z';

describe('trade.instant value (J-charts-desk-14 #6)', () => {
  it('keeps on with the agreement and its time, and off with neither', () => {
    const on = { on: true, agreement: TRADE_INSTANT_AGREEMENT, agreedAt: AT };
    expect(parseTradeInstant(on)).toEqual(on);
    const off = { on: false, agreement: null, agreedAt: null };
    expect(parseTradeInstant(off)).toEqual(off);
  });

  it('refuses on without an agreement or a time, an old agreement, off that keeps one, a bad time and extra fields', () => {
    for (const bad of [
      { on: true, agreement: null, agreedAt: AT },
      { on: true, agreement: TRADE_INSTANT_AGREEMENT, agreedAt: null },
      { on: true, agreement: 'instant-placement-v0', agreedAt: AT },
      { on: true, agreement: TRADE_INSTANT_AGREEMENT },
      { on: false, agreement: TRADE_INSTANT_AGREEMENT, agreedAt: AT },
      { on: false, agreement: null, agreedAt: AT },
      { on: true, agreement: TRADE_INSTANT_AGREEMENT, agreedAt: '2026-11-09' },
      { on: true, agreement: TRADE_INSTANT_AGREEMENT, agreedAt: '2026-02-30T00:00:00.000Z' },
      { on: true, agreement: TRADE_INSTANT_AGREEMENT, agreedAt: AT, skipChecks: true },
      { on: 'yes', agreement: TRADE_INSTANT_AGREEMENT, agreedAt: AT },
      true,
      null,
    ]) {
      expect(() => parseTradeInstant(bad), JSON.stringify(bad)).toThrow('identity.preferences_value_invalid');
    }
  });

  it('checks a trade.instant write before it touches the database', async () => {
    const input = { namespace: TRADE_INSTANT_NAMESPACE, ifVersion: 0, clientRequestId: 'trade-instant:u-1:0:off' };
    await expect(
      setPreferences(noDatabase, context, { ...input, value: { on: true, agreement: null, agreedAt: null } }),
    ).rejects.toMatchObject({ code: 'identity.preferences_value_invalid' });
  });

  it('names one write by person, version and value, never at random', () => {
    const on = { on: true as const, agreement: TRADE_INSTANT_AGREEMENT, agreedAt: AT };
    const off = { on: false as const, agreement: null, agreedAt: null };
    expect(tradeInstantRequestId('U-1', 3, on)).toBe(`trade-instant:u-1:3:on:${AT}`);
    expect(tradeInstantRequestId('U-1', 3, on)).toBe(tradeInstantRequestId('u-1', 3, on));
    expect(tradeInstantRequestId('U-1', 4, off)).toBe('trade-instant:u-1:4:off');
    expect(tradeInstantRequestId('U-1', 3, on).length).toBeLessThanOrEqual(200);
  });
});
