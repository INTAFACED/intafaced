/**
 * Unit card — compose stack passes access-token TTL and kill-state path into svc-edge
 *
 * 1. Promise: host `.env` can shorten JWT_ACCESS_TTL_SECONDS and persist
 *    EDGE_KILL_STATE_PATH across restart (env.ts already defaults 900 and
 *    `.data/edge-kill-state.json`).
 * 2. Break: compose booted edge with rate-limit + body-limit but no TTL or
 *    kill-state path → operator pin is a no-op and the container keeps schema
 *    defaults / in-memory kill forever.
 * 3. Done bar: docker-compose.apps.yml svc-edge has
 *    JWT_ACCESS_TTL_SECONDS: ${JWT_ACCESS_TTL_SECONDS:-900}
 *    EDGE_KILL_STATE_PATH: ${EDGE_KILL_STATE_PATH:-.data/edge-kill-state.json}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-edge block only)
 * 6. RED: pin fails if a unique key drops, defaults drift from env.ts, or
 *    EDGE_TRUST_PROXY / EDGE_GEO_COUNTRY_HEADER / screening lists appear
 * 7. Collision: none — this pin does not restamp EDGE_RATE_LIMIT_* /
 *    EDGE_BODY_LIMIT_BYTES / JWT_ACCESS_SECRET / ISSUER / AUDIENCE /
 *    UPSTREAM_TIMEOUT_MS
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');
const ENV_TS = resolve(import.meta.dirname, './env.ts');

function edgeServiceBlock(source: string): string {
  const match = source.match(/^  svc-edge:\n(?:.*\n)*?(?=^  [a-z]|\Z)/m);
  if (!match) throw new Error('svc-edge service block missing from docker-compose.apps.yml');
  return match[0];
}

const TTL = /^\s+JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}\s*$/gm;
const KILL_PATH = /^\s+EDGE_KILL_STATE_PATH:\s*\$\{EDGE_KILL_STATE_PATH:-\.data\/edge-kill-state\.json\}\s*$/gm;

describe('compose access-token TTL and kill-state path for svc-edge', () => {
  const compose = readFileSync(COMPOSE, 'utf8');
  const envTs = readFileSync(ENV_TS, 'utf8');
  const block = edgeServiceBlock(compose);

  it('env.ts still declares the flags this pin tracks, matching compose defaults', () => {
    expect(envTs).toMatch(/JWT_ACCESS_TTL_SECONDS:\s*z\.coerce\.number\(\)\.int\(\)\.min\(60\)\.max\(3600\)\.default\(900\)/);
    expect(envTs).toMatch(/EDGE_KILL_STATE_PATH:\s*z\.string\(\)\.default\('\.data\/edge-kill-state\.json'\)/);
  });

  it('compose svc-edge block passes unique keys once; defaults 900 and that path', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-edge/);
    expect(block.match(TTL)).toHaveLength(1);
    expect(block.match(KILL_PATH)).toHaveLength(1);
  });

  it('does not invent trust-proxy, geo header, or screening lists', () => {
    expect(block).not.toMatch(/EDGE_TRUST_PROXY:/);
    expect(block).not.toMatch(/EDGE_GEO_COUNTRY_HEADER:/);
    // Operator-provided screening configuration passes through; no list/source is invented.
    const screening = block
      .split('\n')
      .filter((line) => /^\s*INTAFACED_SANCTIONS/.test(line))
      .map((line) => line.trim());
    expect(screening).toEqual([
      'INTAFACED_SANCTIONS_REGIONS: ${INTAFACED_SANCTIONS_REGIONS:-}',
      'INTAFACED_SANCTIONS_LIST_SOURCE: ${INTAFACED_SANCTIONS_LIST_SOURCE:-}',
    ]);
    expect(block).not.toMatch(/JURISDICTION_MATRIX/);
  });
});
