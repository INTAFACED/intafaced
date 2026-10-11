import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verifyAccessToken, type TokenConfig } from '@intafaced/auth';
import { hashRecoveryCode, recoveryCodeOpensRecoveredDropCopyStream } from './recovery-open-recovered-stream.js';

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

  it('source keeps the recovered-session drop-copy door; not a private-stream redo', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'recovery-open-recovered-stream.ts'), 'utf8');
    expect(src).toMatch(/recoveryCodeOpensRecoveredDropCopyStream/);
    expect(src).toMatch(/auth.recovery_missing/);
    expect(src).toMatch(/auth.recovery_spent/);
    expect(src).toMatch(/auth.recovery_invalid/);
    expect(src).toMatch(/hashRecoveryCode/);
    expect(src).toMatch(/issueAccessToken/);
    expect(src).not.toMatch(/PRIVATE_STREAM_PATH/);
    expect(src).not.toMatch(/from '\.\.\/private\//);
    expect(src).not.toMatch(/revokeAllApiKeys/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
    expect(src).not.toMatch(/INSERT\s+sessions/i);
  });
});
