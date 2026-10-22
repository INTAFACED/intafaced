/**
 * SP-conditional-algo-03 (J-cex-spot-09 step 1, backend): the owner minimum iceberg
 * display ratio. Below it refuses `trade.iceberg_display_invalid`; a blank ratio
 * refuses every iceberg `trade.iceberg_display_rule_unset`; a malformed ratio fails boot.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Market } from './types.js';
import { READY_MARKET_LIFECYCLE } from './testing.js';
import { attachIcebergDisplay, TRADE_ICEBERG_DISPLAY_INVALID } from './iceberg-door.js';
import { parseIcebergDisplayRule, TRADE_ICEBERG_DISPLAY_RULE_UNSET } from './iceberg-display-rule.js';

const market = { id: '33333333-3333-4333-8333-333333333333', symbol: 'BTC/USDT', lotSize: parseAmount('0.1') } as Market;
const base = {
  symbol: 'BTC/USDT',
  side: 'buy' as const,
  type: 'limit' as const,
  qty: parseAmount('10'),
  price: parseAmount('100'),
  clientOrderId: 'ice-ratio',
};
const parsed = { type: 'limit', symbol: 'BTC/USDT' };

function deps(raw: string) {
  return {
    marketBySymbol: async () => market,
    lifecycleForMarket: async () => READY_MARKET_LIFECYCLE.snapshot(market),
    icebergDisplayRule: parseIcebergDisplayRule(raw),
  };
}

describe('iceberg owner minimum display ratio (SP-conditional-algo-03)', () => {
  it('ratio 1/15: display 0.5 of 10 is refused, 1 of 10 is accepted', async () => {
    await expect(attachIcebergDisplay(deps('1/15'), base, parsed, '0.5')).rejects.toMatchObject({
      code: TRADE_ICEBERG_DISPLAY_INVALID,
    });
    const ok = await attachIcebergDisplay(deps('1/15'), base, parsed, '1');
    expect(ok.displayQty).toBe('1');
    expect(formatAmount((ok.input as unknown as { displayQty: bigint }).displayQty)).toBe('1');
  });

  it('exactly at the ratio is accepted (2/10 of 10 = 2)', async () => {
    expect((await attachIcebergDisplay(deps('2/10'), base, parsed, '2')).displayQty).toBe('2');
    await expect(attachIcebergDisplay(deps('2/10'), base, parsed, '1.9')).rejects.toMatchObject({
      code: TRADE_ICEBERG_DISPLAY_INVALID,
    });
  });

  it('a blank ratio refuses every iceberg with trade.iceberg_display_rule_unset', async () => {
    for (const raw of ['', '   ']) {
      await expect(attachIcebergDisplay(deps(raw), base, parsed, '5')).rejects.toMatchObject({
        code: TRADE_ICEBERG_DISPLAY_RULE_UNSET,
      });
    }
  });

  it('deps with icebergDisplayRule null refuses every iceberg (required dep, fail closed)', async () => {
    const nullDeps = {
      marketBySymbol: async () => market,
      lifecycleForMarket: async () => READY_MARKET_LIFECYCLE.snapshot(market),
      icebergDisplayRule: null,
    };
    await expect(attachIcebergDisplay(nullDeps, base, parsed, '5')).rejects.toMatchObject({
      code: TRADE_ICEBERG_DISPLAY_RULE_UNSET,
    });
  });

  it('an order with no displayQty is not an iceberg and is not touched by the ratio', async () => {
    const out = await attachIcebergDisplay(deps(''), base, parsed, undefined);
    expect(out.displayQty).toBeNull();
  });

  it('a malformed ratio throws at parse time (boot fails)', () => {
    for (const raw of ['0.1', '1/0', '0/15', '15/15', '16/15', 'abc', '1/15/2', '-1/15']) {
      expect(() => parseIcebergDisplayRule(raw)).toThrow(/TRADE_ICEBERG_MIN_DISPLAY_RATIO/);
    }
    expect(parseIcebergDisplayRule(' 1/15 ')).toEqual({ numerator: 1n, denominator: 15n });
  });

  it('production wires the owner ratio from env into the order door', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(index).toMatch(/icebergDisplayRule: env\.TRADE_ICEBERG_MIN_DISPLAY_RATIO,/);
    const envSrc = readFileSync(new URL('../env.ts', import.meta.url), 'utf8');
    expect(envSrc).toMatch(/TRADE_ICEBERG_MIN_DISPLAY_RATIO: z\.string\(\)\.default\(''\)\.transform\(parseIcebergDisplayRule\)/);
  });
});
