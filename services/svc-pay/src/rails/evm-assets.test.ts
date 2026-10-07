import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { fromChainUnits, parseEvmAssets, toChainUnits } from './evm-assets.js';

describe('parseEvmAssets', () => {
  it('parses native and erc20 forms', () => {
    const map = parseEvmAssets('ETH:native,USDT:0x0000000000000000000000000000000000000001:6');
    expect(map.get('ETH')).toEqual({ kind: 'native', assetId: 'ETH', decimals: 18 });
    expect(map.get('USDT')).toMatchObject({ kind: 'erc20', assetId: 'USDT', decimals: 6 });
  });

  it('refuses an empty map', () => {
    expect(() => parseEvmAssets('')).toThrow(/empty/i);
  });

  it('refuses a bad address', () => {
    expect(() => parseEvmAssets('USDT:not-an-address:6')).toThrow(/address/i);
  });

  it('refuses a blank decimals scale and keeps the omitted native default', () => {
    expect(() => parseEvmAssets('ETH:native:')).toThrow(/Native asset "ETH" has invalid decimals/);
    expect(() => parseEvmAssets('ETH:native:   ')).toThrow(/Native asset "ETH" has invalid decimals/);
    expect(() => parseEvmAssets('USDT:0x0000000000000000000000000000000000000001:')).toThrow(
      /Asset "USDT" needs on-chain decimals 0–36/,
    );
    expect(parseEvmAssets('ETH:native').get('ETH')).toEqual({ kind: 'native', assetId: 'ETH', decimals: 18 });
    expect(parseEvmAssets('ETH:native:0').get('ETH')).toEqual({ kind: 'native', assetId: 'ETH', decimals: 0 });
  });
});

describe('chain ↔ ledger unit conversion', () => {
  it('is identity for 18-decimal native', () => {
    const amt = parseAmount('1.5');
    expect(toChainUnits(amt, 18)).toBe(amt);
    expect(fromChainUnits(amt, 18)).toBe(amt);
  });

  it('converts 6-decimal USDT without truncation', () => {
    const amt = parseAmount('12.345678');
    const units = toChainUnits(amt, 6);
    expect(units).toBe(12_345_678n);
    expect(fromChainUnits(units, 6)).toBe(amt);
  });

  it('refuses truncating a ledger amount into coarser on-chain decimals', () => {
    expect(() => toChainUnits(parseAmount('1.000000000000000001'), 6)).toThrow(/truncate/i);
  });
});
