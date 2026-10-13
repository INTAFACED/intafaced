import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { newlyEnrolledPasskeyOpensSession, openLiveSessionAfterNewlyEnrolledPasskey } from './enroll-after-last-session-open.js';

function fakeSql(creds: unknown[] | null, session?: { id: string; user_id: string; revoked: boolean }) {
  let sessionReads = 0;
  const fn = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('select') && text.includes('webauthn_creds')) {
      if (creds === null) return [];
      return [{ webauthn_creds: creds }];
    }
    if (text.includes('from sessions')) {
      sessionReads += 1;
      if (!session) return [];
      return [
        {
          id: session.id,
          user_id: session.user_id,
          revoked: session.revoked,
          expires_at: new Date(Date.now() + 60_000),
        },
      ];
    }
    throw new Error(`unexpected sql: ${text}`);
  };
  const sql = fn as unknown as Parameters<typeof openLiveSessionAfterNewlyEnrolledPasskey>[0] & {
    sessionReads: number;
  };
  Object.defineProperty(sql, 'sessionReads', { get: () => sessionReads });
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
const live = { id: 'live-1', user_id: A, revoked: false };
const openInput = { userId: A, sessionId: 'live-1' };

describe('newlyEnrolledPasskeyOpensSession — enroll after last unenroll', () => {
  it('newly enrolled verified cred opens the existing live session; no invented session', async () => {
    expect(() => newlyEnrolledPasskeyOpensSession([enrolledAgain])).not.toThrow();
    expect(() => requireVerifiedPasskey([enrolledAgain])).not.toThrow();
    const sql = fakeSql([enrolledAgain], live);
    await expect(openLiveSessionAfterNewlyEnrolledPasskey(sql, openInput)).resolves.toEqual({
      id: 'live-1',
      userId: A,
    });
    expect(sql.sessionReads).toBe(1);
  });

  it('refuses a live session that belongs to a different user', async () => {
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const sql = fakeSql([enrolledAgain], { id: 'live-other', user_id: other, revoked: false });
    const opened = await openLiveSessionAfterNewlyEnrolledPasskey(sql, {
      userId: A,
      sessionId: 'live-other',
    }).then(
      (value) => value,
      () => undefined,
    );
    expect(opened?.userId).not.toBe(other);
    await expect(openLiveSessionAfterNewlyEnrolledPasskey(sql, { userId: A, sessionId: 'live-other' })).rejects.toMatchObject({
      code: 'auth.session_denied',
    });
  });

  it('newly enrolled cred without lastVerifiedAt is auth.passkey_verify_unavailable and does not open', async () => {
    try {
      newlyEnrolledPasskeyOpensSession([enrolledUnverified]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_verify_unavailable' });
    }
    const sql = fakeSql([enrolledUnverified], live);
    await expect(openLiveSessionAfterNewlyEnrolledPasskey(sql, openInput)).rejects.toMatchObject({
      code: 'auth.passkey_verify_unavailable',
    });
    expect(sql.sessionReads).toBe(0);
  });

  it('empty after last unenroll is auth.passkey_missing and does not open', async () => {
    try {
      newlyEnrolledPasskeyOpensSession([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.passkey_missing' });
    }
    const sql = fakeSql([], live);
    await expect(openLiveSessionAfterNewlyEnrolledPasskey(sql, openInput)).rejects.toMatchObject({
      code: 'auth.passkey_missing',
    });
    expect(sql.sessionReads).toBe(0);
  });

  it('source reuses requireVerifiedPasskey and PlaceDoor; no invented challenge or session', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'enroll-after-last-session-open.ts'), 'utf8');
    expect(src).toMatch(/requireVerifiedPasskey/);
    expect(src).toMatch(/PlaceDoor/);
    expect(src).toMatch(/assertSessionLive/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
    expect(src).not.toMatch(/INSERT\s+sessions/i);
    expect(src).not.toMatch(/INSERT\s+challenges/i);
  });
});
