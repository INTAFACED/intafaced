import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { newlyEnrolledPasskeyRevokesSession, revokeSessionAfterNewlyEnrolledPasskey } from './enroll-after-last-session-revoke.js';

function fakeSql(creds: unknown[], liveSessionId?: string) {
  let sessionWrites = 0;
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('select') && text.includes('webauthn_creds')) {
      return [{ webauthn_creds: creds }];
    }
    if (text.includes('update sessions')) {
      sessionWrites += 1;
      const sessionId = values[0];
      if (liveSessionId && sessionId === liveSessionId) return [{ id: sessionId }];
      return [];
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  const sql = fn as Parameters<typeof revokeSessionAfterNewlyEnrolledPasskey>[0] & {
    sessionWrites: number;
  };
  Object.defineProperty(sql, 'sessionWrites', { get: () => sessionWrites });
  return sql;
}

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const verifiedAt = '2026-08-25T00:00:00.000Z';
const enrolledAgain = {
  credentialId: 'cred-3',
  publicKey: 'pk',
  counter: 0,
  createdAt: '2026-08-31T02:00:00.000Z',
  lastVerifiedAt: verifiedAt,
};
const enrolledUnverified = {
  credentialId: 'cred-3',
  publicKey: 'pk',
  counter: 0,
  createdAt: '2026-08-31T02:00:00.000Z',
};
const revokeInput = { userId: A, sessionId: 'live-1' };

describe('newlyEnrolledPasskeyRevokesSession — enroll after last unenroll', () => {
  it('newly enrolled verified cred revokes the live session; no invented challenge', async () => {
    expect(() => newlyEnrolledPasskeyRevokesSession([enrolledAgain])).not.toThrow();
    expect(() => requireVerifiedPasskey([enrolledAgain])).not.toThrow();
    const sql = fakeSql([enrolledAgain], 'live-1');
    await expect(revokeSessionAfterNewlyEnrolledPasskey(sql, revokeInput)).resolves.toEqual({
      revokedSessionId: 'live-1',
    });
    expect(sql.sessionWrites).toBe(1);
  });

  it('newly enrolled cred without lastVerifiedAt is auth.passkey_verify_unavailable and does not revoke', async () => {
    try {
      newlyEnrolledPasskeyRevokesSession([enrolledUnverified]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
    const sql = fakeSql([enrolledUnverified], 'live-1');
    await expect(revokeSessionAfterNewlyEnrolledPasskey(sql, revokeInput)).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(sql.sessionWrites).toBe(0);
  });

  it('empty after last unenroll is auth.passkey_missing and does not revoke', async () => {
    try {
      newlyEnrolledPasskeyRevokesSession([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    const sql = fakeSql([], 'live-1');
    await expect(revokeSessionAfterNewlyEnrolledPasskey(sql, revokeInput)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(sql.sessionWrites).toBe(0);
  });

  it('source reuses requireVerifiedPasskey and revokeSession; no invented challenge', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'enroll-after-last-session-revoke.ts'), 'utf8');
    expect(src).toMatch(/requireVerifiedPasskey/);
    expect(src).toMatch(/revokeSession/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
    expect(src).not.toMatch(/INSERT\s+sessions/i);
    expect(src).not.toMatch(/INSERT\s+challenges/i);
  });
});
