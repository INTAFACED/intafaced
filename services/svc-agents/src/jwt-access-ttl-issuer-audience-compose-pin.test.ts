/**
 * Unit card — compose stack passes access-token TTL / issuer / audience into svc-agents
 *
 * 1. Promise: JWT_ACCESS_TTL_SECONDS, JWT_ISSUER, JWT_AUDIENCE from host `.env`
 *    reach the container (authEnvSchema defaults 900 / intafaced / intafaced.api).
 * 2. Break: compose booted agents with window / timeout / metering but no TTL
 *    or iss/aud → operator pin of token life or issuer/audience is a no-op and
 *    the process keeps schema-only defaults forever.
 * 3. Done bar: docker-compose.apps.yml svc-agents has
 *    JWT_ACCESS_TTL_SECONDS: ${JWT_ACCESS_TTL_SECONDS:-900}
 *    JWT_ISSUER: ${JWT_ISSUER:-intafaced}
 *    JWT_AUDIENCE: ${JWT_AUDIENCE:-intafaced.api}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-agents block only)
 * 6. RED: pin fails if a unique key drops inside the agents block, defaults
 *    drift from 900 / intafaced / intafaced.api, JWT_ACCESS_SECRET is invented,
 *    or usage window / timeout are restamped
 * 7. Collision: usage-window-timeout-compose-pin.test.ts and
 *    academy-url-compose-pin.test.ts — this pin does not restamp those keys.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function agentsServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-agents');
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

const TTL = /^\s+JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}\s*$/gm;
const ISSUER = /^\s+JWT_ISSUER:\s*\$\{JWT_ISSUER:-intafaced\}\s*$/gm;
const AUDIENCE = /^\s+JWT_AUDIENCE:\s*\$\{JWT_AUDIENCE:-intafaced\.api\}\s*$/gm;
const WINDOW = /^\s+AGENTS_USAGE_WINDOW_MINUTES:\s*\$\{AGENTS_USAGE_WINDOW_MINUTES:\?missing — copy \.env\.example to \.env\}\s*$/gm;
const TIMEOUT = /^\s+AGENTS_UPSTREAM_TIMEOUT_MS:\s*\$\{AGENTS_UPSTREAM_TIMEOUT_MS:-60000\}\s*$/gm;

describe('compose JWT access TTL issuer audience for svc-agents', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const authEnv = readFileSync(join(ROOT, 'packages/config/src/env.ts'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-agents/src/env.ts'), 'utf8');
  const block = agentsServiceBlock(compose);

  it('authEnvSchema still defaults TTL/issuer/audience; agents still merges edgeEnvSchema', () => {
    expect(authEnv).toMatch(/JWT_ACCESS_TTL_SECONDS:\s*z\.coerce\.number\(\)\.int\(\)\.min\(60\)\.max\(3600\)\.default\(900\)/);
    expect(authEnv).toMatch(/JWT_ISSUER:\s*z\.string\(\)\.default\('intafaced'\)/);
    expect(authEnv).toMatch(/JWT_AUDIENCE:\s*z\.string\(\)\.default\('intafaced\.api'\)/);
    expect(envTs).toMatch(/\.merge\(edgeEnvSchema\)/);
  });

  it('compose svc-agents block passes unique keys once; defaults 900 / intafaced / intafaced.api', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-agents/);
    expect(block.match(TTL)).toHaveLength(1);
    expect(block.match(ISSUER)).toHaveLength(1);
    expect(block.match(AUDIENCE)).toHaveLength(1);
    expect(countAssignments(block, 'JWT_ACCESS_TTL_SECONDS')).toBe(1);
    expect(countAssignments(block, 'JWT_ISSUER')).toBe(1);
    expect(countAssignments(block, 'JWT_AUDIENCE')).toBe(1);
  });

  it('does not invent JWT_ACCESS_SECRET or restamp usage window / timeout / academy', () => {
    expect(countAssignments(block, 'JWT_ACCESS_SECRET')).toBe(0);
    expect(block).not.toMatch(/JWT_ACCESS_SECRET:/);
    expect(block.match(WINDOW)).toHaveLength(1);
    expect(block.match(TIMEOUT)).toHaveLength(1);
    expect(block).toMatch(/ACADEMY_URL:\s*http:\/\/svc-academy:4016/);
  });
});
