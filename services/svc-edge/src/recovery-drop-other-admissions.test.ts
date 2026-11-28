import { describe, expect, it, vi } from 'vitest';
import { outcomeOf } from './testing/session-door-cases-fixture.js';
import { recoveryCodeDropsOtherAdmissions } from './recovery-drop-other-admissions.js';

const CODE = 'A1B2C-D3E4F';
const HASHES = ['hash-1'];

describe('recoveryCodeDropsOtherAdmissions', () => {
  it('refuses a missing code', () => {
    try {
      recoveryCodeDropsOtherAdmissions({ code: '', recoveryCodeHashes: HASHES });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_missing' });
    }
  });

  it('refuses a spent code', () => {
    try {
      recoveryCodeDropsOtherAdmissions({ code: CODE, recoveryCodeHashes: [] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.recovery_spent' });
    }
  });

  it('allows a remaining code without inventing a session', () => {
    expect(() => recoveryCodeDropsOtherAdmissions({ code: CODE, recoveryCodeHashes: HASHES })).not.toThrow();
  });

  it('is only the recovered admission door; not a streams redo', async () => {
    // The module is this one door and its typed error: no streams door, key revoke, challenge or session.
    const module = await import('./recovery-drop-other-admissions.js');
    expect(Object.keys(module).sort()).toEqual(['RecoveryCodeAdmissionError', 'recoveryCodeDropsOtherAdmissions']);
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
      expect(cases.map((input) => outcomeOf(() => recoveryCodeDropsOtherAdmissions(input)))).toEqual([
        ...Array(4).fill({ refused: 'RecoveryCodeAdmissionError', code: 'auth.recovery_missing' }),
        ...Array(3).fill({ refused: 'RecoveryCodeAdmissionError', code: 'auth.recovery_spent' }),
        { returned: undefined },
      ]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
