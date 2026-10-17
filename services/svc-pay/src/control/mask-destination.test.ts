import { describe, expect, it } from 'vitest';
import { maskDestination, safeDestinationLabel } from './mask-destination.js';

const ADDRESS = '0x1111112222222222222222222222222222333333';
const IBAN = 'DE89 3704 0044 0532 0130 00';

describe('maskDestination', () => {
  it('masks a chain address as first 6 and last 4, and an account as last 4', () => {
    expect(maskDestination('crypto', ADDRESS)).toBe('0x1111…3333');
    expect(maskDestination('crypto', `  ${ADDRESS}  `)).toBe('0x1111…3333');
    expect(maskDestination('bank', IBAN)).toBe('••••3000');
    expect(maskDestination('bank', 'HDFC0001234')).toBe('••••1234');
    // An address-shaped ref is masked as an address even when the kind label is wrong.
    expect(maskDestination('bank', ADDRESS)).toBe('0x1111…3333');
  });

  it('never returns the full destination, including when the value is too short to hide', () => {
    for (const [kind, ref] of [
      ['crypto', ADDRESS],
      ['crypto', '0xabc'],
      ['bank', IBAN],
      ['bank', '1234'],
      ['bank', '12345'],
      ['bank', ''],
    ] as const) {
      const masked = maskDestination(kind, ref);
      const compact = ref.replace(/\s+/g, '');
      expect(masked.length).toBeLessThanOrEqual(16);
      if (compact.length > 0) expect(masked).not.toContain(compact);
    }
    expect(maskDestination('crypto', '0xabc')).toBe('••••');
    expect(maskDestination('bank', '1234')).toBe('••••');
    expect(maskDestination('bank', '12345')).toBe('••••');
    expect(maskDestination('crypto', ADDRESS)).not.toContain('222222');
  });

  it('hides a crypto ref shorter than 20 characters, and shows first 6 and last 4 from 20', () => {
    for (const ref of ['0123456789', '0123456789a', '0123456789ab', '0123456789abc', '1234567890123456789']) {
      expect(ref.length).toBeLessThan(20);
      expect(maskDestination('crypto', ref)).toBe('••••');
      expect(maskDestination('crypto', ref)).not.toContain(ref.slice(0, 4));
    }
    const twenty = 'abcdefghij0123456789';
    expect(twenty).toHaveLength(20);
    expect(maskDestination('crypto', twenty)).toBe('abcdef…6789');
    expect(maskDestination('crypto', twenty)).not.toContain(twenty);
    expect(maskDestination('crypto', `  ${twenty}  `)).toBe('abcdef…6789');
  });

  it('shows the last 4 of an account only when it has at least 9 characters', () => {
    expect(maskDestination('bank', '12345678')).toBe('••••');
    expect(maskDestination('bank', '123456789')).toBe('••••6789');
    expect(maskDestination('bank', '1234 5678')).toBe('••••');
    expect(maskDestination('bank', '1234 56789')).toBe('••••6789');
  });
});

describe('safeDestinationLabel', () => {
  it('keeps a rail or kind label and refuses a label that is the destination', () => {
    expect(safeDestinationLabel('crypto-native', ADDRESS)).toBe('crypto-native');
    expect(safeDestinationLabel('crypto', ADDRESS)).toBe('crypto');
    expect(safeDestinationLabel('bank', IBAN)).toBe('bank');
    expect(safeDestinationLabel(IBAN.replace(/\s+/g, ''), IBAN)).toBe('unknown');
    expect(safeDestinationLabel('not a rail', ADDRESS)).toBe('unknown');
    expect(safeDestinationLabel('', ADDRESS)).toBe('unknown');
  });
});
