import { describe, expect, it } from 'vitest';
import { InvalidEntryError } from '../types.js';
import { BANK_TRANSFER_KEY_SPACES, bankTransferKey, type BankTransferKeySpace } from './bank.js';
import { BANK_TRANSFER_REVERSAL_KEY_SPACES, bankTransferReversalKey, type BankTransferReversalKeySpace } from './bank-transfer-reversal.js';

describe('bank transfer key spaces: cashback-rev and recovery (LG-bank-key-spaces-01, D55)', () => {
  it("bankTransferKey('cashback-rev','R-1',0) -> bank.transfer.cashback-rev:R-1:0", () => {
    expect(bankTransferKey('cashback-rev', 'R-1', 0)).toBe('bank.transfer.cashback-rev:R-1:0');
  });

  it("bankTransferKey('recovery','X',0) -> bank.transfer.recovery:X:0", () => {
    expect(bankTransferKey('recovery', 'X', 0)).toBe('bank.transfer.recovery:X:0');
  });

  it('unknown space still throws InvalidEntryError', () => {
    expect(() => bankTransferKey('cashback' as BankTransferKeySpace, 'R-1', 0)).toThrow(InvalidEntryError);
    expect(() => bankTransferKey('recover' as BankTransferKeySpace, 'R-1', 0)).toThrow(InvalidEntryError);
  });

  it('the existing spaces are unchanged and every key prefix is unique', () => {
    expect(BANK_TRANSFER_KEY_SPACES.slice(0, 4)).toEqual(['own', 'p2p', 'sched', 'rail']);
    const prefixes = BANK_TRANSFER_KEY_SPACES.map((s) => `bank.transfer.${s}:`);
    for (const a of prefixes) for (const b of prefixes) if (a !== b) expect(b.startsWith(a)).toBe(false);
  });

  it('a consented reversal stays internal-only: cashback-rev, recovery and rail are refused (DR6 MAJOR)', () => {
    expect(BANK_TRANSFER_REVERSAL_KEY_SPACES).toEqual(['own', 'p2p', 'sched']);
    for (const space of ['cashback-rev', 'recovery', 'rail']) {
      expect(() => bankTransferReversalKey(space as BankTransferReversalKeySpace, 'T-1', 0)).toThrow(InvalidEntryError);
    }
    expect(bankTransferReversalKey('own', 'T-1', 0)).toBe('bank.transfer.reverse:own:T-1:0');
  });
});
