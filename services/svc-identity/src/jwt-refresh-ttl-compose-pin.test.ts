/**
 * Unit card — compose stack passes JWT_REFRESH_TTL_SECONDS into svc-identity
 *
 * 1. Promise: host `.env` can pin refresh-token life
 *    (authEnvSchema already defaults JWT_REFRESH_TTL_SECONDS to 60*60*24*30).
 * 2. Break: compose booted identity with ACCESS TTL / SECRET / ISSUER /
 *    AUDIENCE but no refresh TTL → operator pin is a no-op and the container
 *    keeps the schema-only 30-day default forever.
 * 3. Done bar: docker-compose.apps.yml svc-identity has
 *    JWT_REFRESH_TTL_SECONDS: ${JWT_REFRESH_TTL_SECONDS:-2592000}.
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-identity block only)
 * 6. RED: pin fails if the line drops, is duplicated, or the compose default
 *    is not 2592000
 * 7. Collision: access TTL / secret / issuer / audience / WEBAUTHN / KYC /
 *    TOTP / waitlist / max-sub-accounts / affiliate-tier / registration pins —
 *    this pin does not restamp those keys
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');
const AUTH_ENV = resolve(import.meta.dirname, '../../../packages/config/src/env.ts');

function identityServiceBlock(source: string): string {
  const match = source.match(/^  svc-identity:\n(?:.*\n)*?(?=^  [a-z]|\Z)/m);
  if (!match) throw new Error('svc-identity service block missing from docker-compose.apps.yml');
  return match[0];
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

const LINE = /^\s+JWT_REFRESH_TTL_SECONDS:\s*\$\{JWT_REFRESH_TTL_SECONDS:-2592000\}\s*$/gm;

describe('compose JWT_REFRESH_TTL_SECONDS for svc-identity', () => {
  const compose = readFileSync(COMPOSE, 'utf8');
  const authEnv = readFileSync(AUTH_ENV, 'utf8');
  const block = identityServiceBlock(compose);

  it('authEnvSchema still defaults JWT_REFRESH_TTL_SECONDS to 60*60*24*30', () => {
    expect(authEnv).toMatch(/JWT_REFRESH_TTL_SECONDS:\s*z\.coerce[\s\S]*?\.default\(60 \* 60 \* 24 \* 30\)/);
  });

  it('wires svc-identity JWT_REFRESH_TTL_SECONDS from the host, unique once, default 2592000', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-identity/);
    expect(block.match(LINE)).toHaveLength(1);
    expect(countAssignments(block, 'JWT_REFRESH_TTL_SECONDS')).toBe(1);
  });

  it('does not restamp access TTL secret issuer audience WEBAUTHN KYC TOTP waitlist max-sub ledger affiliate or registration', () => {
    expect(block).toMatch(/JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}/);
    expect(block).toMatch(/JWT_ACCESS_SECRET:\s*\$\{JWT_ACCESS_SECRET:\?missing — copy \.env\.example to \.env\}/);
    expect(block).toMatch(/JWT_ISSUER:\s*\$\{JWT_ISSUER:-intafaced\}/);
    expect(block).toMatch(/JWT_AUDIENCE:\s*\$\{JWT_AUDIENCE:-intafaced\.api\}/);
    expect(block).toMatch(/WEBAUTHN_ENABLED:\s*\$\{WEBAUTHN_ENABLED:-true\}/);
    expect(block).toMatch(/WEBAUTHN_RP_ID:\s*\$\{WEBAUTHN_RP_ID:-localhost\}/);
    expect(block).toMatch(/WEBAUTHN_RP_NAME:\s*\$\{WEBAUTHN_RP_NAME:-INTAFACED\}/);
    expect(block).toMatch(/WEBAUTHN_ORIGIN:\s*\$\{WEBAUTHN_ORIGIN:-http:\/\/localhost:8090,http:\/\/localhost:3100\}/);
    expect(block).toMatch(/IDENTITY_KYC_DOC_KEY:\s*\$\{IDENTITY_KYC_DOC_KEY:-\}/);
    expect(block).toMatch(/IDENTITY_TOTP_SECRET_KEY:\s*\$\{IDENTITY_TOTP_SECRET_KEY:-\}/);
    expect(block).toMatch(/IDENTITY_MAX_SUB_ACCOUNTS:\s*\$\{IDENTITY_MAX_SUB_ACCOUNTS:-\}/);
    expect(block).toMatch(/INTAFACED_FLAG_WAITLIST_ENABLED:\s*\$\{INTAFACED_FLAG_WAITLIST_ENABLED:-\}/);
    expect(block).toMatch(/INTAFACED_FLAG_REFERRAL_QUEUE:\s*\$\{INTAFACED_FLAG_REFERRAL_QUEUE:-\}/);
    expect(block).toMatch(/IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON:\s*\$\{IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON:-\}/);
    expect(block).toMatch(/LEDGER_URL:\s*http:\/\/svc-ledger:4001/);
    expect(block).toMatch(/REGISTRATION_OPEN:\s*\$\{REGISTRATION_OPEN:-\}/);
    expect(countAssignments(block, 'JWT_ACCESS_TTL_SECONDS')).toBe(1);
    expect(countAssignments(block, 'JWT_ACCESS_SECRET')).toBe(1);
    expect(countAssignments(block, 'JWT_ISSUER')).toBe(1);
    expect(countAssignments(block, 'JWT_AUDIENCE')).toBe(1);
    expect(countAssignments(block, 'WEBAUTHN_ENABLED')).toBe(1);
    expect(countAssignments(block, 'WEBAUTHN_RP_ID')).toBe(1);
    expect(countAssignments(block, 'WEBAUTHN_RP_NAME')).toBe(1);
    expect(countAssignments(block, 'WEBAUTHN_ORIGIN')).toBe(1);
    expect(countAssignments(block, 'IDENTITY_KYC_DOC_KEY')).toBe(1);
    expect(countAssignments(block, 'IDENTITY_TOTP_SECRET_KEY')).toBe(1);
    expect(countAssignments(block, 'IDENTITY_MAX_SUB_ACCOUNTS')).toBe(1);
    expect(countAssignments(block, 'INTAFACED_FLAG_WAITLIST_ENABLED')).toBe(1);
    expect(countAssignments(block, 'INTAFACED_FLAG_REFERRAL_QUEUE')).toBe(1);
    expect(countAssignments(block, 'IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON')).toBe(1);
    expect(countAssignments(block, 'LEDGER_URL')).toBe(1);
    expect(countAssignments(block, 'REGISTRATION_OPEN')).toBe(1);
  });
});
