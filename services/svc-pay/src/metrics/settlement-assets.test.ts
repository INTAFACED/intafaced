import { describe, expect, it } from 'vitest';
import { parseSettlementAssets, SettlementAssetsConfigError } from './settlement-assets.js';

describe('PAY_SETTLEMENT_ASSETS', () => {
  it('blank is unset, never a guessed list', () => {
    expect(parseSettlementAssets(undefined)).toBeNull();
    expect(parseSettlementAssets('')).toBeNull();
    expect(parseSettlementAssets('   ')).toBeNull();
  });

  it('keeps the owner order and trims each entry', () => {
    expect(parseSettlementAssets('USDT, EUR ,BTC')).toEqual(['USDT', 'EUR', 'BTC']);
    expect(parseSettlementAssets('USDC.e')).toEqual(['USDC.e']);
  });

  it.each([['USDT,'], [',USDT'], ['USDT,,EUR'], ['US DT'], ['ABCDEFGHIJKLMNOPQ'], ['-USDT'], ['USDT;EUR']])(
    'refuses a malformed list %j at boot',
    (raw) => {
      expect(() => parseSettlementAssets(raw)).toThrow(SettlementAssetsConfigError);
    },
  );

  it('refuses an asset named twice', () => {
    expect(() => parseSettlementAssets('USDT,EUR,USDT')).toThrow(/twice/);
  });
});
