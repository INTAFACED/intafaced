import { describe, expect, it } from 'vitest';
import {
  HSTS_DEFAULT_MAX_AGE_SECONDS,
  HSTS_MAX_AGE_LIMIT_SECONDS,
  hstsHeaderValue,
  hstsIssues,
  hstsSettings,
  isRegistrableDomain,
} from './security-headers.mjs';

const PROD = { productionPosture: true } as const;
const NON_PROD = { productionPosture: false } as const;
const codes = (env: Record<string, unknown>, options = PROD as { productionPosture: boolean }) =>
  hstsIssues(env, options).map((issue) => issue.code);

describe('hstsHeaderValue (the formatter: no throw path, no preload)', () => {
  it('defaults to one day, host-only, when nothing is set (or the compose empty string)', () => {
    expect(hstsHeaderValue({})).toBe('max-age=86400');
    expect(hstsHeaderValue({ HSTS_MAX_AGE_SECONDS: '', HSTS_INCLUDE_SUBDOMAINS: '' })).toBe('max-age=86400');
    expect(HSTS_DEFAULT_MAX_AGE_SECONDS).toBe(86400);
  });

  it('formats the ramp stages', () => {
    expect(hstsHeaderValue({ HSTS_MAX_AGE_SECONDS: '604800', HSTS_INCLUDE_SUBDOMAINS: 'true' })).toBe('max-age=604800; includeSubDomains');
    expect(hstsHeaderValue({ HSTS_MAX_AGE_SECONDS: '31536000', HSTS_INCLUDE_SUBDOMAINS: 'false' })).toBe('max-age=31536000');
    expect(hstsHeaderValue({ HSTS_MAX_AGE_SECONDS: '63072000' })).toBe('max-age=63072000');
    expect(hstsHeaderValue({ HSTS_MAX_AGE_SECONDS: '0' })).toBe('max-age=0');
  });

  it('falls back to the defaults on any malformed value instead of throwing, and never emits `preload`', () => {
    const hostile = [
      '-1',
      '1e9',
      '0x10',
      '63072001',
      '99999999999',
      '86400; preload',
      'preload',
      'yes',
      ' 5',
      '5 ',
      '08',
      '1.5',
      'NaN',
      'Infinity',
    ];
    for (const bad of hostile) {
      for (const include of [undefined, 'true', 'false', 'TRUE', 'preload', '1', 'yes']) {
        const value = hstsHeaderValue({ HSTS_MAX_AGE_SECONDS: bad, HSTS_INCLUDE_SUBDOMAINS: include });
        expect(value, `${bad}/${include}`).toMatch(/^max-age=\d+(?:; includeSubDomains)?$/);
        expect(value).not.toMatch(/preload/i);
      }
    }
    expect(hstsHeaderValue({ HSTS_MAX_AGE_SECONDS: '63072001' })).toBe('max-age=86400');
    expect(hstsHeaderValue({ HSTS_MAX_AGE_SECONDS: 604800 as unknown as string })).toBe('max-age=86400');
  });

  it('no accepted input can make the value contain the preload token (exhaustive over the knob space shape)', () => {
    for (const age of [undefined, '0', '1', '86400', '63072000']) {
      for (const include of [undefined, 'true', 'false']) {
        expect(hstsHeaderValue({ HSTS_MAX_AGE_SECONDS: age, HSTS_INCLUDE_SUBDOMAINS: include })).not.toMatch(/preload/i);
      }
    }
    expect(Object.keys(hstsSettings({ HSTS_PRELOAD: 'true' }))).not.toContain('preload');
    expect(hstsHeaderValue({ HSTS_PRELOAD: 'true' })).toBe('max-age=86400');
  });
});

describe('hstsSettings / hstsIssues (the boot validator)', () => {
  it('accepts unset, the boundary values and the two booleans', () => {
    expect(codes({})).toEqual([]);
    for (const age of ['0', '1', '86400', '604800', '2592000', '31536000', String(HSTS_MAX_AGE_LIMIT_SECONDS)]) {
      expect(codes({ HSTS_MAX_AGE_SECONDS: age }), age).toEqual([]);
    }
    expect(codes({ HSTS_INCLUDE_SUBDOMAINS: 'false' })).toEqual([]);
  });

  it('refuses a non-integer, negative, oversize or decorated max-age with a stable code that names the variable, not the value', () => {
    for (const bad of ['-1', '1.5', '1e9', 'abc', '63072001', ' 86400', '86400; preload', '+5', '0x10']) {
      const issues = hstsIssues({ HSTS_MAX_AGE_SECONDS: bad }, PROD);
      expect(issues, bad).toEqual([{ code: 'hsts.max_age_invalid', variable: 'HSTS_MAX_AGE_SECONDS' }]);
    }
  });

  it('refuses anything but exactly true|false for include-subdomains', () => {
    for (const bad of ['TRUE', 'True', '1', 'yes', 'preload', 'true ', 'on']) {
      expect(codes({ HSTS_INCLUDE_SUBDOMAINS: bad }), bad).toEqual(['hsts.include_subdomains_invalid']);
    }
  });

  it('refuses more than one day outside production posture, so a copied prod .env cannot pin a non-prod host for a year', () => {
    expect(codes({ HSTS_MAX_AGE_SECONDS: '86400' }, NON_PROD)).toEqual([]);
    expect(codes({ HSTS_MAX_AGE_SECONDS: '604800' }, NON_PROD)).toEqual(['hsts.max_age_above_non_production_cap']);
    expect(codes({ HSTS_MAX_AGE_SECONDS: '63072000' }, NON_PROD)).toEqual(['hsts.max_age_above_non_production_cap']);
    expect(codes({ HSTS_MAX_AGE_SECONDS: '63072000' }, PROD)).toEqual([]);
  });

  it('refuses includeSubDomains when the served host (ADMIN_ORIGIN) is a registrable domain, or cannot be determined', () => {
    const on = { HSTS_INCLUDE_SUBDOMAINS: 'true' };
    expect(codes({ ...on, ADMIN_ORIGIN: 'https://intafaced.com' })).toEqual(['hsts.include_subdomains_on_registrable_domain']);
    expect(codes({ ...on, ADMIN_ORIGIN: 'https://example.co.uk' })).toEqual(['hsts.include_subdomains_on_registrable_domain']);
    expect(codes({ ...on, ADMIN_ORIGIN: 'https://admin.intafaced.com' })).toEqual([]);
    expect(codes({ ...on, ADMIN_ORIGIN: 'https://admin.example.co.uk' })).toEqual([]);
    expect(codes({ ...on })).toEqual(['hsts.include_subdomains_host_unknown']);
    expect(codes({ ...on, ADMIN_ORIGIN: 'not a url' })).toEqual(['hsts.include_subdomains_host_unknown']);
    // Off (or unset) never looks at the host.
    expect(codes({ HSTS_INCLUDE_SUBDOMAINS: 'false', ADMIN_ORIGIN: 'https://intafaced.com' })).toEqual([]);
    expect(codes({ ADMIN_ORIGIN: 'https://intafaced.com' })).toEqual([]);
  });

  it('reports every problem at once', () => {
    expect(codes({ HSTS_MAX_AGE_SECONDS: 'x', HSTS_INCLUDE_SUBDOMAINS: 'maybe' })).toEqual([
      'hsts.max_age_invalid',
      'hsts.include_subdomains_invalid',
    ]);
  });
});

describe('isRegistrableDomain (conservative, not the Public Suffix List)', () => {
  it('is true for apexes, single labels, IP literals and known two-label public suffixes', () => {
    for (const host of [
      'intafaced.com',
      'INTAFACED.com.',
      'localhost',
      'co.uk',
      'example.co.uk',
      'example.com.au',
      '127.0.0.1',
      '::1',
      '',
    ]) {
      expect(isRegistrableDomain(host), host).toBe(true);
    }
  });

  it('is false for hosts below a registrable domain', () => {
    for (const host of ['admin.intafaced.com', 'a.b.intafaced.com', 'admin.example.co.uk', 'x.example.com.au']) {
      expect(isRegistrableDomain(host), host).toBe(false);
    }
  });

  it('documented limitation: private suffixes and rarer public suffixes are not recognised', () => {
    expect(isRegistrableDomain('myapp.vercel.app')).toBe(false);
    expect(isRegistrableDomain('user.github.io')).toBe(false);
    expect(isRegistrableDomain('example.com.pe')).toBe(false);
  });
});
