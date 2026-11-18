/**
 * Unit card — compose stack passes rate-limit flags into svc-edge
 *
 * 1. Promise: EDGE_RATE_LIMIT_ENABLED / MAX / WINDOW_MS from host `.env` reach
 *    the container. MAX and WINDOW have no git default — blank refuses
 *    (never 300 / never 60000). Owner may set 300 and 60000 explicitly.
 *    ENABLED still defaults true.
 * 2. Break: compose `:-300` / `:-60000` / env.ts `.default(300)` / `.default(60_000)`
 *    makes blank look published.
 * 3. Done bar: docker-compose.apps.yml svc-edge has
 *    EDGE_RATE_LIMIT_ENABLED: ${EDGE_RATE_LIMIT_ENABLED:-true}
 *    EDGE_RATE_LIMIT_MAX: ${EDGE_RATE_LIMIT_MAX:?missing — copy .env.example to .env}
 *    EDGE_RATE_LIMIT_WINDOW_MS: ${EDGE_RATE_LIMIT_WINDOW_MS:?missing — copy .env.example to .env}
 *    env.ts EDGE_RATE_LIMIT_MAX has no .default(300); WINDOW has no .default(60_000)
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-edge block only) + env.ts
 * 6. RED: pin fails if a unique key drops, MAX git-default 300 or WINDOW
 *    git-default 60000 returns, EDGE_TRUST_PROXY appears, or DEFAULT_REGION /
 *    JWT lines are restamped
 * 7. Collision: observability-wiring.test.ts — this pin does not restamp scrape
 *    interval vs limiter budget
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function edgeServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-edge');
}

const ENABLED = /^\s+EDGE_RATE_LIMIT_ENABLED:\s*\$\{EDGE_RATE_LIMIT_ENABLED:-true\}\s*$/gm;
const MAX = /^\s+EDGE_RATE_LIMIT_MAX:\s*\$\{EDGE_RATE_LIMIT_MAX:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const WINDOW = /^\s+EDGE_RATE_LIMIT_WINDOW_MS:\s*\$\{EDGE_RATE_LIMIT_WINDOW_MS:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const DEFAULT_REGION = /^\s+DEFAULT_REGION:\s*\$\{DEFAULT_REGION:-XX\}\s*$/gm;
const JWT_ACCESS = /^\s+JWT_ACCESS_SECRET:\s*\$\{JWT_ACCESS_SECRET:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const JWT_ISSUER = /^\s+JWT_ISSUER:\s*\$\{JWT_ISSUER:-intafaced\}\s*$/gm;
const JWT_AUDIENCE = /^\s+JWT_AUDIENCE:\s*\$\{JWT_AUDIENCE:-intafaced\.api\}\s*$/gm;

describe('compose rate-limit flags for svc-edge', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-edge/src/env.ts'), 'utf8');
  const block = edgeServiceBlock(compose);

  it('env.ts still declares the flags this pin tracks; MAX/WINDOW have no git-default', () => {
    expect(envTs).toMatch(/EDGE_RATE_LIMIT_ENABLED:\s*z[\s\S]*?\.default\(true\)/);
    expect(envTs).toMatch(/EDGE_RATE_LIMIT_MAX:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\),/);
    expect(envTs).not.toMatch(/EDGE_RATE_LIMIT_MAX:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.default\(300\)/);
    expect(envTs).toMatch(/EDGE_RATE_LIMIT_WINDOW_MS:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1000\)\.max\(3_600_000\),/);
    expect(envTs).not.toMatch(/EDGE_RATE_LIMIT_WINDOW_MS:[^\n]*?\.default\(/);
  });

  it('compose svc-edge block passes unique keys once; MAX/WINDOW have no git-default', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-edge/);
    expect(block.match(ENABLED)).toHaveLength(1);
    expect(block.match(MAX)).toHaveLength(1);
    expect(block.match(WINDOW)).toHaveLength(1);
  });

  it('does not set EDGE_TRUST_PROXY or restamp DEFAULT_REGION / JWT secrets', () => {
    expect(block).not.toMatch(/EDGE_TRUST_PROXY:/);
    expect(block.match(DEFAULT_REGION)).toHaveLength(1);
    expect(block.match(JWT_ACCESS)).toHaveLength(1);
    expect(block.match(JWT_ISSUER)).toHaveLength(1);
    expect(block.match(JWT_AUDIENCE)).toHaveLength(1);
  });
});
