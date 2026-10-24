import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount, recipes, type Amount } from '@intafaced/ledger-client';
import type { SpaceRecord, SpaceService } from '../spaces/space-service.js';
import { memoryLedgerHistory, type LedgerEntryRecord, type LedgerHistory } from './ledger-history.js';
import { SPEND_CATEGORIES, SpendAnalytics, categorise, type SpendSummary } from './spend.js';

/**
 * Deposit credits are not rewards. No Postgres: the classifier is pure, and
 * the summary is driven from a ledger history port.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const ASSET = 'USDT';
const RANGE = { from: new Date('2020-01-01T00:00:00Z'), to: new Date('2030-01-01T00:00:00Z') };

const ZERO_BUCKETS = {
  transfers: '0',
  trading: '0',
  p2p: '0',
  fees: '0',
  withdrawals: '0',
  earn: '0',
  deposits: '0',
  rewards: '0',
  other: '0',
} as const;

function primarySpace(): SpaceRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    userId: USER,
    assetId: ASSET,
    kind: 'primary',
    name: 'Main',
    goalTarget: null,
    lockedUntil: null,
    unlockRequestedAt: null,
    unlocksAt: null,
    archivedAt: null,
  };
}

function analytics(history: LedgerHistory): SpendAnalytics {
  const spaces = {
    namedSpaces: async () => [primarySpace()],
  } as unknown as SpaceService;
  return new SpendAnalytics(spaces, history);
}

function entry(reason: string, direction: 'debit' | 'credit', amount: string): LedgerEntryRecord {
  return {
    txId: `tx-${reason}-${direction}`,
    module: 'ledger',
    reason,
    direction,
    amount: parseAmount(amount),
    postedAt: new Date('2026-06-01T00:00:00Z'),
  };
}

async function summarise(entries: readonly LedgerEntryRecord[]): Promise<SpendSummary> {
  const history: LedgerHistory = {
    async entriesFor() {
      return [...entries];
    },
  };
  return analytics(history).spendSummary({ userId: USER, assetId: ASSET, range: RANGE });
}

describe('categorise', () => {
  it('sends every deposit reason to deposits', () => {
    expect(SPEND_CATEGORIES).toContain('deposits');
    expect(SPEND_CATEGORIES).toContain('rewards');
    expect(categorise('deposit.credited')).toBe('deposits');
    expect(categorise('deposit')).toBe('deposits');
    expect(categorise('deposit.pending')).toBe('deposits');
  });

  it('keeps reward and token.yield in rewards', () => {
    expect(categorise('reward')).toBe('rewards');
    expect(categorise('reward.paid')).toBe('rewards');
    expect(categorise('token.yield')).toBe('rewards');
    expect(categorise('token.yield.paid')).toBe('rewards');
    expect(categorise('bank.earn.deposited')).toBe('earn');
  });
});

describe('spend summary deposits bucket', () => {
  it('puts a deposit.credited inflow in deposits, not rewards', async () => {
    const ledger = new MemoryLedger();
    const amount: Amount = parseAmount('1000');
    await ledger.post(recipes.deposit({ userId: USER, assetId: ASSET, amount, rail: 'test', railRef: 'analytics-deposit' }));

    const summary = await analytics(memoryLedgerHistory(ledger)).spendSummary({
      userId: USER,
      assetId: ASSET,
      range: { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) },
    });

    expect(summary.outflowByCategory.deposits).toBe('1000');
    expect(summary.outflowByCategory.rewards).toBe('0');
    expect(summary.totalInflow).toBe('1000');
    expect(summary.totalOutflow).toBe('0');
  });

  it('puts a deposit.credited outflow in deposits, not rewards', async () => {
    const summary = await summarise([entry('deposit.credited', 'credit', '5')]);
    expect(summary.outflowByCategory.deposits).toBe('5');
    expect(summary.outflowByCategory.rewards).toBe('0');
    expect(summary.totalOutflow).toBe('5');
  });

  it('keeps a reward outflow in rewards', async () => {
    const reward = await summarise([entry('reward.paid', 'credit', '5')]);
    expect(reward.outflowByCategory.rewards).toBe('5');
    expect(reward.outflowByCategory.deposits).toBe('0');

    const yieldPaid = await summarise([entry('token.yield.paid', 'credit', '5')]);
    expect(yieldPaid.outflowByCategory.rewards).toBe('5');
    expect(yieldPaid.outflowByCategory.deposits).toBe('0');
  });

  it('reports an empty deposits bucket as the decimal string 0', async () => {
    const summary = await summarise([]);
    expect(summary.outflowByCategory).toEqual(ZERO_BUCKETS);
    expect(summary.outflowByCategory.deposits).toBe('0');
  });
});
