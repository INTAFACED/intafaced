import { describe, expect, it, vi } from 'vitest';
import * as webauthnLib from '@simplewebauthn/server';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { PlaceDoor } from './place-door.js';
import { newlyEnrolledPasskeyOpensSession, openLiveSessionAfterNewlyEnrolledPasskey } from './enroll-after-last-session-open.js';

// The WebAuthn library, watched: opening a seat after a passkey must never start a ceremony of its own.
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const real = await importOriginal<typeof import('@simplewebauthn/server')>();
  return { ...real, generateAuthenticationOptions: vi.fn(real.generateAuthenticationOptions) };
});

/** The code a synchronous check refuses with, or null when it passes. */
function refusalOf(check: () => void): unknown {
  try {
    check();
    return null;
  } catch (err) {
    return (err as { code?: unknown }).code;
  }
}

/** A call's outcome: its answer, or the code it refused with. */
async function settle<T>(p: Promise<T>): Promise<{ value: T } | { code: unknown }> {
  try {
    return { value: await p };
  } catch (err) {
    return { code: (err as { code?: unknown }).code };
  }
}

function fakeSql(creds: unknown[] | null, session?: { id: string; user_id: string; revoked: boolean }) {
  let sessionReads = 0;
  const statements: string[] = [];
  const fn = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    statements.push(text.replace(/\s+/g, ' ').trim());
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
  const sql = Object.assign(fn, { statements }) as Parameters<typeof openLiveSessionAfterNewlyEnrolledPasskey>[0] & {
    sessionReads: number;
    statements: string[];
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

  it("answers exactly as PlaceDoor's assertSessionLive does, after one passkey read; no invented challenge or session", async () => {
    const seats = [{ id: 'live-1', user_id: A, revoked: false }, { id: 'live-1', user_id: A, revoked: true }, undefined];
    for (const seat of seats) {
      const own = fakeSql([enrolledAgain], seat);
      const ownOut = await settle(openLiveSessionAfterNewlyEnrolledPasskey(own, { userId: A, sessionId: 'live-1' }));
      const base = fakeSql([enrolledAgain], seat);
      const baseOut = await settle(new PlaceDoor(base).assertSessionLive('live-1'));
      expect(ownOut).toEqual(baseOut);
      // One read of the stored passkeys (the gate), then the door's own read of the seat, and nothing written.
      expect(own.statements[0]).toBe('select webauthn_creds from users where id = ? limit 1');
      expect(own.statements.slice(1)).toEqual(base.statements);
      expect(own.statements.filter((s) => /insert\s+(into\s+)?(challenges|sessions)/.test(s))).toEqual([]);
    }
    // A live seat of someone else is denied, never opened for this person.
    await expect(
      openLiveSessionAfterNewlyEnrolledPasskey(fakeSql([enrolledAgain], { id: 'live-1', user_id: 'someone-else', revoked: false }), {
        userId: A,
        sessionId: 'live-1',
      }),
    ).rejects.toMatchObject({ code: 'auth.session_denied' });
    // Refused at the gate, the door never runs: only the passkey read.
    for (const creds of [[enrolledUnverified], []]) {
      const refused = fakeSql(creds, { id: 'live-1', user_id: A, revoked: false });
      await expect(openLiveSessionAfterNewlyEnrolledPasskey(refused, { userId: A, sessionId: 'live-1' })).rejects.toMatchObject({
        code: refusalOf(() => requireVerifiedPasskey(creds)),
      });
      expect(refused.statements).toHaveLength(1);
    }
    expect(vi.mocked(webauthnLib.generateAuthenticationOptions)).not.toHaveBeenCalled();
  });
});
