import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertLiveCredential,
  createIdentityOwnershipClient,
  LiveCredentialError,
  type LiveCredentialPort,
  type OwnershipSnapshot,
} from './live-credential.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const LIVE: OwnershipSnapshot = { id: SESSION, userId: USER, revoked: false };
const LIVE_KEY: OwnershipSnapshot = { id: KEY, userId: USER, revoked: false };

function port(opts: {
  session?: OwnershipSnapshot | null;
  key?: OwnershipSnapshot | null;
  fail?: LiveCredentialError;
}): LiveCredentialPort {
  return {
    async getSession() {
      if (opts.fail) throw opts.fail;
      return opts.session === undefined ? null : opts.session;
    },
    async getApiKey() {
      if (opts.fail) throw opts.fail;
      return opts.key === undefined ? null : opts.key;
    },
  };
}

describe('assertLiveCredential — session', () => {
  it('accepts a live snapshot and returns { id, userId, revoked } only', async () => {
    const row = await assertLiveCredential(port({ session: LIVE }), { userId: USER, sessionId: SESSION });
    expect(row).toEqual({ id: SESSION, userId: USER, revoked: false });
    expect(Object.keys(row).sort()).toEqual(['id', 'revoked', 'userId']);
  });

  it('denies empty, unknown, and user mismatch — never revoked', async () => {
    await expect(assertLiveCredential(port({ session: LIVE }), { userId: USER, sessionId: '' })).rejects.toMatchObject({
      code: 'auth.session_denied',
    });
    await expect(assertLiveCredential(port({ session: null }), { userId: USER, sessionId: SESSION })).rejects.toMatchObject({
      code: 'auth.session_denied',
    });
    await expect(
      assertLiveCredential(port({ session: { ...LIVE, userId: OTHER } }), { userId: USER, sessionId: SESSION }),
    ).rejects.toMatchObject({ code: 'auth.session_denied' });
    await expect(
      assertLiveCredential(port({ session: { ...LIVE, id: OTHER } }), { userId: USER, sessionId: SESSION }),
    ).rejects.toMatchObject({ code: 'auth.session_denied' });
  });

  it('revoked is auth.session_revoked, not denied', async () => {
    await expect(
      assertLiveCredential(port({ session: { ...LIVE, revoked: true } }), { userId: USER, sessionId: SESSION }),
    ).rejects.toMatchObject({ code: 'auth.session_revoked' });
  });
});

describe('assertLiveCredential — API key (kid present)', () => {
  it('loads the key, not the session', async () => {
    const p = port({
      session: { ...LIVE, revoked: true },
      key: LIVE_KEY,
    });
    await expect(assertLiveCredential(p, { userId: USER, sessionId: SESSION, apiKeyId: KEY })).resolves.toEqual({
      id: KEY,
      userId: USER,
      revoked: false,
    });
  });

  it('denies empty, unknown, and user mismatch', async () => {
    await expect(
      assertLiveCredential(port({ key: LIVE_KEY }), { userId: USER, sessionId: SESSION, apiKeyId: '' }),
    ).rejects.toMatchObject({ code: 'auth.api_key_denied' });
    await expect(
      assertLiveCredential(port({ key: null }), { userId: USER, sessionId: SESSION, apiKeyId: KEY }),
    ).rejects.toMatchObject({ code: 'auth.api_key_denied' });
    await expect(
      assertLiveCredential(port({ key: { ...LIVE_KEY, userId: OTHER } }), { userId: USER, sessionId: SESSION, apiKeyId: KEY }),
    ).rejects.toMatchObject({ code: 'auth.api_key_denied' });
  });

  it('revoked is auth.api_key_revoked, not denied', async () => {
    await expect(
      assertLiveCredential(port({ key: { ...LIVE_KEY, revoked: true } }), { userId: USER, sessionId: SESSION, apiKeyId: KEY }),
    ).rejects.toMatchObject({ code: 'auth.api_key_revoked' });
  });
});

describe('assertLiveCredential — unavailable is fail-closed', () => {
  it('propagates LiveCredentialError unavailable', async () => {
    const fail = new LiveCredentialError('down', 'unavailable');
    await expect(assertLiveCredential(port({ fail }), { userId: USER, sessionId: SESSION })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('wraps a thrown transport error as unavailable', async () => {
    const p: LiveCredentialPort = {
      async getSession() {
        throw new Error('socket hang up');
      },
      async getApiKey() {
        return null;
      },
    };
    await expect(assertLiveCredential(p, { userId: USER, sessionId: SESSION })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('createIdentityOwnershipClient', () => {
  it('GETs the internal paths, 404 is null, 401 is unavailable not live', async () => {
    const seen: string[] = [];
    const client = createIdentityOwnershipClient({
      baseUrl: 'http://identity.test/',
      headers: { 'x-test': '1' },
      fetch: async (input, init) => {
        seen.push(`${String(input)} ${JSON.stringify(init?.headers)}`);
        const url = String(input);
        if (url.endsWith(`/internal/sessions/${SESSION}`)) {
          return new Response('missing', { status: 404 });
        }
        if (url.endsWith(`/internal/api-keys/${KEY}`)) {
          return new Response(JSON.stringify({ error: 'no' }), { status: 401 });
        }
        return new Response('no', { status: 500 });
      },
    });
    await expect(client.getSession(SESSION)).resolves.toBeNull();
    await expect(client.getApiKey(KEY)).rejects.toMatchObject({ code: 'unavailable' });
    expect(seen[0]).toContain(`http://identity.test/internal/sessions/${SESSION}`);
    expect(seen[1]).toContain(`http://identity.test/internal/api-keys/${KEY}`);
    expect(seen.join('\n')).toContain('x-test');
  });

  it('parses published ownership only — extra scopes are stripped, not flattened', async () => {
    const client = createIdentityOwnershipClient({
      baseUrl: 'http://identity.test',
      headers: {},
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: SESSION,
            userId: USER,
            revoked: false,
            scopes: ['trade:write', 'admin:all'],
            jurisdiction: 'DE',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    const row = await client.getSession(SESSION);
    expect(row).toEqual({ id: SESSION, userId: USER, revoked: false });
    expect(row && 'scopes' in row).toBe(false);
  });

  it('non-OK, bad JSON, and schema miss are unavailable', async () => {
    const statuses = [400, 401, 403, 500];
    for (const status of statuses) {
      const client = createIdentityOwnershipClient({
        baseUrl: 'http://identity.test',
        headers: {},
        fetch: async () => new Response(JSON.stringify({ id: SESSION, userId: USER, revoked: false }), { status }),
      });
      await expect(client.getSession(SESSION)).rejects.toMatchObject({ code: 'unavailable' });
    }
    const badJson = createIdentityOwnershipClient({
      baseUrl: 'http://identity.test',
      headers: {},
      fetch: async () => new Response('not-json', { status: 200 }),
    });
    await expect(badJson.getSession(SESSION)).rejects.toMatchObject({ code: 'unavailable' });
    const badShape = createIdentityOwnershipClient({
      baseUrl: 'http://identity.test',
      headers: {},
      fetch: async () =>
        new Response(JSON.stringify({ id: SESSION, userId: USER }), { status: 200 }),
    });
    await expect(badShape.getSession(SESSION)).rejects.toMatchObject({ code: 'unavailable' });
    const down = createIdentityOwnershipClient({
      baseUrl: 'http://identity.test',
      headers: {},
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(down.getSession(SESSION)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('production index does not wire the port', () => {
  it('index.ts never constructs a live-credential client (no INTERNAL_SERVICE_SECRET)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(src).not.toMatch(/createIdentityOwnershipClient/);
    expect(src).not.toMatch(/IDENTITY_URL/);
    const call = src.slice(src.indexOf('const privateGateway = createPrivateWebSocketGateway('));
    expect(call.slice(0, 900)).not.toMatch(/liveCredential/);
  });
});
