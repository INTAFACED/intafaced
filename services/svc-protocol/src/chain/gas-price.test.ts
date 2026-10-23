import { describe, expect, it } from 'vitest';
import { ChainUnavailableError } from './availability.js';
import {
  feeHistoryUnsupported,
  parseGasPercentileSetting,
  quoteFromHistory,
  readGasPrice,
  requireGasPercentileSetting,
  type GasHistoryReader,
  type GasPercentileSetting,
} from './gas-price.js';

const SETTING: GasPercentileSetting = { percentiles: [10, 50, 90], blocks: 4 };
const AS_OF = new Date('2026-10-23T12:00:00.000Z');

describe('parseGasPercentileSetting', () => {
  it('refuses a blank percentile or a blank block count', () => {
    expect(parseGasPercentileSetting('', '4')).toBeNull();
    expect(parseGasPercentileSetting('   ', '4')).toBeNull();
    expect(parseGasPercentileSetting(undefined, '4')).toBeNull();
    expect(parseGasPercentileSetting('10,50,90', '')).toBeNull();
    expect(parseGasPercentileSetting('10,50,90', undefined)).toBeNull();
    expect(() => requireGasPercentileSetting('', '4')).toThrow(/protocol\.gas_percentiles_unset/);
  });

  it('does not treat 0 or a reference percentile as a default', () => {
    expect(parseGasPercentileSetting('10,50,90', '0')).toBeNull();
    expect(parseGasPercentileSetting('10,50,90', '1025')).toBeNull();
    expect(parseGasPercentileSetting('10,90,50', '4')).toBeNull();
    expect(parseGasPercentileSetting('10,50', '4')).toBeNull();
    expect(parseGasPercentileSetting('10,50,101', '4')).toBeNull();
    expect(parseGasPercentileSetting('10,50,90.5', '4')).toBeNull();
  });

  it('reads an owner-published TEST setting exactly', () => {
    expect(parseGasPercentileSetting(' 10, 50, 90 ', '4')).toEqual(SETTING);
  });
});

describe('quoteFromHistory', () => {
  it('floors each percentile across the window and keeps wei as decimal strings', () => {
    const quote = quoteFromHistory({
      gasPrice: 1_000_000_000n,
      baseFeePerGas: [100n, 110n, 120n],
      reward: [
        [10n, 100n, 1000n],
        [20n, 100n, 1000n],
        [31n, 100n, 1001n],
      ],
      setting: SETTING,
      asOf: AS_OF,
      chainId: 84532,
    });
    expect(quote).toEqual({
      asOf: '2026-10-23T12:00:00.000Z',
      chainId: 84532,
      blocks: 4,
      percentiles: [10, 50, 90],
      gasPriceWei: '1000000000',
      baseFeePerGasWei: '120',
      priorityFeeWei: { low: '20', average: '100', high: '1000' },
    });
    expect(JSON.stringify(quote)).not.toMatch(/mainnet|intachain|audited/i);
  });

  it('returns only eth_gasPrice when the node reports no base fee', () => {
    const quote = quoteFromHistory({
      gasPrice: 7n,
      baseFeePerGas: [0n, 0n, 0n],
      reward: null,
      setting: SETTING,
      asOf: AS_OF,
      chainId: 84532,
    });
    expect(quote.gasPriceWei).toBe('7');
    expect(quote.baseFeePerGasWei).toBeNull();
    expect(quote.priorityFeeWei).toBeNull();
  });
});

describe('readGasPrice', () => {
  it('does not invent a price when the node does not answer', async () => {
    const reader: GasHistoryReader = {
      getGasPrice: async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:8545');
        (err as { code?: string }).code = 'ECONNREFUSED';
        throw err;
      },
      getFeeHistory: async () => {
        throw new Error('should not be asked');
      },
    };
    await expect(readGasPrice(reader, SETTING, AS_OF, 84532, 'http://127.0.0.1:8545')).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it('keeps eth_gasPrice when fee history is not offered', async () => {
    let historyCalls = 0;
    const reader: GasHistoryReader = {
      getGasPrice: async () => 9n,
      getFeeHistory: async () => {
        historyCalls += 1;
        const err = new Error('the method eth_feeHistory does not exist');
        err.name = 'MethodNotFoundRpcError';
        throw err;
      },
    };
    const quote = await readGasPrice(reader, SETTING, AS_OF, 84532, 'http://127.0.0.1:8545');
    expect(historyCalls).toBe(1);
    expect(quote.gasPriceWei).toBe('9');
    expect(quote.baseFeePerGasWei).toBeNull();
    expect(quote.priorityFeeWei).toBeNull();
    expect(JSON.stringify(quote)).not.toContain('127.0.0.1');
  });

  it('recognises a method-not-found code and not a transport failure', () => {
    expect(feeHistoryUnsupported(Object.assign(new Error('missing'), { code: -32601 }))).toBe(true);
    expect(feeHistoryUnsupported(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }))).toBe(false);
  });
});
