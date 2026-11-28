import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadIdentityEnv } from './boot.testkit.js';

/**
 * Unit card — compose stack passes waitlist/referral flags into svc-identity
 *
 * 1. Promise: host `.env` can pin INTAFACED_FLAG_WAITLIST_ENABLED and
 *    INTAFACED_FLAG_REFERRAL_QUEUE (env.ts already names them optional).
 * 2. Break: compose booted identity without the names → host pins never
 *    reach the container; waitlist/referral always follow schema/drop only.
 * 3. Done bar: docker-compose.apps.yml svc-identity environment names both
 *    keys with empty host passthrough (`${VAR:-}`). Unset = drop clock.
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-identity block only)
 * 6. RED: pin fails if a key drops off, is duplicated, defaults on, or
 *    restamps WEBAUTHN / KYC / TOTP / max sub-accounts / REGISTRATION_OPEN
 * 7. Collision: existing identity compose pins — this pin only reads the
 *    two flag keys. No waitlist copy, no referral rates.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const WAITLIST = 'INTAFACED_FLAG_WAITLIST_ENABLED';
const REFERRAL = 'INTAFACED_FLAG_REFERRAL_QUEUE';

function identityComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const start = compose.indexOf('\n  svc-identity:');
  expect(start, 'svc-identity service missing from docker-compose.apps.yml').toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n  svc-[a-z]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

describe('compose passes waitlist and referral flags into svc-identity', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = identityComposeBlock();
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('env.ts reads both flags as given and leaves them unset when the host passes none (unset → drop clock)', async () => {
    const unset = await loadIdentityEnv({ [WAITLIST]: undefined, [REFERRAL]: undefined });
    expect(unset[WAITLIST]).toBeUndefined();
    expect(unset[REFERRAL]).toBeUndefined();
    const pinned = await loadIdentityEnv({ [WAITLIST]: 'on', [REFERRAL]: 'off' });
    expect(pinned[WAITLIST]).toBe('on');
    expect(pinned[REFERRAL]).toBe('off');
  });

  it('compose svc-identity block passes both flags from the host with empty defaults', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-identity/);
    expect(block, `${WAITLIST} missing empty-default pass-through`).toMatch(new RegExp(`${WAITLIST}:\\s*\\$\\{${WAITLIST}:-\\}`));
    expect(block, `${REFERRAL} missing empty-default pass-through`).toMatch(new RegExp(`${REFERRAL}:\\s*\\$\\{${REFERRAL}:-\\}`));
    expect(block).not.toMatch(new RegExp(`${WAITLIST}:\\s*\\$\\{${WAITLIST}:-(on|true|1)\\}`));
    expect(block).not.toMatch(new RegExp(`${REFERRAL}:\\s*\\$\\{${REFERRAL}:-(on|true|1)\\}`));
  });

  it('names each flag key once in compose (no duplicate assignments)', () => {
    expect(countAssignments(compose, WAITLIST), `${WAITLIST} must appear once`).toBe(1);
    expect(countAssignments(compose, REFERRAL), `${REFERRAL} must appear once`).toBe(1);
    expect(countAssignments(block, WAITLIST), `${WAITLIST} must appear once on svc-identity`).toBe(1);
    expect(countAssignments(block, REFERRAL), `${REFERRAL} must appear once on svc-identity`).toBe(1);
  });

  it('does not restamp WebAuthn, KYC, TOTP, max sub-accounts, or registration', () => {
    expect(block).toMatch(/REGISTRATION_OPEN:\s*\$\{REGISTRATION_OPEN:-\}/);
    expect(block).toMatch(/WEBAUTHN_ENABLED:\s*\$\{WEBAUTHN_ENABLED:-true\}/);
    expect(block).toMatch(/IDENTITY_KYC_DOC_KEY:\s*\$\{IDENTITY_KYC_DOC_KEY:-\}/);
    expect(block).toMatch(/IDENTITY_TOTP_SECRET_KEY:\s*\$\{IDENTITY_TOTP_SECRET_KEY:-\}/);
    expect(block).toMatch(/IDENTITY_MAX_SUB_ACCOUNTS:\s*\$\{IDENTITY_MAX_SUB_ACCOUNTS:-\}/);
    expect(countAssignments(block, 'REGISTRATION_OPEN')).toBe(1);
    expect(countAssignments(block, 'WEBAUTHN_ENABLED')).toBe(1);
    expect(countAssignments(block, 'IDENTITY_KYC_DOC_KEY')).toBe(1);
    expect(countAssignments(block, 'IDENTITY_TOTP_SECRET_KEY')).toBe(1);
    expect(countAssignments(block, 'IDENTITY_MAX_SUB_ACCOUNTS')).toBe(1);
  });
});
