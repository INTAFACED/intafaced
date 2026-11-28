import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadP2pEnv } from './testing/env-load-fixture.js';

/**
 * Unit card — compose stack passes instrument retention into svc-p2p
 *
 * 1. Promise: host `.env` can pin closed-trade instrument purge days
 *    (env.ts already declares P2P_INSTRUMENT_RETENTION_DAYS).
 * 2. Break: compose booted p2p without the name → operator retention is a
 *    no-op. Blank must refuse, never invent 90d.
 * 3. Done bar: docker-compose.apps.yml svc-p2p environment names
 *    P2P_INSTRUMENT_RETENTION_DAYS with empty host passthrough.
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-p2p block only)
 * 6. RED: pin fails if the name drops off, is duplicated, or bakes
 *    P2P_FEE_BPS / method registry / destination accounts / KMS
 * 7. Collision: offer/escrow/dispute compose pins — this pin only reads
 *    the retention key. Owner publishes days; when set, env.ts still
 *    forbids retention shorter than the dispute SLA.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const KEY = 'P2P_INSTRUMENT_RETENTION_DAYS';

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

describe('compose passes p2p.payment-instruments retention into svc-p2p', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = p2pComposeBlock();

  it('env.ts leaves the retention unset when the host gives none — no git-default 90', async () => {
    expect((await loadP2pEnv()).P2P_INSTRUMENT_RETENTION_DAYS).toBeNull();
    expect((await loadP2pEnv({ [KEY]: '' })).P2P_INSTRUMENT_RETENTION_DAYS).toBeNull();
    expect((await loadP2pEnv({ [KEY]: '90' })).P2P_INSTRUMENT_RETENTION_DAYS).toBe(90);
    await expect(loadP2pEnv({ [KEY]: '29' })).rejects.toThrow(/P2P_INSTRUMENT_RETENTION_DAYS/);
  });

  it('compose svc-p2p block passes retention from the host empty — never a baked 90', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-p2p/);
    expect(block, `${KEY} missing from svc-p2p compose environment`).toMatch(new RegExp(`${KEY}:\\s*\\$\\{${KEY}:-\\}`));
    expect(block).not.toMatch(new RegExp(`${KEY}:\\s*\\$\\{${KEY}:-90\\}`));
  });

  it('names the retention key once in compose (no duplicate assignments)', () => {
    expect(countAssignments(compose, KEY), `${KEY} must appear once`).toBe(1);
    expect(countAssignments(block, KEY), `${KEY} must appear once on svc-p2p`).toBe(1);
  });

  it('does not bake house take, method registry, destination accounts, or KMS', () => {
    expect(block).toMatch(/P2P_FEE_BPS:\s*\$\{P2P_FEE_BPS:-\}/);
    expect(block).not.toMatch(/P2P_FEE_BPS:\s*\$\{P2P_FEE_BPS:-30\}/);
    expect(block).not.toMatch(/P2P_METHOD_REGISTRY/);
    expect(block).not.toMatch(/P2P_DESTINATION_ACCOUNT/);
    expect(block).not.toMatch(/P2P_KMS/);
  });
});
