import { describe, expect, it } from 'vitest';
import { b64urlDecode, decoyCredentialIds } from './webauthn.js';

const SECRET = 'a-server-secret-that-is-long-enough-for-tests';

describe('decoy credential ids (I-signin-sessions-02)', () => {
  it('are the same for the same identifier, ignoring case and spaces, and different for another', () => {
    expect(decoyCredentialIds(SECRET, 'Alice')).toEqual(decoyCredentialIds(SECRET, ' alice '));
    expect(decoyCredentialIds(SECRET, 'alice')).not.toEqual(decoyCredentialIds(SECRET, 'bob'));
    expect(decoyCredentialIds(SECRET, 'alice')).not.toEqual(decoyCredentialIds('another-secret-of-sufficient-length-here', 'alice'));
  });

  it('give 1 to 3 ids of 32 or 64 bytes, and both counts and lengths occur across identifiers', () => {
    const counts = new Set<number>();
    const lengths = new Set<number>();
    for (let i = 0; i < 300; i += 1) {
      const ids = decoyCredentialIds(SECRET, `user-${i}`);
      expect(ids.length).toBeGreaterThanOrEqual(1);
      expect(ids.length).toBeLessThanOrEqual(3);
      counts.add(ids.length);
      for (const id of ids) {
        const bytes = b64urlDecode(id).length;
        expect([32, 64]).toContain(bytes);
        lengths.add(bytes);
      }
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect([...counts].sort()).toEqual([1, 2, 3]);
    expect([...lengths].sort((a, b) => a - b)).toEqual([32, 64]);
  });
});
