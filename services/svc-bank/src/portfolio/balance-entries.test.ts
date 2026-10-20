import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt, type Balance, type LedgerClient } from '@intafaced/ledger-client';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import type { LedgerHistoryPages, LedgerPageEntry } from '../activity/activity-service.js';
import type { SpaceRecord } from '../spaces/space-service.js';
import { PortfolioService, type SpaceLister } from './portfolio-service.js';

/**
 * `bank.portfolio.balanceEntries` through the real router and edge context, with a fake ledger and a fake history. The
 * invariant: the signed sum of the entries read equals the live spendable balance, or the call refuses
 * `portfolio.entries_do_not_sum` with the gap and shows no list.
 */

const SECRET = 'a-bank-balance-entries-edge-secret-long-enough';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SPACE = '44444444-4444-4444-8444-444444444444';

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
    id: 'req-entries',
  });
}

const bal = (ownerType: 'user' | 'subaccount', ownerId: string, assetId: string, kind: 'available' | 'hold', amount: string): Balance => ({
  account: { ownerType, ownerId, assetId, kind },
  accountId: `${ownerType}-${ownerId}-${assetId}-${kind}`,
  amount: amt(amount),
});

let seq = 0;
const entry = (assetId: string, direction: 'debit' | 'credit', amount: string, at: string): LedgerPageEntry => ({
  txId: `tx-${(seq += 1)}`,
  module: 'bank',
  reason: 'test',
  direction,
  amount,
  postedAt: new Date(at),
  assetId,
  entryId: String(seq),
});

function build(opts: {
  balances: Balance[];
  history: Record<string, LedgerPageEntry[]>;
  spaces?: SpaceRecord[];
  pageSize?: number;
  failAt?: number;
}) {
  const ledger = {
    balances: async (ownerType: string, ownerId: string) =>
      opts.balances.filter((r) => r.account.ownerType === ownerType && r.account.ownerId === ownerId),
  } as unknown as Pick<LedgerClient, 'balances'>;
  const lister: SpaceLister = { namedSpaces: async (userId) => (opts.spaces ?? []).filter((s) => s.userId === userId) };
  let calls = 0;
  const pages: LedgerHistoryPages = {
    page: async (req) => {
      calls += 1;
      if (opts.failAt !== undefined && calls >= opts.failAt) throw new Error('ledger down');
      const all = (opts.history[`${req.ownerType}:${req.ownerId}`] ?? []).filter((e) => e.assetId === req.assetId);
      const start = req.cursor === undefined ? 0 : Number(req.cursor);
      const size = opts.pageSize ?? 200;
      const entries = all.slice(start, start + size);
      return { entries, nextCursor: start + size < all.length ? String(start + size) : null };
    },
  };
  const portfolio = new PortfolioService(ledger, lister, { pages });
  return createBankRouter({ portfolio } as unknown as BankServices).createCaller(signed(ALICE));
}

const space = { id: SPACE, userId: ALICE, kind: 'named', name: 'Holiday' } as unknown as SpaceRecord;

describe('bank.portfolio.balanceEntries', () => {
  it('lists the entries newest first and says they sum to the balance', async () => {
    const caller = build({
      balances: [bal('user', ALICE, 'USDT', 'available', '70'), bal('user', ALICE, 'USDT', 'hold', '30')],
      history: {
        [`user:${ALICE}`]: [entry('USDT', 'debit', '100', '2026-10-01T00:00:00Z'), entry('USDT', 'credit', '30', '2026-10-02T00:00:00Z')],
      },
    });
    const out = await caller.portfolio.balanceEntries({ assetId: 'usdt' });
    expect(out.entries.map((e) => e.amount)).toEqual(['30', '100']);
    expect(out.sumCheck).toEqual({ ok: true, entriesSum: '70', balance: '70', entryCount: 2 });
  });

  it('refuses with the gap when one unit is missing, and shows no list', async () => {
    const caller = build({
      balances: [bal('user', ALICE, 'USDT', 'available', '71')],
      history: { [`user:${ALICE}`]: [entry('USDT', 'debit', '70', '2026-10-01T00:00:00Z')] },
    });
    await expect(caller.portfolio.balanceEntries({ assetId: 'USDT' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('portfolio.entries_do_not_sum'),
    });
    await expect(caller.portfolio.balanceEntries({ assetId: 'USDT' })).rejects.toThrow(/gap of -1/);
  });

  it('sums main and a Space for all accounts, and each alone', async () => {
    const config = {
      balances: [bal('user', ALICE, 'BTC', 'available', '2'), bal('subaccount', SPACE, 'BTC', 'available', '3')],
      history: {
        [`user:${ALICE}`]: [entry('BTC', 'debit', '2', '2026-10-01T00:00:00Z')],
        [`subaccount:${SPACE}`]: [entry('BTC', 'debit', '3', '2026-10-03T00:00:00Z')],
      },
      spaces: [space],
    };
    const caller = build(config);
    const all = await caller.portfolio.balanceEntries({ assetId: 'BTC' });
    expect(all.sumCheck.balance).toBe('5');
    expect(all.entries.map((e) => e.accountId)).toEqual([SPACE, 'main']);
    expect((await caller.portfolio.balanceEntries({ assetId: 'BTC', accountId: 'main' })).sumCheck.balance).toBe('2');
    expect((await caller.portfolio.balanceEntries({ assetId: 'BTC', accountId: SPACE })).sumCheck.balance).toBe('3');
  });

  it('pages by offset and checks the whole history, not just the page', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => entry('ETH', 'debit', '1', `2026-10-0${i + 1}T00:00:00Z`));
    const caller = build({ balances: [bal('user', ALICE, 'ETH', 'available', '5')], history: { [`user:${ALICE}`]: rows }, pageSize: 2 });
    const first = await caller.portfolio.balanceEntries({ assetId: 'ETH', limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.sumCheck.entryCount).toBe(5);
    const last = await caller.portfolio.balanceEntries({ assetId: 'ETH', limit: 2, cursor: first.nextCursor! });
    const end = await caller.portfolio.balanceEntries({ assetId: 'ETH', limit: 2, cursor: last.nextCursor! });
    expect(end.nextCursor).toBeNull();
    expect([...first.entries, ...last.entries, ...end.entries].map((e) => e.txId)).toHaveLength(5);
  });

  it('gives no partial check when a history page fails midway', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => entry('ETH', 'debit', '1', `2026-10-0${i + 1}T00:00:00Z`));
    const caller = build({
      balances: [bal('user', ALICE, 'ETH', 'available', '4')],
      history: { [`user:${ALICE}`]: rows },
      pageSize: 2,
      failAt: 2,
    });
    await expect(caller.portfolio.balanceEntries({ assetId: 'ETH' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it("refuses a Space that is not the caller's and never reads another user", async () => {
    const caller = build({
      balances: [],
      history: {},
      spaces: [{ id: SPACE, userId: BOB, kind: 'named', name: 'Bob' } as unknown as SpaceRecord],
    });
    await expect(caller.portfolio.balanceEntries({ assetId: 'BTC', accountId: SPACE })).rejects.toBeDefined();
    await expect(caller.portfolio.balanceEntries({ assetId: 'BTC', userId: BOB } as never)).rejects.toBeDefined();
  });

  it('refuses when no history source is wired', async () => {
    const ledger = { balances: async () => [] } as unknown as Pick<LedgerClient, 'balances'>;
    const portfolio = new PortfolioService(ledger, { namedSpaces: async () => [] });
    const caller = createBankRouter({ portfolio } as unknown as BankServices).createCaller(signed(ALICE));
    await expect(caller.portfolio.balanceEntries({ assetId: 'BTC' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
