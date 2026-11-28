/**
 * Unit card — compose stack passes access-token TTL / issuer / audience into svc-token
 *
 * 1. Promise: host `.env` can pin JWT_ACCESS_TTL_SECONDS, JWT_ISSUER, and
 *    JWT_AUDIENCE on the token container (authEnvSchema / identity defaults
 *    900 / intafaced / intafaced.api). Token merges edgeEnvSchema because it
 *    self-mounts /trpc.
 * 2. Break: compose booted token with *edge-secret + TOKEN_ASSET_ID / LEDGER_URL /
 *    EMISSIONS_* but no TTL/iss/aud → operator pin is a no-op and the
 *    container keeps schema-only defaults forever.
 * 3. Done bar: docker-compose.apps.yml svc-token has
 *    JWT_ACCESS_TTL_SECONDS: ${JWT_ACCESS_TTL_SECONDS:-900}
 *    JWT_ISSUER: ${JWT_ISSUER:-intafaced}
 *    JWT_AUDIENCE: ${JWT_AUDIENCE:-intafaced.api}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-token block only)
 * 6. RED: pin fails if a unique key drops, defaults drift, JWT_ACCESS_SECRET
 *    is invented, or YIELD_DISTRIBUTION_CRON_HOURS appears
 * 7. Collision: emissions-compose-pin.test.ts — this pin does not restamp
 *    EMISSIONS_*, TOKEN_ASSET_ID, or LEDGER_URL
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authEnvSchema } from '@intafaced/config';
import { composeServiceBlock } from '@intafaced/config/compose';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');

const REQUIRED: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://pin:pin@127.0.0.1:9/pin',
  DATABASE_POOL_MAX: '1',
  EDGE_PRINCIPAL_SECRET: 'svc-token-env-pin-edge-secret-00000000001',
  INTERNAL_SERVICE_SECRET: 'svc-token-env-pin-internal-secret-000001',
};

/** svc-token's own env loader, run fresh with exactly these variables over the required ones. */
async function loadTokenEnv(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries({ ...REQUIRED, ...overrides })) vi.stubEnv(key, value);
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function tokenServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-token');
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

const TTL = /^\s+JWT_ACCESS_TTL_SECONDS:\s*\$\{JWT_ACCESS_TTL_SECONDS:-900\}\s*$/gm;
const ISSUER = /^\s+JWT_ISSUER:\s*\$\{JWT_ISSUER:-intafaced\}\s*$/gm;
const AUDIENCE = /^\s+JWT_AUDIENCE:\s*\$\{JWT_AUDIENCE:-intafaced\.api\}\s*$/gm;

describe('compose access-token TTL issuer audience for svc-token', () => {
  const compose = readFileSync(COMPOSE, 'utf8');
  const block = tokenServiceBlock(compose);

  it('authEnvSchema still defaults 900 / intafaced / intafaced.api', async () => {
    const secret = 'x'.repeat(32);
    expect(authEnvSchema.parse({ JWT_ACCESS_SECRET: secret })).toMatchObject({
      JWT_ACCESS_TTL_SECONDS: 900,
      JWT_ISSUER: 'intafaced',
      JWT_AUDIENCE: 'intafaced.api',
    });
    expect(authEnvSchema.parse({ JWT_ACCESS_SECRET: secret, JWT_ACCESS_TTL_SECONDS: '60' }).JWT_ACCESS_TTL_SECONDS).toBe(60);
    expect(authEnvSchema.parse({ JWT_ACCESS_SECRET: secret, JWT_ACCESS_TTL_SECONDS: '3600' }).JWT_ACCESS_TTL_SECONDS).toBe(3600);
    expect(authEnvSchema.safeParse({ JWT_ACCESS_SECRET: secret, JWT_ACCESS_TTL_SECONDS: '59' }).success).toBe(false);
    expect(authEnvSchema.safeParse({ JWT_ACCESS_SECRET: secret, JWT_ACCESS_TTL_SECONDS: '3601' }).success).toBe(false);
    expect(authEnvSchema.safeParse({ JWT_ACCESS_SECRET: secret, JWT_ACCESS_TTL_SECONDS: '900.5' }).success).toBe(false);

    // svc-token takes the edge's principal secret (edgeEnvSchema): no secret, or a short one, refuses to load.
    await expect(loadTokenEnv({ EDGE_PRINCIPAL_SECRET: undefined })).rejects.toThrow(/EDGE_PRINCIPAL_SECRET/);
    await expect(loadTokenEnv({ EDGE_PRINCIPAL_SECRET: 'short' })).rejects.toThrow(/EDGE_PRINCIPAL_SECRET/);
    expect((await loadTokenEnv()).EDGE_PRINCIPAL_SECRET).toBe(REQUIRED.EDGE_PRINCIPAL_SECRET);
  });

  it('wires unique host pass-through keys once; defaults 900 / intafaced / intafaced.api', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-token/);
    expect(block.match(TTL)).toHaveLength(1);
    expect(block.match(ISSUER)).toHaveLength(1);
    expect(block.match(AUDIENCE)).toHaveLength(1);
    expect(countAssignments(block, 'JWT_ACCESS_TTL_SECONDS')).toBe(1);
    expect(countAssignments(block, 'JWT_ISSUER')).toBe(1);
    expect(countAssignments(block, 'JWT_AUDIENCE')).toBe(1);
  });

  it('does not restamp emissions/asset/ledger, invent yield cron, or add JWT_ACCESS_SECRET', () => {
    expect(block).toMatch(/TOKEN_ASSET_ID:\s*\$\{TOKEN_ASSET_ID:-IFC\}/);
    expect(block).toMatch(/LEDGER_URL:\s*http:\/\/svc-ledger:4001/);
    expect(block).toMatch(/EMISSIONS_ENABLED:\s*\$\{EMISSIONS_ENABLED:-true\}/);
    expect(block).toMatch(/EMISSIONS_AUTO_TICK:\s*\$\{EMISSIONS_AUTO_TICK:-false\}/);
    expect(block).toMatch(/EMISSIONS_TICK_MS:\s*\$\{EMISSIONS_TICK_MS:-\}/);
    expect(countAssignments(block, 'TOKEN_ASSET_ID')).toBe(1);
    expect(countAssignments(block, 'LEDGER_URL')).toBe(1);
    expect(countAssignments(block, 'EMISSIONS_ENABLED')).toBe(1);
    expect(countAssignments(block, 'EMISSIONS_AUTO_TICK')).toBe(1);
    expect(countAssignments(block, 'EMISSIONS_TICK_MS')).toBe(1);
    expect(block).toMatch(/YIELD_JOB_ENABLED:\s*\$\{YIELD_JOB_ENABLED:-false\}/);
    expect(block).not.toMatch(/^\s+YIELD_DISTRIBUTION_CRON_HOURS:/m);
    expect(block).not.toMatch(/^\s+JWT_ACCESS_SECRET:/m);
  });
});
