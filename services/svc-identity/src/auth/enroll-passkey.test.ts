import { describe, expect, it } from 'vitest';
import {
  beginEnrollPasskey,
  enrollPasskey,
  libraryTransports,
  requireOrigin,
  requireRpId,
  toRegistrationResponseJSON,
  type PasskeyCeremony,
} from './enroll-passkey.js';
import type { FactorActor } from './factor-gate.js';
import type { ChallengeStorePort } from './webauthn.js';

const mfaActor: FactorActor = { mfa: true, privileged: false };

function fakeSql(rows: unknown[] = []) {
  const fn = async () => rows;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  (fn as unknown as { begin: unknown }).begin = (_o: string, cb: (t: unknown) => unknown) => cb(fn);
  return fn as unknown as Parameters<typeof enrollPasskey>[0];
}

function memChallenges(seed?: { challenge: string; userId: string }): ChallengeStorePort {
  const entries = new Map<string, { challenge: string; userId: string; kind: string }>();
  if (seed) entries.set(seed.challenge, { ...seed, kind: 'registration' });
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
        kind: e.kind as 'registration',
        expiresAt: Date.now() + 60_000,
      };
    },
  };
}

const rp = { rpId: 'intafaced.com', rpName: 'INTAFACED', origin: 'https://app.intafaced.com' };

const ceremony: PasskeyCeremony = {
  generate: async () =>
    ({
      challenge: 'lib-challenge',
      rp: { name: 'INTAFACED', id: 'intafaced.com' },
      user: { id: 'u', name: 'a@b.c', displayName: 'h' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 60_000,
      excludeCredentials: [],
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
        requireResidentKey: false,
      },
      attestation: 'none',
    }) as Awaited<ReturnType<PasskeyCeremony['generate']>>,
  verify: async () =>
    ({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred-1',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['internal'],
        },
      },
    }) as Awaited<ReturnType<PasskeyCeremony['verify']>>,
};

function clientData(challenge: string): string {
  return Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: rp.origin }), 'utf8').toString('base64url');
}

describe('enrollPasskey', () => {
  it('refuses a blank RP id or origin and does not write', async () => {
    expect(() => requireRpId('')).toThrow(/RP id is required/);
    expect(() => requireRpId('   ')).toThrow(/RP id is required/);
    expect(() => requireOrigin('')).toThrow(/origin is required/);
    expect(() => requireOrigin('  ,  ')).toThrow(/origin is required/);

    await expect(
      beginEnrollPasskey(
        fakeSql([{ email: 'a@b.c', handle: 'h', webauthn_creds: [] }]),
        'u',
        { rpId: '', origin: rp.origin },
        memChallenges(),
        ceremony,
      ),
    ).rejects.toMatchObject({ code: 'auth.rp_id_missing' });
    await expect(
      enrollPasskey(
        fakeSql([{ webauthn_creds: [] }]),
        'u',
        { rpId: rp.rpId, origin: '' },
        toRegistrationResponseJSON({
          id: 'c',
          rawId: 'c',
          type: 'public-key',
          response: { clientDataJSON: clientData('x'), attestationObject: 'a' },
        }),
        memChallenges(),
        mfaActor,
        ceremony,
      ),
    ).rejects.toMatchObject({ code: 'auth.origin_missing' });
  });

  it('persists the library credential so a later place can require it', async () => {
    const written: unknown[] = [];
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('?');
        if (text.includes('SELECT')) return [{ email: 'a@b.c', handle: 'h', webauthn_creds: [] }];
        written.push(values);
        return [];
      },
      { json: (v: unknown) => v, begin: (_o: string, cb: (t: unknown) => unknown) => cb(sql as never) },
    );

    const started = await beginEnrollPasskey(sql as never, 'user-1', rp, memChallenges(), ceremony);
    expect(started.challenge).toBe('lib-challenge');
    expect(started.rp.id).toBe('intafaced.com');

    const challenges = memChallenges({ challenge: 'lib-challenge', userId: 'user-1' });
    const out = await enrollPasskey(
      sql as never,
      'user-1',
      rp,
      toRegistrationResponseJSON({
        id: 'cred-1',
        rawId: 'cred-1',
        type: 'public-key',
        response: { clientDataJSON: clientData('lib-challenge'), attestationObject: 'a' },
      }),
      challenges,
      mfaActor,
      ceremony,
    );
    expect(out).toEqual({ credentialId: 'cred-1' });
    const payload = written.find((row) => Array.isArray(row) && row.some((v) => Array.isArray(v)));
    const creds = (payload as unknown[])?.find((v) => Array.isArray(v)) as Array<{
      credentialId: string;
      publicKey: string;
    }>;
    expect(creds[0]?.credentialId).toBe('cred-1');
    expect(creds[0]?.publicKey).toBeTruthy();
  });

  it('treats a missing user as not found', async () => {
    await expect(beginEnrollPasskey(fakeSql([]), 'u', rp, memChallenges(), ceremony)).rejects.toMatchObject({
      code: 'auth.not_found',
    });
  });
});

describe('toRegistrationResponseJSON', () => {
  it('fills required library extensions and drops unknown transports', () => {
    const out = toRegistrationResponseJSON({
      id: 'cred-1',
      rawId: 'cred-1',
      type: 'public-key',
      response: { clientDataJSON: 'cd', attestationObject: 'ao', transports: ['usb', 'not-a-transport'] },
    });
    expect(out.clientExtensionResults).toEqual({});
    expect(out.response.transports).toEqual(['usb']);
    expect(libraryTransports(['usb', 'internal', 'nope'])).toEqual(['usb', 'internal']);
  });
});
