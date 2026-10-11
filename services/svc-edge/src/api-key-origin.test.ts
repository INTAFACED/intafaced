import { describe, expect, it } from 'vitest';
import {
  apiKeyOriginAllowed,
  assertApiKeyOrigin,
  normalizeOriginHost,
  optionalOriginAllowlist,
  optionalOriginAllowlistFromExchange,
  KeyOriginError,
} from './api-key-origin.js';

const LISTED = 'app.example.com';
const KEEP = 'partner.example';

describe('optionalOriginAllowlist', () => {
  it('reads originAllowlist / domainWhitelist / domain_whitelist; never invents', () => {
    expect(optionalOriginAllowlist({ originAllowlist: [LISTED] })).toEqual([LISTED]);
    expect(optionalOriginAllowlist({ domainWhitelist: [KEEP] })).toEqual([KEEP]);
    expect(optionalOriginAllowlist({ domain_whitelist: [` ${LISTED} `] })).toEqual([LISTED]);
    expect(optionalOriginAllowlist({ originAllowlist: [] })).toEqual([]);
    expect(optionalOriginAllowlist({ originAllowlist: [] })).not.toContain('localhost');
    expect(optionalOriginAllowlist({ id: 'k' })).toBeUndefined();
    expect(optionalOriginAllowlist({ originAllowlist: 'app.example.com' })).toBeUndefined();
    expect(optionalOriginAllowlist(null)).toBeUndefined();
  });
});

describe('optionalOriginAllowlistFromExchange', () => {
  it('reads tRPC envelope or bare body; never invents a list', () => {
    expect(optionalOriginAllowlistFromExchange({ result: { data: { json: { originAllowlist: [LISTED] } } } })).toEqual([LISTED]);
    expect(optionalOriginAllowlistFromExchange({ result: { data: { domainWhitelist: [KEEP] } } })).toEqual([KEEP]);
    expect(optionalOriginAllowlistFromExchange({ domain_whitelist: [LISTED] })).toEqual([LISTED]);
    expect(optionalOriginAllowlistFromExchange({ accessToken: 'x' })).toBeUndefined();
  });
});

describe('apiKeyOriginAllowed', () => {
  it('empty list stays open; no invented localhost', () => {
    expect(apiKeyOriginAllowed([], undefined)).toBe(true);
    expect(apiKeyOriginAllowed([], 'https://evil.example')).toBe(true);
    expect(apiKeyOriginAllowed([], 'http://localhost')).toBe(true);
  });

  it('refuses missing origin when the list is set', () => {
    expect(apiKeyOriginAllowed([LISTED], undefined)).toBe(false);
    expect(apiKeyOriginAllowed([LISTED], null)).toBe(false);
    expect(apiKeyOriginAllowed([LISTED], '')).toBe(false);
  });

  it('matching origin proceeds; foreign origin refuses', () => {
    const list = [LISTED, `https://${KEEP}`];
    expect(apiKeyOriginAllowed(list, 'https://app.example.com')).toBe(true);
    expect(apiKeyOriginAllowed(list, 'https://partner.example')).toBe(true);
    expect(apiKeyOriginAllowed(list, 'https://evil.example')).toBe(false);
  });

  it('keeps a bare IPv6 allowlist entry as that address', () => {
    expect(normalizeOriginHost('2001:db8::1')).toBe('2001:db8::1');
    expect(apiKeyOriginAllowed(['2001:db8::1'], 'https://2001')).toBe(false);
    expect(apiKeyOriginAllowed(['2001:db8::1'], 'https://shop.2001')).toBe(false);
    expect(apiKeyOriginAllowed(['2001:db8::1'], 'https://[2001:db8::1]')).toBe(true);
    expect(apiKeyOriginAllowed(['app.example.com'], 'https://app.example.com')).toBe(true);
    expect(apiKeyOriginAllowed(['app.example.com:443'], 'https://app.example.com')).toBe(true);
  });
});

it('canonicalizes equivalent IPv6 addresses and rejects malformed literals', () => {
  expect(apiKeyOriginAllowed(['2001:0DB8:0:0:0:0:0:1'], 'https://[2001:db8::1]:8443')).toBe(true);
  expect(apiKeyOriginAllowed(['[2001:db8::1]:443'], 'https://[2001:db8::1]')).toBe(true);
  expect(apiKeyOriginAllowed(['2001:db8::1'], 'https://[2001:db8::2]')).toBe(false);
  for (const malformed of ['[2001:db8::1]junk', '[2001:db8::1]:bad', '[2001:db8::1', '2001:bad::invalid']) {
    expect(normalizeOriginHost(malformed)).toBeNull();
    expect(apiKeyOriginAllowed([malformed], 'https://[2001:db8::1]')).toBe(false);
  }
});

describe('assertApiKeyOrigin', () => {
  it('empty / missing list stays open; bound list refuses foreign Origin', () => {
    expect(() => assertApiKeyOrigin(undefined, 'https://evil.example')).not.toThrow();
    expect(() => assertApiKeyOrigin([], 'https://evil.example')).not.toThrow();
    expect(() => assertApiKeyOrigin([LISTED], 'https://app.example.com')).not.toThrow();
    expect(() => assertApiKeyOrigin([LISTED], 'https://evil.example')).toThrow(KeyOriginError);
    try {
      assertApiKeyOrigin([LISTED], 'https://evil.example');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.domain_not_allowed' });
    }
    expect(() => assertApiKeyOrigin([LISTED], undefined)).toThrow(KeyOriginError);
  });
});
