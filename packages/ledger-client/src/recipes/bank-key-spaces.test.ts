import { describe, expect, it } from 'vitest';
import { InvalidEntryError } from '../types.js';
import { BANK_TRANSFER_KEY_SPACES, bankTransferKey, type BankTransferKeySpace } from './bank.js';

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
});
