/**
 * Unit card — compose stack passes INTAFACED_REGION_FAIL_CLOSED into svc-edge
 *
 * 1. Promise: host `.env` can arm refuse-when-unresolved; packages/config
 *    jurisdiction already reads that env name.
 * 2. Break: compose pins DEFAULT_REGION=XX but does not pass FAIL_CLOSED →
 *    host cannot arm the flag without a schema-only process.env read inside
 *    the container.
 * 3. Done bar: docker-compose.apps.yml svc-edge has
 *    INTAFACED_REGION_FAIL_CLOSED:
 *    (key, no value; unset omits). Do not default true.
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-edge block only)
 * 6. RED: pin fails if the unique key drops, is duplicated, gets a true
 *    default, or EDGE_TRUST_PROXY / EDGE_GEO_COUNTRY_HEADER / sanctions list
 *    appear
 * 7. Collision: jwt-ttl-kill-state / rate-limit / body-limit compose pins —
 *    this pin does not restamp DEFAULT_REGION, JWT_*, EDGE_RATE_LIMIT_*,
 *    EDGE_KILL_STATE_PATH, EDGE_BODY_LIMIT_BYTES, UPSTREAM_TIMEOUT_MS,
 *    IDENTITY_URL
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');

function edgeServiceBlock(source: string): string {
  const match = source.match(/^  svc-edge:\n(?:.*\n)*?(?=^  [a-z]|\Z)/m);
  if (!match) throw new Error('svc-edge service block missing from docker-compose.apps.yml');
  return match[0];
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

const FAIL_CLOSED = /^\s+INTAFACED_REGION_FAIL_CLOSED:\s*$/gm;
const DEFAULT_REGION = /^\s+DEFAULT_REGION:\s*\$\{DEFAULT_REGION:-XX\}\s*$/gm;
const JWT_ACCESS = /^\s+JWT_ACCESS_SECRET:\s*\$\{JWT_ACCESS_SECRET:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const JWT_ISSUER = /^\s+JWT_ISSUER:\s*\$\{JWT_ISSUER:-intafaced\}\s*$/gm;
const JWT_AUDIENCE = /^\s+JWT_AUDIENCE:\s*\$\{JWT_AUDIENCE:-intafaced\.api\}\s*$/gm;
const JWT_TTL = /^\s+JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}\s*$/gm;
const RATE_ENABLED = /^\s+EDGE_RATE_LIMIT_ENABLED:\s*\$\{EDGE_RATE_LIMIT_ENABLED:-true\}\s*$/gm;
const RATE_MAX = /^\s+EDGE_RATE_LIMIT_MAX:\s*\$\{EDGE_RATE_LIMIT_MAX:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const RATE_WINDOW = /^\s+EDGE_RATE_LIMIT_WINDOW_MS:\s*\$\{EDGE_RATE_LIMIT_WINDOW_MS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const BODY_LIMIT = /^\s+EDGE_BODY_LIMIT_BYTES:\s*\$\{EDGE_BODY_LIMIT_BYTES:-\}\s*$/gm;
const KILL_PATH = /^\s+EDGE_KILL_STATE_PATH:\s*\$\{EDGE_KILL_STATE_PATH:-\.data\/edge-kill-state\.json\}\s*$/gm;
const UPSTREAM = /^\s+UPSTREAM_TIMEOUT_MS:\s*\$\{UPSTREAM_TIMEOUT_MS:-15000\}\s*$/gm;
const IDENTITY_URL = /^\s+IDENTITY_URL:\s*http:\/\/svc-identity:4002\s*$/gm;

describe('compose region fail-closed pass-through for svc-edge', () => {
  const compose = readFileSync(COMPOSE, 'utf8');
  const block = edgeServiceBlock(compose);

  it('wires INTAFACED_REGION_FAIL_CLOSED once as key-no-value (no true default)', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-edge/);
    expect(block.match(FAIL_CLOSED)).toHaveLength(1);
    expect(countAssignments(block, 'INTAFACED_REGION_FAIL_CLOSED')).toBe(1);
    expect(block).not.toMatch(/INTAFACED_REGION_FAIL_CLOSED:\s*\$\{/);
    expect(block).not.toMatch(/INTAFACED_REGION_FAIL_CLOSED:.*true/);
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
  });

  it('does not restamp DEFAULT_REGION JWT rate-limit kill path body limit timeout identity', () => {
    expect(block.match(DEFAULT_REGION)).toHaveLength(1);
    expect(block.match(JWT_ACCESS)).toHaveLength(1);
    expect(block.match(JWT_ISSUER)).toHaveLength(1);
    expect(block.match(JWT_AUDIENCE)).toHaveLength(1);
    expect(block.match(JWT_TTL)).toHaveLength(1);
    expect(block.match(RATE_ENABLED)).toHaveLength(1);
    expect(block.match(RATE_MAX)).toHaveLength(1);
    expect(block.match(RATE_WINDOW)).toHaveLength(1);
    expect(block.match(BODY_LIMIT)).toHaveLength(1);
    expect(block.match(KILL_PATH)).toHaveLength(1);
    expect(block.match(UPSTREAM)).toHaveLength(1);
    expect(block.match(IDENTITY_URL)).toHaveLength(1);
  });
});
