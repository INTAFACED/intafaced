import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { blankAsUnset, requireOwned, requireSetting } from './owner-values.js';
import { defineRefusals } from './refusals.js';

const r = defineRefusals('E', { 'x.cap_unset': 'PRECONDITION_FAILED', 'x.not_found': 'NOT_FOUND' });

describe('blankAsUnset', () => {
  const cap = blankAsUnset(z.coerce.number().int().min(0));

  it('reads blank and spaces as unset, never as zero', () => {
    expect(cap.parse('')).toBeUndefined();
    expect(cap.parse('   ')).toBeUndefined();
    expect(cap.parse(undefined)).toBeUndefined();
  });

  it('parses a set value, zero included', () => {
    expect(cap.parse('5')).toBe(5);
    expect(cap.parse('0')).toBe(0);
  });

  it('still refuses a value the inner schema refuses', () => {
    expect(() => cap.parse('-1')).toThrow();
    expect(() => cap.parse('ten')).toThrow();
  });
});

describe('requireSetting', () => {
  it('returns a set value, zero and empty string included', () => {
    expect(requireSetting(0, r, 'x.cap_unset')).toBe(0);
    expect(requireSetting('', r, 'x.cap_unset')).toBe('');
  });

  it('refuses null and undefined with the code, naming that the owner has not set it', () => {
    expect(() => requireSetting(null, r, 'x.cap_unset')).toThrow(expect.objectContaining({ code: 'x.cap_unset' }));
    expect(() => requireSetting(undefined, r, 'x.cap_unset', 'cap blank', { setting: 'X_CAP' })).toThrow(
      expect.objectContaining({ code: 'x.cap_unset', message: 'cap blank', details: { setting: 'X_CAP' } }),
    );
  });
});

describe('requireOwned', () => {
  const row = { id: 'r1', ownerId: 'u1' };
  const owner = (x: typeof row) => x.ownerId;

  it("returns the caller's own row", () => {
    expect(requireOwned(row, owner, { userId: 'u1' }, r, 'x.not_found')).toBe(row);
  });

  it("refuses someone else's row exactly as a missing one", () => {
    const other = (() => {
      try {
        requireOwned(row, owner, { userId: 'u2' }, r, 'x.not_found');
      } catch (err) {
        return err;
      }
    })();
    const missing = (() => {
      try {
        requireOwned(null, owner, { userId: 'u1' }, r, 'x.not_found');
      } catch (err) {
        return err;
      }
    })();
    expect(other).toMatchObject({ code: 'x.not_found', message: 'x.not_found' });
    expect(missing).toMatchObject({ code: 'x.not_found', message: 'x.not_found' });
  });
});
