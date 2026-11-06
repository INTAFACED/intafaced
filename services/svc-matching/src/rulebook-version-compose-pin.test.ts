/**
 * Unit card — no env sets the public rulebook (RC-cex-spot-08, was R-A7)
 *
 * 1. Promise: the public rulebook has one source, owner versions journaled
 *    through the two-person publish. No env, compose default or host `.env`
 *    pins a version beside it, so the page can never show a version string the
 *    journal does not hold.
 * 2. Break: compose or env.ts read MATCHING_RULEBOOK_VERSION again, or the
 *    router falls back to process.env — two sources that can contradict.
 * 3. Done bar: the svc-matching compose block, env.ts and router.ts never name
 *    MATCHING_RULEBOOK_VERSION; rulebook.ts still treats a blank id as
 *    unpublished. (svc-fix keeps its own MATCHING_RULEBOOK_VERSION for its
 *    certified-session refusal; that is its own container.)
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-matching block) + env.ts + router.ts + rulebook.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const VERSION = 'MATCHING_RULEBOOK_VERSION';

function matchingComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const start = compose.indexOf('\n  svc-matching:');
  expect(start, 'svc-matching service missing from docker-compose.apps.yml').toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n  svc-[a-z]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('svc-matching takes no rulebook version from env', () => {
  const envTs = readFileSync(join(ROOT, 'services/svc-matching/src/env.ts'), 'utf8');
  const routerTs = readFileSync(join(ROOT, 'services/svc-matching/src/router.ts'), 'utf8');
  const rulebookTs = readFileSync(join(ROOT, 'services/svc-matching/src/rulebook.ts'), 'utf8');
  const block = matchingComposeBlock();

  it('env.ts does not read MATCHING_RULEBOOK_VERSION', () => {
    expect(envTs).not.toContain(VERSION);
  });

  it('the router serves the journal, never process.env', () => {
    expect(routerTs).not.toContain(VERSION);
    expect(routerTs).toMatch(/app\.get\('\/rulebook', async \(\) => engine\.rulebookView\(\)\)/);
  });

  it('the svc-matching compose block sets no rulebook version', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-matching/);
    expect(block).not.toMatch(new RegExp(`^\\s*${VERSION}:`, 'm'));
  });

  it('a blank version id is still unpublished', () => {
    expect(rulebookTs).toMatch(/if \(version\.length === 0\) return \{ published: false \}/);
    expect(rulebookTs).toMatch(/RULEBOOK_UNPUBLISHED = 'matching\.rulebook_unpublished'/);
    expect(rulebookTs).toMatch(/blank is unpublished/);
  });
});
