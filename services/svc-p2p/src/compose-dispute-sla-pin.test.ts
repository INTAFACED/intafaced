import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadP2pEnv } from './testing/env-load-fixture.js';

/**
 * Unit card — compose stack passes dispute SLA clocks into svc-p2p
 *
 * 1. Promise: host `.env` can pin the moderator SLA and escalation re-check
 *    (env.ts already declares them).
 * 2. Break: compose booted p2p without the names → operator SLA is a no-op
 *    and the container keeps schema defaults forever.
 * 3. Done bar: docker-compose.apps.yml svc-p2p environment names the two
 *    keys as empty owner pass-through (never baked 604800 / 3600).
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-p2p block only)
 * 6. RED: pin fails if a name drops off, is duplicated, or bakes auto-settle /
 *    P2P_FEE_BPS / restamped escrow/offer/moderator keys
 * 7. Collision: escrow/offer compose pins — this pin only reads the two
 *    dispute SLA keys
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const KEYS = [
  ['P2P_DISPUTE_SLA_SECONDS', '604800'],
  ['P2P_DISPUTE_ESCALATION_RECHECK_SECONDS', '3600'],
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

describe('compose passes p2p.disputes SLA clocks into svc-p2p', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = p2pComposeBlock();

  it('env.ts leaves both clocks unset when the host gives none, and reads a published value', async () => {
    for (const host of [{}, { P2P_DISPUTE_SLA_SECONDS: '', P2P_DISPUTE_ESCALATION_RECHECK_SECONDS: '' }]) {
      const env = await loadP2pEnv(host);
      expect(env.P2P_DISPUTE_SLA_SECONDS).toBeNull();
      expect(env.P2P_DISPUTE_ESCALATION_RECHECK_SECONDS).toBeNull();
    }
    const published = await loadP2pEnv({ P2P_DISPUTE_SLA_SECONDS: '604800', P2P_DISPUTE_ESCALATION_RECHECK_SECONDS: '3600' });
    expect(published.P2P_DISPUTE_SLA_SECONDS).toBe(604_800);
    expect(published.P2P_DISPUTE_ESCALATION_RECHECK_SECONDS).toBe(3_600);
  });

  it('compose svc-p2p block passes each clock from the host empty — never baked hours', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-p2p/);
    for (const [name, fallback] of KEYS) {
      expect(block, `${name} missing from svc-p2p compose environment`).toMatch(new RegExp(`${name}:\\s*\\$\\{${name}:-\\}`));
      expect(block).not.toMatch(new RegExp(`${name}:\\s*\\$\\{${name}:-${fallback}\\}`));
    }
  });

  it('names each SLA key once in compose (no duplicate assignments)', () => {
    for (const [name] of KEYS) {
      expect(countAssignments(compose, name), `${name} must appear once`).toBe(1);
      expect(countAssignments(block, name), `${name} must appear once on svc-p2p`).toBe(1);
    }
  });

  it('does not bake auto-settle, house take, or restamp sibling clocks', () => {
    expect(block).toMatch(/P2P_FEE_BPS:\s*\$\{P2P_FEE_BPS:-\}/);
    expect(block).not.toMatch(/P2P_FEE_BPS:\s*\$\{P2P_FEE_BPS:-30\}/);
    expect(block).not.toMatch(/P2P_DISPUTE_BACKSTOP/);
    expect(block).not.toMatch(/P2P_BACKSTOP_MODERATOR/);
    expect(block).not.toMatch(/P2P_DISPUTE_BACKSTOP_RESOLUTION/);
  });
});
