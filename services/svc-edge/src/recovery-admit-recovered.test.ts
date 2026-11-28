import { describe, expect, it, vi } from 'vitest';
import { outcomeOf } from './testing/session-door-cases-fixture.js';
import { recoveryCodeAdmitsRecoveredSession } from './recovery-admit-recovered.js';

const CODE = 'A1B2C-D3E4F';
const HASHES = ['hash-1'];

describe('recoveryCodeAdmitsRecoveredSession', () => {
  it('refuses a missing code', () => {
    try {
      recoveryCodeAdmitsRecoveredSession({ code: '', recoveryCodeHashes: HASHES });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_missing' });
    }
  });

  it('refuses a spent code', () => {
    try {
      recoveryCodeAdmitsRecoveredSession({ code: CODE, recoveryCodeHashes: [] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_spent' });
    }
  });

  it('allows a remaining code without inventing a session', () => {
    expect(() => recoveryCodeAdmitsRecoveredSession({ code: CODE, recoveryCodeHashes: HASHES })).not.toThrow();
  });

  it('is only the recovered-session admit door; not a drop-other or stream-open redo', async () => {
    // The module is this one door and its typed error: no drop-other, stream, key revoke, challenge or session.
    const module = await import('./recovery-admit-recovered.js');
    expect(Object.keys(module).sort()).toEqual(['RecoveryCodeAdmitError', 'recoveryCodeAdmitsRecoveredSession']);
    const cases = [
      { code: '', recoveryCodeHashes: HASHES },
      { code: '   ', recoveryCodeHashes: HASHES },
      { code: 7, recoveryCodeHashes: HASHES },
      { recoveryCodeHashes: HASHES },
      { code: CODE, recoveryCodeHashes: [] },
      { code: CODE, recoveryCodeHashes: [7] },
      { code: CODE },
      { code: CODE, recoveryCodeHashes: HASHES },
    ];
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      expect(cases.map((input) => outcomeOf(() => recoveryCodeAdmitsRecoveredSession(input)))).toEqual([
        ...Array(4).fill({ refused: 'RecoveryCodeAdmitError', code: 'auth.recovery_missing' }),
        ...Array(3).fill({ refused: 'RecoveryCodeAdmitError', code: 'auth.recovery_spent' }),
        { returned: undefined },
      ]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
