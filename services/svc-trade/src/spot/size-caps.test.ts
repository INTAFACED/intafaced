import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { futuresSizeOverPublishedMax, spotCapRefusal } from './size-caps.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('spot size caps (TRD-0001, TRD-0002)', () => {
  const over = { side: 'buy' as const, type: 'limit', price: parseAmount('2'), qty: parseAmount('2') };

  it('given TRADE_MAX_ORDER 3, a spot limit buy notional above 3 is refused', () => {
    expect(spotCapRefusal(over, '3')).toMatchObject({ code: 'trade.max_order_exceeded' });
    expect(spotCapRefusal({ ...over, price: parseAmount('1'), qty: parseAmount('3') }, '3')).toBeNull();
  });

  it('the refusal is thrown before the original place, so no hold is posted', () => {
    const src = readFileSync(join(here, 'size-caps.ts'), 'utf8');
    const hitch = src.slice(src.indexOf('export function installSpotSizeCaps'));
    const check = hitch.indexOf('spotCapRefusal');
    const call = hitch.indexOf('origPlace.call');
    expect(check).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(check);
    const boot = readFileSync(join(here, '..', 'ledger-client.ts'), 'utf8');
    expect(boot.indexOf('installSpotSizeCaps')).toBeGreaterThan(boot.indexOf('installPreTradeCredit'));
  });

  it('a retry is the same refusal and does not become a second order', () => {
    expect(spotCapRefusal(over, '3')?.code).toBe(spotCapRefusal(over, '3')?.code);
    expect(spotCapRefusal(over, '3')?.code).toBe('trade.max_order_exceeded');
  });

  it('a reduce-only order over the cap is not refused for the cap', () => {
    expect(spotCapRefusal({ ...over, side: 'sell', reduceOnly: true }, '3')).toBeNull();
    expect(spotCapRefusal({ ...over, reduceOnly: false }, '3')?.code).toBe('trade.max_order_exceeded');
  });

  it('an unset cap is not given a number here', () => {
    expect(spotCapRefusal(over, undefined)).toBeNull();
    expect(spotCapRefusal(over, '')).toBeNull();
    expect(spotCapRefusal(over, 'nope')).toBeNull();
  });
});

describe('futures published max order (TRD-0246)', () => {
  it('a published 0 refuses a positive futures size, and exactly the cap is allowed', () => {
    expect(futuresSizeOverPublishedMax(parseAmount('1'), 0)).toBe(true);
    expect(futuresSizeOverPublishedMax(parseAmount('4'), 3)).toBe(true);
    expect(futuresSizeOverPublishedMax(parseAmount('3'), 3)).toBe(false);
  });

  it('the futures open hitch compares size before the original open', () => {
    const src = readFileSync(join(here, '..', 'futures', 'pretrade-credit.ts'), 'utf8');
    const openStart = src.indexOf('export function installPreTradeCreditOpen');
    const openFn = src.slice(openStart);
    const compare = openFn.indexOf('futuresSizeOverPublishedMax');
    const call = openFn.indexOf('origOpen.call');
    expect(compare).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(compare);
  });
});
