import { describe, expect, it } from 'vitest';
import { DeveloperKeyError } from './developer-keys.js';
import { assertSandboxable, DeveloperSandboxError, parseSandboxBaseUrl, parseSandboxCapByTier } from './developer-sandboxes.js';

describe('parseSandboxCapByTier', () => {
  it('reads blank as unset, with no default', () => {
    expect(parseSandboxCapByTier(undefined)).toBeNull();
    expect(parseSandboxCapByTier('  ')).toBeNull();
  });

  it('reads tier=count pairs', () => {
    expect([...parseSandboxCapByTier('full=3, institutional=5')!]).toEqual([
      ['full', 3],
      ['institutional', 5],
    ]);
  });

  it.each(['full', 'gold=3', 'full=3,full=4', 'full=-1', 'full=3;basic=1'])('refuses %j so the service does not start', (raw) => {
    expect(() => parseSandboxCapByTier(raw)).toThrow(/IDENTITY_SANDBOXES_MAX_BY_TIER/);
  });
});

describe('parseSandboxBaseUrl', () => {
  it('reads blank as unset', () => {
    expect(parseSandboxBaseUrl(undefined)).toBeNull();
    expect(parseSandboxBaseUrl('')).toBeNull();
  });

  it('keeps the origin only', () => {
    expect(parseSandboxBaseUrl(' http://localhost:14500/path ')).toBe('http://localhost:14500');
  });

  it('refuses a URL that is not http(s)', () => {
    expect(() => parseSandboxBaseUrl('ftp://example.test')).toThrow(/IDENTITY_SANDBOX_BASE_URL/);
  });

  it('names the variable when the value is not a URL at all', () => {
    expect(() => parseSandboxBaseUrl('sandbox.example.test')).toThrow(/IDENTITY_SANDBOX_BASE_URL/);
  });
});

describe('assertSandboxable', () => {
  it('lets the pay scopes through', () => {
    expect(() => assertSandboxable(['pay:read', 'pay:write'])).not.toThrow();
  });

  it('refuses a trade scope with env.scope_not_sandboxable', () => {
    expect(() => assertSandboxable(['pay:read', 'trade:write'])).toThrow(
      expect.objectContaining({ constructor: DeveloperSandboxError, code: 'env.scope_not_sandboxable' }),
    );
  });

  it('refuses an unknown scope with the key door code', () => {
    expect(() => assertSandboxable(['pay:nonsense'])).toThrow(
      expect.objectContaining({ constructor: DeveloperKeyError, code: 'auth.scope_unknown' }),
    );
  });
});
