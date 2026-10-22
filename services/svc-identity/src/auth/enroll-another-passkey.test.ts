import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { beginEnrollAnotherPasskey, enrollAnotherPasskey } from './enroll-another-passkey.js';
import { beginEnrollPasskey, type PasskeyCeremony } from './enroll-passkey.js';
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
    written,
    get creds() {
      return creds;
    },
  });
}

function fakeSql(rows: unknown[] = []) {
  const fn = async () => rows;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return fn as unknown as Parameters<typeof mintApiKeyAfterPasskey>[1];
}

function queuedSql(queue: unknown[][]) {
  let i = 0;
  const fn = async () => {
    const rows = queue[i] ?? [];
    i += 1;
    return rows;
  };
  return Object.assign(fn, { json: (v: unknown) => v }) as unknown as Parameters<typeof rotateApiKeyAfterPasskey>[1];
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

const first = {
  credentialId: 'cred-1',
  publicKey: 'pk-1',
  counter: 0,
  transports: ['internal'],
  createdAt: '2026-08-31T00:00:00.000Z',
  lastVerifiedAt: '2026-08-25T00:00:00.000Z',
};

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
    verify: async () => ({
      verified: true,
      registrationInfo: {
        credential: {
          id: credentialId,
          publicKey: new Uint8Array([4, 5, 6]),
          counter: 0,
          transports: ['internal'],
        },
      },
    }),
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
  grantorScopes: ['identity:read', 'identity:write'],
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

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'enroll-another-passkey.ts'), 'utf8');

function writtenCreds(written: unknown[]): Array<{ credentialId: string; lastVerifiedAt?: string }> {
  const payload = written.find((row) => Array.isArray(row) && row.some((v) => Array.isArray(v)));
  return ((payload as unknown[])?.find((v) => Array.isArray(v)) ?? []) as Array<{
    credentialId: string;
    lastVerifiedAt?: string;
  }>;
}

describe('enrollAnotherPasskey', () => {
  it('reuses beginEnrollPasskey / enrollPasskey; does not copy the ceremony or invent a challenge', () => {
    expect(src).toMatch(/beginEnrollPasskey\(/);
    expect(src).toMatch(/enrollPasskey\(/);
    expect(src).not.toMatch(/generateRegistrationOptions/);
    expect(src).not.toMatch(/verifyRegistrationResponse/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
  });

  it('enrolls a second cred without dropping the first lastVerifiedAt', async () => {
    const sql = persistSql([first]);
    const ceremony = enrollCeremony('cred-2');
    const challenges = memChallenges({ challenge: 'lib-challenge', userId: 'user-1' });
    const out = await enrollAnotherPasskey(
      sql as never,
      'user-1',
      rp,
      {
        id: 'cred-2',
        rawId: 'cred-2',
        type: 'public-key',
        response: { clientDataJSON: clientData('lib-challenge'), attestationObject: 'a' },
      },
      challenges,
      ceremony,
    );
    expect(out).toEqual({ credentialId: 'cred-2' });
    const creds = writtenCreds(sql.written);
    expect(creds.map((c) => c.credentialId)).toEqual(['cred-1', 'cred-2']);
    expect(creds[0]?.lastVerifiedAt).toBe(first.lastVerifiedAt);
  });

  it('beginEnrollAnotherPasskey and beginEnrollPasskey exclude the first credentialId; challenge is the library fake', async () => {
    const anotherCalls: unknown[] = [];
    const enrollCalls: unknown[] = [];
    const sql = persistSql([first]);

    const startedAnother = await beginEnrollAnotherPasskey(
      sql as never,
      'user-1',
      rp,
      memChallenges(),
      enrollCeremony('cred-2', anotherCalls),
    );
    expect(startedAnother.challenge).toBe('lib-challenge');
    expect(anotherCalls[0]).toMatchObject({ excludeCredentials: [{ id: 'cred-1' }] });

    const started = await beginEnrollPasskey(sql as never, 'user-1', rp, memChallenges(), enrollCeremony('cred-2', enrollCalls));
    expect(started.challenge).toBe('lib-challenge');
    expect(enrollCalls[0]).toMatchObject({ excludeCredentials: [{ id: 'cred-1' }] });
  });

  it('requireVerifiedPasskey succeeds if either of two creds has lastVerifiedAt', () => {
    const onlyFirst = [first, { ...first, credentialId: 'cred-2', lastVerifiedAt: undefined }];
    const onlySecond = [
      { ...first, lastVerifiedAt: undefined },
      {
        credentialId: 'cred-2',
        publicKey: 'pk-2',
        counter: 0,
        createdAt: '2026-08-31T01:00:00.000Z',
        lastVerifiedAt: first.lastVerifiedAt,
      },
    ];
    expect(() => requireVerifiedPasskey(onlyFirst)).not.toThrow();
    expect(() => requireVerifiedPasskey(onlySecond)).not.toThrow();
  });

  it('mintApiKeyAfterPasskey and rotateApiKeyAfterPasskey succeed when only the second or only the first is verified', async () => {
    const onlySecond = [
      { credentialId: 'cred-1', publicKey: 'pk-1', counter: 0, createdAt: '2026-08-31T00:00:00.000Z' },
      {
        credentialId: 'cred-2',
        publicKey: 'pk-2',
        counter: 0,
        createdAt: '2026-08-31T01:00:00.000Z',
        lastVerifiedAt: first.lastVerifiedAt,
      },
    ];
    const onlyFirst = [first, { credentialId: 'cred-2', publicKey: 'pk-2', counter: 0, createdAt: '2026-08-31T01:00:00.000Z' }];

    const mintSecond = makeMinter();
    await expect(mintApiKeyAfterPasskey(mintSecond.minter, fakeSql([{ webauthn_creds: onlySecond }]), mintInput)).resolves.toMatchObject({
      id: 'k1',
    });
    expect(mintSecond.created).toHaveLength(1);

    const mintFirst = makeMinter();
    await expect(mintApiKeyAfterPasskey(mintFirst.minter, fakeSql([{ webauthn_creds: onlyFirst }]), mintInput)).resolves.toMatchObject({
      id: 'k1',
    });
    expect(mintFirst.created).toHaveLength(1);

    const rotateSecond = makeMinter();
    await expect(
      rotateApiKeyAfterPasskey(rotateSecond.minter, queuedSql([[{ webauthn_creds: onlySecond }], [oldRow]]), rotateInput),
    ).resolves.toMatchObject({ id: 'k1', revokedKeyId: 'old' });
    expect(rotateSecond.created).toHaveLength(1);
    expect(rotateSecond.revoked).toEqual(['old']);

    const rotateFirst = makeMinter();
    await expect(
      rotateApiKeyAfterPasskey(rotateFirst.minter, queuedSql([[{ webauthn_creds: onlyFirst }], [oldRow]]), rotateInput),
    ).resolves.toMatchObject({ id: 'k1', revokedKeyId: 'old' });
    expect(rotateFirst.created).toHaveLength(1);
    expect(rotateFirst.revoked).toEqual(['old']);
  });

  it('beginVerifyPasskey allows both credential ids and uses the library challenge', async () => {
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
      verify: async () => ({
        verified: true,
        authenticationInfo: { newCounter: 1, credentialID: 'cred-1' },
      }),
    };
    const two = [first, { credentialId: 'cred-2', publicKey: 'pk-2', counter: 0, createdAt: '2026-08-31T01:00:00.000Z' }];
    const started = await beginVerifyPasskey(fakeSql([{ webauthn_creds: two }]) as never, 'user-1', rp, memChallenges(), ceremony);
    expect(started.challenge).toBe('lib-auth-challenge');
    expect(generateCalls[0]).toMatchObject({
      allowCredentials: [{ id: 'cred-1' }, { id: 'cred-2' }],
    });
  });

  it('duplicate credentialId refuses auth.webauthn_invalid and does not drop the first', async () => {
    const sql = persistSql([first]);
    const ceremony = enrollCeremony('cred-1');
    const challenges = memChallenges({ challenge: 'lib-challenge', userId: 'user-1' });
    await expect(
      enrollAnotherPasskey(
        sql as never,
        'user-1',
        rp,
        {
          id: 'cred-1',
          rawId: 'cred-1',
          type: 'public-key',
          response: { clientDataJSON: clientData('lib-challenge'), attestationObject: 'a' },
        },
        challenges,
        ceremony,
      ),
    ).rejects.toMatchObject({ code: 'auth.webauthn_invalid' });
    expect(sql.written).toEqual([]);
    expect((sql.creds as Array<{ credentialId: string }>).map((c) => c.credentialId)).toEqual(['cred-1']);
    expect((sql.creds as Array<{ lastVerifiedAt?: string }>)[0]?.lastVerifiedAt).toBe(first.lastVerifiedAt);
  });
});
