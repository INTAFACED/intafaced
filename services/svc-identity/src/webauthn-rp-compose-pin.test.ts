/**
 * Unit card — compose stack passes WebAuthn RP id/name/origin into svc-identity
 *
 * 1. Promise: host `.env` can pin WEBAUTHN_RP_ID / WEBAUTHN_RP_NAME /
 *    WEBAUTHN_ORIGIN (env.ts already defaults localhost / INTAFACED /
 *    http://localhost:3000).
 * 2. Break: compose booted identity without the names → operator domain is a
 *    no-op and the container keeps the schema-only default forever.
 * 3. Done bar: docker-compose.apps.yml svc-identity has
 *    WEBAUTHN_RP_ID: ${WEBAUTHN_RP_ID:-localhost}
 *    WEBAUTHN_RP_NAME: ${WEBAUTHN_RP_NAME:-INTAFACED}
 *    WEBAUTHN_ORIGIN: ${WEBAUTHN_ORIGIN:-http://localhost:8090,http://localhost:3100}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-identity block only)
 * 6. RED: pin fails if a line drops, is duplicated, or the compose default
 *    invents a production registrable domain
 * 7. Collision: existing WEBAUTHN_ENABLED pin — this pin only reads RP keys
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';
import { loadIdentityEnv } from './boot.testkit.js';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');

const RP_ID = 'WEBAUTHN_RP_ID';
const RP_NAME = 'WEBAUTHN_RP_NAME';
const ORIGIN = 'WEBAUTHN_ORIGIN';

function identityServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-identity');
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

describe('compose WebAuthn RP id/name/origin for svc-identity', () => {
  const compose = readFileSync(COMPOSE, 'utf8');
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const block = identityServiceBlock(compose);

  it('env.ts defaults RP id/name/origin to localhost / INTAFACED / http://localhost:3000, and reads host values', async () => {
    const unset = await loadIdentityEnv({ [RP_ID]: undefined, [RP_NAME]: undefined, [ORIGIN]: undefined });
    expect([unset.WEBAUTHN_RP_ID, unset.WEBAUTHN_RP_NAME, unset.WEBAUTHN_ORIGIN]).toEqual([
      'localhost',
      'INTAFACED',
      'http://localhost:3000',
    ]);
    const pinned = await loadIdentityEnv({ [RP_ID]: 'desk.test', [RP_NAME]: 'TEST desk', [ORIGIN]: 'https://desk.test' });
    expect([pinned.WEBAUTHN_RP_ID, pinned.WEBAUTHN_RP_NAME, pinned.WEBAUTHN_ORIGIN]).toEqual([
      'desk.test',
      'TEST desk',
      'https://desk.test',
    ]);
  });

  it('wires svc-identity WEBAUTHN_RP_ID WEBAUTHN_RP_NAME WEBAUTHN_ORIGIN from the host, unique once, env.ts defaults', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-identity/);
    expect(block).toMatch(/WEBAUTHN_RP_ID:\s*\$\{WEBAUTHN_RP_ID:-localhost\}/);
    expect(block).toMatch(/WEBAUTHN_RP_NAME:\s*\$\{WEBAUTHN_RP_NAME:-INTAFACED\}/);
    expect(block).toMatch(/WEBAUTHN_ORIGIN:\s*\$\{WEBAUTHN_ORIGIN:-http:\/\/localhost:8090,http:\/\/localhost:3100\}/);
    expect(block.match(/^\s+WEBAUTHN_RP_ID:\s*\$\{WEBAUTHN_RP_ID:-localhost\}\s*$/gm)).toHaveLength(1);
    expect(block.match(/^\s+WEBAUTHN_RP_NAME:\s*\$\{WEBAUTHN_RP_NAME:-INTAFACED\}\s*$/gm)).toHaveLength(1);
    expect(block.match(/^\s+WEBAUTHN_ORIGIN:\s*\$\{WEBAUTHN_ORIGIN:-http:\/\/localhost:8090,http:\/\/localhost:3100\}\s*$/gm)).toHaveLength(
      1,
    );
    expect(countAssignments(compose, RP_ID)).toBe(1);
    expect(countAssignments(compose, RP_NAME)).toBe(1);
    expect(countAssignments(compose, ORIGIN)).toBe(1);
  });

  it('does not restamp WEBAUTHN_ENABLED KYC TOTP max sub-accounts or waitlist flags', () => {
    expect(block).toMatch(/WEBAUTHN_ENABLED:\s*\$\{WEBAUTHN_ENABLED:-true\}/);
    expect(block).toMatch(/IDENTITY_KYC_DOC_KEY:\s*\$\{IDENTITY_KYC_DOC_KEY:-\}/);
    expect(block).toMatch(/IDENTITY_TOTP_SECRET_KEY:\s*\$\{IDENTITY_TOTP_SECRET_KEY:-\}/);
    expect(block).toMatch(/IDENTITY_MAX_SUB_ACCOUNTS:\s*\$\{IDENTITY_MAX_SUB_ACCOUNTS:-\}/);
    expect(block).toMatch(/INTAFACED_FLAG_WAITLIST_ENABLED:\s*\$\{INTAFACED_FLAG_WAITLIST_ENABLED:-\}/);
    expect(block).toMatch(/INTAFACED_FLAG_REFERRAL_QUEUE:\s*\$\{INTAFACED_FLAG_REFERRAL_QUEUE:-\}/);
    expect(countAssignments(block, 'WEBAUTHN_ENABLED')).toBe(1);
    expect(countAssignments(block, 'IDENTITY_KYC_DOC_KEY')).toBe(1);
    expect(countAssignments(block, 'IDENTITY_TOTP_SECRET_KEY')).toBe(1);
    expect(countAssignments(block, 'IDENTITY_MAX_SUB_ACCOUNTS')).toBe(1);
    expect(countAssignments(block, 'INTAFACED_FLAG_WAITLIST_ENABLED')).toBe(1);
    expect(countAssignments(block, 'INTAFACED_FLAG_REFERRAL_QUEUE')).toBe(1);
  });
});
