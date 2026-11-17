/**
 * Unit card — compose stack passes access-token TTL / issuer / audience into svc-support
 *
 * 1. Promise: host `.env` can pin token life and iss/aud for the desk
 *    (identity / edge defaults: 900, intafaced, intafaced.api).
 * 2. Break: compose booted support with edge-secret + identity URL but no
 *    TTL/iss/aud → operator pin is a no-op and the container keeps schema-only
 *    defaults forever.
 * 3. Done bar: docker-compose.apps.yml svc-support has
 *    JWT_ACCESS_TTL_SECONDS: ${JWT_ACCESS_TTL_SECONDS:-900}
 *    JWT_ISSUER: ${JWT_ISSUER:-intafaced}
 *    JWT_AUDIENCE: ${JWT_AUDIENCE:-intafaced.api}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-support block only)
 * 6. RED: pin fails if any line drops, is duplicated in the block, or the
 *    compose default is not 900 / intafaced / intafaced.api
 * 7. Collision: identity already ships TTL; this pin does not restamp
 *    IDENTITY_URL, internal-secret, LEDGER_URL, or JWT_ACCESS_SECRET
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');

function supportServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-support');
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

const TTL = /^\s+JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}\s*$/gm;
const ISSUER = /^\s+JWT_ISSUER:\s*\$\{JWT_ISSUER:-intafaced\}\s*$/gm;
const AUDIENCE = /^\s+JWT_AUDIENCE:\s*\$\{JWT_AUDIENCE:-intafaced\.api\}\s*$/gm;

describe('compose JWT access TTL issuer audience for svc-support', () => {
  const block = supportServiceBlock(readFileSync(COMPOSE, 'utf8'));

  it('wires svc-support JWT_ACCESS_TTL_SECONDS from the host, unique once, default 900', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-support/);
    expect(block.match(TTL)).toHaveLength(1);
    expect(countAssignments(block, 'JWT_ACCESS_TTL_SECONDS')).toBe(1);
  });

  it('wires svc-support JWT_ISSUER from the host, unique once, default intafaced', () => {
    expect(block.match(ISSUER)).toHaveLength(1);
    expect(countAssignments(block, 'JWT_ISSUER')).toBe(1);
  });

  it('wires svc-support JWT_AUDIENCE from the host, unique once, default intafaced.api', () => {
    expect(block.match(AUDIENCE)).toHaveLength(1);
    expect(countAssignments(block, 'JWT_AUDIENCE')).toBe(1);
  });

  it('does not restamp IDENTITY_URL internal-secret LEDGER_URL or JWT_ACCESS_SECRET', () => {
    expect(block).toMatch(/IDENTITY_URL:\s*http:\/\/svc-identity:4002/);
    expect(countAssignments(block, 'IDENTITY_URL')).toBe(1);
    expect(block).toMatch(/\*internal-secret/);
    expect(block).not.toMatch(/LEDGER_URL:/);
    expect(block).not.toMatch(/JWT_ACCESS_SECRET:/);
  });
});
