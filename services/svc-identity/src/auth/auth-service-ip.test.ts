import { describe, expect, it } from 'vitest';
import { ApiKeyIpError, bindApiKeyIpAllowlist } from './auth-service-ip.js';

function fakeSql(rows: unknown[] = []) {
  const fn = async () => rows;
  return fn as unknown as Parameters<typeof bindApiKeyIpAllowlist>[0];
}

describe('bindApiKeyIpAllowlist', () => {
  it('refuses invalid IPs and does not write', async () => {
    await expect(bindApiKeyIpAllowlist(fakeSql(), 'u', 'k', ['10.0.0.0/8'])).rejects.toMatchObject({
      code: 'auth.ip_invalid',
    });
    await expect(bindApiKeyIpAllowlist(fakeSql(), 'u', 'k', ['203.0.113.10', 'not-an-ip'])).rejects.toBeInstanceOf(
      ApiKeyIpError,
    );
  });

  it('returns the bound list and treats a missing key as not found', async () => {
    const ok = fakeSql([{ id: 'k', ip_allowlist: ['203.0.113.10'] }]);
    await expect(bindApiKeyIpAllowlist(ok, 'u', 'k', ['  203.0.113.10  '])).resolves.toEqual({
      id: 'k',
      ipAllowlist: ['203.0.113.10'],
    });
    await expect(bindApiKeyIpAllowlist(fakeSql([]), 'u', 'k', ['203.0.113.10'])).rejects.toMatchObject({
      code: 'auth.not_found',
    });
  });
});
