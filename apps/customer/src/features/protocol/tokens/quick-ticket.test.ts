import { describe, expect, it } from 'vitest';
import { balanceOfCall, deepestPair, readUnits } from './quick-ticket';

const pair = (pool: string, reserve: string) => ({
  pool,
  other: { address: `0x${'b'.repeat(40)}`, name: 'TEST Token B', symbol: 'TESTB', decimals: 18 },
  feeBps: 30,
  reserve,
  reserveOther: '1',
  volume: '0',
  candles: [],
});

describe('quick ticket helpers', () => {
  it('encodes balanceOf with the selector and the owner padded to one word', () => {
    expect(balanceOfCall('0xD9C329E66684830090783D41517EA9F8916222A4')).toBe(
      '0x70a08231000000000000000000000000d9c329e66684830090783d41517ea9f8916222a4',
    );
  });

  it('reads one uint256 word exactly and refuses anything else', () => {
    expect(readUnits('0x00000000000000000000000000000000000000000000021e19e0c9bab2400000')).toBe(10_000n * 10n ** 18n);
    expect(readUnits(null)).toBeNull();
    expect(readUnits('0x')).toBeNull();
    expect(readUnits('not hex')).toBeNull();
    expect(readUnits(`0x${'1'.repeat(65)}`)).toBeNull();
  });

  it('starts on the pool holding most of the token, and none when it is in no pool', () => {
    const shallow = pair(`0x${'1'.repeat(40)}`, '900000000000000000000');
    const deep = pair(`0x${'2'.repeat(40)}`, '1000000000000000000000');
    expect(deepestPair([shallow, deep])?.pool).toBe(deep.pool);
    expect(deepestPair([])).toBeNull();
  });
});
