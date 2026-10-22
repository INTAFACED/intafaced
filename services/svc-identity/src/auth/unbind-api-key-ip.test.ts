import { describe, expect, it } from 'vitest';
import { ApiKeyIpError } from './auth-service-ip.js';
import { apiKeyIpAllowed } from './api-key-ip.js';
import { unbindApiKeyIpAllowlist } from './unbind-api-key-ip.js';

const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LISTED = '203.0.113.10';
const KEEP = '198.51.100.7';

function fakeSqlSequence(results: unknown[][]) {
  let i = 0;
  const fn = async () => results[Math.min(i++, results.length - 1)] ?? [];
  return fn as unknown as Parameters<typeof unbindApiKeyIpAllowlist>[0];
}

describe('unbindApiKeyIpAllowlist', () => {
  it('removes one listed IP and leaves the rest', async () => {
    const sql = fakeSqlSequence([[{ id: KEY, ip_allowlist: [LISTED, KEEP] }], [{ id: KEY, ip_allowlist: [KEEP] }]]);
    await expect(unbindApiKeyIpAllowlist(sql, USER, KEY, ` ${LISTED} `)).resolves.toEqual({
      id: KEY,
      ipAllowlist: [KEEP],
    });
  });

  it('a place from the unbound IP is then refused; a still-listed IP stays open', async () => {
    const sql = fakeSqlSequence([[{ id: KEY, ip_allowlist: [LISTED, KEEP] }], [{ id: KEY, ip_allowlist: [KEEP] }]]);
    const { ipAllowlist } = await unbindApiKeyIpAllowlist(sql, USER, KEY, LISTED);
    expect(apiKeyIpAllowed(ipAllowlist, LISTED)).toBe(false);
    expect(apiKeyIpAllowed(ipAllowlist, KEEP)).toBe(true);
  });

  it('refuses invalid IPs, a missing key, and an IP that is not on the list', async () => {
    await expect(unbindApiKeyIpAllowlist(fakeSqlSequence([[]]), USER, KEY, '10.0.0.0/8')).rejects.toMatchObject({
      code: 'auth.ip_invalid',
    });
    await expect(unbindApiKeyIpAllowlist(fakeSqlSequence([[]]), USER, KEY, LISTED)).rejects.toBeInstanceOf(ApiKeyIpError);
    await expect(unbindApiKeyIpAllowlist(fakeSqlSequence([[{ id: KEY, ip_allowlist: [KEEP] }]]), USER, KEY, LISTED)).rejects.toMatchObject({
      code: 'auth.not_found',
    });
  });
});
