import { describe, expect, it } from 'vitest';
import { checkAmount, shortenAddress } from './withdraw-model';

describe('checkAmount: the typed amount against the available balance, exactly', () => {
  it('says nothing for an empty box and rejects anything that is not a plain decimal', () => {
    expect(checkAmount('', '10')).toBe('empty');
    expect(checkAmount('   ', '10')).toBe('empty');
    for (const bad of ['abc', '1e3', '-5', '1,5', '1.', '.5', '0x10']) expect(checkAmount(bad, '10'), bad).toBe('invalid');
  });
  it('rejects zero, and more places than the ledger carries', () => {
    expect(checkAmount('0', '10')).toBe('zero');
    expect(checkAmount('0.000', '10')).toBe('zero');
    expect(checkAmount('0.0000000000000000001', '10')).toBe('invalid');
  });
  it('accepts up to the available balance and no further, with no rounding', () => {
    expect(checkAmount('569.015372', '569.015372')).toBe('ok');
    expect(checkAmount('569.015373', '569.015372')).toBe('tooMuch');
    expect(checkAmount('0.000000000000000001', '0.000000000000000001')).toBe('ok');
    expect(checkAmount('0.000000000000000002', '0.000000000000000001')).toBe('tooMuch');
  });
  it('cannot judge an amount when the balance is missing or unreadable, and never calls it ok', () => {
    expect(checkAmount('1000000', null)).toBe('unknown');
    expect(checkAmount('5', 'not a number')).toBe('unknown');
    expect(checkAmount('', null)).toBe('empty');
    expect(checkAmount('abc', null)).toBe('invalid');
  });
});

describe('shortenAddress', () => {
  it('keeps the first six and last four characters of a long address', () => {
    expect(shortenAddress('0x52908400098527886E0F7030069857D2E4169EE7')).toBe('0x5290…9EE7');
  });
  it('shows a short one whole, trimmed', () => {
    expect(shortenAddress('  abc123  ')).toBe('abc123');
  });
});
