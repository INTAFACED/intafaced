/**
 * A listed lead's web orders with the lead switch (J-copy-bots-otc-04 #5 to #7; CB-copy-14, CB-copy-16): the decision
 * before the order is placed, with every refusal by its own code and nothing written on a refusal. TEST figures only.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { parseAmount } from '@intafaced/ledger-client/money';
import { principalFor } from '../spot/testing.js';
import { CopyError } from './errors.js';
import type { LeadVenueRead } from './lead-applications.js';
import { LeadTrading, parseLeadDailyBuyCap, parseLeadPairHolding, type LeadOrderAsk, type LeadTradingDeps } from './lead-trading.js';

const LEAD = '11111111-1111-4111-8111-111111111111';
const lead = principalFor(LEAD, ['trade:read', 'trade:write']);

/** A fake of the two sums `decide` reads and the one insert `record` writes; what they count is lead-trading.pg.test.ts's. */
function fakeSql(sums: { held?: { buys: string | null; sells: string | null }; bought?: string | null } = {}) {
  const writes: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    // `sql([...])` (a list helper inside a query) is not a query of its own.
    if (!('raw' in strings)) return strings;
    const text = strings.join('?');
    if (text.includes('INSERT INTO trade.copy_lead_orders')) {
      writes.push(values);
      return Promise.resolve([]);
    }
    if (text.includes('AS buys')) return Promise.resolve([sums.held ?? { buys: null, sells: null }]);
    if (text.includes('AS bought')) return Promise.resolve([{ bought: sums.bought ?? null }]);
    throw new Error(`unexpected query: ${text}`);
  }) as Sql;
  return { sql, writes };
}

const RICH: LeadVenueRead = { state: 'read', owner: '0xabc', test: true, usdc: parseAmount('3000'), asOf: new Date(0) };

function desk(over: Partial<LeadTradingDeps> = {}, sums?: Parameters<typeof fakeSql>[0]) {
  const { sql, writes } = fakeSql(sums);
  const trading = new LeadTrading({
    sql,
    now: () => new Date('2026-11-18T10:00:00.000Z'),
    listing: async () => ({ state: 'listed', assets: ['BTC/USDT'] }),
    minVenueUsdc: parseAmount('1000'),
    venueUsdc: async () => RICH,
    limits: { dailyBuyCap: parseAmount('500'), pairHolding: new Map([['BTC/USDT', parseAmount('5000')]]) },
    ownerDay: { published: true, offsetMinutes: 0 },
    ...over,
  });
  return { trading, writes };
}

const ask = (over: Partial<LeadOrderAsk> = {}): LeadOrderAsk => ({
  orderId: '22222222-2222-4222-8222-222222222222',
  symbol: 'BTC/USDT',
  side: 'buy',
  price: parseAmount('1000'),
  amount: parseAmount('0.1'),
  iceberg: false,
  lead: true,
  ...over,
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CopyError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('a lead order with the switch', () => {
  it('is a lead trade inside the instruments, the equity minimum, the holding limit and the daily buy cap', async () => {
    expect(await desk().trading.decide(lead, ask())).toEqual({ lead: true, reason: null });
  });

  it('an iceberg is never a lead trade, whatever the switch says, and no lead limit is read', async () => {
    const { trading } = desk({ limits: { dailyBuyCap: null, pairHolding: null } });
    expect(await trading.decide(lead, ask({ iceberg: true, lead: true }))).toEqual({ lead: false, reason: 'iceberg' });
  });

  it('the switch off is not a lead trade', async () => {
    expect(await desk().trading.decide(lead, ask({ lead: false }))).toEqual({ lead: false, reason: 'switched_off' });
  });

  it('someone not listed: no switch is an ordinary order; the switch on refuses by name', async () => {
    const { trading } = desk({ listing: async () => null });
    expect(await trading.decide(lead, ask({ lead: false }))).toBeNull();
    expect(await codeOf(trading.decide(lead, ask()))).toBe('trade.copy_lead_not_listed');
    const suspended = desk({ listing: async () => ({ state: 'suspended', assets: ['BTC/USDT'] }) }).trading;
    expect(await codeOf(suspended.decide(lead, ask()))).toBe('trade.copy_lead_not_listed');
  });

  it('a blank leading instrument list refuses naming the list; a pair not on it refuses by name', async () => {
    const blank = desk({ listing: async () => ({ state: 'listed', assets: [] }) }).trading;
    const err = await blank.decide(lead, ask()).catch((e: CopyError) => e);
    expect(err).toBeInstanceOf(CopyError);
    expect((err as CopyError).code).toBe('trade.copy_leader_instruments_not_set');
    expect((err as CopyError).message).toMatch(/leading instrument list/);
    expect(await codeOf(desk().trading.decide(lead, ask({ symbol: 'ETH/USDT' })))).toBe('trade.copy_lead_instrument_unlisted');
  });

  it('a market lead order refuses: it has no price to count against the limits', async () => {
    expect(await codeOf(desk().trading.decide(lead, ask({ price: null })))).toBe('trade.copy_lead_price_required');
  });

  it('the equity minimum: blank refuses as unset, under it refuses, an unreadable or missing venue account refuses', async () => {
    expect(await codeOf(desk({ minVenueUsdc: null }).trading.decide(lead, ask()))).toBe('trade.copy_leader_limit_not_set');
    expect(await codeOf(desk({ minVenueUsdc: parseAmount('3000.01') }).trading.decide(lead, ask()))).toBe(
      'trade.copy_leader_equity_below_min',
    );
    // At exactly the minimum, the lead may trade.
    expect(await desk({ minVenueUsdc: parseAmount('3000') }).trading.decide(lead, ask())).toEqual({ lead: true, reason: null });
    const down = desk({
      venueUsdc: async () => {
        throw new Error('venue down');
      },
    }).trading;
    expect(await codeOf(down.decide(lead, ask()))).toBe('trade.copy_lead_venue_unreadable');
    expect(await codeOf(desk({ venueUsdc: async () => ({ state: 'none' }) }).trading.decide(lead, ask()))).toBe(
      'trade.copy_lead_venue_account_missing',
    );
  });

  it('a pair without a holding limit refuses, as does a blank limit table; a buy over the holding refuses', async () => {
    const other = desk({ listing: async () => ({ state: 'listed', assets: ['BTC/USDT', 'ETH/USDT'] }) }).trading;
    expect(await codeOf(other.decide(lead, ask({ symbol: 'ETH/USDT' })))).toBe('trade.copy_pair_limit_not_set');
    expect(await codeOf(desk({ limits: { dailyBuyCap: parseAmount('500'), pairHolding: null } }).trading.decide(lead, ask()))).toBe(
      'trade.copy_pair_limit_not_set',
    );
    // Held 4950 in lead buys less 0 sold; a 100 buy takes it to 5050, over 5000.
    expect(await codeOf(desk({}, { held: { buys: '4950', sells: null } }).trading.decide(lead, ask()))).toBe(
      'trade.copy_pair_holding_limit',
    );
    // Sells count down: 4950 bought, 100 sold, so a 100 buy holds 4950.
    expect(await desk({}, { held: { buys: '4950', sells: '100' } }).trading.decide(lead, ask())).toEqual({ lead: true, reason: null });
  });

  it('the daily buy cap: blank refuses as unset; a buy that would pass it refuses; a sell is not a buy', async () => {
    expect(
      await codeOf(
        desk({ limits: { dailyBuyCap: null, pairHolding: new Map([['BTC/USDT', parseAmount('5000')]]) } }).trading.decide(lead, ask()),
      ),
    ).toBe('trade.copy_leader_limit_not_set');
    // 450 bought today; this buy of 100 makes 550, over 500.
    expect(await codeOf(desk({}, { bought: '450' }).trading.decide(lead, ask()))).toBe('trade.copy_daily_buy_cap');
    expect(await desk({}, { bought: '400' }).trading.decide(lead, ask())).toEqual({ lead: true, reason: null });
    expect(await desk({}, { bought: '450' }).trading.decide(lead, ask({ side: 'sell' }))).toEqual({ lead: true, reason: null });
    // No owner day: the cap can't be counted.
    expect(await codeOf(desk({ ownerDay: { published: false } }).trading.decide(lead, ask()))).toBe('trade.copy_day_not_set');
  });

  it('records the decision under the order id, the not-lead reason with it', async () => {
    const { trading, writes } = desk();
    await trading.record(lead, ask({ lead: false }), { lead: false, reason: 'switched_off' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual([
      '22222222-2222-4222-8222-222222222222',
      LEAD,
      'BTC/USDT',
      'buy',
      '100',
      false,
      'switched_off',
      '2026-11-18T10:00:00.000Z',
    ]);
  });
});

describe('the owner values', () => {
  it('blank is unset; a decimal above zero is the value; anything else throws', () => {
    expect(parseLeadDailyBuyCap('')).toBeNull();
    expect(parseLeadDailyBuyCap(' 500 ')).toBe(parseAmount('500'));
    expect(() => parseLeadDailyBuyCap('0')).toThrow();
    expect(() => parseLeadDailyBuyCap('lots')).toThrow();
    expect(parseLeadPairHolding('')).toBeNull();
    expect(parseLeadPairHolding('{"BTC/USDT":"5000"}')?.get('BTC/USDT')).toBe(parseAmount('5000'));
    expect(() => parseLeadPairHolding('{"BTC/USDT":5000}')).toThrow();
    expect(() => parseLeadPairHolding('{"btc":"5000"}')).toThrow();
    expect(() => parseLeadPairHolding('[1]')).toThrow();
  });
});
