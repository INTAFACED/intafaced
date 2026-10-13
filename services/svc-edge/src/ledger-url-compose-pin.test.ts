/**
 * Unit card — compose stack passes LEDGER_URL into svc-edge
 *
 * 1. Promise: operator `/admin/ledger/*` forward reaches svc-ledger on the
 *    compose network (env.ts already declares LEDGER_URL optional).
 * 2. Break: compose booted edge with IDENTITY_URL / TRADE_URL / TOKEN_URL but
 *    no LEDGER_URL → console is told money-plane control is unreachable while
 *    svc-ledger is on the same network.
 * 3. Done bar: docker-compose.apps.yml svc-edge has
 *    LEDGER_URL: http://svc-ledger:4001
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-edge block only)
 * 6. RED: pin fails if the unique key drops, value drifts, EDGE_TRUST_PROXY /
 *    EDGE_GEO_COUNTRY_HEADER / screening lists appear, or sibling JWT /
 *    rate-limit / body-limit / kill-state / timeout / region / IDENTITY_URL
 *    lines are restamped
 * 7. Collision: jwt-ttl-kill-state / rate-limit / body-limit compose pins —
 *    this pin does not restamp those keys
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

const LEDGER = /^\s+LEDGER_URL:\s*http:\/\/svc-ledger:4001\s*$/gm;
const IDENTITY = /^\s+IDENTITY_URL:\s*http:\/\/svc-identity:4002\s*$/gm;
const TRADE = /^\s+TRADE_URL:\s*http:\/\/svc-trade:4004\s*$/gm;
const TOKEN = /^\s+TOKEN_URL:\s*http:\/\/svc-token:4003\s*$/gm;
const TTL = /^\s+JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}\s*$/gm;
const JWT_ACCESS = /^\s+JWT_ACCESS_SECRET:\s*\$\{JWT_ACCESS_SECRET:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const JWT_ISSUER = /^\s+JWT_ISSUER:\s*\$\{JWT_ISSUER:-intafaced\}\s*$/gm;
const JWT_AUDIENCE = /^\s+JWT_AUDIENCE:\s*\$\{JWT_AUDIENCE:-intafaced\.api\}\s*$/gm;
const RATE_ENABLED = /^\s+EDGE_RATE_LIMIT_ENABLED:\s*\$\{EDGE_RATE_LIMIT_ENABLED:-true\}\s*$/gm;
const RATE_MAX = /^\s+EDGE_RATE_LIMIT_MAX:\s*\$\{EDGE_RATE_LIMIT_MAX:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const RATE_WINDOW = /^\s+EDGE_RATE_LIMIT_WINDOW_MS:\s*\$\{EDGE_RATE_LIMIT_WINDOW_MS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const BODY_LIMIT = /^\s+EDGE_BODY_LIMIT_BYTES:\s*\$\{EDGE_BODY_LIMIT_BYTES:-\}\s*$/gm;
const KILL_PATH = /^\s+EDGE_KILL_STATE_PATH:\s*\$\{EDGE_KILL_STATE_PATH:-\.data\/edge-kill-state\.json\}\s*$/gm;
const UPSTREAM_TIMEOUT = /^\s+UPSTREAM_TIMEOUT_MS:\s*\$\{UPSTREAM_TIMEOUT_MS:-15000\}\s*$/gm;
const DEFAULT_REGION = /^\s+DEFAULT_REGION:\s*\$\{DEFAULT_REGION:-XX\}\s*$/gm;

describe('compose LEDGER_URL for svc-edge operator forward', () => {
  const compose = readFileSync(COMPOSE, 'utf8');
  const envTs = readFileSync(ENV_TS, 'utf8');
  const block = edgeServiceBlock(compose);

  it('env.ts still declares LEDGER_URL optional', () => {
    expect(envTs).toMatch(/LEDGER_URL:\s*z\.string\(\)\.url\(\)\.optional\(\)/);
  });

  it('compose svc-edge block passes unique keys once; LEDGER_URL is the ledger operator surface', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-edge/);
    expect(block.match(LEDGER)).toHaveLength(1);
    const envKeys = [...block.matchAll(/^\s{6}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
    expect(envKeys).toContain('LEDGER_URL');
    expect(new Set(envKeys).size).toBe(envKeys.length);
  });

  it('does not invent trust-proxy, geo header, or screening lists, and does not restamp siblings', () => {
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
    expect(block.match(IDENTITY)).toHaveLength(1);
    expect(block.match(TRADE)).toHaveLength(1);
    expect(block.match(TOKEN)).toHaveLength(1);
    expect(block.match(TTL)).toHaveLength(1);
    expect(block.match(JWT_ACCESS)).toHaveLength(1);
    expect(block.match(JWT_ISSUER)).toHaveLength(1);
    expect(block.match(JWT_AUDIENCE)).toHaveLength(1);
    expect(block.match(RATE_ENABLED)).toHaveLength(1);
    expect(block.match(RATE_MAX)).toHaveLength(1);
    expect(block.match(RATE_WINDOW)).toHaveLength(1);
    expect(block.match(BODY_LIMIT)).toHaveLength(1);
    expect(block.match(KILL_PATH)).toHaveLength(1);
    expect(block.match(UPSTREAM_TIMEOUT)).toHaveLength(1);
    expect(block.match(DEFAULT_REGION)).toHaveLength(1);
  });
});
