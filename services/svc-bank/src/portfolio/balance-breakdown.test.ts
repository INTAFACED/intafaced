import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { LOCK_KIND_LIST, parseAmount as amt, type Balance, type LedgerClient } from '@intafaced/ledger-client';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import type { SpaceRecord } from '../spaces/space-service.js';
import { PortfolioService, type SpaceLister } from './portfolio-service.js';

/**
 * `bank.portfolio.balanceBreakdown` through the real router and the real edge context, with a fake ledger. The invariant under
 * test: for every asset, total = available + every lock kind, exactly, and each lock names the claim it belongs to. The
 * headline valuation keeps folding the locks into one "used" figure; this read is the one that keeps them apart.
 */

const SECRET = 'a-bank-balance-breakdown-edge-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SPACE = '44444444-4444-4444-8444-444444444444';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

function signed(userId: string, scopes: string[] = ['bank:read']) {
  const principal = {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes,
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
    id: 'req-breakdown',
  });
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

function service(rows: Balance[], spaces: SpaceRecord[] = []) {
  const asked: Array<[string, string]> = [];
  const ledger = {
    balances: async (ownerType: string, ownerId: string) => {
      asked.push([ownerType, ownerId]);
      return rows.filter((r) => r.account.ownerType === ownerType && r.account.ownerId === ownerId);
    },
  } as unknown as Pick<LedgerClient, 'balances'>;
  const lister: SpaceLister = { namedSpaces: async (userId) => spaces.filter((s) => s.userId === userId) };
  return { portfolio: new PortfolioService(ledger, lister), asked };
}

const callerFor = (portfolio: PortfolioService, userId: string, scopes?: string[]) =>
  createBankRouter({ portfolio } as unknown as BankServices).createCaller(signed(userId, scopes));

const named = (id: string, userId: string): SpaceRecord => ({
  id,
  userId,
  assetId: 'USDT',
  kind: 'named',
  name: 'Savings',
  goalTarget: null,
  lockedUntil: null,
  archivedAt: null,
});

describe('bank.portfolio.balanceBreakdown', () => {
  it('splits available from every lock kind, names each claim, and the parts add up to the total exactly', async () => {
    const { portfolio } = service([
      row(ALICE, 'USDT', 'available', '700.25'),
      row(ALICE, 'USDT', 'hold', '100', 'order:o-1'),
      row(ALICE, 'USDT', 'hold', '50.5', 'order:o-2'),
      row(ALICE, 'USDT', 'escrow', '20', 'p2p:t-9'),
      row(ALICE, 'USDT', 'stake', '30', 'token:stake:s-1'),
      row(ALICE, 'USDT', 'collateral', '99.25', 'loan:l-1'),
      row(ALICE, 'BTC', 'available', '0.5'),
    ]);

    const out = await callerFor(portfolio, ALICE).portfolio.balanceBreakdown();

    expect(out.assets).toEqual([
      {
        assetId: 'BTC',
        total: '0.5',
        available: '0.5',
        locked: [],
      },
      {
        assetId: 'USDT',
        total: '1000',
        available: '700.25',
        locked: [
          {
            kind: 'hold',
            amount: '150.5',
            claims: [
              { purpose: 'order:o-1', amount: '100' },
              { purpose: 'order:o-2', amount: '50.5' },
            ],
          },
          { kind: 'escrow', amount: '20', claims: [{ purpose: 'p2p:t-9', amount: '20' }] },
          { kind: 'stake', amount: '30', claims: [{ purpose: 'token:stake:s-1', amount: '30' }] },
          { kind: 'collateral', amount: '99.25', claims: [{ purpose: 'loan:l-1', amount: '99.25' }] },
        ],
      },
    ]);
    // The invariant, restated on the wire: total = available + the sum of every lock, with no remainder.
    for (const asset of out.assets) {
      const sum = [asset.available, ...asset.locked.map((lock) => lock.amount)].reduce((a, b) => a + amt(b), 0n);
      expect(sum).toBe(amt(asset.total));
      for (const lock of asset.locked) {
        expect(lock.claims.reduce((a, c) => a + amt(c.amount), 0n)).toBe(amt(lock.amount));
        expect(LOCK_KIND_LIST).toContain(lock.kind);
      }
    }
  });

  it('adds the named spaces to the same asset, as the headline total does, and reads only this caller', async () => {
    const { portfolio, asked } = service(
      [
        row(ALICE, 'USDT', 'available', '100'),
        row(SPACE, 'USDT', 'available', '40', undefined, 'subaccount'),
        row(SPACE, 'USDT', 'hold', '10', 'order:o-3', 'subaccount'),
        row(BOB, 'USDT', 'available', '999999'),
      ],
      [named(SPACE, ALICE)],
    );

    const out = await callerFor(portfolio, ALICE).portfolio.balanceBreakdown();

    expect(out.assets).toEqual([
      {
        assetId: 'USDT',
        total: '150',
        available: '140',
        locked: [{ kind: 'hold', amount: '10', claims: [{ purpose: 'order:o-3', amount: '10' }] }],
      },
    ]);
    expect(asked).toContainEqual(['user', ALICE]);
    expect(asked).toContainEqual(['subaccount', SPACE]);
    expect(asked.some(([, id]) => id === BOB)).toBe(false);
  });

  it("with scope 'main' leaves the named spaces out and never asks for them", async () => {
    const { portfolio, asked } = service(
      [row(ALICE, 'USDT', 'available', '100'), row(SPACE, 'USDT', 'available', '40', undefined, 'subaccount')],
      [named(SPACE, ALICE)],
    );
    const out = await callerFor(portfolio, ALICE).portfolio.balanceBreakdown({ scope: 'main' });
    expect(out.assets).toEqual([{ assetId: 'USDT', total: '100', available: '100', locked: [] }]);
    expect(asked).toEqual([['user', ALICE]]);
    await expect(callerFor(portfolio, ALICE).portfolio.balanceBreakdown({ scope: 'someone-else' } as never)).rejects.toBeDefined();
  });

  it('shows an asset that holds nothing as absent, not as a zero row, and an empty account as an empty list', async () => {
    const { portfolio } = service([row(ALICE, 'ETH', 'available', '0'), row(ALICE, 'ETH', 'hold', '0', 'order:o-4')]);
    expect(await callerFor(portfolio, ALICE).portfolio.balanceBreakdown()).toEqual({ assets: [] });
  });

  it('keeps a negative lock visible rather than hiding it, so a broken book is seen and not netted away', async () => {
    const { portfolio } = service([row(ALICE, 'USDT', 'available', '10'), row(ALICE, 'USDT', 'hold', '-3', 'order:o-5')]);
    const out = await callerFor(portfolio, ALICE).portfolio.balanceBreakdown();
    expect(out.assets).toEqual([
      {
        assetId: 'USDT',
        total: '7',
        available: '10',
        locked: [{ kind: 'hold', amount: '-3', claims: [{ purpose: 'order:o-5', amount: '-3' }] }],
      },
    ]);
  });

  it('refuses a caller without bank:read and an anonymous caller, and reads nothing', async () => {
    const { portfolio, asked } = service([row(ALICE, 'USDT', 'available', '5')]);
    await expect(callerFor(portfolio, ALICE, ['trade:read']).portfolio.balanceBreakdown()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      createBankRouter({ portfolio } as unknown as BankServices)
        .createCaller(edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' }))
        .portfolio.balanceBreakdown(),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(asked).toEqual([]);
  });

  it('answers a ledger failure as a typed refusal, never as an empty list', async () => {
    const ledger = {
      balances: async () => {
        throw new Error('ledger down');
      },
    } as unknown as Pick<LedgerClient, 'balances'>;
    const portfolio = new PortfolioService(ledger, { namedSpaces: async () => [] });
    await expect(callerFor(portfolio, ALICE).portfolio.balanceBreakdown()).rejects.toBeDefined();
  });
});
