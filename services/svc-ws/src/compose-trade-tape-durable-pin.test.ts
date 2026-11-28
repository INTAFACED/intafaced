import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit card — compose stack passes trade-tape limit and durable names into svc-ws
 *
 * 1. Promise: host `.env` can pin WS_TRADE_RECENT_LIMIT (empty pass-through),
 *    WS_TRADES_DURABLE, and WS_PRIVATE_ORDERS_DURABLE (env.ts already declares them).
 * 2. Break: compose booted ws without the names → operator tape length /
 *    NATS durable names is a no-op and the container always uses schema defaults
 *    (or invents 50 for the tape window).
 * 3. Done bar: docker-compose.apps.yml svc-ws has
 *    WS_TRADE_RECENT_LIMIT: ${WS_TRADE_RECENT_LIMIT:-}
 *    WS_TRADES_DURABLE: ${WS_TRADES_DURABLE:-ws-trade-tape}
 *    WS_PRIVATE_ORDERS_DURABLE: ${WS_PRIVATE_ORDERS_DURABLE:-ws-private-orders}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-ws block only)
 * 6. RED: pin fails if a unique key drops, is duplicated, or defaults drift
 * 7. Collision: existing HEARTBEAT / HIGH_WATER / LAG / PRIVATE_MAX /
 *    GATEWAY / DEPTH / POLL / MARKETS_REFRESH / MAX_CONNECTIONS — this pin
 *    does not restamp them.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const LIMIT = 'WS_TRADE_RECENT_LIMIT';
const TRADES_DURABLE = 'WS_TRADES_DURABLE';
const PRIVATE_DURABLE = 'WS_PRIVATE_ORDERS_DURABLE';

const KEYS = [
  { name: TRADES_DURABLE, fallback: 'ws-trade-tape', envDefault: "'ws-trade-tape'" },
  { name: PRIVATE_DURABLE, fallback: 'ws-private-orders', envDefault: "'ws-private-orders'" },
] as const;

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

describe('compose passes trade-tape limit and durable names into svc-ws', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = wsComposeBlock();

  it('the env loader defaults the durable names to the compose fallbacks (ws-trade-tape / ws-private-orders); tape window is unpublished', async () => {
    const unset = await loadEnv({ [LIMIT]: undefined, [TRADES_DURABLE]: undefined, [PRIVATE_DURABLE]: undefined });
    for (const key of KEYS) {
      expect(unset[key.name]).toBe(key.fallback);
      expect(`'${key.fallback}'`).toBe(key.envDefault);
      expect((await loadEnv({ [key.name]: 'custom-durable' }))[key.name]).toBe('custom-durable');
      await expect(loadEnv({ [key.name]: 'x'.repeat(129) })).rejects.toThrow(new RegExp(key.name));
    }
    expect(unset.WS_TRADE_RECENT_LIMIT).toBeUndefined();
  });

  it('compose svc-ws block passes unique keys once with env.ts defaults', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-ws/);
    expect(block).toMatch(/WS_TRADE_RECENT_LIMIT:\s*\$\{WS_TRADE_RECENT_LIMIT:-\}/);
    expect(block).not.toMatch(/WS_TRADE_RECENT_LIMIT:\s*\$\{WS_TRADE_RECENT_LIMIT:-50\}/);
    for (const key of KEYS) {
      expect(block, `${key.name} missing from svc-ws compose environment`).toMatch(
        new RegExp(`${key.name}:\\s*\\$\\{${key.name}:-${key.fallback}\\}`),
      );
    }
  });

  it('names each key once in compose (no duplicate assignments)', () => {
    expect(countAssignments(compose, LIMIT), `${LIMIT} must appear once`).toBe(1);
    expect(countAssignments(block, LIMIT), `${LIMIT} must appear once on svc-ws`).toBe(1);
    for (const key of KEYS) {
      expect(countAssignments(compose, key.name), `${key.name} must appear once`).toBe(1);
      expect(countAssignments(block, key.name), `${key.name} must appear once on svc-ws`).toBe(1);
    }
  });

  it('does not restamp heartbeat, backpressure, gateway, depth, poll, markets, or max-connections', () => {
    expect(block).toMatch(/WS_HEARTBEAT_MS:\s*\$\{WS_HEARTBEAT_MS:-30000\}/);
    expect(block).toMatch(/WS_HIGH_WATER_BYTES:\s*\$\{WS_HIGH_WATER_BYTES:-\}/);
    expect(block).toMatch(/WS_MAX_LAG_TICKS:\s*\$\{WS_MAX_LAG_TICKS:-\}/);
    expect(block).toMatch(/WS_PRIVATE_MAX_CONNECTIONS_PER_USER:\s*\$\{WS_PRIVATE_MAX_CONNECTIONS_PER_USER:-\}/);
    expect(block).toMatch(/WS_GATEWAY_ENABLED:\s*\$\{WS_GATEWAY_ENABLED:-true\}/);
    expect(block).toMatch(/WS_DEPTH_LIMIT:\s*\$\{WS_DEPTH_LIMIT:-\}/);
    expect(block).toMatch(/WS_POLL_INTERVAL_MS:\s*\$\{WS_POLL_INTERVAL_MS:-250\}/);
    expect(block).toMatch(/WS_MARKETS_REFRESH_MS:\s*\$\{WS_MARKETS_REFRESH_MS:-30000\}/);
    expect(block).toMatch(/WS_MAX_CONNECTIONS:\s*\$\{WS_MAX_CONNECTIONS:-\}/);
    expect(countAssignments(block, 'WS_HEARTBEAT_MS')).toBe(1);
    expect(countAssignments(block, 'WS_HIGH_WATER_BYTES')).toBe(1);
    expect(countAssignments(block, 'WS_MAX_LAG_TICKS')).toBe(1);
    expect(countAssignments(block, 'WS_PRIVATE_MAX_CONNECTIONS_PER_USER')).toBe(1);
    expect(countAssignments(block, 'WS_GATEWAY_ENABLED')).toBe(1);
    expect(countAssignments(block, 'WS_DEPTH_LIMIT')).toBe(1);
    expect(countAssignments(block, 'WS_POLL_INTERVAL_MS')).toBe(1);
    expect(countAssignments(block, 'WS_MARKETS_REFRESH_MS')).toBe(1);
    expect(countAssignments(block, 'WS_MAX_CONNECTIONS')).toBe(1);
  });
});
