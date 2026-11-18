import { afterEach, describe, expect, it, vi } from 'vitest';
import { SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV, TEST_BUSINESS_BLOCKS_ENV, TEST_BUSINESS_BLOCK_REASON } from '@intafaced/config';
import { publishedWording, regionNotice } from './region-notice.js';

// J-bank-18 #1 (BK-safe-01): a person in a blocked region who opens a transfer is told why, in the owner's wording; with
// none published the notice still names the restriction and says the wording is not published.
describe('the blocked-region notice', () => {
  afterEach(() => vi.unstubAllEnvs());
  const stack = () => {
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv(SANCTIONS_REGIONS_ENV, 'KP');
    vi.stubEnv(SANCTIONS_SOURCE_ENV, 'TEST list');
    vi.stubEnv(TEST_BUSINESS_BLOCKS_ENV, 'TEST:AA');
  };

  it('names the business block and carries the owner wording in a blocked region', () => {
    stack();
    expect(regionNotice({ region: 'AA', kycTier: 'basic', wording: '  TEST: transfers are not offered here.  ' })).toEqual({
      region: 'AA',
      blocked: true,
      code: 'denied.region_blocked',
      restriction: TEST_BUSINESS_BLOCK_REASON,
      blockedBy: 'business',
      wording: 'TEST: transfers are not offered here.',
    });
  });

  it('names a screened region too, and reads no wording as not published', () => {
    stack();
    const notice = regionNotice({ region: 'KP', kycTier: 'basic', wording: '   ' });
    expect(notice).toMatchObject({ blocked: true, code: 'denied.region_blocked', blockedBy: 'screening', wording: null });
    expect(notice.restriction).toBeTruthy();
    expect(regionNotice({ region: 'AA', kycTier: 'basic', wording: undefined }).wording).toBeNull();
  });

  it('says nothing in a served region, whatever the wording', () => {
    stack();
    expect(regionNotice({ region: 'DE', kycTier: 'basic', wording: 'TEST wording' })).toEqual({
      region: 'DE',
      blocked: false,
      code: null,
      restriction: null,
      blockedBy: null,
      wording: null,
    });
  });

  it('keeps a blank wording blank', () => {
    expect(publishedWording(undefined)).toBeNull();
    expect(publishedWording('')).toBeNull();
    expect(publishedWording(' x ')).toBe('x');
  });
});
