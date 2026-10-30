import { describe, expect, it } from 'vitest';
import { encodeFunctionData, getAddress, parseAbi } from 'viem';
import { decodeInput, gwei, nativeAmount } from './decode';

const TO = '0x00000000000000000000000000000000000000aa';

describe('decodeInput', () => {
  it('names each argument of a known method', () => {
    const data = encodeFunctionData({
      abi: parseAbi(['function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)']),
      functionName: 'swapExactIn',
      args: [TO, 10n ** 18n, 5n, TO],
    });
    expect(decodeInput(data, TO)).toEqual({
      kind: 'decoded',
      method: 'swapExactIn',
      args: [
        { name: 'tokenIn', type: 'address', value: getAddress(TO) },
        { name: 'amountIn', type: 'uint256', value: '1000000000000000000' },
        { name: 'minAmountOut', type: 'uint256', value: '5' },
        { name: 'to', type: 'address', value: getAddress(TO) },
      ],
    });
  });

  it("reads a swap through the router, which names its pool, apart from the pool's own swap", () => {
    const data = encodeFunctionData({
      abi: parseAbi(['function swapExactIn(address pool, address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)']),
      functionName: 'swapExactIn',
      args: [TO, TO, 7n, 1n, TO],
    });
    const decoded = decodeInput(data, TO);
    expect(decoded.kind === 'decoded' && decoded.args.map((arg) => arg.name)).toEqual([
      'pool',
      'tokenIn',
      'amountIn',
      'minAmountOut',
      'to',
    ]);
  });

  it('an unknown method keeps its selector and invents no names', () => {
    expect(decodeInput('0xdeadbeef0000', TO)).toEqual({ kind: 'unknown', selector: '0xdeadbeef' });
  });

  it('a creation and an empty input are said so', () => {
    expect(decodeInput('0x6080', null)).toEqual({ kind: 'creation' });
    expect(decodeInput('0x', TO)).toEqual({ kind: 'empty' });
  });

  it('a truncated known call is not decoded', () => {
    expect(decodeInput('0xa9059cbb00', TO)).toEqual({ kind: 'unknown', selector: '0xa9059cbb' });
  });
});

describe('units', () => {
  it('formats exactly from decimal strings', () => {
    expect(nativeAmount('12345678901234567890')).toBe('12.34567890123456789');
    expect(gwei('7')).toBe('0.000000007');
  });
});
