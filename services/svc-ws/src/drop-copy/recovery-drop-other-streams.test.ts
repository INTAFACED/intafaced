import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { RecoveryCodeStreamError } from '../private/recovery-drop-other-streams.js';
import { recoveredMintKeyRevokeDropsDropCopyStream } from './recovery-mint-key-revoke-stream.js';
import { RecoveryCodeDropCopyStreamError, hashRecoveryCode, recoveryCodeDropsOtherDropCopyStreams } from './recovery-drop-other-streams.js';

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

  it('keeps the recovered drop-copy door: sha-256 hashes, typed refusals, drops only the seats it is handed; not a private-stream or key-revoke redo', () => {
    expect(hashRecoveryCode(CODE)).toBe(createHash('sha256').update(CODE).digest('hex'));
    const refusal = (input: Parameters<typeof recoveryCodeDropsOtherDropCopyStreams>[0]) => {
      try {
        return { result: recoveryCodeDropsOtherDropCopyStreams(input) };
      } catch (err) {
        expect(err).toBeInstanceOf(RecoveryCodeDropCopyStreamError);
        return { error: (err as RecoveryCodeDropCopyStreamError).code };
      }
    };
    expect(refusal({ code: '  ', recoveryCodeHashes: HASHES })).toEqual({ error: 'auth.recovery_missing' });
    expect(refusal({ code: CODE, recoveryCodeHashes: 'x' })).toEqual({ error: 'auth.recovery_spent' });
    expect(refusal({ code: OTHER_CODE, recoveryCodeHashes: HASHES })).toEqual({ error: 'auth.recovery_invalid' });
    // Its only effect is calling drop on the seats it was handed; it takes no port to revoke keys or write sessions.
    expect(recoveryCodeDropsOtherDropCopyStreams.length).toBe(1);
    const dropped: string[] = [];
    expect(
      refusal({
        code: ` ${CODE} `,
        recoveryCodeHashes: HASHES,
        recoveredSessionId: ` ${KEEP} `,
        subscriptions: [{ sessionId: OTHER, drop: () => dropped.push(OTHER) }, { sessionId: KEEP, drop: () => dropped.push(KEEP) }, 'junk'],
      }),
    ).toEqual({ result: { keptSessionId: KEEP, droppedSessionIds: [OTHER] } });
    expect(dropped).toEqual([OTHER]);
    expect(recoveryCodeDropsOtherDropCopyStreams as unknown).not.toBe(recoveredMintKeyRevokeDropsDropCopyStream);
    expect(RecoveryCodeDropCopyStreamError).not.toBe(RecoveryCodeStreamError);
  });
});
