/**
 * Unit card — compose passes MATCHING_SNAPSHOT_EVERY empty into svc-matching
 *
 * 1. Promise: host `.env` can pin snapshot cadence; compose does not invent 500.
 *    Unset / empty stays unpublished and env.ts refuses boot.
 * 2. Break: compose `:-500` (or omitting the key) makes a blank host env look
 *    published as the schema's invented interval.
 * 3. Done bar: docker-compose.apps.yml svc-matching has
 *    MATCHING_SNAPSHOT_EVERY: ${MATCHING_SNAPSHOT_EVERY:-}
 *    env.ts preprocess blank → undefined, coerce int min 0, no `.default(500)`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-matching block only) + env.ts
 * 6. RED: pin fails if cadence default is 500, compose bakes 500, or sibling
 *    matching keys are restamped
 * 7. Collision: MATCHING_ENGINE_ENABLED stays default true. JOURNAL_PATH stays
 *    volume default. No MATCHING_RULEBOOK_VERSION (the journal is the rulebook's source).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const SNAPSHOT = 'MATCHING_SNAPSHOT_EVERY';
const EMPTY_PASS = `${SNAPSHOT}: \${${SNAPSHOT}:-}`;

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

describe('compose passes MATCHING_SNAPSHOT_EVERY empty into svc-matching', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-matching/src/env.ts'), 'utf8');
  const block = matchingComposeBlock();

  it('env.ts refuses blank cadence — no 500 default; kill-switch stays true', () => {
    expect(envTs).not.toMatch(/MATCHING_SNAPSHOT_EVERY:[\s\S]{0,400}\.default\(500\)/);
    expect(envTs).toMatch(
      /MATCHING_SNAPSHOT_EVERY:\s*z\.preprocess\(\s*\(v\) => \(v === undefined \|\| \(typeof v === 'string' && v\.trim\(\) === ''\) \? undefined : v\),\s*z\.coerce\.number\(\)\.int\(\)\.min\(0\),\s*\)/,
    );
    expect(envTs).toMatch(/MATCHING_ENGINE_ENABLED:[\s\S]{0,400}\.default\(true\)/);
  });

  it('svc-matching compose line is empty pass-through — no invented 500', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-matching/);
    expect(block, `${SNAPSHOT} missing empty pass-through`).toContain(EMPTY_PASS);
    expect(block).toMatch(new RegExp(`${SNAPSHOT}:\\s*\\$\\{${SNAPSHOT}:-\\}`));
    expect(block).not.toMatch(new RegExp(`${SNAPSHOT}:\\s*\\$\\{${SNAPSHOT}:-500\\}`));
    expect(countAssignments(block, SNAPSHOT), `${SNAPSHOT} must appear once on svc-matching`).toBe(1);
    expect(compose.match(/^\s+MATCHING_SNAPSHOT_EVERY:/gm) ?? []).toHaveLength(1);
  });

  it('does not restamp kill-switch / journal / rulebook or invent 500', () => {
    expect(block).toMatch(/MATCHING_ENGINE_ENABLED:\s*\$\{MATCHING_ENGINE_ENABLED:-true\}/);
    expect(block).toMatch(/MATCHING_JOURNAL_PATH:\s*\$\{MATCHING_JOURNAL_PATH:-\/data\/matching\/engine_journal\.ndjson\}/);
    expect(block).not.toMatch(/^\s*MATCHING_RULEBOOK_VERSION:/m);
    expect(block).toMatch(/HTTP_PORT:\s*'4005'/);
  });
});
