import { describe, expect, it } from 'vitest';
import {
  MONEY_PERMISSION_AREAS,
  PAYFAC_PERMISSION_SOCKETS,
  PAYFAC_SURFACE_AREAS,
  SHIPPED_PAYFAC_AREA_COUNT,
  areaForSurface,
  isPayfacPermissionPort,
  permissionAreaCoverage,
  resolveActorMerchantId,
} from './payfac-permissions.js';
import { DEFAULT_GRANTED_AREAS, PERMISSION_AREAS, SubMerchantError, isPermissionArea } from './submerchants.js';

describe('D26-P1-P2 payfac permissions map', () => {
  it('names every vocabulary area exactly once in PERMISSION_AREAS', () => {
    expect(new Set(PERMISSION_AREAS).size).toBe(PERMISSION_AREAS.length);
    expect(PERMISSION_AREAS.length).toBe(11);
  });

  it('ships the actual surface list (eleven) — tracker title 14 is not a target', () => {
    const c = permissionAreaCoverage();
    expect(c.areas).toBe(PERMISSION_AREAS);
    expect(c.shippedCount).toBe(SHIPPED_PAYFAC_AREA_COUNT);
    expect(c.shippedCount).toBe(11);
    expect(c.shippedCount).not.toBe(14);
    expect(PERMISSION_AREAS).toEqual([
      'merchant.profile',
      'checkout.profile',
      'payment.link',
      'payment',
      'payment.refund',
      'settlement',
      'settlement.payout',
      'webhook',
      'kyb',
      'submerchant',
      'permission',
    ]);
  });

  it('refuses an invented fourteenth area and does not invent underwriting', () => {
    expect(isPermissionArea('underwriting')).toBe(false);
    expect(isPermissionArea('payfac.underwriting')).toBe(false);
    expect(PERMISSION_AREAS).not.toContain('underwriting');
    const inventedFourteenth = 'area.14';
    expect(isPermissionArea(inventedFourteenth)).toBe(false);
    expect(PERMISSION_AREAS.length + 1).not.toBe(14);
    expect([...PERMISSION_AREAS, inventedFourteenth]).toHaveLength(12);
  });

  it('never default-grants a money area — onboarding stays visibility-only', () => {
    for (const area of MONEY_PERMISSION_AREAS) {
      expect(DEFAULT_GRANTED_AREAS).not.toContain(area);
    }
    expect(DEFAULT_GRANTED_AREAS).toEqual(['merchant.profile', 'submerchant']);
  });

  it('every mapped surface maps to a known PermissionArea', () => {
    for (const [surface, area] of Object.entries(PAYFAC_SURFACE_AREAS)) {
      expect(PERMISSION_AREAS, surface).toContain(area);
      expect(areaForSurface(surface as keyof typeof PAYFAC_SURFACE_AREAS)).toBe(area);
    }
  });

  it('tRPC money doors share the REST area vocabulary — not a second list', () => {
    expect(areaForSurface('trpc.payment.create')).toBe(areaForSurface('rest.payments.create'));
    expect(areaForSurface('trpc.payment.authorize')).toBe(areaForSurface('rest.payments.authorize'));
    expect(areaForSurface('trpc.payment.capture')).toBe(areaForSurface('rest.payments.capture'));
    expect(areaForSurface('trpc.payment.refund')).toBe(areaForSurface('rest.payments.refund'));
    expect(areaForSurface('trpc.payment.get')).toBe(areaForSurface('rest.payments.read'));
    expect(areaForSurface('trpc.payment.list')).toBe(areaForSurface('rest.payments.list'));
    expect(areaForSurface('trpc.merchant.balances')).toBe(areaForSurface('rest.balances.read'));
    expect(areaForSurface('trpc.merchant.createLink')).toBe(areaForSurface('rest.payment-links.create'));
    expect(areaForSurface('trpc.merchant.checkoutSettings.get')).toBe(areaForSurface('trpc.merchant.profile'));
  });

  it('refund surface is not the same area as capture — value-out is its own grant', () => {
    expect(PAYFAC_SURFACE_AREAS['rest.payments.capture']).toBe('payment');
    expect(PAYFAC_SURFACE_AREAS['rest.payments.refund']).toBe('payment.refund');
  });

  it('payment-links REST maps to payment.link — same area as tRPC createLink', () => {
    expect(PAYFAC_SURFACE_AREAS['rest.payment-links.create']).toBe('payment.link');
    expect(PAYFAC_SURFACE_AREAS['rest.payment-links.list']).toBe('payment.link');
    expect(PAYFAC_SURFACE_AREAS['rest.payment-links.deactivate']).toBe('payment.link');
  });

  it('honest §13 sockets are named (settling partner + fee splits) — not inventable here', () => {
    expect(PAYFAC_PERMISSION_SOCKETS.map((s) => s.id)).toEqual(['socket.payfac-settling-party-partner', 'socket.payfac-split-fee-recipes']);
    for (const s of PAYFAC_PERMISSION_SOCKETS) {
      expect(s.residual.length).toBeGreaterThan(40);
    }
  });

  it('coverage helper exposes areas + money + defaults + sockets together', () => {
    const c = permissionAreaCoverage();
    expect(c.areas).toBe(PERMISSION_AREAS);
    expect(c.shippedCount).toBe(PERMISSION_AREAS.length);
    expect(c.money).toEqual([...MONEY_PERMISSION_AREAS]);
    expect(c.defaults).toBe(DEFAULT_GRANTED_AREAS);
    expect(c.sockets).toBe(PAYFAC_PERMISSION_SOCKETS);
  });

  it('isPayfacPermissionPort requires grant/revoke/list/history — assertHolds alone is not enough', () => {
    expect(isPayfacPermissionPort(null)).toBe(false);
    expect(isPayfacPermissionPort({ assertHolds: async () => undefined })).toBe(false);
    expect(
      isPayfacPermissionPort({
        assertHolds: async () => undefined,
        grantPermission: async () => ({}) as never,
        revokePermission: async () => ({}) as never,
        listPermissions: async () => [],
        permissionHistory: async () => [],
      }),
    ).toBe(true);
  });
});

describe('resolveActorMerchantId — principal only', () => {
  it('refuses when the principal has no merchant node', async () => {
    await expect(resolveActorMerchantId({ getMerchantByUserId: async () => null }, 'user-1')).rejects.toMatchObject({
      code: 'pay.submerchant_not_onboarded',
    });
  });

  it('refuses a missing principal', async () => {
    await expect(resolveActorMerchantId({ getMerchantByUserId: async () => ({ id: 'm' }) }, undefined)).rejects.toBeInstanceOf(
      SubMerchantError,
    );
  });

  it('returns the merchant id from the lookup — never from a body field', async () => {
    await expect(resolveActorMerchantId({ getMerchantByUserId: async () => ({ id: 'merchant-root' }) }, 'user-root')).resolves.toBe(
      'merchant-root',
    );
  });
});
