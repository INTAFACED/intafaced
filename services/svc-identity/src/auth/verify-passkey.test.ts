import { describe, expect, it } from 'vitest';
import { beginVerifyPasskey, verifyPasskey, type VerifyPasskeyCeremony } from './verify-passkey.js';
import type { ChallengeStorePort } from './webauthn.js';

function fakeSql(rows: unknown[] = []) {
  const fn = async () => rows;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return fn as unknown as Parameters<typeof verifyPasskey>[0];
}

function memChallenges(seed?: { challenge: string; userId: string }): ChallengeStorePort {
  const entries = new Map<string, { challenge: string; userId: string; kind: string }>();
  if (seed) entries.set(seed.challenge, { ...seed, kind: 'authentication' });
  return {
    async put(kind, challenge, userId) {
      entries.set(challenge, { challenge, userId: userId ?? '', kind });
    },
    async take(challenge, kind) {
      const e = entries.get(challenge);
      entries.delete(challenge);
      if (!e || e.kind !== kind) return null;
      return {
        challenge: e.challenge,
        userId: e.userId,
        kind: e.kind as 'authentication',
        expiresAt: Date.now() + 60_000,
      };
    },
  };
}

const rp = { rpId: 'intafaced.com', rpName: 'INTAFACED', origin: 'https://app.intafaced.com' };

const enrolled = {
  credentialId: 'cred-1',
  publicKey: Buffer.from([1, 2, 3]).toString('base64url'),
  counter: 0,
  transports: ['internal'],
  createdAt: '2026-08-31T00:00:00.000Z',
};

const ceremony: VerifyPasskeyCeremony = {
  generate: async () =>
    ({
      challenge: 'lib-auth-challenge',
      timeout: 60_000,
      rpId: 'intafaced.com',
      allowCredentials: [{ id: 'cred-1', type: 'public-key', transports: ['internal'] }],
      userVerification: 'required',
    }) as Awaited<ReturnType<VerifyPasskeyCeremony['generate']>>,
  verify: async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1, credentialID: 'cred-1' },
  }),
};

function clientData(challenge: string): string {
  return Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: rp.origin }), 'utf8').toString('base64url');
}

const assertion = {
  id: 'cred-1',
  rawId: 'cred-1',
  type: 'public-key' as const,
  response: {
    clientDataJSON: clientData('lib-auth-challenge'),
    authenticatorData: 'a',
    signature: 's',
  },
};

describe('verifyPasskey', () => {
  it('refuses when no passkey is enrolled and does not mint a challenge', async () => {
    const challenges = memChallenges();
    await expect(beginVerifyPasskey(fakeSql([{ webauthn_creds: [] }]), 'u', rp, challenges, ceremony)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    await expect(beginVerifyPasskey(fakeSql([{ webauthn_creds: null }]), 'u', rp, challenges, ceremony)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    await expect(verifyPasskey(fakeSql([{ webauthn_creds: [] }]), 'u', rp, assertion, challenges, ceremony)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
  });

  it('uses the library challenge and persists the new counter so a later place can require it', async () => {
    const written: unknown[] = [];
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('?');
        if (text.includes('SELECT')) return [{ webauthn_creds: [enrolled] }];
        written.push(values);
        return [];
      },
      { json: (v: unknown) => v },
    );

    const started = await beginVerifyPasskey(sql as never, 'user-1', rp, memChallenges(), ceremony);
    expect(started.challenge).toBe('lib-auth-challenge');
    expect(started.allowCredentials?.[0]?.id).toBe('cred-1');

    const challenges = memChallenges({ challenge: 'lib-auth-challenge', userId: 'user-1' });
    const out = await verifyPasskey(sql as never, 'user-1', rp, assertion, challenges, ceremony);
    expect(out).toEqual({ credentialId: 'cred-1', verified: true });
    const payload = written.find((row) => Array.isArray(row) && row.some((v) => Array.isArray(v)));
    const creds = (payload as unknown[])?.find((v) => Array.isArray(v)) as Array<{
      credentialId: string;
      counter: number;
      lastVerifiedAt?: string;
    }>;
    expect(creds[0]?.credentialId).toBe('cred-1');
    expect(creds[0]?.counter).toBe(1);
    expect(creds[0]?.lastVerifiedAt).toBeTruthy();
  });

  it('treats a missing user as not found', async () => {
    await expect(beginVerifyPasskey(fakeSql([]), 'u', rp, memChallenges(), ceremony)).rejects.toMatchObject({
      code: 'auth.not_found',
    });
  });
});
