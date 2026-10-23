import { describe, expect, it } from 'vitest';
import * as ledgerMoney from '@intafaced/ledger-client/money';
import * as math from './index.js';

describe('money-math', () => {
  it('is the ledger client money module, export for export', () => {
    expect(Object.keys(math).sort()).toEqual(Object.keys(ledgerMoney).sort());
    for (const [name, value] of Object.entries(ledgerMoney)) expect(math[name as keyof typeof math], name).toBe(value);
  });

  it('offers no recipe or ledger client', () => {
    for (const name of ['recipes', 'createHttpLedgerClient', 'MemoryLedger', 'ledgerPostWire']) {
      expect(Object.keys(math), name).not.toContain(name);
    }
  });
});
