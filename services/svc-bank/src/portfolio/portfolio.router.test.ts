import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt, type Balance, type LedgerClient } from '@intafaced/ledger-client';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import { PortfolioService, httpTickerSource, type TickerSource } from './portfolio-service.js';
import type { TickerMap } from './valuation.js';

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

const bal = (ownerId: string, assetId: string, kind: Balance['account']['kind'], amount: string): Balance => ({
  account: { ownerType: 'user', ownerId, assetId, kind },
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

function fakeTrade(map: Record<string, { last: string | null; open: string | null; windowStart?: number | null }>) {
  let calls = 0;
  const source: TickerSource = {
    tickers: async () => {
      calls += 1;
      return mapOf(map);
    },
  };
  return { source, calls: () => calls };
}

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
    const svc = new PortfolioService(ledger, { tickers: trade.source, now: () => NOW });

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
      unpriced: [{ asset: 'IFC', amount: '40' }],
      asOf: NOW.getTime(),
      windowStart: null,
    });
    expect(asked).toEqual([['user', ALICE]]);
  });

  it("only ever reads the caller's own balances: Bob's money is never in Alice's total, and no input can name another user", async () => {
    const { ledger, asked } = fakeLedger(rows);
    const svc = new PortfolioService(ledger, { tickers: fakeTrade({}).source, now: () => NOW });

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
    const svc = new PortfolioService(ledger, { tickers: fakeTrade({}).source });
    const bank = { portfolio: svc } as unknown as BankServices;

    await expect(createBankRouter(bank).createCaller(anonymous()).portfolio.summary()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(callerFor(svc, principal(ALICE, ['trade:read'])).portfolio.summary()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(asked).toEqual([]);
  });

  it('refuses SERVICE_UNAVAILABLE / bank.prices_unavailable when trade is down, with no partial total', async () => {
    const { ledger } = fakeLedger(rows);
    const down: TickerSource = {
      tickers: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:4004');
      },
    };
    const svc = new PortfolioService(ledger, { tickers: down, now: () => NOW });

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
    const svc = new PortfolioService(ledger, { now: () => NOW });
    await expect(callerFor(svc, principal(ALICE)).portfolio.summary()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('answers a stablecoin-only user while trade is down, and never calls trade for them', async () => {
    const { ledger } = fakeLedger([bal(ALICE, 'USDC', 'available', '12.34'), bal(ALICE, 'USD', 'hold', '0.66')]);
    const trade = fakeTrade({});
    const svc = new PortfolioService(ledger, { tickers: trade.source, now: () => NOW });
    const out = await callerFor(svc, principal(ALICE)).portfolio.summary();
    expect(out).toMatchObject({ totalUsd: '13.00', cashUsd: '13.00', cryptoUsd: '0.00', change24hUsd: '0.00' });
    expect(trade.calls()).toBe(0);
  });

  it("on today's svc-trade (no 24 h stats yet) gives the total and a null change, not a guess", async () => {
    const { ledger } = fakeLedger(rows);
    const trade = fakeTrade({ 'BTC/USDT': { last: '60000', open: null } });
    const svc = new PortfolioService(ledger, { tickers: trade.source, now: () => NOW });
    const out = await callerFor(svc, principal(ALICE)).portfolio.summary();
    expect(out.totalUsd).toBe('46000.00');
    expect(out.change24hUsd).toBeNull();
    expect(out.priced.find((r) => r.asset === 'BTC')!.change24hUsd).toBeNull();
  });

  it('an empty ledger is an honest $0.00', async () => {
    const { ledger } = fakeLedger([]);
    const svc = new PortfolioService(ledger, { tickers: fakeTrade({}).source, now: () => NOW });
    const out = await callerFor(svc, principal(ALICE)).portfolio.summary();
    expect(out).toMatchObject({ totalUsd: '0.00', change24hUsd: '0.00', priced: [], unpriced: [] });
  });
});

describe('httpTickerSource, the cross-service call to svc-trade', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('reads GET /api/v1/tickers?limit=500 and parses last/open/windowStart as scaled amounts', async () => {
    let url = '';
    const src = httpTickerSource({
      baseUrl: 'http://trade.test/',
      fetchImpl: (async (u: string) => {
        url = u;
        return json({
          'BTC/USDT': { symbol: 'BTC/USDT', last: '60000.5', open: '59000', windowStart: 1_700_000_000_000, sparkline: ['1'] },
          'ETH/USDT': { last: null, open: null },
          'JUNK/USDT': { last: 'abc', open: 12 },
          bad: null,
        });
      }) as unknown as typeof fetch,
    });
    const map = await src.tickers();
    expect(url).toBe('http://trade.test/api/v1/tickers?limit=500');
    expect(map.get('BTC/USDT')).toEqual({ last: amt('60000.5'), open: amt('59000'), windowStart: 1_700_000_000_000 });
    expect(map.get('ETH/USDT')).toEqual({ last: null, open: null, windowStart: null });
    expect(map.get('JUNK/USDT')).toEqual({ last: null, open: null, windowStart: null });
    expect(map.has('bad')).toBe(false);
  });

  it('times out on a hung svc-trade and refuses bank.prices_unavailable', async () => {
    const hung = (async (_u: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const src = httpTickerSource({ baseUrl: 'http://trade.test', fetchImpl: hung, timeoutMs: 20 });
    await expect(src.tickers()).rejects.toMatchObject({ code: 'bank.prices_unavailable', message: expect.stringContaining('timed out') });
  });

  it('refuses on a 5xx, a refused connection and a non-object body', async () => {
    const make = (impl: unknown) => httpTickerSource({ baseUrl: 'http://trade.test', fetchImpl: impl as typeof fetch });
    await expect(make(async () => json({ error: 'x' }, 503)).tickers()).rejects.toMatchObject({ code: 'bank.prices_unavailable' });
    await expect(
      make(async () => {
        throw new TypeError('fetch failed');
      }).tickers(),
    ).rejects.toMatchObject({ code: 'bank.prices_unavailable' });
    await expect(make(async () => json([1, 2])).tickers()).rejects.toMatchObject({ code: 'bank.prices_unavailable' });
    await expect(make(async () => new Response('not json', { status: 200 })).tickers()).rejects.toMatchObject({
      code: 'bank.prices_unavailable',
    });
  });

  it('end to end: a dead svc-trade surfaces as SERVICE_UNAVAILABLE through the router', async () => {
    const { ledger } = fakeLedger([bal(ALICE, 'BTC', 'available', '1')]);
    const svc = new PortfolioService(ledger, {
      tickers: httpTickerSource({
        baseUrl: 'http://trade.test',
        fetchImpl: (async () => {
          throw new TypeError('fetch failed');
        }) as unknown as typeof fetch,
      }),
    });
    await expect(callerFor(svc, principal(ALICE)).portfolio.summary()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
