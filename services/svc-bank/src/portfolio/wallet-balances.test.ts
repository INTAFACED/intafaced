import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt, type Balance, type LedgerClient } from '@intafaced/ledger-client';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import type { SpaceRecord } from '../spaces/space-service.js';
import { PortfolioService, type SpaceLister, type TickerSource } from './portfolio-service.js';
import type { PriceBook } from './valuation.js';

/** W-balances-01 (back end): asset filter, BTC valuation, one account, the wallet selector. */

const SECRET = 'a-bank-wallet-balances-edge-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SPACE = '44444444-4444-4444-8444-444444444444';
const BOBS_SPACE = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-20T00:00:00.000Z');
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

function callerFor(portfolio: PortfolioService, userId: string) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['bank:read'],
    tier: 'full',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return createBankRouter({ portfolio } as unknown as BankServices).createCaller(
    edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-wallet',
    }),
  );
}

const row = (
  ownerId: string,
  assetId: string,
  kind: Balance['account']['kind'],
  amount: string,
  purpose?: string,
  ownerType: Balance['account']['ownerType'] = 'user',
): Balance => ({
  account: { ownerType, ownerId, assetId, kind, ...(purpose ? { purpose } : {}) },
  accountId: `${ownerType}-${ownerId}-${assetId}-${kind}-${purpose ?? ''}`,
  amount: amt(amount),
});

const space = (id: string, userId: string, name: string): SpaceRecord => ({
  id,
  userId,
  assetId: 'USDT',
  kind: 'named',
  name,
  goalTarget: null,
  lockedUntil: null,
  archivedAt: null,
});

const tickers = (map: Record<string, string>): TickerSource => ({
  prices: async (): Promise<PriceBook> => ({
    tickers: new Map(Object.entries(map).map(([k, v]) => [k, { last: amt(v), open: amt(v), windowStart: null }])),
    listed: new Set(Object.keys(map)),
  }),
});

function service(rows: Balance[], source?: TickerSource) {
  const asked: Array<[string, string]> = [];
  const spaces = [space(SPACE, ALICE, 'Savings'), space(BOBS_SPACE, BOB, 'Bobs')];
  const ledger = {
    balances: async (ownerType: string, ownerId: string) => {
      asked.push([ownerType, ownerId]);
      return rows.filter((r) => r.account.ownerType === ownerType && r.account.ownerId === ownerId);
    },
  } as unknown as Pick<LedgerClient, 'balances'>;
  const lister: SpaceLister = { namedSpaces: async (userId) => spaces.filter((s) => s.userId === userId) };
  return { portfolio: new PortfolioService(ledger, lister, { ...(source ? { tickers: source } : {}), now: () => NOW }), asked };
}

const holdings = [
  row(ALICE, 'USDT', 'available', '30000'),
  row(ALICE, 'BTC', 'available', '0.5'),
  row(ALICE, 'BTC', 'hold', '0.25', 'order:o-1'),
  row(SPACE, 'USDT', 'available', '10000', undefined, 'subaccount'),
  row(BOB, 'USDT', 'available', '999999'),
];

describe('summary: one asset, and the value in BTC', () => {
  it('narrows the total to one asset, whatever its case, and leaves the rest out', async () => {
    const { portfolio } = service(holdings, tickers({ 'BTC/USDT': '60000' }));
    const btc = await callerFor(portfolio, ALICE).portfolio.summary({ assetId: 'btc' });
    expect(btc.priced.map((p) => p.asset)).toEqual(['BTC']);
    expect(btc.totalUsd).toBe('45000.00');
    const usdt = await callerFor(portfolio, ALICE).portfolio.summary({ assetId: 'USDT' });
    expect(usdt.totalUsd).toBe('40000.00');
    expect(usdt.btc).toBeUndefined();
  });

  it('values the whole holding in BTC from the published BTC price, to 8 decimals', async () => {
    const { portfolio } = service(holdings, tickers({ 'BTC/USDT': '60000' }));
    const out = await callerFor(portfolio, ALICE).portfolio.summary({ valueIn: 'btc' });
    // 40,000 USDT + 0.75 BTC at 60,000 = 85,000 USD = 1.41666667 BTC.
    expect(out.totalUsd).toBe('85000.00');
    expect(out.btc).toEqual({ total: '1.41666667', priceUsd: '60000', reason: null });
  });

  it('values a BTC holding at exactly its amount, and falls back to BTC/USDC', async () => {
    const { portfolio } = service([row(ALICE, 'BTC', 'available', '0.12345678')], tickers({ 'BTC/USDC': '71234.5' }));
    const out = await callerFor(portfolio, ALICE).portfolio.summary({ valueIn: 'btc' });
    expect(out.btc?.total).toBe('0.12345678');
  });

  it('says no price is published, and shows no number, when there is no BTC market price', async () => {
    const { portfolio } = service([row(ALICE, 'USDT', 'available', '100')], tickers({ 'ETH/USDT': '3000' }));
    const out = await callerFor(portfolio, ALICE).portfolio.summary({ valueIn: 'btc' });
    expect(out.totalUsd).toBe('100.00');
    expect(out.btc).toEqual({ total: null, priceUsd: null, reason: 'no_price_published' });
  });

  it('refuses, not guesses, when a BTC value is asked and prices cannot be had', async () => {
    const { portfolio } = service([row(ALICE, 'USDT', 'available', '100')]);
    await expect(callerFor(portfolio, ALICE).portfolio.summary({ valueIn: 'btc' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    // Without the BTC option a cash-only holder still gets an answer with no price source.
    expect((await callerFor(portfolio, ALICE).portfolio.summary()).totalUsd).toBe('100.00');
  });

  it('leaves the BTC value blank, not 0, when something is held and none of it can be priced', async () => {
    const { portfolio } = service(
      [row(ALICE, 'EUR', 'available', '500'), row(ALICE, 'NEWCOIN', 'available', '3')],
      tickers({ 'BTC/USDT': '60000' }),
    );
    const out = await callerFor(portfolio, ALICE).portfolio.summary({ valueIn: 'btc' });
    expect(out.totalUsd).toBeNull();
    expect(out.btc).toEqual({ total: null, priceUsd: null, reason: 'nothing_priced' });
    const one = await callerFor(portfolio, ALICE).portfolio.summary({ assetId: 'NEWCOIN', valueIn: 'btc' });
    expect(one.btc?.total).toBeNull();
  });

  it('leaves an unpriced holding out of the BTC value, as it is out of the USD value', async () => {
    const { portfolio } = service(
      [row(ALICE, 'USDT', 'available', '6000'), row(ALICE, 'EUR', 'available', '500')],
      tickers({ 'BTC/USDT': '60000' }),
    );
    const out = await callerFor(portfolio, ALICE).portfolio.summary({ valueIn: 'btc' });
    expect(out.unpriced.map((u) => u.asset)).toEqual(['EUR']);
    expect(out.btc?.total).toBe('0.1');
  });

  it('falls back to BTC/USDC when BTC/USDT has no last price, and refuses when listed markets answer nothing', async () => {
    const noLast: TickerSource = {
      prices: async (): Promise<PriceBook> => ({
        tickers: new Map([
          ['BTC/USDT', { last: null, open: null, windowStart: null }],
          ['BTC/USDC', { last: amt('50000'), open: null, windowStart: null }],
        ]),
        listed: new Set(['BTC/USDT', 'BTC/USDC']),
      }),
    };
    const { portfolio } = service([row(ALICE, 'USDT', 'available', '5000')], noLast);
    expect((await callerFor(portfolio, ALICE).portfolio.summary({ valueIn: 'btc' })).btc).toEqual({
      total: '0.1',
      priceUsd: '50000',
      reason: null,
    });
    const dead: TickerSource = { prices: async () => ({ tickers: new Map(), listed: new Set(['BTC/USDT']) }) };
    const down = service([row(ALICE, 'USDT', 'available', '5000')], dead).portfolio;
    await expect(callerFor(down, ALICE).portfolio.summary({ valueIn: 'btc' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('rounds once, half-up, to 8 decimals', async () => {
    // 1 USD at 3 USD per BTC is 0.33333333; 2 USD is 0.66666667.
    const one = service([row(ALICE, 'USDT', 'available', '1')], tickers({ 'BTC/USDT': '3' }));
    expect((await callerFor(one.portfolio, ALICE).portfolio.summary({ valueIn: 'btc' })).btc?.total).toBe('0.33333333');
    const two = service([row(ALICE, 'USDT', 'available', '2')], tickers({ 'BTC/USDT': '3' }));
    expect((await callerFor(two.portfolio, ALICE).portfolio.summary({ valueIn: 'btc' })).btc?.total).toBe('0.66666667');
  });

  it('values nothing held as 0 BTC with no price needed', async () => {
    const { portfolio } = service([]);
    const out = await callerFor(portfolio, ALICE).portfolio.summary({ valueIn: 'btc' });
    expect(out.btc).toEqual({ total: '0', priceUsd: null, reason: null });
  });
});

describe('balance breakdown: one account and one asset', () => {
  it('lists the wallet selector: the main account, then each named Space, and no one else', async () => {
    const { portfolio } = service(holdings);
    const out = await callerFor(portfolio, ALICE).portfolio.balanceAccounts();
    expect(out.accounts).toEqual([
      { accountId: 'main', walletType: 'main', name: null },
      { accountId: SPACE, walletType: 'space', name: 'Savings' },
    ]);
  });

  it('reads only the account asked for, and each account adds up to the whole', async () => {
    const { portfolio, asked } = service(holdings);
    const api = callerFor(portfolio, ALICE);
    const main = await api.portfolio.balanceBreakdown({ accountId: 'main' });
    const inSpace = await api.portfolio.balanceBreakdown({ accountId: SPACE });
    const all = await api.portfolio.balanceBreakdown();
    expect(main.assets.map((a) => [a.assetId, a.total])).toEqual([
      ['BTC', '0.75'],
      ['USDT', '30000'],
    ]);
    expect(inSpace.assets.map((a) => [a.assetId, a.total])).toEqual([['USDT', '10000']]);
    const usdt = (r: typeof all) => r.assets.find((a) => a.assetId === 'USDT')!.total;
    expect(amt(usdt(main)) + amt(usdt(inSpace))).toBe(amt(usdt(all)));
    expect(asked.some(([, id]) => id === BOB)).toBe(false);
  });

  it("refuses a Space that is not the caller's without reading it, and a malformed account id", async () => {
    const { portfolio, asked } = service(holdings);
    const api = callerFor(portfolio, ALICE);
    await expect(api.portfolio.balanceBreakdown({ accountId: BOBS_SPACE })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(asked).toEqual([]);
    await expect(api.portfolio.balanceBreakdown({ accountId: 'bob' } as never)).rejects.toBeDefined();
  });

  it('takes the account id in any letter case, and lets accountId win over scope and combine with assetId', async () => {
    const { portfolio } = service(holdings);
    const api = callerFor(portfolio, ALICE);
    const upper = await api.portfolio.balanceBreakdown({ accountId: SPACE.toUpperCase() });
    expect(upper.assets.map((a) => a.total)).toEqual(['10000']);
    const both = await api.portfolio.balanceBreakdown({ scope: 'main', accountId: SPACE, assetId: 'usdt' });
    expect(both.assets.map((a) => [a.assetId, a.total])).toEqual([['USDT', '10000']]);
    expect((await api.portfolio.balanceBreakdown({ accountId: SPACE, assetId: 'BTC' })).assets).toEqual([]);
  });

  it('reads no Space list for the main account, so the main figure does not wait on it', async () => {
    const ledger = {
      balances: async (type: string, id: string) => holdings.filter((r) => r.account.ownerType === type && r.account.ownerId === id),
    } as unknown as Pick<LedgerClient, 'balances'>;
    const broken: SpaceLister = {
      namedSpaces: async () => {
        throw new Error('spaces down');
      },
    };
    const portfolio = new PortfolioService(ledger, broken, { now: () => NOW });
    const out = await callerFor(portfolio, ALICE).portfolio.balanceBreakdown({ scope: 'main' });
    expect(out.assets.map((a) => a.assetId)).toEqual(['BTC', 'USDT']);
    await expect(callerFor(portfolio, ALICE).portfolio.balanceBreakdown()).rejects.toBeDefined();
  });

  it('narrows to one asset and keeps its locks apart', async () => {
    const { portfolio } = service(holdings);
    const out = await callerFor(portfolio, ALICE).portfolio.balanceBreakdown({ assetId: 'btc' });
    expect(out.assets).toEqual([
      {
        assetId: 'BTC',
        total: '0.75',
        available: '0.5',
        locked: [{ kind: 'hold', amount: '0.25', claims: [{ purpose: 'order:o-1', amount: '0.25' }] }],
      },
    ]);
  });
});
