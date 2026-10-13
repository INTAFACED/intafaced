import { describe, expect, it } from 'vitest';
import { DECIMAL_UNSET, DEPRECATION_UNSET, IEEE_MONEY, SILENT_BREAK, handleFixDeveloper } from './developer-contract.js';

describe('CARD G-developer remaining FIX changelog + explicit decimal', () => {
  it('refuses a removed FIX tag without deprecation', () => {
    const out = handleFixDeveloper({
      kind: 'changelog',
      previousTags: ['38', '44', '54'],
      nextTags: ['38', '54'],
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(DEPRECATION_UNSET);
    expect(out.posted).toBe(false);
    expect(out.detail).toMatch(/44/);
  });

  it('refuses a deprecated FIX removal without a changelog', () => {
    const out = handleFixDeveloper({
      kind: 'changelog',
      previousTags: ['38', '44'],
      nextTags: ['38'],
      deprecated: ['44'],
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(SILENT_BREAK);
    expect(out.posted).toBe(false);
  });

  it('accepts a named deprecation only with a changelog', () => {
    const out = handleFixDeveloper({
      kind: 'changelog',
      previousTags: ['38', '44'],
      nextTags: ['38'],
      deprecated: ['44'],
      changelog: 'tag 44 Price is deprecated; use 44/15 pair',
    });
    expect(out).toEqual({
      ok: true,
      kind: 'changelog',
      posted: false,
      changelog: 'tag 44 Price is deprecated; use 44/15 pair',
      deprecated: ['44'],
      qty: null,
      price: null,
    });
  });

  it('refuses IEEE / JS-number money and still requires an explicit decimal string', () => {
    const ieee = handleFixDeveloper({ kind: 'decimal', ieee: true, qty: '1.5' });
    const badQty = handleFixDeveloper({ kind: 'decimal', qty: '1e2' });
    expect(ieee.ok).toBe(false);
    expect(badQty.ok).toBe(false);
    if (ieee.ok || badQty.ok) return;
    expect(ieee.reason).toBe(IEEE_MONEY);
    expect(badQty.reason).toBe(DECIMAL_UNSET);
    expect(() =>
      handleFixDeveloper({
        kind: 'decimal',
        qty: 1.5,
      }),
    ).toThrow();
  });

  it('accepts explicit decimal qty/price and never posts from this door', () => {
    const out = handleFixDeveloper({
      kind: 'decimal',
      qty: '1.50',
      price: '100.00',
    });
    expect(out).toEqual({
      ok: true,
      kind: 'decimal',
      posted: false,
      changelog: null,
      deprecated: [],
      qty: '1.50',
      price: '100.00',
    });
  });
});
