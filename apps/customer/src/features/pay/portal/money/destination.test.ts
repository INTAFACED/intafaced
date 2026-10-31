import { describe, expect, it } from 'vitest';
import { maskedLike, sameMasked } from './destination';

describe('the Verify check that a retyped destination is the saved one (J-merchant-02 #5)', () => {
  const saved = '0xAbCd00000000000000000000000000000000Ef12';
  it('masks like svc-pay: first 6 and last 4 of an address, the last 4 of an account', () => {
    expect(maskedLike('crypto', saved)).toBe('0xabcd…ef12');
    expect(maskedLike('bank', 'DE89370400440532013000')).toBe('••••3000');
    expect(maskedLike('bank', 'SHORT')).toBe('••••');
  });
  it('ignores the case of a crypto address, as a checksummed one mixes it', () => {
    expect(sameMasked('crypto', saved.toLowerCase(), '0xAbCd…Ef12')).toBe(true);
    expect(sameMasked('crypto', saved.toUpperCase().replace('0X', '0x'), '0xabcd…ef12')).toBe(true);
    expect(sameMasked('crypto', '0xabcd00000000000000000000000000000000ef13', '0xabcd…ef12')).toBe(false);
  });
  it('compares an account exactly', () => {
    expect(sameMasked('bank', 'DE89370400440532013000', '••••3000')).toBe(true);
    expect(sameMasked('bank', 'DE89370400440532013001', '••••3000')).toBe(false);
  });
});
