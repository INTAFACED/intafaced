import { describe, expect, it } from 'vitest';
import { merchantCapabilityFlagsSchema } from '@intafaced/contracts';
import {
  MERCHANT_PERMISSIONS,
  capabilityFlags,
  capabilityFlagsForSession,
  pricingVisibilityFor,
  roleHasPermission,
  rolesWithPermission,
  seesFullPricing,
} from '../merchant-ops/roles.js';
import { PortalError } from './errors.js';
import { parseProfilePatch, profileChangeHash } from './fields.js';
import { decodeSeriesCursor, encodeSeriesCursor, requirePageLimit } from './series-cursor.js';

describe('merchant portal capability flags', () => {
  it('pins the wire flags to the role table, including profile.manage for owner and admin only', () => {
    expect(Object.keys(merchantCapabilityFlagsSchema.shape).sort()).toEqual([...MERCHANT_PERMISSIONS].sort());
    for (const role of ['owner', 'admin', 'finance', 'developer', 'viewer'] as const) {
      const flags = capabilityFlags(role);
      expect(Object.keys(flags).sort()).toEqual([...MERCHANT_PERMISSIONS].sort());
      for (const permission of MERCHANT_PERMISSIONS) {
        expect(flags[permission]).toBe(roleHasPermission(role, permission));
      }
    }
    expect(rolesWithPermission('profile.manage')).toEqual(['owner', 'admin']);
    expect(rolesWithPermission('payout.approve')).toEqual(['owner', 'admin', 'finance']);
    expect(seesFullPricing('finance')).toBe(true);
    expect(pricingVisibilityFor('viewer')).toBe('fee_only');
    expect(pricingVisibilityFor('developer')).toBe('fee_only');
    expect(pricingVisibilityFor('owner')).toBe('full');
  });

  it('clears write flags when the session is not interactive and leaves reads', () => {
    const live = capabilityFlagsForSession('owner', true);
    const quiet = capabilityFlagsForSession('owner', false);
    expect(live['profile.manage']).toBe(true);
    expect(live['payout.approve']).toBe(true);
    expect(quiet['profile.read']).toBe(true);
    expect(quiet['payments.read']).toBe(true);
    expect(quiet['profile.manage']).toBe(false);
    expect(quiet['team.manage']).toBe(false);
    expect(quiet['payout.request']).toBe(false);
    expect(quiet['payout.approve']).toBe(false);
    expect(quiet['exports.create']).toBe(false);
    expect(capabilityFlagsForSession('finance', false)['disputes.respond']).toBe(false);
    expect(capabilityFlagsForSession('finance', false)['disputes.read']).toBe(true);
    expect(capabilityFlags('viewer')['profile.manage']).toBe(false);
  });
});

describe('merchant portal profile patch', () => {
  it('keeps legal name and address pending and applies a display name immediately', () => {
    const parsed = parseProfilePatch({
      displayName: 'Shop',
      legalName: 'Shop Ltd',
      website: 'https://shop.example',
    });
    expect(parsed.immediate).toEqual({ displayName: 'Shop', website: 'https://shop.example' });
    expect(parsed.sensitive).toEqual({ legalName: 'Shop Ltd' });
    expect(Object.keys(parsed.sensitive)).toEqual(['legalName']);
  });

  it('refuses an empty patch, a non-https website, and a bad email without naming the field', () => {
    expect(() => parseProfilePatch({})).toThrow(PortalError);
    expect(() => parseProfilePatch({ website: 'http://shop.example' })).toThrowError(
      expect.objectContaining({ code: 'pay.profile_field_invalid' }),
    );
    expect(() => parseProfilePatch({ supportEmail: 'not-an-email' })).toThrowError(
      expect.objectContaining({ code: 'pay.profile_field_invalid', message: 'pay.profile_field_invalid' }),
    );
  });

  it('binds the review hash to the proposal and the version', () => {
    const proposed = { legalName: 'Shop Ltd' };
    const hash = profileChangeHash(proposed, '3');
    expect(hash).toBe(profileChangeHash({ legalName: 'Shop Ltd' }, '3'));
    expect(hash).not.toBe(profileChangeHash(proposed, '4'));
    expect(hash).not.toBe(profileChangeHash({ legalName: 'Other Ltd' }, '3'));
  });
});

describe('series cursor', () => {
  it('round-trips a period and asset and refuses a blank page size', () => {
    const raw = encodeSeriesCursor('2026-10-05', 'USDT');
    expect(decodeSeriesCursor(raw)).toEqual({ period: '2026-10-05', assetCode: 'USDT' });
    expect(() => decodeSeriesCursor('nope')).toThrowError(expect.objectContaining({ code: 'pay.list_cursor_invalid' }));
    expect(() => requirePageLimit(undefined, 'pay.analytics_limit_unset')).toThrowError(
      expect.objectContaining({ code: 'pay.analytics_limit_unset' }),
    );
  });
});
