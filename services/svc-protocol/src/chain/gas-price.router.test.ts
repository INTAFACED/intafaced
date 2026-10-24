import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import type { GasPercentileSetting } from './gas-price.js';

const SECRET = 'a-protocol-gas-test-edge-secret-length';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-protocol' });
const anonymous = () => edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-gas' });

const SETTING: GasPercentileSetting = { percentiles: [10, 50, 90], blocks: 4 };

function deps(overrides: Partial<ProtocolRouterDeps> = {}): ProtocolRouterDeps {
  return {
    chain: {
      config: { chainId: 84532 },
      gasPrice: async () => {
        throw new Error('chain should not be asked');
      },
    },
    registry: {},
    relay: {},
    relayEnabled: () => false,
    ammFactoryAddress: () => '0x0000000000000000000000000000000000000000',
    swapSlippageBps: () => null,
    ...overrides,
  } as unknown as ProtocolRouterDeps;
}

describe('protocol.gasPrice', () => {
  it('refuses a blank owner setting before any chain read', async () => {
    let asked = 0;
    const router = createProtocolRouter(
      deps({
        gasPercentiles: () => null,
        chain: {
          gasPrice: async () => {
            asked += 1;
            throw new Error('asked');
          },
        } as unknown as ProtocolRouterDeps['chain'],
      }),
    );
    await expect(router.createCaller(anonymous()).gasPrice()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('protocol.gas_percentiles_unset'),
    });
    expect(asked).toBe(0);
  });

  it('returns the chain quote for a published setting and does not call twice for one read', async () => {
    let asked = 0;
    const router = createProtocolRouter(
      deps({
        gasPercentiles: () => SETTING,
        now: () => new Date('2026-10-23T12:00:00.000Z'),
        chain: {
          gasPrice: async (setting: GasPercentileSetting) => {
            asked += 1;
            expect(setting).toEqual(SETTING);
            return {
              asOf: '2026-10-23T12:00:00.000Z',
              chainId: 84532,
              blocks: 4,
              percentiles: [10, 50, 90],
              gasPriceWei: '9',
              baseFeePerGasWei: null,
              priorityFeeWei: null,
            };
          },
        } as unknown as ProtocolRouterDeps['chain'],
      }),
    );
    await expect(router.createCaller(anonymous()).gasPrice()).resolves.toMatchObject({
      gasPriceWei: '9',
      baseFeePerGasWei: null,
      priorityFeeWei: null,
      percentiles: [10, 50, 90],
    });
    expect(asked).toBe(1);
  });
});
