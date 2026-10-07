import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashRecoveryCode, recoveryCodeDropsOtherDropCopyStreams } from './recovery-drop-other-streams.js';

const CODE = 'A1B2C-D3E4F';
const OTHER_CODE = 'FFFFF-00000';
const HASHES = [hashRecoveryCode(CODE)];
const KEEP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const THIRD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

describe('recoveryCodeDropsOtherDropCopyStreams', () => {
  it('refuses a missing code', () => {
    try {
      recoveryCodeDropsOtherDropCopyStreams({ code: '', recoveryCodeHashes: HASHES });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_missing' });
    }
  });

  it('refuses a spent code', () => {
    try {
      recoveryCodeDropsOtherDropCopyStreams({ code: CODE, recoveryCodeHashes: [] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_spent' });
    }
  });

  it('allows a matching code without inventing a session', () => {
    expect(recoveryCodeDropsOtherDropCopyStreams({ code: CODE, recoveryCodeHashes: HASHES, recoveredSessionId: KEEP })).toEqual({
      keptSessionId: KEEP,
      droppedSessionIds: [],
    });
  });

  it('a matching recovery hash drops the other drop-copy seats and keeps the recovered session', () => {
    const dropped: string[] = [];
    const result = recoveryCodeDropsOtherDropCopyStreams({
      code: CODE,
      recoveryCodeHashes: [hashRecoveryCode(OTHER_CODE), hashRecoveryCode(CODE)],
      recoveredSessionId: KEEP,
      subscriptions: [
        { sessionId: OTHER, drop: () => dropped.push(OTHER) },
        { sessionId: KEEP, drop: () => dropped.push(KEEP) },
        { sessionId: THIRD, drop: () => dropped.push(THIRD) },
      ],
    });
    expect(result.keptSessionId).toBe(KEEP);
    expect(result.droppedSessionIds).toEqual([OTHER, THIRD]);
    expect(dropped).toEqual([OTHER, THIRD]);
  });

  it('a wrong code does not drop drop-copy seats and is not recovery', () => {
    const dropped: string[] = [];
    try {
      recoveryCodeDropsOtherDropCopyStreams({
        code: OTHER_CODE,
        recoveryCodeHashes: HASHES,
        recoveredSessionId: KEEP,
        subscriptions: [
          { sessionId: KEEP, drop: () => dropped.push(KEEP) },
          { sessionId: OTHER, drop: () => dropped.push(OTHER) },
        ],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_invalid' });
    }
    expect(dropped).toEqual([]);
  });

  it('the raw presented code is not treated as a stored hash', () => {
    const dropped: string[] = [];
    try {
      recoveryCodeDropsOtherDropCopyStreams({
        code: CODE,
        recoveryCodeHashes: [CODE],
        recoveredSessionId: KEEP,
        subscriptions: [{ sessionId: OTHER, drop: () => dropped.push(OTHER) }],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_invalid' });
    }
    expect(dropped).toEqual([]);
  });

  it('source keeps the recovered drop-copy door; not a private-stream or key-revoke redo', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'recovery-drop-other-streams.ts'), 'utf8');
    expect(src).toMatch(/recoveryCodeDropsOtherDropCopyStreams/);
    expect(src).toMatch(/auth.recovery_missing/);
    expect(src).toMatch(/auth.recovery_spent/);
    expect(src).toMatch(/auth.recovery_invalid/);
    expect(src).toMatch(/hashRecoveryCode/);
    expect(src).not.toMatch(/PRIVATE_STREAM_PATH/);
    expect(src).not.toMatch(/recoveredMintKeyRevokeDropsDropCopyStream/);
    expect(src).not.toMatch(/revokeAllApiKeys/);
    expect(src).not.toMatch(/generateAuthenticationOptions/);
    expect(src).not.toMatch(/INSERT\s+sessions/i);
  });
});
