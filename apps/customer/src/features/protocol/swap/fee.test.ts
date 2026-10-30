import { describe, expect, it } from 'vitest';
import type { ProtocolSwapFees } from '@intafaced/contracts/protocol-swap';
import { chosenFee, feeFields, toGwei } from './fee';

// TEST figures only: shaped like a fee read, not any network's live fees.
const FEES: ProtocolSwapFees = {
  asOf: '2026-10-29T12:00:00.000Z',
  chainId: 84532,
  blocks: 20,
  percentiles: [10, 50, 90],
  baseFeePerGasWei: '1000000000',
  feeCapWei: '100000000000',
  levels: {
    slow: { maxFeePerGasWei: '2000000001', maxPriorityFeePerGasWei: '1', overCap: false },
    normal: { maxFeePerGasWei: '2001000000', maxPriorityFeePerGasWei: '1000000', overCap: false },
    fast: { maxFeePerGasWei: '200000000000', maxPriorityFeePerGasWei: '198000000000', overCap: true },
  },
  sponsored: false,
};

describe('chosenFee', () => {
  it('takes a level as the service priced it', () => {
    expect(chosenFee(FEES, 'normal', '')).toEqual({ ok: true, maxFeePerGas: 2_001_000_000n, maxPriorityFeePerGas: 1_000_000n });
  });

  it('refuses a level above the cap instead of lowering it', () => {
    expect(chosenFee(FEES, 'fast', '')).toEqual({ ok: false, reason: 'over_cap' });
  });

  it('reads a custom fee in gwei as the most per gas, with Normal’s priority', () => {
    expect(chosenFee(FEES, 'custom', '5')).toEqual({ ok: true, maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 1_000_000n });
    expect(chosenFee(FEES, 'custom', '1.000000001')).toMatchObject({ ok: true, maxFeePerGas: 1_000_000_001n });
  });

  it('caps the custom priority at the custom most', () => {
    const tight = { ...FEES, baseFeePerGasWei: '1' };
    expect(chosenFee(tight, 'custom', '0.0001')).toEqual({ ok: true, maxFeePerGas: 100_000n, maxPriorityFeePerGas: 100_000n });
  });

  it.each([
    ['above the cap', '100000', 'over_cap'],
    ['under the next base fee', '0.5', 'under_base'],
    ['blank', '', 'custom_invalid'],
    ['zero', '0', 'custom_invalid'],
    ['more decimals than gwei has', '1.0000000001', 'custom_invalid'],
    ['not a number', 'fast', 'custom_invalid'],
  ])('refuses a custom fee %s', (_name, text, reason) => {
    expect(chosenFee(FEES, 'custom', text)).toEqual({ ok: false, reason });
  });

  it('accepts a custom fee exactly at the cap', () => {
    expect(chosenFee(FEES, 'custom', '100')).toMatchObject({ ok: true, maxFeePerGas: 100_000_000_000n });
  });
});

describe('fee display and request fields', () => {
  it('shows wei per gas as gwei with every decimal', () => {
    expect(toGwei(2_000_000_001n)).toBe('2.000000001');
    expect(toGwei(7n)).toBe('0.000000007');
  });

  it('writes the two fields as hex', () => {
    expect(feeFields({ ok: true, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n })).toEqual({
      maxFeePerGas: '0x77359400',
      maxPriorityFeePerGas: '0x1',
    });
  });
});
