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
    expect(withdrawalPermissionHits({ scopes: ['spot'], flags: { enableWithdraw: 1 } })).toEqual(['flag:enableWithdraw']);
    expect(withdrawalPermissionHits({ scopes: ['spot'], flags: { enableWithdraw: 'true' } })).toEqual(['flag:enableWithdraw']);
    expect(withdrawalPermissionHits({ scopes: ['spot'], flags: { enableWithdraw: 'TRUE' } })).toEqual(['flag:enableWithdraw']);
    expect(() => assertTradeOnly({ scopes: ['spot'], flags: { enableWithdraw: 1 } })).toThrow(WithdrawalPermissionRefusedError);
    expect(() => assertTradeOnly({ scopes: ['spot'], flags: { enableWithdraw: 'true' } })).toThrow(
      WithdrawalPermissionRefusedError,
    );
    expect(withdrawalPermissionHits({ scopes: ['spot'], flags: { enableWithdraw: false } })).toEqual([]);
    expect(withdrawalPermissionHits({ scopes: ['spot'], flags: { enableWithdraw: 0 } })).toEqual([]);
    expect(withdrawalPermissionHits({ scopes: ['spot'], flags: { enableWithdraw: 'false' } })).toEqual([]);
    expect(withdrawalPermissionHits({ scopes: ['spot'], flags: { enableWithdraw: '0' } })).toEqual([]);
    expect(withdrawalPermissionHits({ scopes: ['spot'], flags: { enableSpot: 1 } })).toEqual([]);
    expect(withdrawalPermissionHits({ scopes: ['trade'], flags: { note: 'withdraw' } })).toEqual(['flag:note=withdraw']);
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

  it('refuses a string or other non-array scopes value before the character walk', () => {
    const assertRefused = (scopes: unknown) => {
      const permissions = { scopes } as unknown as Parameters<typeof assertTradeOnly>[0];
      expect(() => assertTradeOnly(permissions)).toThrow(WithdrawalPermissionRefusedError);
      expect(() => withdrawalPermissionHits(permissions)).toThrow(WithdrawalPermissionRefusedError);
      try {
        assertTradeOnly(permissions);
      } catch (err) {
        expect(err).toBeInstanceOf(WithdrawalPermissionRefusedError);
        expect((err as WithdrawalPermissionRefusedError).code).toBe('venue_vault.withdrawal_permission_refused');
      }
    };

    assertRefused('withdraw');
    assertRefused(JSON.parse('{"scopes":"withdraw"}').scopes);
    assertRefused(null);
    assertRefused({ withdraw: true });

    expect(() => assertTradeOnly({ scopes: ['spot', 'trade', 'read', 'order'] })).not.toThrow();
    for (const scope of [
      'universal_transfer',
      'internal_transfer',
      'universal-transfer',
      'internal-transfer',
      'funds_out',
      'enableUniversalTransfer',
    ]) {
      expect(withdrawalPermissionHits({ scopes: [scope] })).toEqual([`scope:${scope}`]);
      expect(() => assertTradeOnly({ scopes: [scope] })).toThrow(WithdrawalPermissionRefusedError);
    }
  });
});
