/**
 * Unit card — compose does not invent BLUEPRINT_ENGINE_MODE=mock
 *
 * 1. Promise: host `.env` can pin MODE. Blank stays unset so env.ts default
 *    `http` applies. Mock is explicit only.
 * 2. Break: compose `:-mock` serves stub profiles when the operator never set
 *    a mode — the fallback env.ts forbids.
 * 3. Done bar: docker-compose.apps.yml svc-blueprint has
 *    BLUEPRINT_ENGINE_MODE: ${BLUEPRINT_ENGINE_MODE:-}
 *    env.ts still defaults `http`; compose `''` parses as that default.
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-blueprint block) + env.ts
 * 6. RED: pin fails if compose contains `:-mock` or `:-http`
 * 7. Collision: crew / mentor / season / renderer / timeout — this pin does
 *    not restamp them. ENGINE_URL empty pass-through is the URL mill.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const MODE = 'BLUEPRINT_ENGINE_MODE';
const LINE = /^\s+BLUEPRINT_ENGINE_MODE:\s*\$\{BLUEPRINT_ENGINE_MODE:-\}\s*$/gm;

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: 'an-edge-principal-secret-long-enough-for-the-schema',
  BLUEPRINT_ENGINE_URL: 'https://neural-engine.internal/v1',
};

function blueprintComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const start = compose.indexOf('\n  svc-blueprint:');
  expect(start, 'svc-blueprint service missing from docker-compose.apps.yml').toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n  svc-[a-z]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('BLUEPRINT_ENGINE_MODE', undefined);
  vi.stubEnv('BLUEPRINT_ENGINE_URL', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compose BLUEPRINT_ENGINE_MODE empty pass-through (no invented mock)', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = blueprintComposeBlock();

  it('compose svc-blueprint block passes MODE once with empty fallback', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-blueprint/);
    expect(block.match(LINE)).toHaveLength(1);
    expect(countAssignments(compose, MODE), `${MODE} must appear once`).toBe(1);
    expect(countAssignments(block, MODE), `${MODE} must appear once on svc-blueprint`).toBe(1);
  });

  it('compose pin must not contain :-mock (or :-http)', () => {
    expect(block).not.toMatch(/BLUEPRINT_ENGINE_MODE:-\s*mock/);
    expect(block).not.toMatch(/\$\{BLUEPRINT_ENGINE_MODE:-mock\}/);
    expect(block).not.toMatch(/\$\{BLUEPRINT_ENGINE_MODE:-http\}/);
  });

  it('does not restamp crew/mentor/season/renderer/url/timeout', () => {
    expect(block).toMatch(/BLUEPRINT_ENGINE_URL:\s*\$\{BLUEPRINT_ENGINE_URL:-\}/);
    expect(block).not.toMatch(/\$\{BLUEPRINT_ENGINE_URL:-http:\/\/host\.docker\.internal:4108\}/);
    expect(block).toMatch(/BLUEPRINT_ENGINE_TIMEOUT_MS:\s*\$\{BLUEPRINT_ENGINE_TIMEOUT_MS:-20000\}/);
    expect(block).toMatch(/BLUEPRINT_CREW_CAPACITY:\s*\$\{BLUEPRINT_CREW_CAPACITY:-\}/);
    expect(block).toMatch(/BLUEPRINT_MENTOR_SHORTLIST_SIZE:\s*\$\{BLUEPRINT_MENTOR_SHORTLIST_SIZE:-\}/);
    expect(block).toMatch(/BLUEPRINT_SEASON:\s*\$\{BLUEPRINT_SEASON:-\}/);
    expect(block).toMatch(/BLUEPRINT_CARD_RENDERER_URL:\s*\$\{BLUEPRINT_CARD_RENDERER_URL:-\}/);
  });
});

describe('BLUEPRINT_ENGINE_MODE blank uses env http (compose empty string)', () => {
  it('unset MODE is http', async () => {
    const parsed = await loadWith({});
    expect(parsed.BLUEPRINT_ENGINE_MODE).toBe('http');
  });

  it('blank MODE is http (not mock, does not refuse boot)', async () => {
    const parsed = await loadWith({ BLUEPRINT_ENGINE_MODE: '' });
    expect(parsed.BLUEPRINT_ENGINE_MODE).toBe('http');
  });

  it('explicit mock is still allowed in non-prod', async () => {
    const parsed = await loadWith({ APP_ENV: 'dev', BLUEPRINT_ENGINE_MODE: 'mock' });
    expect(parsed.BLUEPRINT_ENGINE_MODE).toBe('mock');
  });

  it('garbage MODE refuses boot (does not invent mock or http)', async () => {
    await expect(loadWith({ BLUEPRINT_ENGINE_MODE: 'garbage' })).rejects.toThrow(/BLUEPRINT_ENGINE_MODE/);
  });
});
