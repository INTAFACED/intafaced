import { describe, expect, it } from 'vitest';
import { GAS_PERCENTILES_UNSET, protocolGasPriceOutputSchema } from './protocol-gas.js';

const quote = {
  asOf: '2026-10-23T00:00:00.000Z',
  chainId: 84532,
  blocks: 4,
  percentiles: [10, 50, 90] as const,
  gasPriceWei: '1000000000',
  baseFeePerGasWei: '100',
  priorityFeeWei: { low: '1', average: '2', high: '3' },
};

describe('protocol.gasPrice wire', () => {
  it('accepts a quote and rejects a float wei or an extra field', () => {
    expect(protocolGasPriceOutputSchema.safeParse(quote).success).toBe(true);
    expect(protocolGasPriceOutputSchema.safeParse({ ...quote, gasPriceWei: '1.5' }).success).toBe(false);
    expect(protocolGasPriceOutputSchema.safeParse({ ...quote, extra: 1 }).success).toBe(false);
    expect(GAS_PERCENTILES_UNSET).toBe('protocol.gas_percentiles_unset');
  });

  it('accepts a gas-price-only quote when the node reported no base fee', () => {
    expect(protocolGasPriceOutputSchema.safeParse({ ...quote, baseFeePerGasWei: null, priorityFeeWei: null }).success).toBe(true);
  });
});
