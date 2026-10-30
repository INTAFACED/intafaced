import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import type { GasPriceQuote } from '../chain/gas-price.js';
import { BASE_FEE_HEADROOM, feeLevels, parseFeeCapWei, requireFeeCapWei, SwapFeeError } from './fee-levels.js';

const QUOTE: GasPriceQuote = {
  asOf: '2026-10-29T12:00:00.000Z',
  chainId: 84532,
  blocks: 20,
  percentiles: [10, 50, 90],
  gasPriceWei: '1500000000',
  baseFeePerGasWei: '1000000000',
  priorityFeeWei: { low: '1', average: '1000000', high: '2000000000' },
};

describe('parseFeeCapWei', () => {
  it('reads whole wei above zero', () => {
    expect(parseFeeCapWei('100000000000')).toBe(100_000_000_000n);
    expect(parseFeeCapWei(' 7 ')).toBe(7n);
  });
  it.each(['', '   ', '0', '-1', '1.5', '1e9', '0x10', 'gwei', `${(1n << 256n).toString()}`])(
    'refuses %j as blank, never a default',
    (raw) => {
      expect(parseFeeCapWei(raw)).toBeNull();
    },
  );
  it('refuses an unset value by name', () => {
    expect(() => requireFeeCapWei(null)).toThrow(/protocol\.swap_fee_cap_unset/);
    expect(() => requireFeeCapWei(undefined)).toThrow(SwapFeeError);
  });
});

describe('feeLevels', () => {
  it('prices each level from the next base fee and its percentile, in wei, without a number', () => {
    const fees = feeLevels(QUOTE, 100_000_000_000n);
    expect(fees.baseFeePerGasWei).toBe('1000000000');
    expect(fees.levels.slow).toEqual({ maxFeePerGasWei: (2_000_000_000n + 1n).toString(), maxPriorityFeePerGasWei: '1', overCap: false });
    expect(fees.levels.normal.maxPriorityFeePerGasWei).toBe('1000000');
    expect(fees.levels.fast.maxFeePerGasWei).toBe((1_000_000_000n * BASE_FEE_HEADROOM + 2_000_000_000n).toString());
    expect(fees.feeCapWei).toBe('100000000000');
    expect(fees.sponsored).toBe(false);
    expect(fees.percentiles).toEqual([10, 50, 90]);
  });

  it('marks a level above the cap instead of lowering it', () => {
    const fees = feeLevels(QUOTE, 2_500_000_000n);
    expect(fees.levels.slow.overCap).toBe(false);
    expect(fees.levels.fast.overCap).toBe(true);
    expect(fees.levels.fast.maxFeePerGasWei).toBe('4000000000');
  });

  it('keeps magnitudes past 2^53 exact', () => {
    const big = feeLevels({ ...QUOTE, baseFeePerGasWei: '9007199254740993', priorityFeeWei: { low: '1', average: '1', high: '1' } }, 1n);
    expect(big.levels.normal.maxFeePerGasWei).toBe('18014398509481987');
  });

  it.each([
    ['no base fee', { baseFeePerGasWei: null }],
    ['no priority history', { priorityFeeWei: null }],
  ])('refuses %s with protocol.fee_market_unread', (_name, change) => {
    expect(() => feeLevels({ ...QUOTE, ...change } as GasPriceQuote, 1n)).toThrow(/protocol\.fee_market_unread/);
  });
});

const edge = createEdgeContext({ secret: 'a-protocol-fee-test-edge-secret-length', serviceName: 'svc-protocol' });
const anonymous = () => edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-fees' });

function caller(overrides: Partial<ProtocolRouterDeps>, onRead: () => void = () => undefined) {
  const deps = {
    chain: {
      config: { chainId: 84532 },
      gasPrice: async () => {
        onRead();
        return QUOTE;
      },
    },
    registry: {},
    relay: {},
    relayEnabled: () => false,
    ammFactoryAddress: () => '0x0000000000000000000000000000000000000000',
    swapSlippageBps: () => null,
    ...overrides,
  } as unknown as ProtocolRouterDeps;
  return createProtocolRouter(deps).createCaller(anonymous());
}

describe('protocol.amm.feeLevels', () => {
  it('answers the levels when both owner settings are set', async () => {
    const fees = await caller({
      swapFeeCapWei: () => 100_000_000_000n,
      gasPercentiles: () => ({ percentiles: [10, 50, 90], blocks: 20 }),
    }).amm.feeLevels();
    expect(fees.levels.normal.overCap).toBe(false);
    expect(fees.blocks).toBe(20);
  });

  it.each<[string, Partial<ProtocolRouterDeps>, string]>([
    [
      'a blank cap',
      { swapFeeCapWei: () => null, gasPercentiles: () => ({ percentiles: [10, 50, 90], blocks: 20 }) },
      'protocol.swap_fee_cap_unset',
    ],
    ['an absent cap seam', { gasPercentiles: () => ({ percentiles: [10, 50, 90], blocks: 20 }) }, 'protocol.swap_fee_cap_unset'],
    ['blank percentiles', { swapFeeCapWei: () => 1n, gasPercentiles: () => null }, 'protocol.gas_percentiles_unset'],
  ])('refuses %s before the node is asked', async (_name, overrides, code) => {
    let asked = 0;
    await expect(caller(overrides as Partial<ProtocolRouterDeps>, () => (asked += 1)).amm.feeLevels()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(code),
    });
    expect(asked).toBe(0);
  });

  it('refuses a node with no fee market by name', async () => {
    const chain = { config: { chainId: 84532 }, gasPrice: async () => ({ ...QUOTE, baseFeePerGasWei: null, priorityFeeWei: null }) };
    await expect(
      caller({
        chain: chain as unknown as ProtocolRouterDeps['chain'],
        swapFeeCapWei: () => 1n,
        gasPercentiles: () => ({ percentiles: [10, 50, 90], blocks: 20 }),
      }).amm.feeLevels(),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringContaining('protocol.fee_market_unread') });
  });
});
