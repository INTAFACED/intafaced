import { describe, expect, it } from 'vitest';
import { verifyAccessToken, type TokenConfig } from '@intafaced/auth';
import { createHash } from 'node:crypto';
import { RecoveryCodeOpenStreamError, recoveryCodeOpensRecoveredStream } from '../private/recovery-open-recovered-stream.js';
import {
  RecoveryCodeOpenDropCopyError,
  hashRecoveryCode,
  recoveryCodeOpensRecoveredDropCopyStream,
} from './recovery-open-recovered-stream.js';

const CODE = 'A1B2C-D3E4F';
const OTHER_CODE = 'FFFFF-00000';
const HASHES = [hashRecoveryCode(CODE)];
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEEP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const tokens: TokenConfig = {
  secret: 'test-access-secret-at-least-32-chars!!',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

describe('recoveryCodeOpensRecoveredDropCopyStream', () => {
  it('refuses a missing code', () => {
    try {
      recoveryCodeOpensRecoveredDropCopyStream({ code: '', recoveryCodeHashes: HASHES });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_missing' });
    }
  });

  it('refuses a spent code', () => {
    try {
      recoveryCodeOpensRecoveredDropCopyStream({ code: CODE, recoveryCodeHashes: [] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_spent' });
    }
  });

  it('a matching code authorizes the recovered session and does not invent one', async () => {
    const opened = await recoveryCodeOpensRecoveredDropCopyStream({
      code: CODE,
      recoveryCodeHashes: HASHES,
      recoveredSessionId: KEEP,
      userId: USER,
      tokens,
    });
    expect(opened.sessionId).toBe(KEEP);
    const principal = await verifyAccessToken(opened.accessToken, tokens);
    expect(principal.userId).toBe(USER);
    expect(principal.sid).toBe(KEEP);
    expect(principal.scopes).toContain('trade:read');
  });

  it('a matching code with no recovered session does not invent one or authorize it', () => {
    try {
      recoveryCodeOpensRecoveredDropCopyStream({
        code: CODE,
        recoveryCodeHashes: HASHES,
        userId: USER,
        tokens,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_invalid' });
    }
  });

  it('refuses to authorize when the token config is unset', () => {
    try {
      recoveryCodeOpensRecoveredDropCopyStream({
        code: CODE,
        recoveryCodeHashes: HASHES,
        recoveredSessionId: KEEP,
        userId: USER,
        tokens: null,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_invalid' });
    }
  });

  it('a wrong code does not authorize the recovered drop-copy stream', () => {
    try {
      recoveryCodeOpensRecoveredDropCopyStream({
        code: OTHER_CODE,
        recoveryCodeHashes: HASHES,
        recoveredSessionId: KEEP,
        userId: USER,
        tokens,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_invalid' });
    }
  });

  it('the raw presented code is not treated as a stored hash', () => {
    try {
      recoveryCodeOpensRecoveredDropCopyStream({
        code: CODE,
        recoveryCodeHashes: [CODE],
        recoveredSessionId: KEEP,
        userId: USER,
        tokens,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_invalid' });
    }
  });

  it('keeps the recovered-session drop-copy door: sha-256 hashes, its own typed refusals, a trade:read token for that session only; not a private-stream redo', async () => {
    expect(hashRecoveryCode(CODE)).toBe(createHash('sha256').update(CODE).digest('hex'));
    const refusal = (input: Parameters<typeof recoveryCodeOpensRecoveredDropCopyStream>[0]) => {
      try {
        recoveryCodeOpensRecoveredDropCopyStream(input);
        return 'opened';
      } catch (err) {
        expect(err).toBeInstanceOf(RecoveryCodeOpenDropCopyError);
        expect(err).not.toBeInstanceOf(RecoveryCodeOpenStreamError);
        return (err as RecoveryCodeOpenDropCopyError).code;
      }
    };
    expect(refusal({ code: '  ', recoveryCodeHashes: HASHES })).toBe('auth.recovery_missing');
    expect(refusal({ code: CODE, recoveryCodeHashes: 'x' })).toBe('auth.recovery_spent');
    expect(refusal({ code: OTHER_CODE, recoveryCodeHashes: HASHES, recoveredSessionId: KEEP, userId: USER, tokens })).toBe(
      'auth.recovery_invalid',
    );
    expect(
      refusal({ code: CODE, recoveryCodeHashes: HASHES, recoveredSessionId: KEEP, userId: USER, tokens: { ...tokens, secret: 'short' } }),
    ).toBe('auth.recovery_invalid');
    // Its one effect is a read-only token for the recovered session it was given: no new session, no key revoke.
    expect(recoveryCodeOpensRecoveredDropCopyStream.length).toBe(1);
    const opened = await recoveryCodeOpensRecoveredDropCopyStream({
      code: ` ${CODE} `,
      recoveryCodeHashes: HASHES,
      recoveredSessionId: ` ${KEEP} `,
      userId: ` ${USER} `,
      tokens,
    });
    expect(opened.sessionId).toBe(KEEP);
    const principal = await verifyAccessToken(opened.accessToken, tokens);
    expect(principal.sid).toBe(KEEP);
    expect(principal.userId).toBe(USER);
    expect(principal.scopes).toEqual(['trade:read']);
    expect(recoveryCodeOpensRecoveredDropCopyStream as unknown).not.toBe(recoveryCodeOpensRecoveredStream);
  });
});
