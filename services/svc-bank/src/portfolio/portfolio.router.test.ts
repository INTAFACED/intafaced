import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt, type Balance, type LedgerClient } from '@intafaced/ledger-client';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import type { SpaceRecord } from '../spaces/space-service.js';
import { PortfolioService, httpTickerSource, type SpaceLister, type TickerSource } from './portfolio-service.js';
import type { PriceBook, TickerMap } from './valuation.js';

/**
 * `bank.portfolio.summary` through the real router and the real edge-context,
 * with a fake ledger and a fake trade client. No database, no network.
 */

const SECRET = 'a-bank-portfolio-test-edge-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-13T08:00:00Z');

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

function principal(userId: string, scopes: string[] = ['bank:read']): Principal {
  return {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes,
    tier: 'full',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed(p: Principal) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-portfolio',
  });
}

const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

const bal = (
  ownerId: string,
  assetId: string,
  kind: Balance['account']['kind'],
  amount: string,
  ownerType: Balance['account']['ownerType'] = 'user',
): Balance => ({
  account: { ownerType, ownerId, assetId, kind },
  accountId: `${ownerId}-${assetId}-${kind}`,
  amount: amt(amount),
});

/** A ledger that answers for any owner it has rows for, and records who was asked. */
function fakeLedger(rows: Balance[]) {
  const asked: Array<[string, string]> = [];
  const ledger = {
    balances: async (ownerType: string, ownerId: string) => {
      asked.push([ownerType, ownerId]);
      return rows.filter((r) => r.account.ownerType === ownerType && r.account.ownerId === ownerId);
    },
  } as unknown as Pick<LedgerClient, 'balances'>;
  return { ledger, asked };
}

function fakeTrade(
  map: Record<string, { last: string | null; open: string | null; windowStart?: number | null }>,
  extraListed: string[] = [],
) {
  let calls = 0;
  const source: TickerSource = {
    prices: async (): Promise<PriceBook> => {
      calls += 1;
      // A market is listed if it has a ticker, or is named in `extraListed` (listed but its book was unreadable).
      return { tickers: mapOf(map), listed: new Set([...Object.keys(map), ...extraListed]) };
    },
  };
  return { source, calls: () => calls };
}

const space = (id: string, userId: string, kind: SpaceRecord['kind'] = 'named', assetId = 'BTC'): SpaceRecord => ({
  id,
  userId,
  assetId,
  kind,
  name: id,
  goalTarget: null,
  lockedUntil: null,
  archivedAt: null,
});

/** A Space list that, like the real one, answers only for the user asked about. */
function fakeSpaces(all: SpaceRecord[]): SpaceLister {
  return { namedSpaces: async (userId) => all.filter((s) => s.userId === userId) };
}

const noSpaces = fakeSpaces([]);

function mapOf(map: Record<string, { last: string | null; open: string | null; windowStart?: number | null }>): TickerMap {
  return new Map(
    Object.entries(map).map(([k, v]) => [
      k,
      { last: v.last === null ? null : amt(v.last), open: v.open === null ? null : amt(v.open), windowStart: v.windowStart ?? null },
    ]),
  );
}

function callerFor(service: PortfolioService, p: Principal) {
  const bank = { portfolio: service } as unknown as BankServices;
  return createBankRouter(bank).createCaller(signed(p));
}

describe('bank.portfolio.summary', () => {
  const rows = [
    bal(ALICE, 'USDT', 'available', '1000'),
    bal(ALICE, 'BTC', 'available', '0.5'),
    bal(ALICE, 'BTC', 'hold', '0.25'),
    bal(ALICE, 'IFC', 'available', '40'),
    bal(BOB, 'USDT', 'available', '999999'),
  ];

  it("returns the signed-in user's server-computed total (labelled TEST DATA)", async () => {
    const { ledger, asked } = fakeLedger(rows);
    const trade = fakeTrade({ 'BTC/USDT': { last: '60000', open: '59000', windowStart: null } });
    const svc = new PortfolioService(ledger, noSpaces, { tickers: trade.source, now: () => NOW });

    const out = await callerFor(svc, principal(ALICE)).portfolio.summary();

    expect(out).toEqual({
      totalUsd: '46000.00', // 1000 + 0.75 x 60000
      change24hUsd: '750.00', // 0.75 x (60000 - 59000), a price move and not P&L
      cashUsd: '1000.00',
      cryptoUsd: '45000.00',
      priced: [
        { asset: 'BTC', amount: '0.75', priceUsd: '60000', valueUsd: '45000', change24hUsd: '750', pair: 'BTC/USDT' },
        { asset: 'USDT', amount: '1000', priceUsd: '1', valueUsd: '1000', change24hUsd: '0', pair: null },
      ],
      unpriced: [{ asset: 'IFC', amount: '40', reason: 'no_market' }],
      asOf: NOW.getTime(),
      windowStart: null,
    });
    expect(asked).toEqual([['user', ALICE]]);
  });

  it("only ever reads the caller's own balances: Bob's money is never in Alice's total, and no input can name another user", async () => {
    const { ledger, asked } = fakeLedger(rows);
    const svc = new PortfolioService(ledger, noSpaces, { tickers: fakeTrade({}).source, now: () => NOW });

    const bobs = await callerFor(svc, principal(BOB)).portfolio.summary();
    expect(bobs.totalUsd).toBe('999999.00');
    expect(asked).toEqual([['user', BOB]]);

    // The procedure takes no input: a smuggled owner is stripped before it can matter.
    const caller = callerFor(svc, principal(ALICE)) as unknown as {
      portfolio: { summary: (i?: unknown) => Promise<{ totalUsd: string | null }> };
    };
    const alices = await caller.portfolio.summary({ userId: BOB });
    expect(alices.totalUsd).not.toBe('999999.00');
    expect(asked[asked.length - 1]).toEqual(['user', ALICE]);
  });

  it('refuses an anonymous caller and a token without bank:read, and reads nothing', async () => {
    const { ledger, asked } = fakeLedger(rows);
    const svc = new PortfolioService(ledger, noSpaces, { tickers: fakeTrade({}).source });
    const bank = { portfolio: svc } as unknown as BankServices;

    await expect(createBankRouter(bank).createCaller(anonymous()).portfolio.summary()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(callerFor(svc, principal(ALICE, ['trade:read'])).portfolio.summary()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(asked).toEqual([]);
  });

  it('refuses SERVICE_UNAVAILABLE / bank.prices_unavailable when trade is down, with no partial total', async () => {
    const { ledger } = fakeLedger(rows);
    const down: TickerSource = {
      prices: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:4004');
      },
    };
    const svc = new PortfolioService(ledger, noSpaces, { tickers: down, now: () => NOW });

    const err = await callerFor(svc, principal(ALICE))
      .portfolio.summary()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect((err as Error).message).toContain('bank.prices_unavailable');
    // The raw network error (host, port) is not echoed to the caller.
    expect((err as Error).message).not.toContain('ECONNREFUSED');
  });

  it('refuses when no price source is wired at all, instead of valuing at zero', async () => {
    const { ledger } = fakeLedger(rows);
    const svc = new PortfolioService(ledger, noSpaces, { now: () => NOW });
    await expect(callerFor(svc, principal(ALICE)).portfolio.summary()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('answers a stablecoin-only user while trade is down, and never calls trade for them', async () => {
    const { ledger } = fakeLedger([bal(ALICE, 'USDC', 'available', '12.34'), bal(ALICE, 'USD', 'hold', '0.66')]);
    const trade = fakeTrade({});
    const svc = new PortfolioService(ledger, noSpaces, { tickers: trade.source, now: () => NOW });
    const out = await callerFor(svc, principal(ALICE)).portfolio.summary();
    expect(out).toMatchObject({ totalUsd: '13.00', cashUsd: '13.00', cryptoUsd: '0.00', change24hUsd: '0.00' });
    expect(trade.calls()).toBe(0);
  });

  it("on today's svc-trade (no 24 h stats yet) gives the total and a null change, not a guess", async () => {
    const { ledger } = fakeLedger(rows);
    const trade = fakeTrade({ 'BTC/USDT': { last: '60000', open: null } });
    const svc = new PortfolioService(ledger, noSpaces, { tickers: trade.source, now: () => NOW });
    const out = await callerFor(svc, principal(ALICE)).portfolio.summary();
    expect(out.totalUsd).toBe('46000.00');
    expect(out.change24hUsd).toBeNull();
    expect(out.priced.find((r) => r.asset === 'BTC')!.change24hUsd).toBeNull();
  });

  it('an empty ledger is an honest $0.00', async () => {
    const { ledger } = fakeLedger([]);
    const svc = new PortfolioService(ledger, noSpaces, { tickers: fakeTrade({}).source, now: () => NOW });
    const out = await callerFor(svc, principal(ALICE)).portfolio.summary();
    expect(out).toMatchObject({ totalUsd: '0.00', change24hUsd: '0.00', priced: [], unpriced: [] });
  });
});

describe('httpTickerSource, the cross-service call to svc-trade', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const COPY = "Prices can't be loaded right now, so your total can't be shown. Try again in a minute.";

  /** Routes by path, like svc-trade does. */
  const trade = (tickers: () => Response | Promise<Response>, markets: () => Response | Promise<Response>, urls: string[] = []) =>
    (async (u: string) => {
      urls.push(u);
      return u.includes('/api/v1/tickers') ? tickers() : markets();
    }) as unknown as typeof fetch;

  it('reads /api/v1/tickers and /api/v1/markets (limit 500) and parses prices and the listed set', async () => {
    const urls: string[] = [];
    const src = httpTickerSource({
      baseUrl: 'http://trade.test/',
      fetchImpl: trade(
        () =>
          json({
            'BTC/USDT': { symbol: 'BTC/USDT', last: '60000.5', open: '59000', windowStart: 1_700_000_000_000, sparkline: ['1'] },
            'ETH/USDT': { last: null, open: null },
            'JUNK/USDT': { last: 'abc', open: 12 },
            bad: null,
          }),
        () =>
          json([
            { symbol: 'BTC/USDT', type: 'spot', active: true },
            { symbol: 'SOL/USDT', type: 'spot', active: true },
            { symbol: 'OLD/USDT', type: 'spot', active: false },
            { symbol: 'BTC/USDT:USDT', type: 'swap', active: true },
          ]),
        urls,
      ),
    });
    const { tickers, listed } = await src.prices();
    expect(urls.sort()).toEqual(['http://trade.test/api/v1/markets?limit=500', 'http://trade.test/api/v1/tickers?limit=500']);
    expect(tickers.get('BTC/USDT')).toEqual({ last: amt('60000.5'), open: amt('59000'), windowStart: 1_700_000_000_000 });
    expect(tickers.get('ETH/USDT')).toEqual({ last: null, open: null, windowStart: null });
    expect(tickers.get('JUNK/USDT')).toEqual({ last: null, open: null, windowStart: null });
    expect(tickers.has('bad')).toBe(false);
    expect([...listed].sort()).toEqual(['BTC/USDT', 'SOL/USDT']);
  });

  it('times out on a hung svc-trade (either call) and refuses bank.prices_unavailable', async () => {
    // Markets answers; tickers never does. Only the abort signal ends it.
    const fetchImpl = (async (u: string, init: { signal: AbortSignal }) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        if (u.includes('/markets')) resolve(json([]));
      })) as unknown as typeof fetch;
    const src = httpTickerSource({ baseUrl: 'http://trade.test', fetchImpl, timeoutMs: 20 });
    await expect(src.prices()).rejects.toMatchObject({ code: 'bank.prices_unavailable', message: COPY });

    const slowMarkets = (async (u: string, init: { signal: AbortSignal }) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        if (u.includes('/tickers')) resolve(json({}));
      })) as unknown as typeof fetch;
    await expect(httpTickerSource({ baseUrl: 'http://trade.test', fetchImpl: slowMarkets, timeoutMs: 20 }).prices()).rejects.toMatchObject({
      code: 'bank.prices_unavailable',
    });
  });

  it('refuses on a 5xx from either call, a refused connection and a wrong-shaped body', async () => {
    const ok = () => json({});
    const okMarkets = () => json([]);
    const make = (impl: typeof fetch) => httpTickerSource({ baseUrl: 'http://trade.test', fetchImpl: impl });
    const refused = { code: 'bank.prices_unavailable' };
    await expect(make(trade(() => json({ error: 'x' }, 503), okMarkets)).prices()).rejects.toMatchObject(refused);
    await expect(make(trade(ok, () => json({ error: 'x' }, 502))).prices()).rejects.toMatchObject(refused);
    await expect(
      make((async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch).prices(),
    ).rejects.toMatchObject(refused);
    await expect(make(trade(() => json([1, 2]), okMarkets)).prices()).rejects.toMatchObject(refused);
    await expect(make(trade(ok, () => json({ not: 'a list' }))).prices()).rejects.toMatchObject(refused);
    await expect(make(trade(() => new Response('not json', { status: 200 }), okMarkets)).prices()).rejects.toMatchObject(refused);
  });

  it('end to end: a dead svc-trade surfaces as SERVICE_UNAVAILABLE with the user-facing sentence', async () => {
    const { ledger } = fakeLedger([bal(ALICE, 'BTC', 'available', '1')]);
    const svc = new PortfolioService(ledger, noSpaces, {
      tickers: httpTickerSource({
        baseUrl: 'http://trade.test',
        fetchImpl: (async () => {
          throw new TypeError('fetch failed');
        }) as unknown as typeof fetch,
      }),
    });
    const err = await callerFor(svc, principal(ALICE))
      .portfolio.summary()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect((err as Error).message).toContain(COPY);
    expect((err as Error).message).toContain('bank.prices_unavailable');
  });
});

describe('markets that /tickers left out: matching down refuses, a new listing is just not priced yet', () => {
  const alice = [bal(ALICE, 'USDT', 'available', '100'), bal(ALICE, 'BTC', 'available', '1'), bal(ALICE, 'NEW', 'available', '7')];
  const run = (trade: ReturnType<typeof fakeTrade>, rows = alice) =>
    callerFor(
      new PortfolioService(fakeLedger(rows).ledger, noSpaces, { tickers: trade.source, now: () => NOW }),
      principal(ALICE),
    ).portfolio.summary();

  it('refuses when markets are listed but /tickers carries none of them (svc-matching is down)', async () => {
    const err = await run(fakeTrade({}, ['BTC/USDT', 'ETH/USDT', 'NEW/USDT'])).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect((err as Error).message).toContain('bank.prices_unavailable');
  });

  it('serves the total when only one listed market is missing, and lists that coin as no_price_yet', async () => {
    const out = await run(fakeTrade({ 'BTC/USDT': { last: '60000', open: '59000' } }, ['NEW/USDT']));
    expect(out.totalUsd).toBe('60100.00');
    expect(out.change24hUsd).toBe('1000.00');
    expect(out.unpriced).toEqual([{ asset: 'NEW', amount: '7', reason: 'no_price_yet' }]);
  });

  it('a coin whose USDT market is missing but USDC market answers is priced from USDC', async () => {
    const out = await run(fakeTrade({ 'BTC/USDT': { last: '60000', open: null }, 'NEW/USDC': { last: '2', open: '2' } }, ['NEW/USDT']));
    expect(out.priced.find((r) => r.asset === 'NEW')).toMatchObject({ pair: 'NEW/USDC', valueUsd: '14' });
    expect(out.unpriced).toEqual([]);
  });

  it('a coin with no USDT or USDC market at all is unpriced with reason no_market', async () => {
    const rows = [bal(ALICE, 'USDT', 'available', '100'), bal(ALICE, 'IFC', 'available', '5'), bal(ALICE, 'EUR', 'available', '9')];
    const out = await run(fakeTrade({ 'BTC/USDT': { last: '60000', open: '59000' } }), rows);
    expect(out.totalUsd).toBe('100.00');
    expect(out.unpriced).toEqual([
      { asset: 'EUR', amount: '9', reason: 'no_market' },
      { asset: 'IFC', amount: '5', reason: 'no_market' },
    ]);
  });

  it('stable-only users never need prices, even when listed markets exist', async () => {
    const trade = fakeTrade({}, ['BTC/USDT']);
    const out = await run(trade, [bal(ALICE, 'USDT', 'available', '3')]);
    expect(out.totalUsd).toBe('3.00');
    expect(trade.calls()).toBe(0);
  });
});

describe("Spaces: everything the user owns is in the total, and nobody else's", () => {
  const rows = [
    bal(ALICE, 'USDT', 'available', '100'),
    bal(ALICE, 'BTC', 'available', '0.1'),
    // Alice's named Space "holiday" holds BTC (subaccount owner type) and some USDT; one is locked.
    bal('space-alice-1', 'BTC', 'available', '0.4', 'subaccount'),
    bal('space-alice-1', 'BTC', 'hold', '0.1', 'subaccount'),
    bal('space-alice-2', 'USDT', 'available', '50', 'subaccount'),
    // Bob's Space is large and must never leak into Alice's total.
    bal(BOB, 'USDT', 'available', '1', 'user'),
    bal('space-bob-1', 'BTC', 'available', '100', 'subaccount'),
  ];
  const spaces = fakeSpaces([
    space('space-alice-1', ALICE),
    space('space-alice-2', ALICE, 'named', 'USDT'),
    space('primary-alice', ALICE, 'primary'),
    space('space-bob-1', BOB),
  ]);
  const prices = () => fakeTrade({ 'BTC/USDT': { last: '60000', open: '59000' } }).source;

  it("counts a user's Space balances (free and locked) with their main balance", async () => {
    const { ledger, asked } = fakeLedger(rows);
    const svc = new PortfolioService(ledger, spaces, { tickers: prices(), now: () => NOW });
    const out = await callerFor(svc, principal(ALICE)).portfolio.summary();
    // BTC 0.1 + 0.4 + 0.1 = 0.6 -> 36000; USDT 100 + 50 = 150
    expect(out.totalUsd).toBe('36150.00');
    expect(out.cashUsd).toBe('150.00');
    expect(out.cryptoUsd).toBe('36000.00');
    expect(out.change24hUsd).toBe('600.00');
    expect(out.priced.find((r) => r.asset === 'BTC')!.amount).toBe('0.6');
    // The primary Space is a view over the user's own accounts, so it adds no read of its own.
    expect(asked.sort()).toEqual(
      [
        ['user', ALICE],
        ['subaccount', 'space-alice-1'],
        ['subaccount', 'space-alice-2'],
      ].sort(),
    );
  });

  it("never reads or counts another user's Space", async () => {
    const { ledger, asked } = fakeLedger(rows);
    const svc = new PortfolioService(ledger, spaces, { tickers: prices(), now: () => NOW });
    const out = await callerFor(svc, principal(ALICE)).portfolio.summary();
    expect(asked.some(([, id]) => id === 'space-bob-1')).toBe(false);
    expect(out.priced.find((r) => r.asset === 'BTC')!.amount).not.toContain('100');

    const bobs = await callerFor(svc, principal(BOB)).portfolio.summary();
    expect(bobs.priced.find((r) => r.asset === 'BTC')!.amount).toBe('100');
    expect(bobs.totalUsd).toBe('6000001.00');
  });

  it('even a mis-scoped Space list cannot pull in a Space whose owner is someone else', async () => {
    const { ledger, asked } = fakeLedger(rows);
    const leaky: SpaceLister = { namedSpaces: async () => [space('space-alice-1', ALICE), space('space-bob-1', BOB)] };
    const svc = new PortfolioService(ledger, leaky, { tickers: prices(), now: () => NOW });
    await callerFor(svc, principal(ALICE)).portfolio.summary();
    expect(asked.some(([, id]) => id === 'space-bob-1')).toBe(false);
  });

  it('a user whose only crypto sits in a Space is not told they hold nothing', async () => {
    const { ledger } = fakeLedger([bal('space-alice-1', 'BTC', 'available', '1', 'subaccount')]);
    const svc = new PortfolioService(ledger, fakeSpaces([space('space-alice-1', ALICE)]), { tickers: prices(), now: () => NOW });
    const out = await callerFor(svc, principal(ALICE)).portfolio.summary();
    expect(out.totalUsd).toBe('60000.00');
  });
});

describe('bank.portfolio.summary display currency and scope (PF-overview-03)', () => {
  const rows = [
    bal(ALICE, 'USDT', 'available', '1000'),
    bal(ALICE, 'BTC', 'available', '0.5'),
    bal('space-alice-1', 'BTC', 'available', '1', 'subaccount'),
    bal('space-bob-1', 'BTC', 'available', '100', 'subaccount'),
  ];
  const spaces = fakeSpaces([space('space-alice-1', ALICE), space('space-bob-1', BOB)]);
  const prices = () => fakeTrade({ 'BTC/USDT': { last: '60000', open: '60000', windowStart: null } }).source;
  const make = () => new PortfolioService(fakeLedger(rows).ledger, spaces, { tickers: prices(), now: () => NOW });

  it('shows BTC when the display currency is BTC, from the same price book', async () => {
    const out = await callerFor(make(), principal(ALICE)).portfolio.summary({ displayCurrency: 'btc' });
    expect(out.totalUsd).toBe('91000.00'); // 1000 + 1.5 x 60000
    expect(out.btc).toEqual({ total: '1.51666667', priceUsd: '60000', reason: null });
  });

  it('keeps USD and adds no BTC block when the display currency is USD', async () => {
    const out = await callerFor(make(), principal(ALICE)).portfolio.summary({ displayCurrency: 'USD' });
    expect(out.totalUsd).toBe('91000.00');
    expect(out.btc).toBeUndefined();
  });

  it('refuses a currency with no rate source by name and never falls back to a guess', async () => {
    await expect(callerFor(make(), principal(ALICE)).portfolio.summary({ displayCurrency: 'EUR' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('scopes to main, to one named space, and the parts add up to the combined total', async () => {
    const caller = callerFor(make(), principal(ALICE));
    const main = await caller.portfolio.summary({ scope: 'main' });
    const one = await caller.portfolio.summary({ scope: 'space-alice-1' });
    const all = await caller.portfolio.summary({ scope: 'combined' });
    expect(main.totalUsd).toBe('31000.00');
    expect(one.totalUsd).toBe('60000.00');
    expect(all.totalUsd).toBe('91000.00');
    expect(Number(main.totalUsd) + Number(one.totalUsd)).toBe(Number(all.totalUsd));
  });

  it("refuses a space that is not the caller's without reading it", async () => {
    const { ledger, asked } = fakeLedger(rows);
    const svc = new PortfolioService(ledger, spaces, { tickers: prices(), now: () => NOW });
    await expect(callerFor(svc, principal(ALICE)).portfolio.summary({ scope: 'space-bob-1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(asked.some(([, id]) => id === 'space-bob-1')).toBe(false);
  });
});
