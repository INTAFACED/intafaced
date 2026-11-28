/**
 * Unit card — ws connection ceilings are owner-published; blank refuses
 *
 * 1. Promise: WS_MAX_CONNECTIONS and WS_PRIVATE_MAX_CONNECTIONS_PER_USER from
 *    host `.env` reach the container. Unset / blank do not become 5000 / 16.
 *    Attach refuses ws.max_connections_unset /
 *    ws.private_max_connections_per_user_unset. Never invent a ceiling.
 * 2. Break: compose `:-5000` / `:-16` or env.ts `.default(5_000)` / `.default(16)`
 *    looks published when the operator never set a socket ceiling.
 * 3. Done bar: docker-compose.apps.yml svc-ws has
 *    WS_MAX_CONNECTIONS: ${WS_MAX_CONNECTIONS:-}
 *    WS_PRIVATE_MAX_CONNECTIONS_PER_USER: ${WS_PRIVATE_MAX_CONNECTIONS_PER_USER:-}
 *    env.ts preprocess blank → undefined, union undefined | int min 1,
 *    no `.default(5_000)` / `.default(16)`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-ws block only), env.ts,
 *    max-connections.ts, hub attach
 * 6. RED: pin fails if capacity default is 5000/16, compose bakes those,
 *    or sibling ws keys are restamped
 * 7. Collision: HEARTBEAT / HIGH_WATER / LAG / GATEWAY / DEPTH / POLL /
 *    MARKETS_REFRESH / TRADE_URL / JWT / SBE — this pin does not restamp them.
 *    WS_POLL_INTERVAL_MS stays 250. Nginx /ws is not recut.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPublishedConnectionCeiling, WS_MAX_CONNECTIONS_UNSET, WS_PRIVATE_MAX_CONNECTIONS_PER_USER_UNSET } from './max-connections.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

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

const CAP = /^\s+WS_MAX_CONNECTIONS:\s*\$\{WS_MAX_CONNECTIONS:-\}\s*$/gm;
const PER_USER = /^\s+WS_PRIVATE_MAX_CONNECTIONS_PER_USER:\s*\$\{WS_PRIVATE_MAX_CONNECTIONS_PER_USER:-\}\s*$/gm;

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('WS_MAX_CONNECTIONS', undefined);
  vi.stubEnv('WS_PRIVATE_MAX_CONNECTIONS_PER_USER', undefined);
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compose WS_MAX_CONNECTIONS / per-user for svc-ws', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = wsComposeBlock();

  it('the env loader refuses blank ceilings — no 5000 / 16 default; poll stays 250', async () => {
    const unset = await loadWith({
      WS_MAX_CONNECTIONS: undefined,
      WS_PRIVATE_MAX_CONNECTIONS_PER_USER: undefined,
      WS_POLL_INTERVAL_MS: undefined,
    });
    expect(unset.WS_MAX_CONNECTIONS).toBeUndefined();
    expect(unset.WS_PRIVATE_MAX_CONNECTIONS_PER_USER).toBeUndefined();
    expect(unset.WS_POLL_INTERVAL_MS).toBe(250);
    expect((await loadWith({ WS_MAX_CONNECTIONS: '1' })).WS_MAX_CONNECTIONS).toBe(1);
    await expect(loadWith({ WS_MAX_CONNECTIONS: '0' })).rejects.toThrow(/WS_MAX_CONNECTIONS/);
    await expect(loadWith({ WS_MAX_CONNECTIONS: '1.5' })).rejects.toThrow(/WS_MAX_CONNECTIONS/);
    expect((await loadWith({ WS_PRIVATE_MAX_CONNECTIONS_PER_USER: '1' })).WS_PRIVATE_MAX_CONNECTIONS_PER_USER).toBe(1);
    await expect(loadWith({ WS_PRIVATE_MAX_CONNECTIONS_PER_USER: '0' })).rejects.toThrow(/WS_PRIVATE_MAX_CONNECTIONS_PER_USER/);
    await expect(loadWith({ WS_PRIVATE_MAX_CONNECTIONS_PER_USER: '1.5' })).rejects.toThrow(/WS_PRIVATE_MAX_CONNECTIONS_PER_USER/);
    expect((await loadWith({ WS_POLL_INTERVAL_MS: '50' })).WS_POLL_INTERVAL_MS).toBe(50);
    expect((await loadWith({ WS_POLL_INTERVAL_MS: '60000' })).WS_POLL_INTERVAL_MS).toBe(60_000);
    await expect(loadWith({ WS_POLL_INTERVAL_MS: '49' })).rejects.toThrow(/WS_POLL_INTERVAL_MS/);
    await expect(loadWith({ WS_POLL_INTERVAL_MS: '60001' })).rejects.toThrow(/WS_POLL_INTERVAL_MS/);
  });

  it('compose svc-ws block is the unique home; ceilings are empty pass-through', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-ws/);
    expect(block.match(CAP)).toHaveLength(1);
    expect(block.match(PER_USER)).toHaveLength(1);
    expect(block).not.toMatch(/WS_MAX_CONNECTIONS:\s*\$\{WS_MAX_CONNECTIONS:-5000\}/);
    expect(block).not.toMatch(/WS_PRIVATE_MAX_CONNECTIONS_PER_USER:\s*\$\{WS_PRIVATE_MAX_CONNECTIONS_PER_USER:-16\}/);
    expect(countAssignments(block, 'WS_MAX_CONNECTIONS')).toBe(1);
    expect(countAssignments(block, 'WS_PRIVATE_MAX_CONNECTIONS_PER_USER')).toBe(1);
    expect(compose.match(/^\s+WS_MAX_CONNECTIONS:/gm) ?? []).toHaveLength(1);
    expect(compose.match(/^\s+WS_PRIVATE_MAX_CONNECTIONS_PER_USER:/gm) ?? []).toHaveLength(1);
  });

  it('does not restamp poll/heartbeat/gateway/depth/jwt or invent seats', () => {
    expect(block).toMatch(/WS_POLL_INTERVAL_MS:\s*\$\{WS_POLL_INTERVAL_MS:-250\}/);
    expect(block).toMatch(/WS_HEARTBEAT_MS:\s*\$\{WS_HEARTBEAT_MS:-30000\}/);
    expect(block).toMatch(/WS_HIGH_WATER_BYTES:\s*\$\{WS_HIGH_WATER_BYTES:-\}/);
    expect(block).toMatch(/WS_MAX_LAG_TICKS:\s*\$\{WS_MAX_LAG_TICKS:-\}/);
    expect(block).toMatch(/WS_GATEWAY_ENABLED:\s*\$\{WS_GATEWAY_ENABLED:-true\}/);
    expect(block).toMatch(/WS_DEPTH_LIMIT:\s*\$\{WS_DEPTH_LIMIT:-\}/);
    expect(block).toMatch(/WS_MARKETS_REFRESH_MS:\s*\$\{WS_MARKETS_REFRESH_MS:-30000\}/);
    expect(WS_MAX_CONNECTIONS_UNSET).toBe('ws.max_connections_unset');
    expect(WS_PRIVATE_MAX_CONNECTIONS_PER_USER_UNSET).toBe('ws.private_max_connections_per_user_unset');
  });
});

describe('svc-ws WS_MAX_CONNECTIONS refuse-closed', () => {
  it('unset WS_MAX_CONNECTIONS is unpublished (no invent 5000)', async () => {
    const parsed = await loadWith({ WS_MAX_CONNECTIONS: undefined });
    expect(parsed.WS_MAX_CONNECTIONS).toBeUndefined();
  });

  it('blank WS_MAX_CONNECTIONS is unpublished', async () => {
    const parsed = await loadWith({ WS_MAX_CONNECTIONS: '' });
    expect(parsed.WS_MAX_CONNECTIONS).toBeUndefined();
  });

  it('whitespace WS_MAX_CONNECTIONS is unpublished', async () => {
    const parsed = await loadWith({ WS_MAX_CONNECTIONS: '   ' });
    expect(parsed.WS_MAX_CONNECTIONS).toBeUndefined();
  });

  it('zero WS_MAX_CONNECTIONS refuses (no invent 1 seat)', async () => {
    await expect(loadWith({ WS_MAX_CONNECTIONS: '0' })).rejects.toThrow(/WS_MAX_CONNECTIONS/);
  });

  it('explicit owner pin 5000 is accepted (not invented)', async () => {
    const parsed = await loadWith({ WS_MAX_CONNECTIONS: '5000' });
    expect(parsed.WS_MAX_CONNECTIONS).toBe(5000);
  });
});

describe('svc-ws WS_PRIVATE_MAX_CONNECTIONS_PER_USER refuse-closed', () => {
  it('unset per-user cap is unpublished (no invent 16)', async () => {
    const parsed = await loadWith({ WS_PRIVATE_MAX_CONNECTIONS_PER_USER: undefined });
    expect(parsed.WS_PRIVATE_MAX_CONNECTIONS_PER_USER).toBeUndefined();
  });

  it('blank per-user cap is unpublished', async () => {
    const parsed = await loadWith({ WS_PRIVATE_MAX_CONNECTIONS_PER_USER: '' });
    expect(parsed.WS_PRIVATE_MAX_CONNECTIONS_PER_USER).toBeUndefined();
  });

  it('zero per-user cap refuses (no invent 1 seat)', async () => {
    await expect(loadWith({ WS_PRIVATE_MAX_CONNECTIONS_PER_USER: '0' })).rejects.toThrow(/WS_PRIVATE_MAX_CONNECTIONS_PER_USER/);
  });

  it('explicit owner pin 16 is accepted (not invented)', async () => {
    const parsed = await loadWith({ WS_PRIVATE_MAX_CONNECTIONS_PER_USER: '16' });
    expect(parsed.WS_PRIVATE_MAX_CONNECTIONS_PER_USER).toBe(16);
  });
});

describe('isPublishedConnectionCeiling pin', () => {
  it('unset / NaN / 0 refuse by name — never invent 5000', () => {
    expect(isPublishedConnectionCeiling(undefined)).toBe(false);
    expect(isPublishedConnectionCeiling(Number.NaN)).toBe(false);
    expect(isPublishedConnectionCeiling(0)).toBe(false);
    expect(isPublishedConnectionCeiling(5000)).toBe(true);
  });
});
