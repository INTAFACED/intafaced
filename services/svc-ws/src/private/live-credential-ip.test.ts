import { describe, expect, it } from 'vitest';
import {
  assertLiveCredential,
  createIdentityOwnershipClient,
  optionalIpAllowlist,
  type LiveCredentialPort,
  type OwnershipSnapshot,
} from './live-credential.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LISTED = '203.0.113.10';
const FOREIGN = '198.51.100.7';

const LIVE_KEY: OwnershipSnapshot = { id: KEY, userId: USER, revoked: false };

function port(key: OwnershipSnapshot | null): LiveCredentialPort {
  return {
    async getSession() {
      return null;
    },
    async getApiKey() {
      return key;
    },
  };
}

describe('assertLiveCredential — API key IP allowlist', () => {
  it('empty / omitted list stays open; listed IP stays live', async () => {
    const input = { userId: USER, sessionId: SESSION, apiKeyId: KEY, callerIp: LISTED };
    await expect(assertLiveCredential(port(LIVE_KEY), input)).resolves.toEqual({
      id: KEY,
      userId: USER,
      revoked: false,
    });
    await expect(assertLiveCredential(port({ ...LIVE_KEY, ipAllowlist: [] }), input)).resolves.toMatchObject({
      id: KEY,
    });
    await expect(assertLiveCredential(port({ ...LIVE_KEY, ipAllowlist: [LISTED] }), input)).resolves.toMatchObject({ id: KEY });
  });

  it('foreign or missing IP on a bound key is auth.ip_not_allowed, not revoked', async () => {
    const bound: OwnershipSnapshot = { ...LIVE_KEY, ipAllowlist: [LISTED] };
    await expect(
      assertLiveCredential(port(bound), { userId: USER, sessionId: SESSION, apiKeyId: KEY, callerIp: FOREIGN }),
    ).rejects.toMatchObject({ code: 'auth.ip_not_allowed' });
    await expect(
      assertLiveCredential(port(bound), { userId: USER, sessionId: SESSION, apiKeyId: KEY, callerIp: null }),
    ).rejects.toMatchObject({ code: 'auth.ip_not_allowed' });
    await expect(assertLiveCredential(port(bound), { userId: USER, sessionId: SESSION, apiKeyId: KEY })).rejects.toMatchObject({
      code: 'auth.ip_not_allowed',
    });
  });

  it('session seats ignore the allowlist', async () => {
    const p: LiveCredentialPort = {
      async getSession() {
        return { id: SESSION, userId: USER, revoked: false, ipAllowlist: [LISTED] };
      },
      async getApiKey() {
        return { ...LIVE_KEY, ipAllowlist: [LISTED] };
      },
    };
    await expect(assertLiveCredential(p, { userId: USER, sessionId: SESSION, callerIp: FOREIGN })).resolves.toEqual({
      id: SESSION,
      userId: USER,
      revoked: false,
    });
  });
});

describe('optionalIpAllowlist', () => {
  it('reads ipAllowlist or ip_allowlist string[]; rejects junk', () => {
    expect(optionalIpAllowlist({ ipAllowlist: [LISTED] })).toEqual([LISTED]);
    expect(optionalIpAllowlist({ ip_allowlist: [LISTED] })).toEqual([LISTED]);
    expect(optionalIpAllowlist({ id: KEY })).toBeUndefined();
    expect(optionalIpAllowlist({ ipAllowlist: [1] })).toBeUndefined();
    expect(optionalIpAllowlist(null)).toBeUndefined();
  });
});

describe('createIdentityOwnershipClient — optional key IP list', () => {
  it('keeps a string[] ipAllowlist from the key body; omits when absent', async () => {
    const withList = createIdentityOwnershipClient({
      baseUrl: 'http://identity.test',
      headers: {},
      fetch: async () =>
        new Response(JSON.stringify({ id: KEY, userId: USER, revoked: false, ipAllowlist: [LISTED] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(withList.getApiKey(KEY)).resolves.toEqual({
      id: KEY,
      userId: USER,
      revoked: false,
      ipAllowlist: [LISTED],
    });

    const bare = createIdentityOwnershipClient({
      baseUrl: 'http://identity.test',
      headers: {},
      fetch: async () =>
        new Response(JSON.stringify({ id: KEY, userId: USER, revoked: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const row = await bare.getApiKey(KEY);
    expect(row).toEqual({ id: KEY, userId: USER, revoked: false });
    expect(row && 'ipAllowlist' in row).toBe(false);
  });
});
