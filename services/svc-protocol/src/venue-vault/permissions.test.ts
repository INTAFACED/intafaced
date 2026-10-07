import { describe, expect, it } from 'vitest';
import { assertTradeOnly, withdrawalPermissionHits, WithdrawalPermissionRefusedError } from './permissions.js';

describe('S-L6 venue key permissions — refuse at registration', () => {
  it('allows trade-only scopes', () => {
    expect(() => assertTradeOnly({ scopes: ['spot', 'trade', 'read', 'order'] })).not.toThrow();
    expect(withdrawalPermissionHits({ scopes: ['futures'], flags: { enableSpot: true } })).toEqual([]);
  });

  it('refuses withdraw scopes and enableWithdraw flags', () => {
    expect(withdrawalPermissionHits({ scopes: ['trade', 'withdraw'] })).toEqual(['scope:withdraw']);
    expect(withdrawalPermissionHits({ scopes: ['spot'], flags: { enableWithdraw: true } })).toEqual(['flag:enableWithdraw']);
    expect(withdrawalPermissionHits({ scopes: ['universalTransfer'] })[0]).toMatch(/universalTransfer/i);
    expect(() => assertTradeOnly({ scopes: ['withdraw'] })).toThrow(WithdrawalPermissionRefusedError);
  });

  it('refuses internal-transfer fund-out flags', () => {
    expect(() => assertTradeOnly({ scopes: ['spot'], flags: { enableInternalTransfer: true } })).toThrow(WithdrawalPermissionRefusedError);
  });

  it('refuses separated transfer scopes, funds_out, and matching flags', () => {
    const blocked = [
      'universal_transfer',
      'internal_transfer',
      'universal-transfer',
      'internal-transfer',
      'funds_out',
      'enableUniversalTransfer',
      'withdraw',
      'universaltransfer',
      'internaltransfer',
      'wallet_withdraw',
      'perm.withdraw',
      'canwithdraw',
    ];
    for (const scope of blocked) {
      expect(withdrawalPermissionHits({ scopes: [scope] })).toEqual([`scope:${scope}`]);
      expect(() => assertTradeOnly({ scopes: [scope] })).toThrow(WithdrawalPermissionRefusedError);
    }
    expect(withdrawalPermissionHits({ scopes: ['trade'], flags: { universal_transfer: true } })).toEqual(['flag:universal_transfer']);
    expect(() => assertTradeOnly({ scopes: ['trade'], flags: { universal_transfer: true } })).toThrow(WithdrawalPermissionRefusedError);
    expect(withdrawalPermissionHits({ scopes: ['trade'], flags: { enable_internal_transfer: true } })).toEqual([
      'flag:enable_internal_transfer',
    ]);
    expect(() => assertTradeOnly({ scopes: ['trade'], flags: { enable_internal_transfer: true } })).toThrow(
      WithdrawalPermissionRefusedError,
    );
    expect(withdrawalPermissionHits({ scopes: ['spot', 'trade', 'read', 'order'] })).toEqual([]);
    expect(() => assertTradeOnly({ scopes: ['spot', 'trade', 'read', 'order'] })).not.toThrow();
  });
});
