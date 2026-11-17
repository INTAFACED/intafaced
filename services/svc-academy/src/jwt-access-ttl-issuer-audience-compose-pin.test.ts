/**
 * Unit card — compose stack passes access-token TTL / issuer / audience into svc-academy
 *
 * 1. Promise: host `.env` can pin token life and iss/aud for academy
 *    (authEnvSchema already defaults 900 / intafaced / intafaced.api).
 * 2. Break: compose booted academy with *edge-secret plus TOKEN_URL /
 *    IDENTITY_URL / stream / capacity / paper+tournament kills but no
 *    TTL/iss/aud → operator pin is a no-op and the container keeps the
 *    schema-only defaults forever.
 * 3. Done bar: docker-compose.apps.yml svc-academy has
 *    JWT_ACCESS_TTL_SECONDS: ${JWT_ACCESS_TTL_SECONDS:-900}
 *    JWT_ISSUER: ${JWT_ISSUER:-intafaced}
 *    JWT_AUDIENCE: ${JWT_AUDIENCE:-intafaced.api}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-academy block only)
 * 6. RED: pin fails if any of the three lines drop, duplicate in the academy
 *    block, or the compose defaults are not 900 / intafaced / intafaced.api
 * 7. Collision: stream / capacity / paper / tournament / TOKEN_URL /
 *    IDENTITY_URL pins — this pin does not restamp those keys
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');
const AUTH_ENV = resolve(import.meta.dirname, '../../../packages/config/src/env.ts');

function academyServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-academy');
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

const TTL = /^\s+JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}\s*$/gm;
const ISSUER = /^\s+JWT_ISSUER:\s*\$\{JWT_ISSUER:-intafaced\}\s*$/gm;
const AUDIENCE = /^\s+JWT_AUDIENCE:\s*\$\{JWT_AUDIENCE:-intafaced\.api\}\s*$/gm;

describe('compose JWT access TTL issuer audience for svc-academy', () => {
  const compose = readFileSync(COMPOSE, 'utf8');
  const authEnv = readFileSync(AUTH_ENV, 'utf8');
  const block = academyServiceBlock(compose);

  it('authEnvSchema still defaults 900 / intafaced / intafaced.api', () => {
    expect(authEnv).toMatch(/JWT_ACCESS_TTL_SECONDS:\s*z\.coerce\.number\(\)\.int\(\)\.min\(60\)\.max\(3600\)\.default\(900\)/);
    expect(authEnv).toMatch(/JWT_ISSUER:\s*z\.string\(\)\.default\('intafaced'\)/);
    expect(authEnv).toMatch(/JWT_AUDIENCE:\s*z\.string\(\)\.default\('intafaced\.api'\)/);
  });

  it('wires svc-academy JWT_ACCESS_TTL_SECONDS JWT_ISSUER JWT_AUDIENCE once with identity defaults', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-academy/);
    expect(block.match(TTL)).toHaveLength(1);
    expect(block.match(ISSUER)).toHaveLength(1);
    expect(block.match(AUDIENCE)).toHaveLength(1);
    expect(countAssignments(block, 'JWT_ACCESS_TTL_SECONDS')).toBe(1);
    expect(countAssignments(block, 'JWT_ISSUER')).toBe(1);
    expect(countAssignments(block, 'JWT_AUDIENCE')).toBe(1);
  });

  it('does not restamp stream capacity paper tournament TOKEN_URL IDENTITY_URL or add JWT_ACCESS_SECRET', () => {
    expect(block).toMatch(/TOKEN_URL:\s*http:\/\/svc-token:4003/);
    expect(block).toMatch(/IDENTITY_URL:\s*http:\/\/svc-identity:4002/);
    expect(block).toMatch(/ACADEMY_STREAM_PROVIDER:\s*\$\{ACADEMY_STREAM_PROVIDER:-none\}/);
    expect(block).toMatch(/ACADEMY_MAX_ROOM_CAPACITY:\s*\$\{ACADEMY_MAX_ROOM_CAPACITY:-\}/);
    expect(block).toMatch(/ACADEMY_PAPER_TRADING_ENABLED:\s*\$\{ACADEMY_PAPER_TRADING_ENABLED:-true\}/);
    expect(block).toMatch(/ACADEMY_TOURNAMENT_ENABLED:\s*\$\{ACADEMY_TOURNAMENT_ENABLED:-true\}/);
    expect(countAssignments(block, 'TOKEN_URL')).toBe(1);
    expect(countAssignments(block, 'IDENTITY_URL')).toBe(1);
    expect(countAssignments(block, 'ACADEMY_STREAM_PROVIDER')).toBe(1);
    expect(countAssignments(block, 'ACADEMY_MAX_ROOM_CAPACITY')).toBe(1);
    expect(countAssignments(block, 'ACADEMY_PAPER_TRADING_ENABLED')).toBe(1);
    expect(countAssignments(block, 'ACADEMY_TOURNAMENT_ENABLED')).toBe(1);
    expect(countAssignments(block, 'JWT_ACCESS_SECRET')).toBe(0);
    expect(block).toMatch(/LIVEKIT_URL:\s*\$\{LIVEKIT_URL:-\}/);
    expect(block).toMatch(/LIVEKIT_API_KEY:\s*\$\{LIVEKIT_API_KEY:-\}/);
    expect(block).toMatch(/LIVEKIT_API_SECRET:\s*\$\{LIVEKIT_API_SECRET:-\}/);
  });
});
