import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadP2pEnv } from './testing/env-load-fixture.js';

/**
 * Unit card — compose stack passes escrow clocks into svc-p2p
 *
 * 1. Promise: host `.env` can pin escrow/payment/release deadlines and the
 *    sweep interval (env.ts already declares them).
 * 2. Break: compose booted p2p without the names → operator clocks are a
 *    no-op and the container keeps schema defaults forever.
 * 3. Done bar: docker-compose.apps.yml svc-p2p environment names the four
 *    keys as empty owner pass-through (never baked 120 / 900 / 1800 / 30).
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-p2p block only)
 * 6. RED: pin fails if a name drops off, is duplicated, or bakes P2P_FEE_BPS
 * 7. Collision: #2126 offer ceilings / #2127 bank jobs — this pin only reads
 *    the four deadline/sweep keys
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const OWNER_EMPTY = [
  ['P2P_ESCROW_DEADLINE_SECONDS', '120'],
  ['P2P_PAYMENT_DEADLINE_SECONDS', '900'],
  ['P2P_RELEASE_DEADLINE_SECONDS', '1800'],
  ['P2P_SWEEP_INTERVAL_SECONDS', '30'],
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

describe('compose passes p2p.escrow clocks into svc-p2p', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = p2pComposeBlock();

  it('env.ts leaves the four clocks unset when the host gives none, and reads a published value', async () => {
    const names = OWNER_EMPTY.map(([name]) => name);
    for (const host of [{}, Object.fromEntries(names.map((name) => [name, '']))]) {
      const env = await loadP2pEnv(host);
      for (const name of names) expect(env[name], name).toBeNull();
    }
    const published = await loadP2pEnv(Object.fromEntries(OWNER_EMPTY));
    for (const [name, value] of OWNER_EMPTY) expect(published[name], name).toBe(Number(value));
  });

  it('compose svc-p2p block passes each clock from the host empty — never baked hours', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-p2p/);
    for (const [name, baked] of OWNER_EMPTY) {
      expect(block, `${name} missing from svc-p2p compose environment`).toMatch(new RegExp(`${name}:\\s*\\$\\{${name}:-\\}`));
      expect(block).not.toMatch(new RegExp(`${name}:\\s*\\$\\{${name}:-${baked}\\}`));
    }
  });

  it('names each deadline key once in compose (no duplicate assignments)', () => {
    for (const [name] of OWNER_EMPTY) {
      expect(countAssignments(compose, name), `${name} must appear once`).toBe(1);
      expect(countAssignments(block, name), `${name} must appear once on svc-p2p`).toBe(1);
    }
  });

  it('passes house take empty — never a baked 30', async () => {
    expect(block).toMatch(/P2P_FEE_BPS:\s*\$\{P2P_FEE_BPS:-\}/);
    expect(block).not.toMatch(/P2P_FEE_BPS:\s*\$\{P2P_FEE_BPS:-30\}/);
    expect((await loadP2pEnv()).P2P_FEE_BPS).toBeNull();
  });
});
