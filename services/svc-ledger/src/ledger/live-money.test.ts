import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InvalidEntryError, parseAmount as amt, userAvailable } from '@intafaced/ledger-client';
import { assertScaledBigintAmounts, parseStoredAmount } from './live-money.js';

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

  // The two stub-driven tests that stood here pinned "snapshot only after green, only while the tip
  // lock is held" against a fake `sql.begin`. The proof no longer takes a tip lock (#4755). Their
  // real-database successors live in snapshot-anchor.test.ts ('a failed proof writes no snapshot',
  // 'snapshot rows carry the tip the proof read') and run against Postgres, not a fake.

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
