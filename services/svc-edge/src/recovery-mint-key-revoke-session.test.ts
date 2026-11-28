import { describe, expect, it } from 'vitest';
import { assertIdentityApiKeyLive } from './api-key-revoked.js';
import { recoveredMintKeyRevokeRefusesSession } from './recovery-mint-key-revoke-session.js';

const USER = '11111111-1111-4111-8111-111111111111';
const KEY = '33333333-3333-4333-8333-333333333333';
const SECRET = 'edge-test-identity-ownership-secret-32';

const base = {
  identityUrl: 'http://identity.test',
  apiKeyId: KEY,
  userId: USER,
  identityOwnershipSecret: SECRET,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('recoveredMintKeyRevokeRefusesSession', () => {
  it('refuses while the recovered-session key is still live', async () => {
    await expect(
      recoveredMintKeyRevokeRefusesSession({
        ...base,
        fetch: async () => json({ id: KEY, userId: USER, revoked: false }),
      }),
    ).rejects.toMatchObject({ code: 'auth.api_key_live' });
  });

  it('allows the HTTP refuse after that key is revoked', async () => {
    await expect(
      recoveredMintKeyRevokeRefusesSession({
        ...base,
        fetch: async () => json({ id: KEY, userId: USER, revoked: true }),
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a missing key', async () => {
    await expect(
      recoveredMintKeyRevokeRefusesSession({
        ...base,
        fetch: async () => new Response(null, { status: 404 }),
      }),
    ).rejects.toMatchObject({ code: 'auth.api_key_denied' });
  });

  it('refuses a missing apiKeyId without inventing a session check', async () => {
    await expect(
      recoveredMintKeyRevokeRefusesSession({
        ...base,
        apiKeyId: '',
        fetch: async () => {
          throw new Error('should not fetch');
        },
      }),
    ).rejects.toMatchObject({ code: 'auth.api_key_denied' });
  });

  it('asks identity as assertIdentityApiKeyLive does and inverts only its verdict; not a drop-other or stream redo', async () => {
    // The module is this one door and its typed error: no drop-other, stream, key revoke, challenge or session.
    const module = await import('./recovery-mint-key-revoke-session.js');
    expect(Object.keys(module).sort()).toEqual(['RecoveredMintKeySessionError', 'recoveredMintKeyRevokeRefusesSession']);
    // For every identity answer it asks identity exactly what assertIdentityApiKeyLive asks, and only inverts its
    // verdict: revoked is the door's pass, live is auth.api_key_live, anything else is the same refusal.
    const answers: Array<() => Promise<Response>> = [
      async () => json({ id: KEY, userId: USER, revoked: true }),
      async () => json({ id: KEY, userId: USER, revoked: false }),
      async () => json({ id: KEY, userId: 'someone-else', revoked: true }),
      async () => new Response(null, { status: 404 }),
      async () => new Response(null, { status: 503 }),
      async () => {
        throw new Error('ECONNREFUSED');
      },
    ];
    const settle = (p: Promise<unknown>) =>
      p.then(
        () => ({ ok: true }),
        (err: { name?: string; code?: string }) => ({ name: err.name, code: err.code }),
      );
    const outcomes: unknown[] = [];
    for (const answer of answers) {
      const viaDoor: Array<{ url: string; init: RequestInit | undefined }> = [];
      const viaLive: Array<{ url: string; init: RequestInit | undefined }> = [];
      const door = await settle(
        recoveredMintKeyRevokeRefusesSession({ ...base, fetch: async (url, init) => (viaDoor.push({ url: String(url), init }), answer()) }),
      );
      const live = await settle(
        assertIdentityApiKeyLive({ ...base, fetch: async (url, init) => (viaLive.push({ url: String(url), init }), answer()) }),
      );
      expect(viaDoor).toHaveLength(1);
      expect(viaDoor[0]!.url).toBe(viaLive[0]!.url);
      expect(viaDoor[0]!.init?.method ?? 'GET').toBe(viaLive[0]!.init?.method ?? 'GET');
      outcomes.push({ door, live });
    }
    expect(outcomes).toEqual([
      { door: { ok: true }, live: { name: 'ApiKeyRevokedError', code: 'auth.api_key_revoked' } },
      { door: { name: 'RecoveredMintKeySessionError', code: 'auth.api_key_live' }, live: { ok: true } },
      ...outcomes.slice(2).map((o) => ({ door: (o as { live: unknown }).live, live: (o as { live: unknown }).live })),
    ]);
    for (const o of outcomes.slice(2)) expect((o as { live: { ok?: boolean } }).live.ok).toBeUndefined();
  });
});
