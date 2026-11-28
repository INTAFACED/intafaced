/**
 * Unit card — BLUEPRINT_ENGINE_URL unset/blank must not invent host.docker.internal:4108
 *
 * 1. Promise: blank/unset BLUEPRINT_ENGINE_URL with MODE=http refuses boot.
 *    Owner-set URL (including http://host.docker.internal:4108) is that
 *    endpoint. MODE=mock may omit the URL. This mill does not invent an engine.
 * 2. Break: z.string().url().default('http://localhost:4108') plus compose
 *    ${BLUEPRINT_ENGINE_URL:-http://host.docker.internal:4108} stamps a live
 *    engine when the operator never named one — and docker.internal is not
 *    loopback, so prod assert may not refuse it.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) refuses http+unset
 *    and http+blank; source has no localhost / docker.internal default; compose
 *    passes BLUEPRINT_ENGINE_URL with empty fallback.
 * 4. Class M
 * 5. Paths: env.ts via loadEnv at import (same as boot); docker-compose.apps.yml
 *    svc-blueprint block
 * 6. RED: default localhost/docker.internal returns, unset/blank parse as live
 *    URL, or compose interpolates :-http://host.docker.internal:4108
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE = resolve(HERE, '../../../docker-compose.apps.yml');
const OWNER_DOCKER = 'http://host.docker.internal:4108';
const OWNER_INTERNAL = 'https://neural-engine.internal/v1';

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: 'an-edge-principal-secret-long-enough-for-the-schema',
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('BLUEPRINT_ENGINE_URL', undefined);
  vi.stubEnv('BLUEPRINT_ENGINE_MODE', undefined);
  vi.stubEnv('APP_ENV', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('svc-blueprint BLUEPRINT_ENGINE_URL refuse-closed', () => {
  it('compose does not interpolate :-http://host.docker.internal:4108', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const start = compose.indexOf('\n  svc-blueprint:');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = compose.slice(start + 1);
    const next = rest.search(/\n  svc-[a-z]+:/);
    const block = next === -1 ? rest : rest.slice(0, next);
    expect(block).toMatch(/BLUEPRINT_ENGINE_URL:\s*\$\{BLUEPRINT_ENGINE_URL:-\}/);
    expect(block).not.toMatch(/BLUEPRINT_ENGINE_URL:.*host\.docker\.internal/);
    expect(block).not.toMatch(/\$\{BLUEPRINT_ENGINE_URL:-http:\/\/host\.docker\.internal:4108\}/);
  });

  it('unset BLUEPRINT_ENGINE_URL with http mode refuses (no silent docker.internal)', async () => {
    await expect(loadWith({ BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: undefined })).rejects.toThrow(/BLUEPRINT_ENGINE_URL/);
  });

  it('blank BLUEPRINT_ENGINE_URL with default http mode refuses', async () => {
    await expect(loadWith({ BLUEPRINT_ENGINE_URL: '' })).rejects.toThrow(/BLUEPRINT_ENGINE_URL/);
  });

  it('whitespace BLUEPRINT_ENGINE_URL with http mode refuses', async () => {
    await expect(loadWith({ BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: '   ' })).rejects.toThrow(/BLUEPRINT_ENGINE_URL/);
  });

  it('garbage BLUEPRINT_ENGINE_URL refuses boot (does not invent a host)', async () => {
    await expect(loadWith({ BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: 'not-a-url' })).rejects.toThrow(/BLUEPRINT_ENGINE_URL/);
  });

  it('explicit URL is operator-set, including host.docker.internal when named', async () => {
    const internal = await loadWith({ BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: OWNER_INTERNAL });
    expect(internal.BLUEPRINT_ENGINE_URL).toBe(OWNER_INTERNAL);
    const docker = await loadWith({ BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: OWNER_DOCKER });
    expect(docker.BLUEPRINT_ENGINE_URL).toBe(OWNER_DOCKER);
  });

  it('mock mode may omit BLUEPRINT_ENGINE_URL (unpublished, not invented)', async () => {
    const parsed = await loadWith({ APP_ENV: 'dev', BLUEPRINT_ENGINE_MODE: 'mock' });
    expect(parsed.BLUEPRINT_ENGINE_MODE).toBe('mock');
    expect(parsed.BLUEPRINT_ENGINE_URL).toBeUndefined();
  });
});
