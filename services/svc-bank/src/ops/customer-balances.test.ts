import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt, type Balance, type LedgerClient } from '@intafaced/ledger-client';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import type { LedgerHistoryPages } from '../activity/activity-service.js';
import { PortfolioService } from '../portfolio/portfolio-service.js';
import { flattenBreakdown } from './customer-balances.js';

/**
 * `bank.ops.customerBalances` and `bank.ops.customerBalanceEntries` through the real router and edge context: the finance-treasury
 * desk reads a customer's balances with `admin:treasury` only, every read is logged with operator and customer before any figure
 * is read, and a customer's own session is refused.
 */

const SECRET = 'a-bank-customer-balances-edge-secret-long-enough';
const OPERATOR = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

function signed(userId: string, scopes: string[]) {
  const principal = {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-desk',
  });
}

const row = (assetId: string, kind: 'available' | 'hold' | 'stake', amount: string, purpose?: string): Balance => ({
  account: { ownerType: 'user', ownerId: CUSTOMER, assetId, kind, ...(purpose ? { purpose } : {}) },
  accountId: `${assetId}-${kind}-${purpose ?? ''}`,
  amount: amt(amount),
});

function build(rows: Balance[], entries: Array<{ direction: 'debit' | 'credit'; amount: string }> = [], withPages = true) {
  const asked: string[] = [];
  const ledger = {
    balances: async (ownerType: string, ownerId: string) => {
      asked.push(`${ownerType}:${ownerId}`);
      return rows.filter((r) => r.account.ownerType === ownerType && r.account.ownerId === ownerId);
    },
  } as unknown as Pick<LedgerClient, 'balances'>;
  const pages: LedgerHistoryPages = {
    page: async () => ({
      entries: entries.map((e, i) => ({
        txId: `t${i}`,
        module: 'bank',
        reason: 'x',
        direction: e.direction,
        amount: e.amount,
        postedAt: new Date(`2026-10-0${i + 1}T00:00:00Z`),
        assetId: 'USDT',
        entryId: String(i + 1),
      })),
      nextCursor: null,
    }),
  };
  const portfolio = new PortfolioService(ledger, { namedSpaces: async () => [] }, withPages ? { pages } : {});
  const router = createBankRouter({ portfolio } as unknown as BankServices);
  return { asked, as: (userId: string, scopes: string[]) => router.createCaller(signed(userId, scopes)) };
}

describe('finance-treasury customer balances', () => {
  it('shows the same split as the customer, one column per lock kind, and logs the read first', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { as } = build([row('USDT', 'available', '70'), row('USDT', 'hold', '20', 'order:a'), row('USDT', 'stake', '10', 'earn:p')]);
    const out = await as(OPERATOR, ['admin:treasury']).ops.customerBalances({ userId: CUSTOMER });
    expect(out.assets).toEqual([{ assetId: 'USDT', total: '100', available: '70', hold: '20', escrow: '0', stake: '10', collateral: '0' }]);
    const line = JSON.parse(String(info.mock.calls.at(-1)?.[0]));
    expect(line).toMatchObject({
      event: 'bank.ops.customer_balances_read',
      actorUserId: OPERATOR,
      ownerUserId: CUSTOMER,
      what: 'breakdown',
    });
    info.mockRestore();
  });

  it('refuses a customer session and an operator without the treasury scope, and reads nothing', async () => {
    const { as, asked } = build([row('USDT', 'available', '5')]);
    await expect(as(CUSTOMER, ['bank:read']).ops.customerBalances({ userId: CUSTOMER })).rejects.toBeDefined();
    await expect(as(OPERATOR, ['admin:compliance']).ops.customerBalances({ userId: CUSTOMER })).rejects.toBeDefined();
    await expect(as(CUSTOMER, ['bank:read']).ops.customerBalanceEntries({ userId: CUSTOMER, assetId: 'USDT' })).rejects.toBeDefined();
    expect(asked).toEqual([]);
  });

  it('refuses a smuggled field and a non-uuid customer', async () => {
    const { as } = build([]);
    await expect(as(OPERATOR, ['admin:treasury']).ops.customerBalances({ userId: 'nope' })).rejects.toBeDefined();
    await expect(as(OPERATOR, ['admin:treasury']).ops.customerBalances({ userId: CUSTOMER, extra: 1 } as never)).rejects.toBeDefined();
  });

  it('refuses the read when the audit line cannot be written', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('log sink down');
    });
    const { as, asked } = build([row('USDT', 'available', '5')]);
    await expect(as(OPERATOR, ['admin:treasury']).ops.customerBalances({ userId: CUSTOMER })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(asked).toEqual([]);
    info.mockRestore();
  });

  it('lists the entries behind the balance with the sum check, and names a mismatch', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const ok = build(
      [row('USDT', 'available', '70')],
      [
        { direction: 'debit', amount: '100' },
        { direction: 'credit', amount: '30' },
      ],
    );
    const out = await ok.as(OPERATOR, ['admin:treasury']).ops.customerBalanceEntries({ userId: CUSTOMER, assetId: 'USDT' });
    expect(out.sumCheck).toEqual({ ok: true, entriesSum: '70', balance: '70', entryCount: 2 });
    const bad = build([row('USDT', 'available', '71')], [{ direction: 'debit', amount: '70' }]);
    await expect(
      bad.as(OPERATOR, ['admin:treasury']).ops.customerBalanceEntries({ userId: CUSTOMER, assetId: 'USDT' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: expect.objectContaining({ code: 'portfolio.entries_do_not_sum' }),
    });
    info.mockRestore();
  });

  it('says the history is unavailable when the history reads are not set up, not an opaque error', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const off = build([row('USDT', 'available', '5')], [], false);
    await expect(
      off.as(OPERATOR, ['admin:treasury']).ops.customerBalanceEntries({ userId: CUSTOMER, assetId: 'USDT' }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    info.mockRestore();
  });

  it('flattens a missing lock kind to an exact zero, never a blank', () => {
    expect(flattenBreakdown([{ assetId: 'BTC', total: '1', available: '1', locked: [] }])[0]).toMatchObject({
      hold: '0',
      escrow: '0',
      stake: '0',
      collateral: '0',
    });
  });
});
