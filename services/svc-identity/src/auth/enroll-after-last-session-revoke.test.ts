import { describe, expect, it, vi } from 'vitest';
import * as webauthnLib from '@simplewebauthn/server';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { revokeSession } from './revoke-session.js';
import { newlyEnrolledPasskeyRevokesSession, revokeSessionAfterNewlyEnrolledPasskey } from './enroll-after-last-session-revoke.js';

// The WebAuthn library, watched: revoking after a passkey must never start a ceremony of its own.
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

function fakeSql(creds: unknown[], liveSessionId?: string) {
  let sessionWrites = 0;
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    statements.push({ text: text.replace(/\s+/g, ' ').trim(), values });
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
  const sql = Object.assign(fn, { statements }) as Parameters<typeof revokeSessionAfterNewlyEnrolledPasskey>[0] & {
    sessionWrites: number;
    statements: Array<{ text: string; values: unknown[] }>;
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

  it('revokes exactly as revokeSession does, after one passkey read; no invented challenge or session', async () => {
    for (const liveId of ['live-1', undefined]) {
      const own = fakeSql([enrolledAgain], liveId);
      const ownOut = revokeSessionAfterNewlyEnrolledPasskey(own, revokeInput);
      const base = fakeSql([enrolledAgain], liveId);
      const baseRevoked = await revokeSession(base, A, 'live-1');
      if (baseRevoked) await expect(ownOut).resolves.toEqual({ revokedSessionId: 'live-1' });
      else await expect(ownOut).rejects.toMatchObject({ code: 'auth.not_found' });
      // One read of the stored passkeys (the gate), then revokeSession's own statement with its own values.
      expect(own.statements[0]).toEqual({ text: 'select webauthn_creds from users where id = ? limit 1', values: [A] });
      expect(own.statements.slice(1)).toEqual(base.statements);
      expect(own.statements.filter((s) => /insert\s+(into\s+)?(challenges|sessions)/.test(s.text))).toEqual([]);
    }
    // Refused at the gate, revokeSession never runs: only the passkey read.
    for (const creds of [[enrolledUnverified], []]) {
      const refused = fakeSql(creds, 'live-1');
      await expect(revokeSessionAfterNewlyEnrolledPasskey(refused, revokeInput)).rejects.toMatchObject({
        code: refusalOf(() => requireVerifiedPasskey(creds)),
      });
      expect(refused.statements).toHaveLength(1);
    }
    expect(vi.mocked(webauthnLib.generateAuthenticationOptions)).not.toHaveBeenCalled();
  });
});
