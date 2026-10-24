import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt, type Balance, type LedgerClient } from '@intafaced/ledger-client';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import type { AssetRegistryReads } from '../assets/supported-assets.js';
import { PortfolioService, type SpaceLister, type TickerSource } from './portfolio-service.js';
import type { PriceBook } from './valuation.js';

/**
 * `bank.portfolio.allocation` through the real router, with a fake ledger, fake prices and a fake asset registry. All figures
 * are TEST data. The invariants: every grouping adds up to the total exactly, available + locked equals each asset's value,
 * staked coins are earn, an asset the registry does not list is unclassified and still counted, an asset with no price is
 * in no share, and a missing price source or registry refuses like `summary` does.
 */

const SECRET = 'a-bank-allocation-test-edge-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-19T08:00:00Z');
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

function signed(userId: string) {
  const principal = {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['bank:read'],
    tier: 'full',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-allocation',
  });
}

const bal = (ownerId: string, assetId: string, kind: Balance['account']['kind'], amount: string): Balance => ({
  account: { ownerType: 'user', ownerId, assetId, kind },
  accountId: `${ownerId}-${assetId}-${kind}`,
  amount: amt(amount),
});

const noSpaces: SpaceLister = { namedSpaces: async () => [] };

/** TEST registry rows: only the fields the allocation reads. */
const registry = (kinds: Record<string, string>): AssetRegistryReads => ({
  listed: async () =>
    Object.entries(kinds).map(([id, kind]) => ({ id, kind })) as unknown as Awaited<ReturnType<AssetRegistryReads['listed']>>,
});
const KINDS = registry({ BTC: 'crypto', ETH: 'crypto', IFC: 'native', XAU: 'commodity' });

function service(rows: Balance[], tickers?: Record<string, string>, assets: AssetRegistryReads | null = KINDS) {
  const ledger = {
    balances: async (ownerType: string, ownerId: string) =>
      rows.filter((r) => r.account.ownerType === ownerType && r.account.ownerId === ownerId),
  } as unknown as Pick<LedgerClient, 'balances'>;
  const source: TickerSource | undefined = tickers
    ? {
        prices: async (): Promise<PriceBook> => ({
          tickers: new Map(Object.entries(tickers).map(([k, last]) => [k, { last: amt(last), open: null, windowStart: null }])),
          listed: new Set([...Object.keys(tickers), 'DOGE/USDT']),
        }),
      }
    : undefined;
  return new PortfolioService(ledger, noSpaces, { ...(source ? { tickers: source } : {}), assets, now: () => NOW });
}

const call = (svc: PortfolioService, userId: string) =>
  createBankRouter({ portfolio: svc } as unknown as BankServices).createCaller(signed(userId));

describe('bank.portfolio.allocation', () => {
  const rows = [
    bal(ALICE, 'USDT', 'available', '1000'),
    bal(ALICE, 'USDC', 'available', '500'),
    bal(ALICE, 'USD', 'available', '250'),
    bal(ALICE, 'BTC', 'available', '0.5'),
    bal(ALICE, 'BTC', 'hold', '0.25'),
    bal(ALICE, 'ETH', 'stake', '2'),
    bal(ALICE, 'IFC', 'available', '40'),
    bal(BOB, 'USDT', 'available', '999999'),
  ];
  const prices = { 'BTC/USDT': '60000', 'ETH/USDT': '3000', 'DOGE/USDT': '0' };

  it('groups the priced holdings by class and by available / locked, adding up to the total', async () => {
    const out = await call(service(rows, prices), ALICE).portfolio.allocation();

    // 1000 + 500 + 250 + 0.75 x 60000 + 2 x 3000 = 52750 (IFC has no market: not counted)
    expect(out.totalValueUsd).toBe('52750');
    expect(out.classes.map((c) => [c.class, c.valueUsd])).toEqual([
      ['fiat', '250'],
      ['stablecoin', '1500'],
      ['crypto', '45000'],
      ['earn', '6000'],
    ]);
    expect(out.classes[2]!.assets).toEqual([{ asset: 'BTC', valueUsd: '45000', share: '0.853080568720379147' }]);
    // The staked ETH is earn, not crypto.
    expect(out.classes[3]!.assets).toEqual([{ asset: 'ETH', valueUsd: '6000', share: '0.113744075829383886' }]);
    // Locked: 0.25 BTC hold = 15000 and 2 ETH staked = 6000; the rest is spendable.
    expect(out.types).toEqual([
      { type: 'available', valueUsd: '31750', share: '0.601895734597156398' },
      { type: 'locked', valueUsd: '21000', share: '0.398104265402843602' },
    ]);
    expect(amt(out.types[0]!.valueUsd) + amt(out.types[1]!.valueUsd)).toBe(amt(out.totalValueUsd));
    expect(out.classes.reduce((sum, c) => sum + amt(c.valueUsd), 0n)).toBe(amt(out.totalValueUsd));
    expect(out.unpriced).toEqual([{ asset: 'IFC', amount: '40', reason: 'no_market' }]);
    expect(out.asOf).toBe(NOW.getTime());
  });

  it('splits one coin between its class and earn by the stake part, both adding up to its value', async () => {
    const book = [bal(ALICE, 'USDT', 'available', '70'), bal(ALICE, 'USDT', 'stake', '30'), bal(ALICE, 'USDT', 'hold', '5')];
    const out = await call(service(book, prices), ALICE).portfolio.allocation();
    expect(out.totalValueUsd).toBe('105');
    expect(out.classes.map((c) => [c.class, c.valueUsd])).toEqual([
      ['stablecoin', '75'],
      ['earn', '30'],
    ]);
    expect(out.types.map((t) => [t.type, t.valueUsd])).toEqual([
      ['available', '70'],
      ['locked', '35'],
    ]);
  });

  it('names a priced asset the registry does not list as unclassified and still counts it', async () => {
    const book = [bal(ALICE, 'USDT', 'available', '100'), bal(ALICE, 'BTC', 'available', '0.001')];
    const out = await call(service(book, prices, registry({ ETH: 'crypto' })), ALICE).portfolio.allocation();
    expect(out.totalValueUsd).toBe('160');
    expect(out.classes).toEqual([
      { class: 'stablecoin', valueUsd: '100', share: '0.625', assets: [{ asset: 'USDT', valueUsd: '100', share: '0.625' }] },
      { class: 'unclassified', valueUsd: '60', share: '0.375', assets: [{ asset: 'BTC', valueUsd: '60', share: '0.375' }] },
    ]);
    expect(out.classes.reduce((sum, c) => sum + amt(c.valueUsd), 0n)).toBe(amt(out.totalValueUsd));
  });

  it('classes a commodity and a fiat currency from the registry kind', async () => {
    const book = [bal(ALICE, 'XAU', 'available', '1'), bal(ALICE, 'EUR', 'available', '10')];
    const out = await call(
      service(book, { 'XAU/USDT': '2400', 'EUR/USDT': '1.1' }, registry({ XAU: 'commodity', EUR: 'fiat' })),
      ALICE,
    ).portfolio.allocation();
    expect(out.classes.map((c) => [c.class, c.valueUsd])).toEqual([
      ['fiat', '11'],
      ['commodity', '2400'],
    ]);
  });

  it('refuses bank.asset_registry_unavailable when a coin needs its class and the registry is not connected or fails', async () => {
    await expect(call(service(rows, prices, null), ALICE).portfolio.allocation()).rejects.toMatchObject({
      message: expect.stringContaining('not connected'),
    });
    const broken: AssetRegistryReads = { listed: async () => Promise.reject(new Error('ledger down')) };
    await expect(call(service(rows, prices, broken), ALICE).portfolio.allocation()).rejects.toMatchObject({
      message: expect.stringContaining('could not be read'),
    });
    // Cash only needs no registry.
    const cash = await call(service([bal(ALICE, 'USD', 'available', '5')], undefined, null), ALICE).portfolio.allocation();
    expect(cash.classes.map((c) => c.class)).toEqual(['fiat']);
  });

  it("never includes another user's money", async () => {
    const out = await call(service(rows, prices), BOB).portfolio.allocation();
    expect(out.totalValueUsd).toBe('999999');
    expect(out.classes.map((c) => c.class)).toEqual(['stablecoin']);
  });

  it('answers an empty book with no groups and no invented share', async () => {
    const out = await call(service([], prices), ALICE).portfolio.allocation();
    expect(out).toMatchObject({ totalValueUsd: '0', classes: [], types: [], unpriced: [] });
  });

  it('keeps an unpriced coin out of every share', async () => {
    const out = await call(service([bal(ALICE, 'IFC', 'available', '40')], prices), ALICE).portfolio.allocation();
    expect(out.totalValueUsd).toBe('0');
    expect(out.classes).toEqual([]);
    expect(out.unpriced).toEqual([{ asset: 'IFC', amount: '40', reason: 'no_market' }]);
  });

  it('refuses bank.prices_unavailable when a priced coin is held and there is no price source', async () => {
    await expect(call(service(rows), ALICE).portfolio.allocation()).rejects.toMatchObject({
      message: expect.stringContaining("Prices can't be loaded"),
    });
  });

  it('needs no price source for cash only', async () => {
    const out = await call(service([bal(ALICE, 'USDT', 'available', '10')]), ALICE).portfolio.allocation();
    expect(out.classes).toEqual([
      { class: 'stablecoin', valueUsd: '10', share: '1', assets: [{ asset: 'USDT', valueUsd: '10', share: '1' }] },
    ]);
  });
});
