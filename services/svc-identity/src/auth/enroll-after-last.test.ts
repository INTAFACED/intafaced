import { describe, expect, it, vi } from 'vitest';
import * as webauthnLib from '@simplewebauthn/server';
import { beginEnrollAfterLastUnenroll, enrollAfterLastUnenroll } from './enroll-after-last.js';
import { beginEnrollPasskey, enrollPasskey, toRegistrationResponseJSON, type PasskeyCeremony } from './enroll-passkey.js';

// The WebAuthn library, watched: enrolling after the last passkey runs the ceremony it is given, never one of its own.
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const real = await importOriginal<typeof import('@simplewebauthn/server')>();
  return {
    ...real,
    generateRegistrationOptions: vi.fn(real.generateRegistrationOptions),
    verifyRegistrationResponse: vi.fn(real.verifyRegistrationResponse),
    generateAuthenticationOptions: vi.fn(real.generateAuthenticationOptions),
  };
});
import { mintApiKeyAfterPasskey, requireVerifiedPasskey } from './mint-api-key-passkey.js';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { rotateApiKeyAfterPasskey } from './rotate-api-key-passkey.js';
import { beginVerifyPasskey, type VerifyPasskeyCeremony } from './verify-passkey.js';
import type { ChallengeStorePort } from './webauthn.js';

function persistSql(initialCreds: unknown[]) {
  let creds = initialCreds;
  const written: unknown[] = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('SELECT')) return [{ email: 'a@b.c', handle: 'h', webauthn_creds: creds }];
    written.push(values);
    const payload = values.find((v) => Array.isArray(v));
    if (Array.isArray(payload)) creds = payload;
    return [];
  };
  return Object.assign(fn, {
    json: (v: unknown) => v,
    begin: (_o: string, cb: (t: unknown) => unknown) => cb(fn as never),
    written,
    get creds() {
      return creds;
    },
  });
}

function fakeSql(rows: unknown[] = []) {
  const fn = async () => rows;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  (fn as unknown as { begin: unknown }).begin = (_o: string, cb: (t: unknown) => unknown) => cb(fn);
  return fn as unknown as Parameters<typeof mintApiKeyAfterPasskey>[1];
}

function queuedSql(queue: unknown[][]) {
  let i = 0;
  const fn = async () => {
    const rows = queue[i] ?? [];
    i += 1;
    return rows;
  };
  return Object.assign(fn, {
    json: (v: unknown) => v,
    begin: (_o: string, cb: (t: unknown) => unknown) => cb(fn as never),
  }) as unknown as Parameters<typeof rotateApiKeyAfterPasskey>[1];
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
const verifiedAt = '2026-08-25T00:00:00.000Z';

function clientData(challenge: string): string {
  return Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: rp.origin }), 'utf8').toString('base64url');
}

function enrollCeremony(credentialId: string, generateCalls: unknown[] = []): PasskeyCeremony {
  return {
    generate: async (opts) => {
      generateCalls.push(opts);
      return {
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
      } as Awaited<ReturnType<PasskeyCeremony['generate']>>;
    },
    verify: async () =>
      ({
        verified: true,
        registrationInfo: {
          credential: {
            id: credentialId,
            publicKey: new Uint8Array([4, 5, 6]),
            counter: 0,
            transports: ['internal'],
          },
        },
      }) as Awaited<ReturnType<PasskeyCeremony['verify']>>,
  };
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

const mintInput = {
  userId: 'user-1',
  name: 'desk',
  scopes: ['identity:read'],
  grantorScopes: ['identity:read', 'identity:write'] as const,
};

const oldRow = {
  id: 'old',
  name: 'desk',
  scopes: ['identity:read'],
  domain_whitelist: [],
  expires_at: null,
  mode: 'live',
  ip_allowlist: [],
  account_id: null,
};

const rotateInput = { userId: 'user-1', keyId: 'old', grantorScopes: ['identity:read'] as const };

function writtenCreds(written: unknown[]): Array<{ credentialId: string }> {
  const payload = written.find((row) => Array.isArray(row) && row.some((v) => Array.isArray(v)));
  return ((payload as unknown[])?.find((v) => Array.isArray(v)) ?? []) as Array<{ credentialId: string }>;
}

const enrolledAgain = {
  credentialId: 'cred-3',
  publicKey: 'pk-3',
  counter: 0,
  createdAt: '2026-08-31T02:00:00.000Z',
  lastVerifiedAt: verifiedAt,
};

describe('enrollAfterLastUnenroll — enroll after last passkey was unenrolled', () => {
  it('reuses beginEnrollPasskey / enrollPasskey; does not invent a challenge', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-01T00:00:00.000Z'), toFake: ['Date'] });
    try {
      // The same options, held challenge and written passkeys as beginEnrollPasskey / enrollPasskey, from the given ceremony.
      const run = async (begin: typeof beginEnrollPasskey, finish: typeof enrollPasskey) => {
        const sql = persistSql([]);
        const generateCalls: unknown[] = [];
        const ceremony = enrollCeremony('cred-3', generateCalls);
        const challenges = memChallenges();
        const started = await begin(sql as never, 'user-1', rp, challenges, ceremony);
        const out = await finish(
          sql as never,
          'user-1',
          rp,
          toRegistrationResponseJSON({
            id: 'cred-3',
            rawId: 'cred-3',
            type: 'public-key',
            response: { clientDataJSON: clientData(started.challenge), attestationObject: 'a' },
          }),
          challenges,
          { mfa: true, privileged: false },
          ceremony,
        );
        return { started, generateCalls, out, written: sql.written, creds: sql.creds };
      };
      const own = await run(beginEnrollAfterLastUnenroll, enrollAfterLastUnenroll);
      const base = await run(beginEnrollPasskey, enrollPasskey);
      expect(own).toEqual(base);
      expect(own.started.challenge).toBe('lib-challenge');
      expect(own.generateCalls).toHaveLength(1);
      expect(own.out).toEqual({ credentialId: 'cred-3' });
    } finally {
      vi.useRealTimers();
    }
    // The WebAuthn library itself is never called: the ceremony given is the only one.
    expect(vi.mocked(webauthnLib.generateRegistrationOptions)).not.toHaveBeenCalled();
    expect(vi.mocked(webauthnLib.verifyRegistrationResponse)).not.toHaveBeenCalled();
    expect(vi.mocked(webauthnLib.generateAuthenticationOptions)).not.toHaveBeenCalled();
  });

  it('empty after last unenroll is auth.passkey_missing for mint, rotate, and session', async () => {
    expect(() => requireVerifiedPasskey([])).toThrow();
    try {
      requireVerifiedPasskey([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    const { minter, created } = makeMinter();
    await expect(mintApiKeyAfterPasskey(minter, fakeSql([{ webauthn_creds: [] }]), mintInput)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    await expect(rotateApiKeyAfterPasskey(minter, queuedSql([[{ webauthn_creds: [] }]]), rotateInput)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(created).toEqual([]);
  });

  it('beginEnrollAfterLastUnenroll on empty creds uses the library challenge and excludes nothing', async () => {
    const generateCalls: unknown[] = [];
    const started = await beginEnrollAfterLastUnenroll(
      persistSql([]) as never,
      'user-1',
      rp,
      memChallenges(),
      enrollCeremony('cred-3', generateCalls),
    );
    expect(started.challenge).toBe('lib-challenge');
    expect(generateCalls[0]).toMatchObject({ excludeCredentials: [] });
  });

  it('enrolls a new cred onto empty after last unenroll', async () => {
    const sql = persistSql([]);
    const ceremony = enrollCeremony('cred-3');
    const challenges = memChallenges({ challenge: 'lib-challenge', userId: 'user-1' });
    const out = await enrollAfterLastUnenroll(
      sql as never,
      'user-1',
      rp,
      toRegistrationResponseJSON({
        id: 'cred-3',
        rawId: 'cred-3',
        type: 'public-key',
        response: { clientDataJSON: clientData('lib-challenge'), attestationObject: 'a' },
      }),
      challenges,
      { mfa: true, privileged: false },
      ceremony,
    );
    expect(out).toEqual({ credentialId: 'cred-3' });
    expect(writtenCreds(sql.written).map((c) => c.credentialId)).toEqual(['cred-3']);
  });

  it('mint, rotate, and session can verify again after the new cred is verified', async () => {
    expect(() => requireVerifiedPasskey([enrolledAgain])).not.toThrow();

    const mint = makeMinter();
    await expect(mintApiKeyAfterPasskey(mint.minter, fakeSql([{ webauthn_creds: [enrolledAgain] }]), mintInput)).resolves.toMatchObject({
      id: 'k1',
    });
    expect(mint.created).toHaveLength(1);

    const rotate = makeMinter();
    await expect(
      rotateApiKeyAfterPasskey(rotate.minter, queuedSql([[{ webauthn_creds: [enrolledAgain] }], [oldRow]]), rotateInput),
    ).resolves.toMatchObject({ id: 'k1', revokedKeyId: 'old' });
    expect(rotate.created).toHaveLength(1);
    expect(rotate.revoked).toEqual(['old']);

    const generateCalls: unknown[] = [];
    const ceremony: VerifyPasskeyCeremony = {
      generate: async (opts) => {
        generateCalls.push(opts);
        return {
          challenge: 'lib-auth-challenge',
          timeout: 60_000,
          rpId: 'intafaced.com',
          allowCredentials: [],
          userVerification: 'required',
        } as Awaited<ReturnType<VerifyPasskeyCeremony['generate']>>;
      },
      verify: async () =>
        ({
          verified: true,
          authenticationInfo: { newCounter: 1, credentialID: 'cred-3' },
        }) as Awaited<ReturnType<VerifyPasskeyCeremony['verify']>>,
    };
    const started = await beginVerifyPasskey(
      fakeSql([{ webauthn_creds: [enrolledAgain] }]) as never,
      'user-1',
      rp,
      memChallenges(),
      ceremony,
    );
    expect(started.challenge).toBe('lib-auth-challenge');
    expect(generateCalls[0]).toMatchObject({ allowCredentials: [{ id: 'cred-3' }] });
  });
});
