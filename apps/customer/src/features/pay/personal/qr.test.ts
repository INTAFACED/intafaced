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

// Golden matrices: each row is the module row packed 4 modules per hex digit (last digit zero-padded). Both codes were
// decoded back to their exact text with Apple's Vision QR detector when they were recorded. If the encoder changes
// and these fail, decode the new output with a scanner before updating them.
const hex = (m: boolean[][]) =>
  m.map((row) => {
    let out = '';
    for (let i = 0; i < row.length; i += 4) {
      let v = 0;
      for (let j = 0; j < 4; j++) v = (v << 1) | (row[i + j] ? 1 : 0);
      out += v.toString(16);
    }
    return out;
  });
const GOLDEN: { text: string; rows: string[] }[] = [
  {
    text: 'https://example.test/pay/send?to=maya',
    rows: [
      'fec8bbf8',
      '82d2ca08',
      'ba4eb2e8',
      'ba80cae8',
      'ba0fb2e8',
      '82621a08',
      'feaaabf8',
      '00c67000',
      'b726c258',
      '4118f388',
      'da5aa830',
      '0cd63b88',
      'e2804860',
      '09edf238',
      '5f5a5d38',
      '70859490',
      '96a9a5d0',
      '700d8970',
      '93d188a0',
      '28a1e5a0',
      '7325ffe0',
      '00f6e8f8',
      'fef43ad0',
      '82e008d8',
      'ba63cfa0',
      'babbc8c8',
      'bad22128',
      '821abbd0',
      'fe8f9a10',
    ],
  },
  {
    text: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx7',
    rows: [
      'fe0857564bf8',
      '824285fcd208',
      'baeea8e9d2e8',
      'bac97a231ae8',
      'ba95dff63ae8',
      '82d8289c8208',
      'feaaaaaaabf8',
      '00c868a9e000',
      'be152f8353e0',
      '0027eed61d18',
      '4318057cafb0',
      'e4583831e2e0',
      'de1d6b135048',
      '24165d4e1d18',
      'f34a19e4afb0',
      'fd3634a9e2e0',
      '53d960035048',
      '2cb5cf561d18',
      '174d9dfcafb0',
      'e534b089e2e0',
      'bfc9efc35fc8',
      '38b5c8961898',
      '5abc4adcbab0',
      '588e98a9e8e0',
      'ffc1df834fc8',
      '302dba560818',
      '5b04677cb530',
      '58f685a9f7f8',
      'c68198934ad8',
      '20dd62560818',
      'eb27effcb530',
      '28cfa4a9f7e0',
      'c2e1a9834ac8',
      'f8f95ad60818',
      '0b21e37cb530',
      '78c8a7e9f7e0',
      '9a783fa34fc8',
      '00f158f60898',
      'fe331a9caab0',
      '82b0d8a9e8e0',
      'bac20f835fc8',
      'bab162d61288',
      'bad34c7cb830',
      '82009f29ed60',
      'feaa158347d0',
    ],
  },
];

describe('golden codes', () => {
  it.each(GOLDEN.map((g) => [g.text.length, g] as const))('matches the recorded matrix for a %s-character text', (_length, g) => {
    expect(hex(encodeQr(g.text, 'M'))).toEqual(g.rows);
  });
});
