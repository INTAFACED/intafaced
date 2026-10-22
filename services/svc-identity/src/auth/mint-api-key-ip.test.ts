import { describe, expect, it } from 'vitest';
import { apiKeyIpAllowed } from './api-key-ip.js';
import { mintApiKeyWithIpAllowlist, type ApiKeyMinter } from './mint-api-key-ip.js';

function fakeSql(rows: unknown[] = []) {
  const fn = async () => rows;
  return fn as unknown as Parameters<typeof mintApiKeyWithIpAllowlist>[1];
}

function makeMinter() {
  const created: unknown[] = [];
  const revoked: string[] = [];
  const minter: ApiKeyMinter = {
    async createApiKey(input) {
      created.push(input);
      return { id: 'k1', key: 'ifk_live_secret', prefix: 'ifk_live', mode: input.mode ?? 'live' };
    },
    async revokeApiKey(_userId, keyId) {
      revoked.push(keyId);
      return true;
    },
  };
  return { minter, created, revoked };
}

const base = {
  userId: 'u',
  name: 'desk',
  scopes: ['identity:read'],
  grantorScopes: ['identity:read', 'identity:write'],
};

describe('mintApiKeyWithIpAllowlist', () => {
  it('refuses invalid IPs before create', async () => {
    const { minter, created } = makeMinter();
    await expect(mintApiKeyWithIpAllowlist(minter, fakeSql(), { ...base, ips: ['10.0.0.0/8'] })).rejects.toMatchObject({
      code: 'auth.ip_invalid',
    });
    expect(created).toEqual([]);
  });

  it('binds the list so an unlisted IP is refused from the first call', async () => {
    const { minter, created, revoked } = makeMinter();
    const minted = await mintApiKeyWithIpAllowlist(minter, fakeSql([{ id: 'k1', ip_allowlist: ['203.0.113.10', '2001:db8::1'] }]), {
      ...base,
      ips: ['  203.0.113.10  ', '2001:db8::1'],
    });
    expect(minted.ipAllowlist).toEqual(['203.0.113.10', '2001:db8::1']);
    expect(created).toHaveLength(1);
    expect(revoked).toEqual([]);
    expect(apiKeyIpAllowed(minted.ipAllowlist, '198.51.100.9')).toBe(false);
    expect(apiKeyIpAllowed(minted.ipAllowlist, undefined)).toBe(false);
    expect(apiKeyIpAllowed(minted.ipAllowlist, '203.0.113.10')).toBe(true);
  });

  it('empty ips stays open', async () => {
    const { minter } = makeMinter();
    const minted = await mintApiKeyWithIpAllowlist(minter, fakeSql([{ id: 'k1', ip_allowlist: [] }]), { ...base, ips: [] });
    expect(apiKeyIpAllowed(minted.ipAllowlist, '198.51.100.9')).toBe(true);
  });

  it('revokes the minted key if bind fails', async () => {
    const { minter, revoked } = makeMinter();
    await expect(mintApiKeyWithIpAllowlist(minter, fakeSql([]), { ...base, ips: ['203.0.113.10'] })).rejects.toMatchObject({
      code: 'auth.not_found',
    });
    expect(revoked).toEqual(['k1']);
  });
});
