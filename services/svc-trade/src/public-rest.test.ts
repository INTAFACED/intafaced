import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { exchangeErrorSchema, marketSchema, ohlcvSchema, orderBookSchema, tickerSchema, tradeSchema } from '@intafaced/exchange-contract';
import { parseAmount } from '@intafaced/ledger-client';
import {
  bpsToRate,
  decimalPlaces,
  fakeMarket,
  fakePrint,
  presentCcxtMarket,
  presentOrderBook,
  presentPublicTrade,
  presentTicker,
  registerPublicRest,
  OPEN_POSITION_GATES_NOTE,
  type PublicRestDeps,
} from './public-rest.js';
import { MatchingNoBookError, MatchingUnavailableError } from './spot/matching-client.js';
import type { TickerStats24h } from './spot/ticker-stats.js';
import { markSourceFromBook } from './futures/mark-source.js';

describe('bpsToRate / decimalPlaces', () => {
  it('converts integer bps to a decimal rate string', () => {
    expect(bpsToRate(10)).toBe('0.001');
    expect(bpsToRate(20)).toBe('0.002');
    expect(bpsToRate(100)).toBe('0.01');
    expect(bpsToRate(0)).toBe('0');
    expect(bpsToRate(1)).toBe('0.0001');
  });

  it('counts significant fractional places', () => {
    expect(decimalPlaces('0.01')).toBe(2);
    expect(decimalPlaces('0.0001')).toBe(4);
    expect(decimalPlaces('1')).toBe(0);
    expect(decimalPlaces('0.0100')).toBe(2);
  });
});

describe('presenters', () => {
  it('presents a market that validates against the CCXT market schema', () => {
    const wire = presentCcxtMarket(
      fakeMarket({
        symbol: 'BTC/USDT',
        tickSize: parseAmount('0.01'),
        lotSize: parseAmount('0.0001'),
        makerBps: 10,
        takerBps: 20,
      }),
    );
    expect(marketSchema.safeParse(wire).success).toBe(true);
    expect(wire.maker).toBe('0.001');
    expect(wire.taker).toBe('0.002');
    // Precision is the tick and the lot themselves, not a count of places.
    expect(wire.precisionMode).toBe('TICK_SIZE');
    expect(wire.precision.price).toBe('0.01');
    expect(wire.precision.amount).toBe('0.0001');
    expect(wire.limits.amount.min).toBe('0.0001');
    // Money fields are decimal strings, never numbers.
    expect(typeof wire.maker).toBe('string');
    expect(typeof wire.limits.cost.min).toBe('string');
  });

  /**
   * A bot must be able to tell a simulated market from a real one.
   *
   * `markets(limit)` still includes paper rows in the published page, so a paper market
   * already appears in `fetchMarkets` as an ordinary `active: true` spot
   * market — and `placeOrder` then routes it to the paper path, taking no hold
   * and posting nothing to the ledger, while returning a 201 that looks like
   * any other order. Without this field a bot books a position it does not
   * have and has no way to find out.
   */
  it('says out loud when a market is simulated', () => {
    const real = presentCcxtMarket(fakeMarket({ symbol: 'BTC/USDT' }));
    expect(real.paper).toBe(false);
    expect(real.limits.leverage.max).toBeNull();
    // Still a valid CCXT market — the extra field must not break the schema.
    expect(marketSchema.safeParse(real).success).toBe(true);

    const sim = presentCcxtMarket(fakeMarket({ symbol: 'BTC/USDT', paper: true }));
    expect(sim.paper).toBe(true);
    expect(marketSchema.safeParse(sim).success).toBe(true);
    // Not disguised as inactive — it IS tradable, just not for real money.
    expect(sim.active).toBe(true);
    expect(sim.orderable).toBe(true);
  });

  it('listed futures stay active and are not orderable until the host enables futures', () => {
    const perp = presentCcxtMarket(fakeMarket({ symbol: 'BTC/USDT-PERP', kind: 'futures' }));
    expect(perp.active).toBe(true);
    expect(perp.swap).toBe(true);
    expect(perp.orderable).toBe(false);
    expect(perp.settle).toBeNull();
    expect(perp.linear).toBeNull();
    expect(perp.inverse).toBeNull();
    expect(perp.limits.leverage.max).toBeNull();
    expect(perp.limits.leverage.min).toBeNull();
    expect(marketSchema.safeParse(perp).success).toBe(true);

    const live = presentCcxtMarket(fakeMarket({ symbol: 'BTC/USDT-PERP', kind: 'futures' }), Date.now(), {
      futuresOrderable: true,
      futuresMaxLeverage: '4.25',
    });
    expect(live.orderable).toBe(true);
    expect(live.limits.leverage.max).toBe('4.25');

    const halted = presentCcxtMarket(fakeMarket({ symbol: 'BTC/USDT-PERP', kind: 'futures', status: 'halted' }), Date.now(), {
      futuresOrderable: true,
      futuresMaxLeverage: '4.25',
    });
    expect(halted.active).toBe(false);
    expect(halted.orderable).toBe(false);

    const opt = presentCcxtMarket(fakeMarket({ symbol: 'BTC/USDT-OPT', kind: 'options' }), Date.now(), {
      futuresOrderable: true,
    });
    expect(opt.orderable).toBe(false);
  });

  /**
   * A bot must tell "venue shut" from "exchange down" / empty book.
   *
   * `active` is listing status (operator halted / not launched). Session hours
   * are a different question: EUR/USD is permanently listed and shut every
   * weekend. Without `sessionOpen` + `hours` on the wire, a bot only sees an
   * empty book or a `trade.market_closed` after it already tried to order.
   * Same predicates as `assertMarketOpen` — never invent a second calendar.
   */
  it('publishes schedule hours and sessionOpen from the same table as the order path', () => {
    // Crypto is continuous — always open, no next flip.
    const btc = presentCcxtMarket(fakeMarket({ symbol: 'BTC/USDT' }), Date.parse('2026-01-10T12:00:00Z'));
    expect(btc.schedule).toBe('crypto-24x7');
    expect(btc.sessionOpen).toBe(true);
    expect(btc.nextSessionChange).toBeNull();
    expect(btc.hours).toEqual({ kind: 'continuous' });
    expect(marketSchema.safeParse(btc).success).toBe(true);

    // FX: Saturday UTC is closed on the interbank week (America/New_York).
    const eurusdSat = presentCcxtMarket(
      fakeMarket({
        symbol: 'EUR/USD',
        baseAsset: 'EUR',
        quoteAsset: 'USD',
        schedule: 'fx-global',
        assetClass: 'forex',
      }),
      Date.parse('2026-01-10T12:00:00Z'), // Saturday
    );
    expect(eurusdSat.active).toBe(true); // listed
    expect(eurusdSat.sessionOpen).toBe(false); // venue shut
    expect(eurusdSat.orderable).toBe(false); // FX separate — holiday/rail unpublished
    expect(eurusdSat.schedule).toBe('fx-global');
    expect(eurusdSat.hours.kind).toBe('sessions');
    if (eurusdSat.hours.kind === 'sessions') {
      expect(eurusdSat.hours.timezone).toBe('America/New_York');
      expect(eurusdSat.hours.windows.length).toBeGreaterThan(0);
      // Empty holidays named unpublished on FX degrade — never invent days.
      expect(eurusdSat.hours.holidays).toEqual([]);
    }
    expect(eurusdSat.nextSessionChange).not.toBeNull();
    expect(eurusdSat.nextSessionChange?.open).toBe(true);
    expect(marketSchema.safeParse(eurusdSat).success).toBe(true);

    // FX mid-week session windows open (Wednesday 12:00 UTC = still open NY).
    const eurusdWed = presentCcxtMarket(
      fakeMarket({
        symbol: 'EUR/USD',
        baseAsset: 'EUR',
        quoteAsset: 'USD',
        schedule: 'fx-global',
        assetClass: 'forex',
      }),
      Date.parse('2026-01-14T12:00:00Z'),
    );
    expect(eurusdWed.sessionOpen).toBe(true);
    expect(eurusdWed.orderable).toBe(false);
    expect(eurusdWed.product).toBe('fx');
    const degrade = eurusdWed.degrade;
    expect(degrade).toBeDefined();
    if (!degrade) throw new Error('fx degrade missing');
    expect(degrade.convert).toBe('refused');
    expect(degrade.holidayCalendar.published).toBe(false);
    expect(degrade.rail.socket).toBe('socket.forex-settlement');
    expect(marketSchema.safeParse(eurusdWed).success).toBe(true);
  });

  /**
   * The regression this shape exists to stop. Seven of the sixteen live
   * listings have a lot size that is not a power of ten — the six forex majors
   * at 1000 units and NATGAS/USD at 10 — and the previous decimal-places
   * report collapsed every one of them to `0`. A client rounding an amount to
   * 0 decimal places builds 1500 units of EUR/USD, which the engine must
   * reject because it enforces the lot as a multiple.
   */
  it('reports a lot size larger than one exactly, not as zero decimal places', () => {
    const eurusd = presentCcxtMarket(
      fakeMarket({
        symbol: 'EUR/USD',
        baseAsset: 'EUR',
        quoteAsset: 'USD',
        tickSize: parseAmount('0.00001'),
        lotSize: parseAmount('1000'),
        minQty: parseAmount('1000'),
        assetClass: 'forex',
        schedule: 'fx-global',
      }),
    );
    expect(marketSchema.safeParse(eurusd).success).toBe(true);
    expect(eurusd.precision.amount).toBe('1000');
    expect(eurusd.precision.price).toBe('0.00001');
    // The old report was the number 0, which reads as "whole units are fine".
    expect(eurusd.precision.amount).not.toBe(0);

    const natgas = presentCcxtMarket(
      fakeMarket({ symbol: 'NATGAS/USD', tickSize: parseAmount('0.001'), lotSize: parseAmount('10'), minQty: parseAmount('10') }),
    );
    expect(natgas.precision.amount).toBe('10');

    // A quantity built from the reported precision is a multiple of the lot —
    // the property a client actually depends on to get an order accepted.
    for (const wire of [eurusd, natgas]) {
      const lot = parseAmount(wire.precision.amount);
      expect(parseAmount(wire.limits.amount.min!) % lot).toBe(0n);
    }
  });

  it('presents depth as a CCXT order book with decimal-string levels', () => {
    const wire = presentOrderBook(
      'BTC/USDT',
      {
        bids: [
          ['100.5', '1.2'],
          ['100', '3'],
        ],
        asks: [['101', '0.5']],
        sequence: 42,
      },
      1_700_000_000_000,
    );
    expect(orderBookSchema.safeParse(wire).success).toBe(true);
    expect(wire.nonce).toBe(42);
    expect(wire.bids[0]).toEqual(['100.5', '1.2']);
    expect(typeof wire.bids[0]![0]).toBe('string');
    expect(typeof wire.bids[0]![1]).toBe('string');
  });

  it('presents a ticker with BBO + last as decimal strings', () => {
    const wire = presentTicker(
      'BTC/USDT',
      {
        bids: [['100', '2']],
        asks: [['101', '1.5']],
        sequence: 7,
      },
      fakePrint({ price: parseAmount('100.25'), qty: parseAmount('0.5'), quoteAmount: parseAmount('50.125') }),
      1_700_000_000_000,
    );
    expect(tickerSchema.safeParse(wire).success).toBe(true);
    expect(wire.bid).toBe('100');
    expect(wire.bidVolume).toBe('2');
    expect(wire.ask).toBe('101');
    expect(wire.askVolume).toBe('1.5');
    expect(wire.last).toBe('100.25');
    expect(wire.close).toBe('100.25');
    expect(typeof wire.bid).toBe('string');
    expect(typeof wire.last).toBe('string');
    // Without a stats argument the rollups stay null — never invented.
    expect(wire.high).toBeNull();
    expect(wire.baseVolume).toBeNull();
  });

  it('presents a ticker with null last when the tape is empty', () => {
    const wire = presentTicker('BTC/USDT', { bids: [], asks: [], sequence: 0 }, null, 1_700_000_000_000);
    expect(tickerSchema.safeParse(wire).success).toBe(true);
    expect(wire.bid).toBeNull();
    expect(wire.ask).toBeNull();
    expect(wire.last).toBeNull();
  });

  it('presents a public trade without user/order/fee leakage', () => {
    const wire = presentPublicTrade(
      'BTC/USDT',
      fakePrint({
        id: 'fill-taker-1',
        side: 'sell',
        price: parseAmount('99.5'),
        qty: parseAmount('0.25'),
        quoteAmount: parseAmount('24.875'),
      }),
    );
    expect(tradeSchema.safeParse(wire).success).toBe(true);
    expect(wire.id).toBe('fill-taker-1');
    expect(wire.order).toBeNull();
    expect(wire.fee).toBeNull();
    expect(wire.takerOrMaker).toBeNull();
    expect(wire.side).toBe('sell');
    expect(wire.price).toBe('99.5');
    expect(wire.amount).toBe('0.25');
    expect(wire.cost).toBe('24.875');
    expect(typeof wire.price).toBe('string');
    // No private fields on the wire object.
    expect('userId' in wire).toBe(false);
    expect('user_id' in wire).toBe(false);
  });
});

describe('public REST routes', () => {
  const market = fakeMarket({ id: 'm-btc', symbol: 'BTC/USDT' });
  const print = fakePrint({ id: 'tape-1', price: parseAmount('100.5'), qty: parseAmount('1'), quoteAmount: parseAmount('100.5') });

  function deps(overrides: Partial<PublicRestDeps> = {}): PublicRestDeps {
    return {
      markets: async () => [market],
      marketBySymbol: async (symbol) => (symbol === 'BTC/USDT' ? market : null),
      depth: async () => ({
        bids: [['100', '2']],
        asks: [['101', '1.5']],
        sequence: 7,
      }),
      publicTape: async () => [print],
      candles: async () => [],
      now: () => 1_700_000_000_000,
      ...overrides,
    };
  }

  async function build(d: PublicRestDeps = deps()) {
    const app = Fastify();
    registerPublicRest(app, d);
    await app.ready();
    return app;
  }

  it('GET /api/v1/time returns the public clock with no auth', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/time' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ serverTime: 1_700_000_000_000 });
    await app.close();
  });

  it('GET /api/v1/markets lists markets with no auth', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/markets?limit=50' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as unknown[];
    expect(body).toHaveLength(1);
    expect(marketSchema.safeParse(body[0]).success).toBe(true);
    expect((body[0] as { symbol: string }).symbol).toBe('BTC/USDT');
    expect((body[0] as { orderable: boolean }).orderable).toBe(true);
    await app.close();
  });

  it('GET /api/v1/markets lists futures as active but not orderable unless the host enables them', async () => {
    const perp = fakeMarket({ id: 'm-perp', symbol: 'BTC/USDT-PERP', kind: 'futures' });
    const app = await build(
      deps({
        markets: async () => [perp],
        futures: { jobsEnabled: false },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/markets?limit=50' });
    const row = res.json()[0] as { symbol: string; active: boolean; orderable: boolean };
    expect(row.symbol).toBe('BTC/USDT-PERP');
    expect(row.active).toBe(true);
    expect(row.orderable).toBe(false);
    await app.close();

    const live = await build(
      deps({
        markets: async () => [perp],
        futures: { jobsEnabled: false, orderableEnabled: true, maxLeverage: '4.25' },
      }),
    );
    const liveRow = (await live.inject({ method: 'GET', url: '/api/v1/markets?limit=50' })).json()[0] as { orderable: boolean };
    expect(liveRow.orderable).toBe(true);
    await live.close();
  });

  it('GET /api/v1/capabilities exposes matrix + refuse arms without auth', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      asOfMs: number;
      routes: Array<{ name: string; kind: string }>;
      refuseArms: Array<{ id: string; httpStatus: number }>;
      notes: {
        rateLimit: { enforcedBy: string; publicPerMinute: number; privatePerMinute: number; windowMs: number };
        algo: { createEnabled: boolean; jobsEnabled: boolean; jobsDefault: false; icebergs: 'out' };
        futures: { jobsEnabled: boolean; jobsDefault: false; orderableEnabled: boolean; orderableDefault: false };
        openPositionGates: string;
      };
    };
    expect(body.asOfMs).toBe(1_700_000_000_000);
    expect(body.routes.length).toBeGreaterThan(10);
    expect(body.routes.some((r) => r.name === 'setLeverage' && r.kind === 'supported')).toBe(true);
    expect(body.routes.some((r) => r.name === 'setLeverage' && r.kind === 'refuse')).toBe(false);
    expect(body.routes.some((r) => r.name === 'setMarginMode' && r.kind === 'refuse')).toBe(true);
    expect(body.routes.some((r) => r.name === 'setMarginMode' && r.kind === 'supported')).toBe(false);
    expect(body.refuseArms.some((a) => a.id === 'setLeverageTooHigh' && a.httpStatus === 400)).toBe(true);
    expect(body.refuseArms.some((a) => a.id === 'setLeverage' && a.httpStatus === 501)).toBe(false);
    expect(body.refuseArms.some((a) => a.id === 'setMarginMode' && a.httpStatus === 501)).toBe(true);
    expect(body.refuseArms.some((a) => a.id === 'setMarginMode' && a.httpStatus === 200)).toBe(false);
    expect(body.routes.some((r) => r.name === 'openPosition')).toBe(true);
    expect(body.routes.some((r) => r.name === 'fetchAdlDisclosure')).toBe(true);
    expect(body.refuseArms.some((a) => a.id === 'adlDisclosureRequired')).toBe(false);
    expect(body.notes.rateLimit).toEqual({
      enforcedBy: 'edge',
      publicPerMinute: 300,
      privatePerMinute: 300,
      windowMs: 60_000,
    });
    expect(body.notes.algo).toEqual({
      createEnabled: true,
      jobsEnabled: false,
      jobsDefault: false,
      icebergs: 'out',
    });
    expect(body.notes.futures).toEqual({
      orderableEnabled: false,
      orderableDefault: false,
      jobsEnabled: false,
      jobsDefault: false,
      profitSourceConfigured: false,
      profitSourceDefault: false,
      nextFundingTimestamp: 'unpublished',
      indexPrice: 'unpublished',
      ladderNumbers: 'd3_unset',
      insuranceEmptyBlocksLiveList: true,
      insuranceTargetSize: 'owner_unset',
      fundingMaxAbsRateConfigured: false,
      fundingMaxAbsRateDefault: false,
      fundingMarketCount: 0,
      venueMarkConfigured: false,
      venueMarkDefault: false,
      fundingIntervalConfigured: false,
      fundingIntervalDefault: false,
    });
    expect(body.notes.openPositionGates).toBe(OPEN_POSITION_GATES_NOTE);
    expect(body.notes.openPositionGates).toContain('leverage required 400');
    expect(body.notes.openPositionGates).toContain('unnamed profit pot 403 NotSupported');
    expect(body.notes.openPositionGates).toContain('no silent 1x');
    await app.close();
  });

  it('GET /api/v1/capabilities reports jobsEnabled when the host passes the live flag', async () => {
    const app = await build(deps({ algo: { createEnabled: true, jobsEnabled: true } }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(res.json().notes.algo).toMatchObject({ jobsEnabled: true, jobsDefault: false, icebergs: 'out' });
    await app.close();
  });

  it('GET /api/v1/capabilities reports futures jobsEnabled only when the host passes the live flag', async () => {
    const app = await build(deps({ futures: { jobsEnabled: true } }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(res.json().notes.futures).toMatchObject({ jobsEnabled: true, jobsDefault: false, orderableEnabled: false });
    await app.close();
  });

  it('GET /api/v1/capabilities reports futures orderableEnabled only when the host passes the live flag', async () => {
    const app = await build(deps({ futures: { jobsEnabled: false, orderableEnabled: true } }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(res.json().notes.futures).toMatchObject({ orderableEnabled: true, orderableDefault: false });
    await app.close();
  });

  it('GET /api/v1/capabilities reports profitSourceConfigured only when the host names a pot', async () => {
    const app = await build(deps({ futures: { jobsEnabled: false, profitSourceConfigured: true } }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(res.json().notes.futures).toMatchObject({ profitSourceConfigured: true, profitSourceDefault: false });
    await app.close();
  });

  it('GET /api/v1/capabilities reports fundingMaxAbsRateConfigured only when the host set D2', async () => {
    const app = await build(deps({ futures: { jobsEnabled: false, fundingMaxAbsRateConfigured: true } }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(res.json().notes.futures).toMatchObject({
      fundingMaxAbsRateConfigured: true,
      fundingMaxAbsRateDefault: false,
    });
    expect(JSON.stringify(res.json().notes.futures)).not.toMatch(/0\.01/);
    await app.close();
  });

  it('GET /api/v1/capabilities reports venueMarkConfigured without echoing venue id or symbols', async () => {
    const app = await build(deps({ futures: { jobsEnabled: false, venueMarkConfigured: true } }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    const futures = res.json().notes.futures as Record<string, unknown>;
    expect(futures).toMatchObject({ venueMarkConfigured: true, venueMarkDefault: false });
    expect(futures).not.toHaveProperty('venueId');
    expect(futures).not.toHaveProperty('symbols');
    expect(JSON.stringify(futures)).not.toMatch(/binance|bybit|okx|BTC\/USDT/i);
    await app.close();
  });

  it('GET /api/v1/capabilities reports fundingIntervalConfigured without echoing ms', async () => {
    const app = await build(deps({ futures: { jobsEnabled: false, fundingIntervalConfigured: true } }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    const futures = res.json().notes.futures as Record<string, unknown>;
    expect(futures).toMatchObject({ fundingIntervalConfigured: true, fundingIntervalDefault: false });
    expect(futures).not.toHaveProperty('fundingIntervalMs');
    expect(JSON.stringify(futures)).not.toMatch(/28_?800_?000|28800000/);
    await app.close();
  });

  it('GET /api/v1/orderbook/:symbol returns depth with decimal strings', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/orderbook/BTC%2FUSDT?limit=10' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(orderBookSchema.safeParse(body).success).toBe(true);
    expect(body.symbol).toBe('BTC/USDT');
    expect(body.nonce).toBe(7);
    expect(body.bids).toEqual([['100', '2']]);
    expect(body.asks).toEqual([['101', '1.5']]);
    await app.close();
  });

  it('GET /api/v1/orderbook/:symbol 404s for an unknown market', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/orderbook/NOPE%2FUSDT' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('BadSymbol');
    await app.close();
  });

  it('GET /api/v1/orderbook/:symbol 502s when the engine is unreachable', async () => {
    const app = await build(
      deps({
        depth: async () => {
          throw new MatchingUnavailableError('svc-matching down');
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/orderbook/BTC%2FUSDT?limit=50' });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('ExchangeNotAvailable');
    await app.close();
  });

  it('GET /api/v1/orderbook/:symbol 404s trade.no_book when matching holds no book', async () => {
    const app = await build(
      deps({
        depth: async () => {
          throw new MatchingNoBookError(market.id);
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/orderbook/BTC%2FUSDT?limit=50' });
    expect(res.statusCode).toBe(404);
    expect(res.json().intafacedCode).toBe('trade.no_book');
    expect(res.json().code).toBe('ExchangeError');
    expect(res.json().code).not.toBe('BadSymbol');
    await app.close();
  });

  it('GET /api/v1/orderbook/:symbol 200 empty ladder is a live empty book', async () => {
    const app = await build(
      deps({
        depth: async () => ({ bids: [], asks: [], sequence: 9 }),
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/orderbook/BTC%2FUSDT?limit=50' });
    expect(res.statusCode).toBe(200);
    expect(res.json().bids).toEqual([]);
    expect(res.json().asks).toEqual([]);
    expect(res.json().nonce).toBe(9);
    await app.close();
  });

  it('refuses over-max depth limit (never clamp to 500)', async () => {
    let seen = 0;
    const app = await build(
      deps({
        depth: async (_id, limit) => {
          seen = limit;
          return { bids: [], asks: [], sequence: 1 };
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/orderbook/BTC%2FUSDT?limit=99999' });
    expect(res.statusCode).toBe(400);
    expect(res.json().intafacedCode).toBe('trade.orderbook_limit_unset');
    expect(seen).toBe(0);
    await app.close();
  });

  it('GET /api/v1/ticker/:symbol returns BBO + last with no auth', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/ticker/BTC%2FUSDT' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(tickerSchema.safeParse(body).success).toBe(true);
    expect(body.symbol).toBe('BTC/USDT');
    expect(body.bid).toBe('100');
    expect(body.ask).toBe('101');
    expect(body.last).toBe('100.5');
    expect(typeof body.bid).toBe('string');
    expect(typeof body.last).toBe('string');
    await app.close();
  });

  it('GET /api/v1/ticker/:symbol 404s for an unknown market', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/ticker/NOPE%2FUSDT' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('BadSymbol');
    await app.close();
  });

  it('GET /api/v1/ticker/:symbol 502s when the engine is unreachable', async () => {
    const app = await build(
      deps({
        depth: async () => {
          throw new MatchingUnavailableError('svc-matching down');
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/ticker/BTC%2FUSDT' });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('ExchangeNotAvailable');
    await app.close();
  });

  it('GET /api/v1/ticker/:symbol 404s trade.no_book when matching holds no book', async () => {
    const app = await build(
      deps({
        depth: async () => {
          throw new MatchingNoBookError(market.id);
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/ticker/BTC%2FUSDT' });
    expect(res.statusCode).toBe(404);
    expect(res.json().intafacedCode).toBe('trade.no_book');
    await app.close();
  });

  it('GET /api/v1/trades/:symbol returns public tape without user ids', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/trades/BTC%2FUSDT?limit=10' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as unknown[];
    expect(body).toHaveLength(1);
    expect(tradeSchema.safeParse(body[0]).success).toBe(true);
    const trade = body[0] as { order: null; fee: null; price: string };
    expect(trade.order).toBeNull();
    expect(trade.fee).toBeNull();
    expect(trade.price).toBe('100.5');
    expect(JSON.stringify(body)).not.toMatch(/user/i);
    await app.close();
  });

  it('GET /api/v1/trades/:symbol returns empty array when no prints exist', async () => {
    const app = await build(deps({ publicTape: async () => [] }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/trades/BTC%2FUSDT?limit=100' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('GET /api/v1/trades/:symbol 404s for an unknown market', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/trades/NOPE%2FUSDT' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('BadSymbol');
    await app.close();
  });

  it('refuses over-max trades limit (never clamp to 500)', async () => {
    let seen = 0;
    const app = await build(
      deps({
        publicTape: async (_id, limit) => {
          seen = limit;
          return [];
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/trades/BTC%2FUSDT?limit=99999' });
    expect(res.statusCode).toBe(400);
    expect(res.json().intafacedCode).toBe('trade.trades_limit_unset');
    expect(seen).toBe(0);
    await app.close();
  });

  it('GET /api/v1/trades/:symbol?since=: passes sinceMs into publicTape', async () => {
    let seenLimit = 0;
    let seenSince: number | undefined = -1;
    const app = await build(
      deps({
        publicTape: async (_id, limit, sinceMs) => {
          seenLimit = limit;
          seenSince = sinceMs;
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/trades/BTC%2FUSDT?since=1700000000000&limit=50',
    });
    expect(res.statusCode).toBe(200);
    expect(seenLimit).toBe(50);
    expect(seenSince).toBe(1_700_000_000_000);
    await app.close();
  });

  it('GET /api/v1/trades/:symbol?since=: invalid (NaN / negative) → 400 without publicTape', async () => {
    let called = false;
    const app = await build(
      deps({
        publicTape: async () => {
          called = true;
          return [];
        },
      }),
    );
    for (const since of ['nope', '-1']) {
      called = false;
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/trades/BTC%2FUSDT?since=${encodeURIComponent(since)}&limit=100`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('BadRequest');
      expect(called).toBe(false);
    }
    await app.close();
  });

  it('GET /api/v1/tickers returns a record of tickers keyed by symbol', async () => {
    const eth = fakeMarket({ id: 'm-eth', symbol: 'ETH/USDT', baseAsset: 'ETH' });
    const app = await build(
      deps({
        markets: async () => [market, eth],
        marketBySymbol: async (symbol) => (symbol === 'BTC/USDT' ? market : symbol === 'ETH/USDT' ? eth : null),
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/tickers?limit=500' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['BTC/USDT', 'ETH/USDT']);
    expect(tickerSchema.safeParse(body['BTC/USDT']).success).toBe(true);
    expect(tickerSchema.safeParse(body['ETH/USDT']).success).toBe(true);
    expect((body['BTC/USDT'] as { bid: string }).bid).toBe('100');
    expect(typeof (body['BTC/USDT'] as { last: string }).last).toBe('string');
    await app.close();
  });

  describe('24 h stats + sparkline', () => {
    const stats = (over: Partial<TickerStats24h> = {}): TickerStats24h => ({
      open: parseAmount('100'),
      high: parseAmount('110'),
      low: parseAmount('95'),
      vwap: parseAmount('102.5'),
      baseVolume: parseAmount('4'),
      quoteVolume: parseAmount('410'),
      windowStart: 1_699_913_600_000,
      sparkline: [parseAmount('100'), parseAmount('110'), parseAmount('100.5')],
      ...over,
    });

    it('GET /api/v1/tickers fills the rollups and a sparkline, from ONE stats call for all markets', async () => {
      const eth = fakeMarket({ id: 'm-eth', symbol: 'ETH/USDT' });
      const calls: Array<readonly string[]> = [];
      const app = await build(
        deps({
          markets: async () => [market, eth],
          tickerStats: async (ids) => {
            calls.push(ids);
            return new Map([
              ['m-btc', stats()],
              [
                'm-eth',
                stats({
                  open: null,
                  high: null,
                  low: null,
                  vwap: null,
                  baseVolume: null,
                  quoteVolume: null,
                  windowStart: null,
                  sparkline: [],
                }),
              ],
            ]);
          },
        }),
      );
      const res = await app.inject({ method: 'GET', url: '/api/v1/tickers?limit=500' });
      const body = res.json() as Record<string, Record<string, unknown>>;
      expect(calls).toEqual([['m-btc', 'm-eth']]);
      const btc = body['BTC/USDT']!;
      expect(tickerSchema.safeParse(btc).success).toBe(true);
      expect(btc).toMatchObject({
        open: '100',
        high: '110',
        low: '95',
        vwap: '102.5',
        baseVolume: '4',
        quoteVolume: '410',
        last: '100.5',
        change: '0.5',
        percentage: '0.5',
        windowStart: 1_699_913_600_000,
        sparkline: ['100', '110', '100.5'],
      });
      const quiet = body['ETH/USDT']!;
      expect(quiet.open).toBeNull();
      expect(quiet.change).toBeNull();
      expect(quiet.percentage).toBeNull();
      expect(quiet.windowStart).toBeNull();
      expect(quiet.sparkline).toEqual([]);
      await app.close();
    });

    it('GET /api/v1/ticker/:symbol carries the rollups and windowStart but no sparkline', async () => {
      const app = await build(deps({ tickerStats: async () => new Map([['m-btc', stats()]]) }));
      const res = await app.inject({ method: 'GET', url: '/api/v1/ticker/BTC%2FUSDT' });
      const body = res.json() as Record<string, unknown>;
      expect(body.open).toBe('100');
      expect(body.high).toBe('110');
      expect(body.windowStart).toBe(1_699_913_600_000);
      expect('sparkline' in body).toBe(false);
      await app.close();
    });

    it('a failed stats query serves null rollups instead of failing /tickers or /ticker', async () => {
      const app = await build(
        deps({
          tickerStats: async () => {
            throw new Error('stats query timed out');
          },
        }),
      );
      const all = await app.inject({ method: 'GET', url: '/api/v1/tickers?limit=500' });
      expect(all.statusCode).toBe(200);
      const row = (all.json() as Record<string, Record<string, unknown>>)['BTC/USDT']!;
      expect(row.last).toBe('100.5');
      expect(row.open).toBeNull();
      expect(row.sparkline).toEqual([]);
      const one = await app.inject({ method: 'GET', url: '/api/v1/ticker/BTC%2FUSDT' });
      expect(one.statusCode).toBe(200);
      expect((one.json() as Record<string, unknown>).open).toBeNull();
      await app.close();
    });

    it('a mount without a stats source keeps null rollups (never invented)', async () => {
      const app = await build();
      const res = await app.inject({ method: 'GET', url: '/api/v1/tickers?limit=500' });
      const row = (res.json() as Record<string, Record<string, unknown>>)['BTC/USDT']!;
      expect(row.open).toBeNull();
      expect(row.high).toBeNull();
      expect(row.sparkline).toEqual([]);
      await app.close();
    });

    it('percentage is exact and signed: 100 -> 99.72 is -0.28 %', () => {
      const wire = presentTicker(
        'BTC/USDT',
        { bids: [], asks: [], sequence: 0 },
        fakePrint({ price: parseAmount('99.72') }),
        1_700_000_000_000,
        stats(),
      );
      expect(wire.change).toBe('-0.28');
      expect(wire.percentage).toBe('-0.28');
    });
  });

  it('GET /api/v1/tickers returns empty object when no markets listed', async () => {
    const app = await build(deps({ markets: async () => [] }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/tickers?limit=500' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    await app.close();
  });

  it('GET /api/v1/tickers omits a hop-down market rather than publishing an empty BBO', async () => {
    const app = await build(
      deps({
        depth: async () => {
          throw new MatchingUnavailableError('svc-matching down');
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/tickers?limit=500' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    await app.close();
  });

  it('GET /api/v1/tickers omits matching 404 no-book rather than an empty live BBO', async () => {
    const app = await build(
      deps({
        depth: async () => {
          throw new MatchingNoBookError(market.id);
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/tickers?limit=500' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    await app.close();
  });

  it('GET /api/v1/tickers keeps a 200 empty ladder and omits only dead hops', async () => {
    const live = fakeMarket({ id: 'm-live', symbol: 'ETH/USDT', baseAsset: 'ETH' });
    const empty = fakeMarket({ id: 'm-empty', symbol: 'SOL/USDT', baseAsset: 'SOL' });
    const gone = fakeMarket({ id: 'm-gone', symbol: 'XRP/USDT', baseAsset: 'XRP' });
    const down = fakeMarket({ id: 'm-down', symbol: 'DOGE/USDT', baseAsset: 'DOGE' });
    const app = await build(
      deps({
        markets: async () => [live, empty, gone, down],
        marketBySymbol: async (symbol) => [live, empty, gone, down].find((m) => m.symbol === symbol) ?? null,
        depth: async (id) => {
          if (id === live.id)
            return { bids: [['100', '1']] as [string, string][], asks: [['101', '1']] as [string, string][], sequence: 4 };
          if (id === empty.id) return { bids: [], asks: [], sequence: 2 };
          if (id === gone.id) throw new MatchingNoBookError(id);
          throw new MatchingUnavailableError('svc-matching down');
        },
        publicTape: async () => [],
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/tickers?limit=500' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, { bid: string | null }>;
    expect(Object.keys(body).sort()).toEqual(['ETH/USDT', 'SOL/USDT']);
    expect(body['ETH/USDT']!.bid).toBe('100');
    expect(body['SOL/USDT']!.bid).toBeNull();
    expect(body['XRP/USDT']).toBeUndefined();
    expect(body['DOGE/USDT']).toBeUndefined();
    await app.close();
  });

  // ── OHLCV ────────────────────────────────────────────────────────────────

  const candle = {
    openTimeMs: 1_700_000_000_000,
    open: parseAmount('100'),
    high: parseAmount('105.5'),
    low: parseAmount('99'),
    close: parseAmount('101.25'),
    volume: parseAmount('12.5'),
  };

  it('GET /api/v1/ohlcv/:symbol serves real candles as CCXT tuples with no auth', async () => {
    const app = await build(deps({ candles: async () => [candle] }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/ohlcv/BTC%2FUSDT?timeframe=1m&limit=500' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as unknown[];
    expect(body).toHaveLength(1);
    // [timestamp, open, high, low, close, volume] — the contract's own shape.
    expect(ohlcvSchema.safeParse(body[0]).success).toBe(true);
    expect(body[0]).toEqual([1_700_000_000_000, '100', '105.5', '99', '101.25', '12.5']);
    // Every price is a decimal string. A float here would lose the ledger's 18
    // places on the way to a chart that people trade from.
    for (const field of (body[0] as unknown[]).slice(1)) expect(typeof field).toBe('string');
    await app.close();
  });

  it('GET /api/v1/ohlcv/:symbol passes timeframe, since and limit through to the aggregator', async () => {
    let seen: { tf: string; limit: number; since?: number } | null = null;
    const app = await build(
      deps({
        candles: async (_id, timeframe, limit, sinceMs) => {
          seen = { tf: timeframe, limit, since: sinceMs };
          return [];
        },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ohlcv/BTC%2FUSDT?timeframe=1h&since=1700000000000&limit=100',
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({ tf: '1h', limit: 100, since: 1_700_000_000_000 });
    await app.close();
  });

  it('GET /api/v1/ohlcv/:symbol owner-explicit 1m is published (not invented)', async () => {
    let seen: { tf: string; limit: number } | null = null;
    const app = await build(
      deps({
        candles: async (_id, timeframe, limit) => {
          seen = { tf: timeframe, limit };
          return [];
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/ohlcv/BTC%2FUSDT?timeframe=1m&limit=500' });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({ tf: '1m', limit: 500 });
    await app.close();
  });

  it('refuses over-max ohlcv limit (never clamp to 1000)', async () => {
    let called = false;
    const app = await build(
      deps({
        candles: async () => {
          called = true;
          return [];
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/ohlcv/BTC%2FUSDT?timeframe=1m&limit=99999' });
    expect(res.statusCode).toBe(400);
    expect(res.json().intafacedCode).toBe('trade.ohlcv_limit_unset');
    expect(called).toBe(false);
    await app.close();
  });

  /**
   * A market that has never traded has no candles. That is an honest empty
   * chart — and critically NOT a zero-filled series, which would put a price of
   * 0 on a chart somebody trades from.
   */
  it('GET /api/v1/ohlcv/:symbol returns empty for a market that has never traded', async () => {
    const app = await build(deps({ candles: async () => [] }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/ohlcv/BTC%2FUSDT?timeframe=1m&limit=500' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it('GET /api/v1/ohlcv/:symbol 404s BadSymbol for an unknown market', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/ohlcv/NOPE%2FUSDT' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('BadSymbol');
    await app.close();
  });

  it('GET /api/v1/ohlcv/:symbol 400s BadRequest for a bad timeframe, without aggregating', async () => {
    let called = false;
    const app = await build(
      deps({
        candles: async () => {
          called = true;
          return [];
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/ohlcv/BTC%2FUSDT?timeframe=7m' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BadRequest');
    expect(res.json().intafacedCode).toBe('trade.invalid_timeframe');
    expect(called).toBe(false);
    await app.close();
  });

  it('GET /api/v1/ohlcv/:symbol 400s for an invalid since, without aggregating', async () => {
    let called = false;
    const app = await build(
      deps({
        candles: async () => {
          called = true;
          return [];
        },
      }),
    );
    for (const since of ['nope', '-1']) {
      called = false;
      const res = await app.inject({ method: 'GET', url: `/api/v1/ohlcv/BTC%2FUSDT?timeframe=1m&since=${since}&limit=500` });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('BadRequest');
      expect(called).toBe(false);
    }
    await app.close();
  });

  // ── Funding rate ─────────────────────────────────────────────────────────

  /**
   * Declared in REST_ROUTES and previously not mounted at all, so it answered
   * Fastify's generic 404 — indistinguishable from a bad URL or a broken
   * deploy. It is now a typed refusal, and above all NOT a fabricated "0".
   */
  it('GET /api/v1/funding-rate/:symbol refuses a spot market with NotSupported, not a made-up rate', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/funding-rate/BTC%2FUSDT' });
    expect(res.statusCode).toBe(501);
    const body = res.json();
    expect(body.code).toBe('NotSupported');
    expect(body.intafacedCode).toBe('trade.funding_rate_spot_market');
    // The refusal must not carry a number a client could mistake for a rate.
    expect(body.fundingRate).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/fundingRate/);
    await app.close();
  });

  it('GET /api/v1/funding-rate/:symbol 404s BadSymbol for an unknown market', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/funding-rate/NOPE%2FUSDT' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('BadSymbol');
    await app.close();
  });

  it('GET /api/v1/funding-rate/:symbol refuses futures when no rate published (never invents 0)', async () => {
    const perp = fakeMarket({
      id: '11111111-1111-4111-8111-111111111111',
      symbol: 'BTC/USDT-PERP',
      kind: 'futures',
    });
    const app = await build(
      deps({
        marketBySymbol: async (s) => (s === perp.symbol ? perp : null),
        fundingRateForMarket: async () => null,
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/funding-rate/BTC%2FUSDT-PERP' });
    expect(res.statusCode).toBe(501);
    expect(res.json().code).toBe('NotSupported');
    expect(res.json().intafacedCode).toBe('trade.funding_rate_unavailable');
    expect(res.json().retryAfter).toBeUndefined();
    expect(JSON.stringify(res.json())).not.toMatch(/"fundingRate"/);
    await app.close();
  });

  it('GET /api/v1/funding-rate/:symbol returns published futures rate only', async () => {
    const perp = fakeMarket({
      id: '11111111-1111-4111-8111-111111111111',
      symbol: 'BTC/USDT-PERP',
      kind: 'futures',
    });
    const app = await build(
      deps({
        marketBySymbol: async (s) => (s === perp.symbol ? perp : null),
        fundingRateForMarket: async () => ({
          fundingRate: '0.0001',
          fundingTimestamp: 1_700_000_000_000,
          fundingDatetime: '2023-11-14T22:13:20.000Z',
          nextFundingTimestamp: null,
          markPrice: null,
          indexPrice: null,
        }),
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/funding-rate/BTC%2FUSDT-PERP' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.symbol).toBe('BTC/USDT-PERP');
    expect(body.fundingRate).toBe('0.0001');
    expect(body.nextFundingTimestamp).toBeNull();
    await app.close();
  });

  /**
   * D26-P1-T1a public door: public mark uses the same liquidation-gated port as
   * index.ts (`futuresJobs.markPrice` → `markPriceFromQuote`). A book that only
   * has last-trade must not appear as markPrice on the wire.
   */
  it('GET /api/v1/funding-rate/:symbol markPrice is null when the mark port only has last-trade', async () => {
    const perp = fakeMarket({
      id: '11111111-1111-4111-8111-111111111111',
      symbol: 'BTC/USDT-PERP',
      kind: 'futures',
    });
    const marks = markSourceFromBook({
      async readBook() {
        return { bestBid: null, bestAsk: null, last: '50000', observedAt: new Date() };
      },
    });
    const app = await build(
      deps({
        marketBySymbol: async (s) => (s === perp.symbol ? perp : null),
        fundingRateForMarket: async (marketId) => {
          const markPrice = await marks.markPrice({ marketId, at: new Date() });
          return {
            fundingRate: '0.0001',
            fundingTimestamp: 1_700_000_000_000,
            fundingDatetime: '2023-11-14T22:13:20.000Z',
            nextFundingTimestamp: null,
            markPrice,
            indexPrice: null,
          };
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/funding-rate/BTC%2FUSDT-PERP' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fundingRate).toBe('0.0001');
    expect(body.markPrice).toBeNull();
    await app.close();
  });

  it('GET /api/v1/funding-rate/:symbol serves mid markPrice from the same mark port', async () => {
    const perp = fakeMarket({
      id: '11111111-1111-4111-8111-111111111111',
      symbol: 'BTC/USDT-PERP',
      kind: 'futures',
    });
    const marks = markSourceFromBook({
      async readBook() {
        return { bestBid: '49900', bestAsk: '50100', last: '48000', observedAt: new Date() };
      },
    });
    const app = await build(
      deps({
        marketBySymbol: async (s) => (s === perp.symbol ? perp : null),
        fundingRateForMarket: async (marketId) => {
          const markPrice = await marks.markPrice({ marketId, at: new Date() });
          return {
            fundingRate: '0.0001',
            fundingTimestamp: 1_700_000_000_000,
            fundingDatetime: '2023-11-14T22:13:20.000Z',
            nextFundingTimestamp: null,
            markPrice,
            indexPrice: null,
          };
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/funding-rate/BTC%2FUSDT-PERP' });
    expect(res.statusCode).toBe(200);
    expect(res.json().markPrice).toBe('50000');
    await app.close();
  });

  /**
   * The whole point of the taxonomy: every failure on this surface validates
   * against `exchangeErrorSchema`, so a CCXT client can branch on the class
   * instead of pattern-matching our internal strings.
   */
  it('answers every public failure in the CCXT error shape', async () => {
    const app = await build(
      deps({
        depth: async () => {
          throw new MatchingUnavailableError('svc-matching down');
        },
      }),
    );
    for (const url of [
      '/api/v1/ticker/NOPE%2FUSDT',
      '/api/v1/orderbook/NOPE%2FUSDT',
      '/api/v1/trades/NOPE%2FUSDT',
      '/api/v1/ohlcv/NOPE%2FUSDT',
      '/api/v1/funding-rate/NOPE%2FUSDT',
      '/api/v1/ohlcv/BTC%2FUSDT?timeframe=7m',
      '/api/v1/trades/BTC%2FUSDT?since=nope',
      '/api/v1/orderbook/BTC%2FUSDT',
      '/api/v1/ticker/BTC%2FUSDT',
      '/api/v1/funding-rate/BTC%2FUSDT',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      const parsed = exchangeErrorSchema.safeParse(res.json());
      expect(parsed.success, `${url} → ${res.body}`).toBe(true);
    }
    await app.close();
  });

  it('does not invent nextFundingTimestamp from TRADE_FUTURES_FUNDING_INTERVAL_MS', () => {
    const src = readFileSync(new URL('./public-rest.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/nextFundingTimestamp:\s*quote\.nextFundingTimestamp/);
    expect(src).not.toMatch(/TRADE_FUTURES_FUNDING_INTERVAL_MS/);
    expect(src).not.toMatch(/8 \* 60 \* 60/);
    expect(src).not.toMatch(/28_?800_?000/);
  });
});
