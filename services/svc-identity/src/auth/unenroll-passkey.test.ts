import { describe, expect, it } from 'vitest';
import { requireVerifiedPasskey, mintApiKeyAfterPasskey } from './mint-api-key-passkey.js';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { rotateApiKeyAfterPasskey } from './rotate-api-key-passkey.js';
import { beginVerifyPasskey, type VerifyPasskeyCeremony } from './verify-passkey.js';
import type { ChallengeStorePort } from './webauthn.js';
import { unenrollPasskey } from './unenroll-passkey.js';

function fakeSql(rows: unknown[] = []) {
  const fn = async () => rows;
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return fn as unknown as Parameters<typeof unenrollPasskey>[0];
}

function trackingSql(selectRows: unknown[]) {
  const written: unknown[] = [];
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('SELECT')) return selectRows;
      written.push(values);
      return [];
    },
    { json: (v: unknown) => v },
  );
  return { sql: sql as unknown as Parameters<typeof unenrollPasskey>[0], written };
}

function memChallenges(): ChallengeStorePort {
  return {
    async put() {
      throw new Error('challenge store put must not be called');
    },
    async take() {
      return null;
    },
  };
}

function makeMinter() {
  const created: unknown[] = [];
  const minter: ApiKeyMinter = {
    async createApiKey(input) {
      created.push(input);
      return { id: 'k1', key: 'ifk_live_secret', prefix: 'ifk_live', mode: input.mode ?? 'live' };
    },
    async revokeApiKey() {
      return true;
    },
  };
  return { minter, created };
}

const enrolled = {
  credentialId: 'cred-1',
  publicKey: 'pk',
  counter: 0,
  createdAt: '2026-08-31T00:00:00.000Z',
  lastVerifiedAt: '2026-08-25T00:00:00.000Z',
};
const other = {
  credentialId: 'cred-2',
  publicKey: 'pk2',
  counter: 1,
  createdAt: '2026-08-31T00:00:00.000Z',
  lastVerifiedAt: '2026-08-25T00:00:00.000Z',
};

const mintInput = {
  userId: 'u',
  name: 'desk',
  scopes: ['identity:read'],
  grantorScopes: ['identity:read', 'identity:write'],
};
const rotateInput = { userId: 'u', keyId: 'old', grantorScopes: ['identity:read'] as const };
const rp = { rpId: 'intafaced.com', rpName: 'INTAFACED', origin: 'https://app.intafaced.com' };

describe('unenrollPasskey', () => {
  it('unenrolls an enrolled+verified cred so the written array no longer contains it', async () => {
    const { sql, written } = trackingSql([{ webauthn_creds: [enrolled, other] }]);
    const out = await unenrollPasskey(sql, 'u', 'cred-1');
    expect(out).toEqual({ credentialId: 'cred-1', remaining: 1 });
    const payload = written.find((row) => Array.isArray(row) && row.some((v) => Array.isArray(v)));
    const creds = (payload as unknown[])?.find((v) => Array.isArray(v)) as Array<{ credentialId: string }>;
    expect(creds.map((c) => c.credentialId)).toEqual(['cred-2']);
  });

  it('after unenrolling the last cred, mint rotate and session verify refuse passkey_missing', async () => {
    const { sql, written } = trackingSql([{ webauthn_creds: [enrolled] }]);
    const out = await unenrollPasskey(sql, 'u', 'cred-1');
    expect(out).toEqual({ credentialId: 'cred-1', remaining: 0 });
    const payload = written.find((row) => Array.isArray(row) && row.some((v) => Array.isArray(v)));
    const creds = (payload as unknown[])?.find((v) => Array.isArray(v)) as unknown[];
    expect(creds).toEqual([]);

    try {
      requireVerifiedPasskey([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }

    const { minter, created } = makeMinter();
    const emptySql = fakeSql([{ webauthn_creds: [] }]);
    await expect(mintApiKeyAfterPasskey(minter, emptySql, mintInput)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    await expect(rotateApiKeyAfterPasskey(minter, emptySql, rotateInput)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(created).toEqual([]);

    let generateCalled = false;
    const ceremony: VerifyPasskeyCeremony = {
      generate: async () => {
        generateCalled = true;
        throw new Error('ceremony.generate must not invent a challenge');
      },
      verify: async () => {
        throw new Error('ceremony.verify must not be called');
      },
    };
    await expect(beginVerifyPasskey(emptySql, 'u', rp, memChallenges(), ceremony)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(generateCalled).toBe(false);
  });

  it('treats a missing user as not_found and does not write', async () => {
    const { sql, written } = trackingSql([]);
    await expect(unenrollPasskey(sql, 'u', 'cred-1')).rejects.toMatchObject({ code: 'auth.not_found' });
    expect(written).toEqual([]);
  });

  it('treats an unknown credentialId as passkey_missing and does not write', async () => {
    const { sql, written } = trackingSql([{ webauthn_creds: [enrolled] }]);
    await expect(unenrollPasskey(sql, 'u', 'cred-unknown')).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(written).toEqual([]);
  });

  it('refuses a blank credentialId and does not write', async () => {
    const { sql, written } = trackingSql([{ webauthn_creds: [enrolled] }]);
    await expect(unenrollPasskey(sql, 'u', '')).rejects.toMatchObject({
      code: 'auth.credential_id_missing',
    });
    await expect(unenrollPasskey(sql, 'u', '   ')).rejects.toMatchObject({
      code: 'auth.credential_id_missing',
    });
    expect(written).toEqual([]);
  });
});
