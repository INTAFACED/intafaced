import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit card — compose stack passes heartbeat cap into svc-ws
 *
 * 1. Promise: host `.env` can pin WS_HEARTBEAT_MS (env.ts already declares it).
 *    WS_HIGH_WATER_BYTES is owner-published in high-water-bytes-compose-pin.test.ts.
 *    WS_MAX_LAG_TICKS is owner-published in max-lag-ticks-compose-pin.test.ts.
 *    Per-user cap is owner-published in max-connections-compose-pin.test.ts.
 * 2. Break: compose booted ws without the name → operator heartbeat is a
 *    no-op and the container always uses the schema default.
 * 3. Done bar: docker-compose.apps.yml svc-ws has
 *    WS_HEARTBEAT_MS: ${WS_HEARTBEAT_MS:-30000}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-ws block only)
 * 6. RED: pin fails if a unique key drops, is duplicated, or defaults drift
 * 7. Collision: existing DEPTH_LIMIT / POLL / GATEWAY / MARKETS_REFRESH /
 *    MAX_CONNECTIONS / TRADE_URL / JWT / LAG / HIGH_WATER — this pin does not
 *    restamp them. WS_POLL_INTERVAL_MS stays 250. Nginx /ws is not recut.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const HEARTBEAT = 'WS_HEARTBEAT_MS';

const KEYS = [{ name: HEARTBEAT, fallback: '30000', envDefault: '30_000' }] as const;

async function loadEnv(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function wsComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const start = compose.indexOf('\n  svc-ws:');
  expect(start, 'svc-ws service missing from docker-compose.apps.yml').toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n  svc-[a-z]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

describe('compose passes heartbeat and backpressure caps into svc-ws', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = wsComposeBlock();

  it('the env loader defaults each flag this pin tracks to the compose fallback (30000)', async () => {
    const unset = await loadEnv(Object.fromEntries(KEYS.map((key) => [key.name, undefined])));
    for (const key of KEYS) {
      expect(unset[key.name]).toBe(Number(key.fallback));
      expect((await loadEnv({ [key.name]: '1000' }))[key.name]).toBe(1_000);
      await expect(loadEnv({ [key.name]: '999' })).rejects.toThrow(new RegExp(key.name));
    }
  });

  it('compose svc-ws block passes unique keys once with env.ts defaults', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-ws/);
    for (const key of KEYS) {
      expect(block, `${key.name} missing from svc-ws compose environment`).toMatch(
        new RegExp(`${key.name}:\\s*\\$\\{${key.name}:-${key.fallback}\\}`),
      );
    }
  });

  it('names each key once in compose (no duplicate assignments)', () => {
    for (const key of KEYS) {
      expect(countAssignments(compose, key.name), `${key.name} must appear once`).toBe(1);
      expect(countAssignments(block, key.name), `${key.name} must appear once on svc-ws`).toBe(1);
    }
  });

  it('does not restamp gateway/depth/trade/jwt/lag/high-water', () => {
    expect(block).toMatch(/WS_DEPTH_LIMIT:\s*\$\{WS_DEPTH_LIMIT:-\}/);
    expect(block).toMatch(/WS_POLL_INTERVAL_MS:\s*\$\{WS_POLL_INTERVAL_MS:-250\}/);
    expect(block).toMatch(/WS_GATEWAY_ENABLED:\s*\$\{WS_GATEWAY_ENABLED:-true\}/);
    expect(block).toMatch(/WS_MARKETS_REFRESH_MS:\s*\$\{WS_MARKETS_REFRESH_MS:-30000\}/);
    expect(block).toMatch(/WS_MAX_CONNECTIONS:\s*\$\{WS_MAX_CONNECTIONS:-\}/);
    expect(block).toMatch(/WS_MAX_LAG_TICKS:\s*\$\{WS_MAX_LAG_TICKS:-\}/);
    expect(block).toMatch(/WS_HIGH_WATER_BYTES:\s*\$\{WS_HIGH_WATER_BYTES:-\}/);
    expect(block).toMatch(/TRADE_URL:\s*http:\/\/svc-trade:4004/);
  });
});
