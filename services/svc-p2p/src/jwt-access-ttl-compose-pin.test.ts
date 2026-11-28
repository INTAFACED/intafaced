import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authEnvSchema } from '@intafaced/config';
import { describe, expect, it } from 'vitest';

/**
 * Unit card — compose stack passes access-token TTL / iss / aud into svc-p2p
 *
 * 1. Promise: host `.env` can pin token life and iss/aud
 *    (authEnvSchema already defaults 900 / intafaced / intafaced.api).
 * 2. Break: compose booted p2p with trading/escrow/dispute/retention knobs
 *    but no JWT TTL/iss/aud → operator pin is a no-op and the container
 *    keeps schema-only defaults forever.
 * 3. Done bar: docker-compose.apps.yml svc-p2p has
 *    JWT_ACCESS_TTL_SECONDS: ${JWT_ACCESS_TTL_SECONDS:-900}
 *    JWT_ISSUER: ${JWT_ISSUER:-intafaced}
 *    JWT_AUDIENCE: ${JWT_AUDIENCE:-intafaced.api}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-p2p block only)
 * 6. RED: pin fails if a key drops, is duplicated in the p2p block, or
 *    the compose defaults are not 900 / intafaced / intafaced.api
 * 7. Collision: offer/escrow/dispute/retention compose pins — this pin
 *    does not restamp those keys, bake P2P_FEE_BPS, or add JWT_ACCESS_SECRET
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const KEYS = [
  ['JWT_ACCESS_TTL_SECONDS', '900'],
  ['JWT_ISSUER', 'intafaced'],
  ['JWT_AUDIENCE', 'intafaced.api'],
] as const;

function p2pComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const start = compose.indexOf('\n  svc-p2p:');
  expect(start, 'svc-p2p service missing from docker-compose.apps.yml').toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n  svc-[a-z]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

describe('compose passes access-token TTL issuer audience into svc-p2p', () => {
  const block = p2pComposeBlock();

  it('authEnvSchema still defaults TTL / issuer / audience', () => {
    const secret = { JWT_ACCESS_SECRET: 's'.repeat(32) };
    expect(authEnvSchema.parse(secret)).toMatchObject({
      JWT_ACCESS_TTL_SECONDS: 900,
      JWT_ISSUER: 'intafaced',
      JWT_AUDIENCE: 'intafaced.api',
    });
    expect(authEnvSchema.parse({ ...secret, JWT_ACCESS_TTL_SECONDS: '60' }).JWT_ACCESS_TTL_SECONDS).toBe(60);
    expect(authEnvSchema.parse({ ...secret, JWT_ACCESS_TTL_SECONDS: '3600' }).JWT_ACCESS_TTL_SECONDS).toBe(3600);
    expect(authEnvSchema.safeParse({ ...secret, JWT_ACCESS_TTL_SECONDS: '59' }).success).toBe(false);
    expect(authEnvSchema.safeParse({ ...secret, JWT_ACCESS_TTL_SECONDS: '3601' }).success).toBe(false);
  });

  it('compose svc-p2p block passes each JWT key from the host with identity defaults', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-p2p/);
    for (const [name, fallback] of KEYS) {
      expect(block, `${name} missing from svc-p2p compose environment`).toMatch(
        new RegExp(`${name}:\\s*\\$\\{${name}:-${fallback.replace('.', '\\.')}\\}`),
      );
    }
  });

  it('names each JWT key once on svc-p2p (no duplicate assignments)', () => {
    for (const [name] of KEYS) {
      expect(countAssignments(block, name), `${name} must appear once on svc-p2p`).toBe(1);
    }
  });

  it('does not bake house take or add JWT_ACCESS_SECRET', () => {
    expect(block).toMatch(/P2P_FEE_BPS:\s*\$\{P2P_FEE_BPS:-\}/);
    expect(block).not.toMatch(/P2P_FEE_BPS:\s*\$\{P2P_FEE_BPS:-30\}/);
    expect(block).not.toMatch(/JWT_ACCESS_SECRET:/);
  });
});
