import { describe, expect, it } from 'vitest';
import { encodeQr, qrCapacity, qrPath } from './qr';

// Decoding proof: 50 codes (all four levels, versions 1 to 40, accents, 0 to 1700 characters) were rendered and read back
// with Apple's Vision QR detector during development and every payload matched. These tests keep the structure honest.

const size = (m: boolean[][]) => m.length;

describe('encodeQr', () => {
  it('uses version 1 (21 modules) for a short text and grows with the text', () => {
    expect(size(encodeQr('hi', 'M'))).toBe(21);
    expect(size(encodeQr('x'.repeat(14), 'M'))).toBe(21);
    expect(size(encodeQr('x'.repeat(15), 'M'))).toBe(25);
    expect(size(encodeQr('x'.repeat(14), 'H'))).toBe(25);
  });
  it('is square and deterministic', () => {
    const a = encodeQr('https://example.test/pay/send?to=maya');
    const b = encodeQr('https://example.test/pay/send?to=maya');
    expect(a).toEqual(b);
    for (const row of a) expect(row.length).toBe(a.length);
  });
  it('draws the three finder patterns and the timing lines', () => {
    const m = encodeQr('timing check', 'M');
    const n = m.length;
    const finder = (x: number, y: number) => {
      for (let d = 0; d < 7; d++) {
        expect(m[y]![x + d]).toBe(true);
        expect(m[y + 6]![x + d]).toBe(true);
        expect(m[y + d]![x]).toBe(true);
        expect(m[y + d]![x + 6]).toBe(true);
      }
      expect(m[y + 3]![x + 3]).toBe(true);
      expect(m[y + 1]![x + 1]).toBe(false);
    };
    finder(0, 0);
    finder(n - 7, 0);
    finder(0, n - 7);
    for (let i = 8; i < n - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
    // The always-dark module beside the bottom-left finder.
    expect(m[n - 8]![8]).toBe(true);
  });
  it('writes a format word that matches its own error-correction level', () => {
    const m = encodeQr('format', 'L');
    // Read the 15 format bits around the top-left finder, the way a scanner does.
    let bits = 0;
    const order: [number, number][] = [];
    for (let i = 0; i <= 5; i++) order.push([8, i]);
    order.push([8, 7], [8, 8], [7, 8]);
    for (let i = 9; i < 15; i++) order.push([14 - i, 8]);
    order.forEach(([x, y], i) => {
      if (m[y]![x]) bits |= 1 << i;
    });
    const word = bits ^ 0x5412;
    // Level L is the two bits 01.
    expect(word >>> 13).toBe(1);
    // The BCH remainder must divide cleanly.
    let rem = word;
    for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
    expect(rem).toBe(0);
  });
  it('handles text outside ASCII', () => {
    expect(size(encodeQr('héllo ✓', 'M'))).toBeGreaterThanOrEqual(21);
  });
  it('refuses text past the largest code', () => {
    expect(() => encodeQr('x'.repeat(qrCapacity('H') + 1), 'H')).toThrow(RangeError);
    expect(() => encodeQr('x'.repeat(qrCapacity('H')), 'H')).not.toThrow();
  });
});

describe('qrPath', () => {
  it('adds a quiet zone and emits one run per stretch of dark modules', () => {
    const { d, size: total } = qrPath(
      [
        [true, true, false],
        [false, true, false],
        [false, false, false],
      ],
      1,
    );
    expect(total).toBe(5);
    expect(d).toBe('M1,1h2v1h-2zM2,2h1v1h-1z');
  });
});
