import { describe, expect, it } from 'vitest';
import { checkAddress, checkAmount, checkLabel, checkTag, shortenAddress } from './withdraw-model';

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

describe('address-book entry checks, the bank’s own rules made before any call', () => {
  it('accepts an EVM address and refuses anything else with a reason', () => {
    expect(checkAddress('0x52908400098527886E0F7030069857D2E4169EE7')).toBe('ok');
    expect(checkAddress('  0x52908400098527886e0f7030069857d2e4169ee7 ')).toBe('ok');
    expect(checkAddress('')).toBe('empty');
    for (const bad of ['0x1234', '52908400098527886E0F7030069857D2E4169EE7', '0x52908400098527886E0F7030069857D2E4169EG7', 'TXyz'])
      expect(checkAddress(bad), bad).toBe('invalid');
  });
  it('takes a label of 1 to 64 characters with no spaces at either end, and an optional tag on the same rule', () => {
    expect(checkLabel('Cold wallet')).toBe('ok');
    expect(checkLabel('  ')).toBe('empty');
    expect(checkLabel(' x')).toBe('invalid');
    expect(checkLabel('x'.repeat(65))).toBe('invalid');
    expect(checkLabel('a\tb')).toBe('invalid');
    expect(checkTag('')).toBe('ok');
    expect(checkTag('777')).toBe('ok');
    expect(checkTag('777 ')).toBe('invalid');
  });
});
