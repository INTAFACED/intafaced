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
    expect(maskDestination('bank', '12345')).toBe('••••2345');
    expect(maskDestination('crypto', ADDRESS)).not.toContain('222222');
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
