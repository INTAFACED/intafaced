/**
 * Unit card — compose stack passes upstream auth header + prefix into svc-agents
 *
 * 1. Promise: AGENTS_UPSTREAM_AUTH_HEADER and AGENTS_UPSTREAM_AUTH_PREFIX from
 *    host `.env` reach the container (env.ts already defaults x-api-key / empty).
 * 2. Break: compose booted agents with provider / fee / metering / window /
 *    timeout / JWT / key-no-value UPSTREAM urls but no auth header or prefix →
 *    operator pin of how the upstream authenticates is a no-op and the process
 *    keeps schema-only defaults forever.
 * 3. Done bar: docker-compose.apps.yml svc-agents has
 *    AGENTS_UPSTREAM_AUTH_HEADER: ${AGENTS_UPSTREAM_AUTH_HEADER:-x-api-key}
 *    AGENTS_UPSTREAM_AUTH_PREFIX: ${AGENTS_UPSTREAM_AUTH_PREFIX:-}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-agents block only)
 * 6. RED: pin fails if a unique key drops inside the agents block, defaults
 *    drift from x-api-key / empty, or provider / window / timeout / metering /
 *    fee / JWT / key-no-value UPSTREAM urls are restamped
 * 7. Collision: usage-window-timeout-compose-pin.test.ts and
 *    jwt-access-ttl-issuer-audience-compose-pin.test.ts — this pin does not
 *    restamp those keys. Do not invent a provider name.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function agentsServiceBlock(source: string): string {
  const match = source.match(/^  svc-agents:\n(?:.*\n)*?(?=^  [a-z]|\Z)/m);
  if (!match) throw new Error('svc-agents service block missing from docker-compose.apps.yml');
  return match[0];
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

const HEADER = /^\s+AGENTS_UPSTREAM_AUTH_HEADER:\s*\$\{AGENTS_UPSTREAM_AUTH_HEADER:-x-api-key\}\s*$/gm;
const PREFIX = /^\s+AGENTS_UPSTREAM_AUTH_PREFIX:\s*\$\{AGENTS_UPSTREAM_AUTH_PREFIX:-\}\s*$/gm;
const WINDOW = /^\s+AGENTS_USAGE_WINDOW_MINUTES:\s*\$\{AGENTS_USAGE_WINDOW_MINUTES:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const TIMEOUT = /^\s+AGENTS_UPSTREAM_TIMEOUT_MS:\s*\$\{AGENTS_UPSTREAM_TIMEOUT_MS:-60000\}\s*$/gm;
const JWT_TTL = /^\s+JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}\s*$/gm;
const JWT_ISS = /^\s+JWT_ISSUER:\s*\$\{JWT_ISSUER:-intafaced\}\s*$/gm;
const JWT_AUD = /^\s+JWT_AUDIENCE:\s*\$\{JWT_AUDIENCE:-intafaced\.api\}\s*$/gm;

describe('compose upstream auth header and prefix for svc-agents', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-agents/src/env.ts'), 'utf8');
  const block = agentsServiceBlock(compose);

  it('env.ts still declares the flags this pin tracks, matching compose defaults', () => {
    expect(envTs).toMatch(/AGENTS_UPSTREAM_AUTH_HEADER:\s*z\.string\(\)\.default\('x-api-key'\)/);
    expect(envTs).toMatch(/AGENTS_UPSTREAM_AUTH_PREFIX:\s*z\.string\(\)\.default\(''\)/);
  });

  it('compose svc-agents block passes unique keys once; defaults x-api-key / empty', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-agents/);
    expect(block.match(HEADER)).toHaveLength(1);
    expect(block.match(PREFIX)).toHaveLength(1);
    expect(countAssignments(block, 'AGENTS_UPSTREAM_AUTH_HEADER')).toBe(1);
    expect(countAssignments(block, 'AGENTS_UPSTREAM_AUTH_PREFIX')).toBe(1);
  });

  it('does not restamp provider / window / timeout / metering / fee / JWT / key-no-value UPSTREAM', () => {
    expect(block).toMatch(/AGENTS_PROVIDER:\s*\$\{AGENTS_PROVIDER:-mock\}/);
    expect(block).not.toMatch(/AGENTS_PROVIDER:\s*\$\{AGENTS_PROVIDER:-upstream\}/);
    expect(block).toMatch(/AGENTS_FEE_ASSET_ID:\s*\$\{AGENTS_FEE_ASSET_ID:\?missing — copy \.env\.example to \.env\}/);
    expect(block).toMatch(/AGENTS_METERING_ENABLED:\s*\$\{AGENTS_METERING_ENABLED:\?missing — copy \.env\.example to \.env\}/);
    expect(block.match(WINDOW)).toHaveLength(1);
    expect(block.match(TIMEOUT)).toHaveLength(1);
    expect(block.match(JWT_TTL)).toHaveLength(1);
    expect(block.match(JWT_ISS)).toHaveLength(1);
    expect(block.match(JWT_AUD)).toHaveLength(1);
    expect(block).toMatch(/^\s+AGENTS_UPSTREAM_BASE_URL:\s*$/m);
    expect(block).toMatch(/^\s+AGENTS_UPSTREAM_API_KEY:\s*$/m);
  });
});
