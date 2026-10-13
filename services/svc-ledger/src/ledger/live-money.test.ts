import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql, TransactionSql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { InvalidEntryError, parseAmount as amt, userAvailable } from '@intafaced/ledger-client';
import { assertScaledBigintAmounts, parseStoredAmount } from './live-money.js';
import { runScheduledReconciliation, type ReconciliationReport } from './reconcile.js';

/** Enough of a client for the tip lock. The insert itself is not this stub's job. */
function sqlThatLocksTip(onLock: () => void): Sql {
  const tx = ((strings: TemplateStringsArray) => {
    const text = strings.join(' ');
    if (!text.includes('FOR UPDATE')) {
      return Promise.reject(new Error(`scheduled reconciliation ran SQL before the snapshot decision: ${text}`));
    }
    onLock();
    return Promise.resolve([{ hash: 'tip-hash', seq: '4', frozen: false, reason: null }]);
  }) as unknown as Sql;
  Object.assign(tx, { savepoint: (fn: (held: TransactionSql) => Promise<unknown>) => fn(tx as unknown as TransactionSql) });
  return {
    begin: (_isolation: string, fn: (tx: Sql) => Promise<unknown>) => fn(tx),
  } as unknown as Sql;
}

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

const LIVE_MONEY_FILES = [
  'ledger/live-money.ts',
  'ledger/postgres-ledger.ts',
  'ledger/reconcile.ts',
  'ledger/history.ts',
  's2s-http.ts',
  'router.ts',
  'service.ts',
  'operator-http.ts',
  'index.ts',
] as const;

function failedReport(): ReconciliationReport {
  return {
    ok: false,
    ranAt: new Date('2026-08-26T00:00:00.000Z'),
    balances: { ok: false, drift: [], accountsChecked: 1 },
    chain: { ok: true, length: 3 },
    totals: { USDT: '1' },
    unbalancedAssets: ['USDT'],
  };
}

function greenReport(): ReconciliationReport {
  return {
    ok: true,
    ranAt: new Date('2026-08-26T00:00:00.000Z'),
    balances: { ok: true, accountsChecked: 1 },
    chain: { ok: true, length: 3 },
    totals: { USDT: '0' },
    unbalancedAssets: [],
  };
}

describe('live money — refuse Number/parseFloat, refuse a broken snapshot', () => {
  it('refuses a JS number amount instead of mixing it into bigint math', () => {
    expect(() =>
      assertScaledBigintAmounts([
        { account: userAvailable('11111111-1111-4111-8111-111111111111', 'USDT'), direction: 'debit', amount: 10 as never },
      ]),
    ).toThrow(InvalidEntryError);
  });

  it('accepts a scaled bigint amount', () => {
    expect(() =>
      assertScaledBigintAmounts([
        { account: userAvailable('11111111-1111-4111-8111-111111111111', 'USDT'), direction: 'debit', amount: amt('10') },
      ]),
    ).not.toThrow();
  });

  it('refuses a stored column that arrived as a JS number', () => {
    expect(() => parseStoredAmount(0.1, 'accounts.balance')).toThrow(InvalidEntryError);
    expect(() => parseStoredAmount(1, 'accounts.balance')).toThrow(/JS number/);
    expect(parseStoredAmount('12.5', 'accounts.balance')).toBe(amt('12.5'));
  });

  it('does not snapshot a book that failed reconciliation — that would heal the break as success', async () => {
    let snapshotted = 0;
    let locked = false;
    const result = await runScheduledReconciliation(
      sqlThatLocksTip(() => {
        locked = true;
      }),
      {
        reconcileInTransaction: async () => failedReport(),
        haltReconciliationInTransaction: async () => {
          throw new Error('unexpected proof throw');
        },
        publishReconciliationResult: async () => {},
      },
      async () => {
        snapshotted += 1;
        return 1;
      },
    );
    expect(locked).toBe(true);
    expect(result.snapshotted).toBe(false);
    expect(result.report.ok).toBe(false);
    expect(snapshotted).toBe(0);
  });

  it('snapshots only after the book proves green, and only while the tip lock is already held', async () => {
    let snapshotted = 0;
    let locked = false;
    const result = await runScheduledReconciliation(
      sqlThatLocksTip(() => {
        locked = true;
      }),
      {
        haltReconciliationInTransaction: async () => {
          throw new Error('unexpected proof throw');
        },
        publishReconciliationResult: async () => {},
        reconcileInTransaction: async () => {
          expect(locked).toBe(true);
          return greenReport();
        },
      },
      async () => {
        expect(locked).toBe(true);
        snapshotted += 1;
        return 4;
      },
    );
    expect(result.snapshotted).toBe(true);
    expect(snapshotted).toBe(1);
  });

  it('live money files never coerce with Number() or parseFloat', () => {
    for (const rel of LIVE_MONEY_FILES) {
      const code = readFileSync(join(srcRoot, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(code, rel).not.toMatch(/\bparseFloat\s*\(/);
      expect(code, rel).not.toMatch(/\bNumber\s*\(/);
    }
  });
});
