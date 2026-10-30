import { describe, expect, it } from 'vitest';
import { bpsToPercent, formatUnits, minimumOut, percentToBps, poolsFor, receivedIn, TRANSFER_TOPIC } from './swap-math';

const A = '0x00000000000000000000000000000000000a11ce';
const B = '0x00000000000000000000000000000000000b0b00';
const C = '0x00000000000000000000000000000000000071a0';
const pool = (p: string, t0: string, t1: string) => ({
  pool: p,
  token0: t0,
  token1: t1,
  feeBps: 30,
  reserve0: '1',
  reserve1: '1',
  blockTimestampLast: 0,
});

describe('swap math', () => {
  it('finds the pools for a pair in either order and none for one token', () => {
    const pools = [pool('0x1', A, B), pool('0x2', B, A), pool('0x3', A, C)];
    expect(poolsFor(pools, A, B).map((p) => p.pool)).toEqual(['0x1', '0x2']);
    expect(poolsFor(pools, B.toUpperCase().replace('0X', '0x'), A).map((p) => p.pool)).toEqual(['0x1', '0x2']);
    expect(poolsFor(pools, A, A)).toEqual([]);
  });
  it('floors the minimum and refuses one that rounds to nothing', () => {
    expect(minimumOut(10_000n, 100)).toBe(9_900n);
    expect(minimumOut(9_999n, 1)).toBe(9_998n);
    expect(minimumOut(1n, 100)).toBeNull();
    expect(minimumOut(10n, 10_000)).toBeNull();
    expect(minimumOut(10n, -1)).toBeNull();
  });
  it('reads percentages as whole basis points', () => {
    expect(percentToBps('1')).toBe(100);
    expect(percentToBps('0.5')).toBe(50);
    expect(percentToBps('0.25')).toBe(25);
    expect(percentToBps('60')).toBe(6000);
    for (const bad of ['', '1.234', '-1', 'abc', '1e2']) expect(percentToBps(bad)).toBeNull();
    expect(bpsToPercent(300)).toBe('3');
    expect(bpsToPercent(25)).toBe('0.25');
    expect(bpsToPercent(150)).toBe('1.5');
  });
  it('formats base units without a float', () => {
    expect(formatUnits(9_969_900_600_091_017_092n, 18)).toBe('9.9699');
    expect(formatUnits(1_234_567_000_000n, 6, 6)).toBe('1,234,567');
    expect(formatUnits(10_000_000n, 6, 6)).toBe('10');
  });
  it('sums only what the token paid the person in the receipt', () => {
    const me = '0x52908400098527886E0F7030069857D2E4169EE7';
    const to = `0x${me.slice(2).toLowerCase().padStart(64, '0')}`;
    const other = `0x${'1'.repeat(64)}`;
    const logs = [
      { address: B, topics: [TRANSFER_TOPIC, other, to], data: '0x05' },
      { address: B, topics: [TRANSFER_TOPIC, other, other], data: '0x07' },
      { address: A, topics: [TRANSFER_TOPIC, other, to], data: '0x09' },
      { address: B, topics: [`0x${'2'.repeat(64)}`, other, to], data: '0x11' },
    ];
    expect(receivedIn(logs, B, me)).toBe(5n);
  });
});
