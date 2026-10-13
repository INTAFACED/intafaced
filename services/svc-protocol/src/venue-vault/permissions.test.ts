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
    expect(() => assertTradeOnly({ scopes: ['spot'], flags: { enableWithdraw: 'true' } })).toThrow(WithdrawalPermissionRefusedError);
    expect(withdrawalPermissionHits({ scopes: ['spot'], flags: { enableWithdraw: false } })).toEqual([]);
    expect(withdrawalPermissionHits({ scopes: ['spot'], flags: { enableWithdraw: 0 } })).toEqual([]);
    expect(withdrawalPermissionHits({ scopes: ['spot'], flags: { enableWithdraw: 'false' } })).toEqual([]);
    expect(withdrawalPermissionHits({ scopes: ['spot'], flags: { enableWithdraw: '0' } })).toEqual([]);
    expect(withdrawalPermissionHits({ scopes: ['spot'], flags: { enableSpot: 1 } })).toEqual([]);
    expect(withdrawalPermissionHits({ scopes: ['trade'], flags: { note: 'withdraw' } })).toEqual(['flag:note=withdraw']);
    expect(withdrawalPermissionHits({ scopes: ['universalTransfer'] })[0]).toMatch(/universalTransfer/i);
    expect(() => assertTradeOnly({ scopes: ['withdraw'] })).toThrow(WithdrawalPermissionRefusedError);
  });

  it.each(['1', 'yes', 'enabled', '', -1, 2])('refuses an ambiguous withdrawal flag value %s', (value) => {
    expect(() => assertTradeOnly({ scopes: ['trade'], flags: { enableWithdraw: value } })).toThrow(WithdrawalPermissionRefusedError);
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
    assertRefused([{}]);
    assertRefused([null]);
    assertRefused([1]);

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

  it('applies one shared rule: case, space, underscore and hyphen fold; send, transfer and read-write wallets refused', () => {
    for (const scope of [
      'wallet:transactions:send',
      'can_transfer',
      'AccountTransfer',
      'SubMemberTransfer',
      'internal transfer',
      'Internal Transfer',
      'WALLET:READ_WRITE',
      'wallet:read_write',
      'fund out',
    ]) {
      expect(withdrawalPermissionHits({ scopes: ['trade', scope] })).toEqual([`scope:${scope}`]);
      expect(() => assertTradeOnly({ scopes: [scope] })).toThrow(WithdrawalPermissionRefusedError);
    }
    expect(withdrawalPermissionHits({ scopes: ['trade'], flags: { can_transfer: true } })).toEqual(['flag:can_transfer']);
    expect(withdrawalPermissionHits({ scopes: ['trade'], flags: { 'Sub Member Transfer': 'yes' } })).toEqual(['flag:Sub Member Transfer']);
    expect(withdrawalPermissionHits({ scopes: ['trade'], flags: { can_transfer: false } })).toEqual([]);
    expect(withdrawalPermissionHits({ scopes: ['wallet:accounts:read', 'wallet:buys:create'] })).toEqual([]);
  });

  it('refuses empty or blank scopes: nothing shows the key cannot withdraw', () => {
    expect(() => assertTradeOnly({ scopes: [] })).toThrow(WithdrawalPermissionRefusedError);
    expect(() => withdrawalPermissionHits({ scopes: [] })).toThrow(WithdrawalPermissionRefusedError);
    expect(() => assertTradeOnly({ scopes: ['  '] })).toThrow(WithdrawalPermissionRefusedError);
    expect(() => assertTradeOnly({ scopes: [''] })).toThrow(WithdrawalPermissionRefusedError);
  });

  it('refuses flags that are not a plain object of primitives', () => {
    for (const flags of ['enableWithdraw', ['enableWithdraw'], null, { nested: { enableWithdraw: true } }, { list: [true] }, { x: null }]) {
      const permissions = { scopes: ['trade'], flags } as unknown as Parameters<typeof assertTradeOnly>[0];
      expect(() => assertTradeOnly(permissions)).toThrow(WithdrawalPermissionRefusedError);
    }
    expect(() => assertTradeOnly({ scopes: ['trade'], flags: { enableSpot: true, tier: 'a', n: 2 } })).not.toThrow();
    expect(() => assertTradeOnly({ scopes: ['trade'] })).not.toThrow();
  });
});
