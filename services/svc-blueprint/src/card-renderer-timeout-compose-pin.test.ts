/**
 * Unit card — compose stack passes BLUEPRINT_CARD_RENDERER_TIMEOUT_MS plus
 * optional engine/card-renderer API keys into svc-blueprint
 *
 * 1. Promise: host `.env` BLUEPRINT_CARD_RENDERER_TIMEOUT_MS reaches the
 *    container (env.ts already defaults 10000). Optional API keys pass through
 *    only when set (key-no-value).
 * 2. Break: compose booted blueprint with engine mode/url/timeout, crew/season,
 *    and empty card renderer URL but no PNG timeout → operator cannot shorten
 *    a hung rasterizer from `.env`. `${VAR:-}` on API keys would inject '' and
 *    fail env.ts min(1).
 * 3. Done bar: docker-compose.apps.yml svc-blueprint has
 *    BLUEPRINT_CARD_RENDERER_TIMEOUT_MS: ${BLUEPRINT_CARD_RENDERER_TIMEOUT_MS:-10000}
 *    BLUEPRINT_ENGINE_API_KEY:
 *    BLUEPRINT_CARD_RENDERER_API_KEY:
 *    once each (key-no-value, not `${VAR:-}`).
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-blueprint block only)
 * 6. RED: pin fails if the unique keys drop, duplicate, timeout default drifts,
 *    or API keys use empty-string interpolation
 * 7. Collision: compose-crew-capacity-season-timeout-pin.test.ts — this pin
 *    does not restamp BLUEPRINT_ENGINE_MODE/URL/TIMEOUT, crew/mentor/season,
 *    BLUEPRINT_CARD_RENDERER_URL, or JWT. Does not invent a rasterizer URL.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const KEY = 'BLUEPRINT_CARD_RENDERER_TIMEOUT_MS';
const ENGINE_KEY = 'BLUEPRINT_ENGINE_API_KEY';
const RENDERER_KEY = 'BLUEPRINT_CARD_RENDERER_API_KEY';
const TIMEOUT = /^\s+BLUEPRINT_CARD_RENDERER_TIMEOUT_MS:\s*\$\{BLUEPRINT_CARD_RENDERER_TIMEOUT_MS:-10000\}\s*$/gm;
const ENGINE_API_KEY = /^\s+BLUEPRINT_ENGINE_API_KEY:\s*$/gm;
const RENDERER_API_KEY = /^\s+BLUEPRINT_CARD_RENDERER_API_KEY:\s*$/gm;
const ENGINE_MODE = /^\s+BLUEPRINT_ENGINE_MODE:\s*\$\{BLUEPRINT_ENGINE_MODE:-\}\s*$/gm;
const ENGINE_URL = /^\s+BLUEPRINT_ENGINE_URL:\s*\$\{BLUEPRINT_ENGINE_URL:-\}\s*$/gm;
const ENGINE_TIMEOUT = /^\s+BLUEPRINT_ENGINE_TIMEOUT_MS:\s*\$\{BLUEPRINT_ENGINE_TIMEOUT_MS:-20000\}\s*$/gm;
const CREW = /^\s+BLUEPRINT_CREW_CAPACITY:\s*\$\{BLUEPRINT_CREW_CAPACITY:-\}\s*$/gm;
const MENTOR = /^\s+BLUEPRINT_MENTOR_SHORTLIST_SIZE:\s*\$\{BLUEPRINT_MENTOR_SHORTLIST_SIZE:-\}\s*$/gm;
const SEASON = /^\s+BLUEPRINT_SEASON:\s*\$\{BLUEPRINT_SEASON:-\}\s*$/gm;
const RENDERER_URL = /^\s+BLUEPRINT_CARD_RENDERER_URL:\s*\$\{BLUEPRINT_CARD_RENDERER_URL:-\}\s*$/gm;

function blueprintComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const start = compose.indexOf('\n  svc-blueprint:');
  expect(start, 'svc-blueprint service missing from docker-compose.apps.yml').toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n  svc-[a-z]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: 'an-edge-principal-secret-long-enough-for-the-schema',
  BLUEPRINT_ENGINE_MODE: 'mock',
};

/** The service's own env, parsed by env.ts at import as at boot. */
async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  for (const key of [KEY, ENGINE_KEY, RENDERER_KEY]) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  return (await import('./env.js')).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

describe('compose passes card-renderer timeout into svc-blueprint', () => {
  const block = blueprintComposeBlock();

  it('env.ts still defaults BLUEPRINT_CARD_RENDERER_TIMEOUT_MS to 10000 matching compose', async () => {
    expect((await loadWith({})).BLUEPRINT_CARD_RENDERER_TIMEOUT_MS).toBe(10_000);
    expect((await loadWith({ [KEY]: '2500' })).BLUEPRINT_CARD_RENDERER_TIMEOUT_MS).toBe(2_500);
  }, 20_000);

  it('env.ts keeps API keys optional (empty string fails; unset omits)', async () => {
    const unset = await loadWith({});
    expect(unset.BLUEPRINT_ENGINE_API_KEY).toBeUndefined();
    expect(unset.BLUEPRINT_CARD_RENDERER_API_KEY).toBeUndefined();
    await expect(loadWith({ [ENGINE_KEY]: '' })).rejects.toThrow(new RegExp(ENGINE_KEY));
    await expect(loadWith({ [RENDERER_KEY]: '' })).rejects.toThrow(new RegExp(RENDERER_KEY));
    const set = await loadWith({ [ENGINE_KEY]: 'k1', [RENDERER_KEY]: 'k2' });
    expect([set.BLUEPRINT_ENGINE_API_KEY, set.BLUEPRINT_CARD_RENDERER_API_KEY]).toEqual(['k1', 'k2']);
    // No sign-in settings: the service authenticates the edge, not a token of its own.
    expect(Object.keys(set).filter((name) => name.startsWith('JWT_'))).toEqual([]);
  });

  it('compose svc-blueprint block passes the timeout once with default 10000', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-blueprint/);
    expect(block.match(TIMEOUT)).toHaveLength(1);
  });

  it('compose svc-blueprint block passes each API key once as key-no-value', () => {
    expect(block.match(ENGINE_API_KEY)).toHaveLength(1);
    expect(block.match(RENDERER_API_KEY)).toHaveLength(1);
    expect(block).not.toMatch(/BLUEPRINT_ENGINE_API_KEY:\s*\$\{/);
    expect(block).not.toMatch(/BLUEPRINT_CARD_RENDERER_API_KEY:\s*\$\{/);
  });

  it('names timeout and API keys once inside the blueprint block', () => {
    expect(countAssignments(block, KEY), `${KEY} must appear once on svc-blueprint`).toBe(1);
    expect(countAssignments(block, ENGINE_KEY), `${ENGINE_KEY} must appear once on svc-blueprint`).toBe(1);
    expect(countAssignments(block, RENDERER_KEY), `${RENDERER_KEY} must appear once on svc-blueprint`).toBe(1);
  });

  it('does not restamp engine/crew/season/renderer URL or add JWT', () => {
    expect(block.match(ENGINE_MODE)).toHaveLength(1);
    expect(block.match(ENGINE_URL)).toHaveLength(1);
    expect(block.match(ENGINE_TIMEOUT)).toHaveLength(1);
    expect(block.match(CREW)).toHaveLength(1);
    expect(block.match(MENTOR)).toHaveLength(1);
    expect(block.match(SEASON)).toHaveLength(1);
    expect(block.match(RENDERER_URL)).toHaveLength(1);
    expect(block).not.toMatch(/BLUEPRINT_ENGINE_MODE:\s*\$\{BLUEPRINT_ENGINE_MODE:-mock\}/);
    expect(block).not.toMatch(/BLUEPRINT_ENGINE_MODE:\s*\$\{BLUEPRINT_ENGINE_MODE:-http\}/);
    expect(block).not.toMatch(/\bJWT_/);
  });
});
