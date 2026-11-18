/**
 * Unit card — compose stack passes MATCHING_ENGINE_ENABLED into svc-matching
 *
 * 1. Promise: host `.env` can halt the engine (env.ts already refuses
 *    submissions before the journal when MATCHING_ENGINE_ENABLED is false).
 * 2. Break: compose booted matching with only MATCHING_JOURNAL_PATH → host
 *    kill is a no-op and the container keeps the schema default forever.
 * 3. Done bar: docker-compose.apps.yml svc-matching has
 *    MATCHING_ENGINE_ENABLED: ${MATCHING_ENGINE_ENABLED:-false} and the custody
 *    switch, so the engine runs only where the host turns custody on too
 *    (OWNER 288: our own book settles fills as customer money in our ledger).
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-matching block only)
 * 6. RED: pin fails if the kill drops off, is duplicated, defaults true, or
 *    restamps MATCHING_JOURNAL_PATH / INTERNAL_SERVICE_SECRET / SNAPSHOT
 * 7. Collision: none — this pin only reads svc-matching. No books, no mids.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const ENGINE = 'MATCHING_ENGINE_ENABLED';
const SNAPSHOT = 'MATCHING_SNAPSHOT_EVERY';
const JOURNAL = 'MATCHING_JOURNAL_PATH';

function matchingComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const start = compose.indexOf('\n  svc-matching:');
  expect(start, 'svc-matching service missing from docker-compose.apps.yml').toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n  svc-[a-z]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

describe('compose passes matching engine kill-switch into svc-matching', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-matching/src/env.ts'), 'utf8');
  const block = matchingComposeBlock();

  it('env.ts leaves an unset MATCHING_ENGINE_ENABLED to the custody switch (no default of its own)', () => {
    expect(envTs).toMatch(/MATCHING_ENGINE_ENABLED:\s*z/);
    expect(envTs).not.toMatch(/MATCHING_ENGINE_ENABLED:[\s\S]{0,200}?\.default\(/);
    expect(envTs).toMatch(/resolveOwnOrderBook\('MATCHING_ENGINE_ENABLED'/);
  });

  it('compose svc-matching block passes the kill from the host with default false, and the custody switch default off', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-matching/);
    expect(block, `${ENGINE} missing false-default pass-through`).toMatch(new RegExp(`${ENGINE}:\\s*\\$\\{${ENGINE}:-false\\}`));
    expect(block).not.toMatch(new RegExp(`${ENGINE}:\\s*\\$\\{${ENGINE}:-true\\}`));
    expect(block).toMatch(/LEDGER_CUSTODY_LAYER:\s*\$\{LEDGER_CUSTODY_LAYER:-off\}/);
  });

  it('names each matching host-env key once in compose (no duplicate assignments)', () => {
    expect(countAssignments(compose, ENGINE), `${ENGINE} must appear once`).toBe(1);
    expect(countAssignments(compose, SNAPSHOT), `${SNAPSHOT} must appear once`).toBe(1);
    expect(countAssignments(block, ENGINE), `${ENGINE} must appear once on svc-matching`).toBe(1);
    expect(countAssignments(block, SNAPSHOT), `${SNAPSHOT} must appear once on svc-matching`).toBe(1);
    expect(countAssignments(block, JOURNAL), `${JOURNAL} must stay once on svc-matching`).toBe(1);
  });

  it('does not restamp journal path, snapshot cadence, or INTERNAL_SERVICE_SECRET', () => {
    expect(block).toMatch(/MATCHING_JOURNAL_PATH:\s*\$\{MATCHING_JOURNAL_PATH:-\/data\/matching\/engine_journal\.ndjson\}/);
    expect(block).toMatch(/MATCHING_SNAPSHOT_EVERY:\s*\$\{MATCHING_SNAPSHOT_EVERY:-\}/);
    expect(block).not.toMatch(/INTERNAL_SERVICE_SECRET:\s*\$\{INTERNAL_SERVICE_SECRET/);
    expect(countAssignments(block, 'INTERNAL_SERVICE_SECRET')).toBe(0);
  });
});
