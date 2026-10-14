import { describe, expect, it } from 'vitest';

import { qrModules, qrPath, QR_QUIET_ZONE } from './qr';

describe('qr', () => {
  it('turns modules into one path of horizontal runs inside a quiet zone', () => {
    const { size, d } = qrPath([
      [true, false, true],
      [false, true, true],
      [true, true, false],
    ]);
    expect(size).toBe(3 + QR_QUIET_ZONE * 2);
    expect(d).toBe('M4 4h1v1h-1zM6 4h1v1h-1zM5 5h2v1h-2zM4 6h2v1h-2z');
  });

  it('draws an empty path for a blank grid', () => {
    expect(qrPath([[false, false]], 0)).toEqual({ size: 1, d: '' });
  });

  it('encodes through the real uqr: a square grid with no border and a finder pattern in the corner', () => {
    const modules = qrModules('otpauth://totp/INTAFACED:a%40b.c?secret=JBSWY3DPEHPK3PXP&issuer=INTAFACED');
    expect(modules).toHaveLength(37);
    expect(modules.every((row) => row.length === 37)).toBe(true);
    expect(modules[0]!.slice(0, 7)).toEqual(Array(7).fill(true));
    expect(modules[1]![1]).toBe(false);
  });

  it('refuses empty or oversized text', () => {
    expect(() => qrModules('')).toThrow();
    expect(() => qrModules('a'.repeat(513))).toThrow();
  });
});
