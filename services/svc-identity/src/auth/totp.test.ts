import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateSecret,
  hotp,
  matchTotpStep,
  totp,
  totpStepOffset,
  totpUri,
  verifyTotp,
} from './totp.js';

/**
 * TOTP is verified against the RFC's own published test vectors. That is the
 * whole reason this is implemented rather than imported — a dependency in the
 * authentication path we cannot check against the spec is a dependency we are
 * trusting blind.
 */

describe('base32', () => {
  it('round-trips', () => {
    for (const input of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'Hello, world!']) {
      expect(base32Decode(base32Encode(Buffer.from(input))).toString()).toBe(input);
    }
  });

  it('matches RFC 4648 vectors', () => {
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Encode(Buffer.from('fo'))).toBe('MZXQ');
    expect(base32Encode(Buffer.from('foo'))).toBe('MZXW6');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('rejects a non-base32 character rather than silently producing garbage', () => {
    expect(() => base32Decode('MZXW6!')).toThrow(/Invalid base32/);
  });

  it('tolerates lowercase, padding and whitespace, as authenticator apps emit', () => {
    expect(base32Decode('mzxw6ytboi=').toString()).toBe('foobar');
    expect(base32Decode('MZXW 6YTB OI').toString()).toBe('foobar');
  });
});

describe('HOTP — RFC 4226 Appendix D', () => {
  // Secret is the ASCII string "12345678901234567890".
  const secret = Buffer.from('12345678901234567890');
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];

  it.each(expected.map((code, counter) => [counter, code]))('counter %i → %s', (counter, code) => {
    expect(hotp(secret, BigInt(counter))).toBe(code);
  });
});

describe('TOTP — RFC 6238 Appendix B', () => {
  const secretBase32 = base32Encode(Buffer.from('12345678901234567890'));

  // The RFC's SHA-1 vectors. Times are seconds since epoch.
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(vectors)('t=%i → %s', (seconds, code) => {
    expect(totp(secretBase32, { at: new Date(seconds * 1000), digits: 8 })).toBe(code);
  });
});

describe('verification', () => {
  const secret = generateSecret();

  it('accepts the current code', () => {
    const now = new Date();
    expect(verifyTotp(secret, totp(secret, { at: now }), { at: now })).toBe(true);
  });

  it('tolerates one step of clock drift in each direction', () => {
    const now = new Date();
    const past = new Date(now.getTime() - 30_000);
    const future = new Date(now.getTime() + 30_000);

    expect(verifyTotp(secret, totp(secret, { at: past }), { at: now })).toBe(true);
    expect(verifyTotp(secret, totp(secret, { at: future }), { at: now })).toBe(true);
  });

  it('rejects a code two steps away — the window is bounded on purpose', () => {
    const now = new Date();
    const stale = new Date(now.getTime() - 90_000);
    expect(verifyTotp(secret, totp(secret, { at: stale }), { at: now })).toBe(false);
  });

  it('rejects a wrong code', () => {
    expect(verifyTotp(secret, '000000')).toBe(false);
  });

  it('rejects non-numeric input without throwing', () => {
    for (const bad of ['abcdef', '', '12 34 56x', '<script>']) {
      expect(verifyTotp(secret, bad), bad).toBe(false);
    }
  });

  it('rejects a code of the wrong length', () => {
    const now = new Date();
    const code = totp(secret, { at: now });
    expect(verifyTotp(secret, code.slice(0, 5), { at: now })).toBe(false);
    expect(verifyTotp(secret, code + '0', { at: now })).toBe(false);
  });

  it('does not accept another secret’s code', () => {
    const other = generateSecret();
    const now = new Date();
    expect(verifyTotp(secret, totp(other, { at: now }), { at: now })).toBe(false);
  });

  it('matchTotpStep returns the counter that produced the code', () => {
    const now = new Date('2020-01-01T00:00:30.000Z');
    const seconds = Math.floor(now.getTime() / 1000);
    const counter = BigInt(Math.floor(seconds / 30));
    const code = totp(secret, { at: now });
    expect(matchTotpStep(secret, code, { at: now })).toBe(counter);
    expect(matchTotpStep(secret, '000000', { at: now })).toBeNull();
  });

  it('totpStepOffset tells an old code, a fresh one and a clock ahead apart, and refuses a wrong code', () => {
    const now = new Date('2020-01-01T00:10:00.000Z');
    const ago = (s: number) => new Date(now.getTime() + s * 1000);
    expect(totpStepOffset(secret, totp(secret, { at: now }), { at: now })).toBe(0);
    expect(totpStepOffset(secret, totp(secret, { at: ago(-150) }), { at: now })).toBe(-5);
    expect(totpStepOffset(secret, totp(secret, { at: ago(90) }), { at: now })).toBe(3);
    // Outside the reach it says nothing, and it never widens what login accepts.
    expect(totpStepOffset(secret, totp(secret, { at: ago(-30 * 21) }), { at: now })).toBeNull();
    expect(matchTotpStep(secret, totp(secret, { at: ago(-150) }), { at: now })).toBeNull();
    expect(totpStepOffset(secret, totp(generateSecret(), { at: now }), { at: now, reach: 0 })).toBeNull();
  });
});

describe('secrets and enrolment', () => {
  it('generates a distinct 160-bit secret each time', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateSecret()));
    expect(secrets.size).toBe(50);
    expect(base32Decode(generateSecret()).length).toBe(20);
  });

  it('builds an otpauth URI an authenticator app can read', () => {
    const uri = totpUri('JBSWY3DPEHPK3PXP', 'sovereign@example.com');
    expect(uri).toMatch(/^otpauth:\/\/totp\/INTAFACED:/);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=INTAFACED');
    expect(uri).toContain('period=30');
  });

  it('escapes an account name that would otherwise break the URI', () => {
    expect(totpUri('JBSWY3DPEHPK3PXP', 'a/b?c=d')).toContain('a%2Fb%3Fc%3Dd');
  });

  it('issues unique recovery codes', () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
  });
});
