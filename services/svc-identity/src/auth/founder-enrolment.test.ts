/**
 * Founder invites: the pure half (generator, hashing, matching, env parsing).
 * The database half is register-founder.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  base32,
  canonicalInvite,
  founderEnrolmentConfig,
  generateFounderInvites,
  groupInvite,
  hashInvite,
  INVITE_BYTES,
  matchInvite,
  parseInviteExpiry,
  parseInviteHashes,
} from './founder-enrolment.js';

const here = dirname(fileURLToPath(import.meta.url));
const serviceDir = join(here, '..', '..');
const GROUPED = /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/;

describe('generateFounderInvites', () => {
  it('prints two distinct codes: at least 128 bits, base32, grouped for typing', () => {
    const out = generateFounderInvites();
    expect(INVITE_BYTES * 8).toBeGreaterThanOrEqual(128);
    expect(out.codes).toHaveLength(2);
    expect(new Set(out.codes).size).toBe(2);
    for (const code of out.codes) {
      expect(code).toMatch(GROUPED);
      // 32 base32 characters carry 160 bits.
      expect(canonicalInvite(code)).toHaveLength(32);
    }
  });

  it('hashes the canonical code with sha256 so an operator can verify one by hand', () => {
    const out = generateFounderInvites();
    out.codes.forEach((code, i) => {
      const expected = createHash('sha256').update(code.replaceAll('-', ''), 'utf8').digest('hex');
      expect(out.hashes[i]).toBe(expected);
      expect(out.hashes[i]).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('expires 72 hours after generation and prints the two env lines (hashes and expiry only)', () => {
    const now = new Date('2026-10-14T00:00:00.000Z');
    const out = generateFounderInvites(now);
    expect(out.expiresAt).toBe('2026-10-17T00:00:00.000Z');
    expect(out.envLines).toEqual([
      `IDENTITY_FOUNDER_INVITE_HASHES=${out.hashes[0]},${out.hashes[1]}`,
      'IDENTITY_FOUNDER_INVITE_EXPIRES_AT=2026-10-17T00:00:00.000Z',
    ]);
    for (const line of out.envLines) for (const code of out.codes) expect(line).not.toContain(canonicalInvite(code));
  });

  it('its env lines parse back into a config the service accepts, and each code matches its own hash only', () => {
    const out = generateFounderInvites(new Date('2026-10-14T00:00:00.000Z'));
    const config = founderEnrolmentConfig(out.hashes.join(','), out.expiresAt);
    expect(config?.hashes).toEqual(out.hashes);
    expect(matchInvite(out.codes[0]!, out.hashes)).toBe(out.hashes[0]);
    expect(matchInvite(out.codes[1]!, out.hashes)).toBe(out.hashes[1]);
  });

  it('the script prints two grouped codes plus the two env lines, and nothing else needs a network or a file', () => {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/founder-invites.ts'], {
      cwd: serviceDir,
      encoding: 'utf8',
      // No database, no secrets: it must not need the service environment.
      env: { PATH: process.env.PATH ?? '' },
    });
    const codes = stdout.match(/Invite \d: (\S+)/g)?.map((l) => l.split(': ')[1]!) ?? [];
    expect(codes).toHaveLength(2);
    for (const code of codes) expect(code).toMatch(GROUPED);
    const hashes = /^IDENTITY_FOUNDER_INVITE_HASHES=([0-9a-f]{64}),([0-9a-f]{64})$/m.exec(stdout);
    const expiry = /^IDENTITY_FOUNDER_INVITE_EXPIRES_AT=(\S+)$/m.exec(stdout);
    expect(hashes).not.toBeNull();
    expect(expiry).not.toBeNull();
    expect(hashInvite(canonicalInvite(codes[0]!))).toBe(hashes![1]);
    expect(hashInvite(canonicalInvite(codes[1]!))).toBe(hashes![2]);
    expect(parseInviteExpiry(expiry![1])!.getTime() - Date.now()).toBeGreaterThan(71 * 3_600_000);
    // The codes appear on the "Invite n:" lines, never on the env lines.
    for (const line of stdout.split('\n').filter((l) => l.startsWith('IDENTITY_'))) {
      for (const code of codes) expect(line).not.toContain(canonicalInvite(code));
    }
  });

  it('the script source imports no network, file, process or database module', () => {
    const source = readFileSync(join(serviceDir, 'scripts', 'founder-invites.ts'), 'utf8');
    expect(source).not.toMatch(/node:(fs|net|http|https|child_process|dgram|dns|tls)|fetch\(|postgres|writeFile|from '\.\.\/src\/env/);
    const lib = readFileSync(join(here, 'founder-enrolment.ts'), 'utf8');
    expect(lib).not.toMatch(/node:(fs|net|http|https|child_process|dgram|dns|tls)|fetch\(|postgres|process\.env/);
  });
});

describe('matchInvite', () => {
  const out = generateFounderInvites();

  it('accepts the grouped, ungrouped, lower-case and padded spellings of the same code', () => {
    const canonical = canonicalInvite(out.codes[0]!);
    for (const spelling of [
      out.codes[0]!,
      canonical,
      canonical.toLowerCase(),
      ` ${out.codes[0]!.toLowerCase()} `,
      out.codes[0]!.replaceAll('-', ' '),
    ]) {
      expect(matchInvite(spelling, out.hashes)).toBe(out.hashes[0]);
    }
  });

  it('refuses a wrong code, a one-character change, a truncation, an extension and garbage', () => {
    const canonical = canonicalInvite(out.codes[0]!);
    const flipped = canonical.slice(0, -1) + (canonical.endsWith('A') ? 'B' : 'A');
    for (const bad of ['', 'x', canonical.slice(1), `${canonical}A`, flipped, '!'.repeat(32), out.hashes[0]!]) {
      expect(matchInvite(bad, out.hashes)).toBeNull();
    }
  });

  it('compares with timingSafeEqual over every configured hash, without an early exit', () => {
    const lib = readFileSync(join(here, 'founder-enrolment.ts'), 'utf8');
    const body = lib.slice(lib.indexOf('export function matchInvite'), lib.indexOf('export function parseInviteHashes'));
    expect(body).toContain('timingSafeEqual');
    expect(body).not.toMatch(/\breturn hash\b|\bbreak\b/);
    expect(body).not.toMatch(/===\s*hash|hash\s*===/);
  });

  it('base32 follows RFC 4648', () => {
    expect(base32(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI');
    expect(groupInvite('ABCDEFGH')).toBe('ABCD-EFGH');
  });
});

describe('env parsing: no invented defaults', () => {
  const h1 = 'a'.repeat(64);
  const h2 = 'b'.repeat(64);

  it('unset or blank is undefined (enrolment closed)', () => {
    for (const blank of [undefined, null, '', '   ']) {
      expect(parseInviteHashes(blank)).toBeUndefined();
      expect(parseInviteExpiry(blank)).toBeUndefined();
    }
    expect(founderEnrolmentConfig(undefined, undefined)).toBeUndefined();
  });

  it('one without the other is a closed door, not a guess', () => {
    expect(founderEnrolmentConfig(`${h1},${h2}`, undefined)).toBeUndefined();
    expect(founderEnrolmentConfig(undefined, '2026-10-17T00:00:00Z')).toBeUndefined();
  });

  it('malformed values throw (fail boot) instead of silently closing', () => {
    expect(() => parseInviteHashes(h1)).toThrow(/exactly 2/);
    expect(() => parseInviteHashes(`${h1},${h1}`)).toThrow(/different/);
    expect(() => parseInviteHashes(`${h1},${h2},${h2}`)).toThrow();
    expect(() => parseInviteHashes(`${h1},${'B'.repeat(64)}`)).toThrow(/lowercase/);
    expect(() => parseInviteHashes(`${h1},zz`)).toThrow();
    expect(() => parseInviteExpiry('tomorrow')).toThrow(/ISO 8601/);
    expect(() => parseInviteExpiry('2026-10-17')).toThrow(/ISO 8601/);
    expect(() => parseInviteExpiry('2026-13-45T00:00:00Z')).toThrow(/ISO 8601/);
  });

  it('valid values parse', () => {
    expect(parseInviteHashes(` ${h1} , ${h2} `)).toEqual([h1, h2]);
    expect(parseInviteExpiry('2026-10-17T08:00:00+08:00')?.toISOString()).toBe('2026-10-17T00:00:00.000Z');
  });
});
