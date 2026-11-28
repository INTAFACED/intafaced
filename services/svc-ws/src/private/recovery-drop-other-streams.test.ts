import { describe, expect, it } from 'vitest';
import { RecoveryCodeStreamError, recoveryCodeDropsOtherStreams } from './recovery-drop-other-streams.js';

const CODE = 'A1B2C-D3E4F';
const HASHES = ['hash-1'];

describe('recoveryCodeDropsOtherStreams', () => {
  it('refuses a missing code', () => {
    try {
      recoveryCodeDropsOtherStreams({ code: '', recoveryCodeHashes: HASHES });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_missing' });
    }
  });

  it('refuses a spent code', () => {
    try {
      recoveryCodeDropsOtherStreams({ code: CODE, recoveryCodeHashes: [] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_spent' });
    }
  });

  it('allows a remaining code without inventing a session', () => {
    expect(() => recoveryCodeDropsOtherStreams({ code: CODE, recoveryCodeHashes: HASHES })).not.toThrow();
  });

  it('keeps the recovered stream door: typed refusals only, from the code and hashes alone; not a keys redo', () => {
    const refusal = (input: { code?: unknown; recoveryCodeHashes?: unknown }) => {
      try {
        return { ok: recoveryCodeDropsOtherStreams(input) === undefined };
      } catch (err) {
        expect(err).toBeInstanceOf(RecoveryCodeStreamError);
        return { error: (err as RecoveryCodeStreamError).code };
      }
    };
    expect(refusal({ code: '   ', recoveryCodeHashes: HASHES })).toEqual({ error: 'auth.recovery_missing' });
    expect(refusal({ code: 42, recoveryCodeHashes: HASHES })).toEqual({ error: 'auth.recovery_missing' });
    expect(refusal({ code: CODE, recoveryCodeHashes: 'hash-1' })).toEqual({ error: 'auth.recovery_spent' });
    expect(refusal({ code: CODE, recoveryCodeHashes: [7] })).toEqual({ error: 'auth.recovery_spent' });
    // It takes only the presented code and the stored hashes: no port to revoke keys, mint a challenge or write a
    // session, and it leaves what it was given untouched.
    expect(recoveryCodeDropsOtherStreams.length).toBe(1);
    const given = Object.freeze({ code: ` ${CODE} `, recoveryCodeHashes: Object.freeze([...HASHES]) });
    expect(refusal(given)).toEqual({ ok: true });
    expect(given).toEqual({ code: ` ${CODE} `, recoveryCodeHashes: HASHES });
  });
});
