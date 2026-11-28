/**
 * Unit card — ws consecutive lag ticks are owner-published; blank refuses
 *
 * 1. Promise: WS_MAX_LAG_TICKS from host `.env` reaches the container.
 *    Unset / blank do not become 20. Attach refuses ws.max_lag_ticks_unset.
 *    Never invent a lag bound. Owner may set 20 (~5 seconds at default cadence).
 * 2. Break: compose `:-20` or env.ts `.default(20)` looks published when the
 *    operator never set the disconnect policy.
 * 3. Done bar: docker-compose.apps.yml svc-ws has
 *    WS_MAX_LAG_TICKS: ${WS_MAX_LAG_TICKS:-}
 *    env.ts preprocess blank → undefined, union undefined | int min 1,
 *    no `.default(20)`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-ws block only), env.ts,
 *    max-lag-ticks.ts, hub attach
 * 6. RED: pin fails if lag default is 20, compose bakes 20, or sibling
 *    ws keys are restamped
 * 7. Collision: HEARTBEAT / HIGH_WATER / GATEWAY / POLL /
 *    MARKETS_REFRESH / MAX_CONNECTIONS / DEPTH / TRADE_URL / JWT / SBE /
 *    TRADES_DURABLE / PRIVATE_ORDERS_DURABLE / TRADE_RECENT / DROP_COPY_RECENT
 *    — this pin does not restamp them.
 *    WS_POLL_INTERVAL_MS stays 250. Nginx /ws is not recut.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPublishedMaxLagTicks, WS_MAX_LAG_TICKS_UNSET } from './max-lag-ticks.js';

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

const LAG = /^\s+WS_MAX_LAG_TICKS:\s*\$\{WS_MAX_LAG_TICKS:-\}\s*$/gm;

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('WS_MAX_LAG_TICKS', undefined);
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compose WS_MAX_LAG_TICKS for svc-ws', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = wsComposeBlock();

  it('the env loader refuses blank lag ticks — no 20 default; poll stays 250', async () => {
    const unset = await loadWith({ WS_MAX_LAG_TICKS: undefined, WS_POLL_INTERVAL_MS: undefined });
    expect(unset.WS_MAX_LAG_TICKS).toBeUndefined();
    expect(unset.WS_POLL_INTERVAL_MS).toBe(250);
    expect((await loadWith({ WS_MAX_LAG_TICKS: '1' })).WS_MAX_LAG_TICKS).toBe(1);
    await expect(loadWith({ WS_MAX_LAG_TICKS: '0' })).rejects.toThrow(/WS_MAX_LAG_TICKS/);
    await expect(loadWith({ WS_MAX_LAG_TICKS: '1.5' })).rejects.toThrow(/WS_MAX_LAG_TICKS/);
    expect((await loadWith({ WS_POLL_INTERVAL_MS: '50' })).WS_POLL_INTERVAL_MS).toBe(50);
    expect((await loadWith({ WS_POLL_INTERVAL_MS: '60000' })).WS_POLL_INTERVAL_MS).toBe(60_000);
    await expect(loadWith({ WS_POLL_INTERVAL_MS: '49' })).rejects.toThrow(/WS_POLL_INTERVAL_MS/);
    await expect(loadWith({ WS_POLL_INTERVAL_MS: '60001' })).rejects.toThrow(/WS_POLL_INTERVAL_MS/);
  });

  it('compose svc-ws block is the unique home; lag ticks are empty pass-through', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-ws/);
    expect(block.match(LAG)).toHaveLength(1);
    expect(block).not.toMatch(/WS_MAX_LAG_TICKS:\s*\$\{WS_MAX_LAG_TICKS:-20\}/);
    expect(countAssignments(block, 'WS_MAX_LAG_TICKS')).toBe(1);
    expect(compose.match(/^\s+WS_MAX_LAG_TICKS:/gm) ?? []).toHaveLength(1);
  });

  it('does not restamp poll/heartbeat/gateway/max-connections/depth/jwt or invent 20', () => {
    expect(block).toMatch(/WS_POLL_INTERVAL_MS:\s*\$\{WS_POLL_INTERVAL_MS:-250\}/);
    expect(block).toMatch(/WS_HEARTBEAT_MS:\s*\$\{WS_HEARTBEAT_MS:-30000\}/);
    expect(block).toMatch(/WS_HIGH_WATER_BYTES:\s*\$\{WS_HIGH_WATER_BYTES:-\}/);
    expect(block).toMatch(/WS_GATEWAY_ENABLED:\s*\$\{WS_GATEWAY_ENABLED:-true\}/);
    expect(block).toMatch(/WS_MAX_CONNECTIONS:\s*\$\{WS_MAX_CONNECTIONS:-\}/);
    expect(block).toMatch(/WS_DEPTH_LIMIT:\s*\$\{WS_DEPTH_LIMIT:-\}/);
    expect(block).toMatch(/WS_TRADE_RECENT_LIMIT:\s*\$\{WS_TRADE_RECENT_LIMIT:-\}/);
    expect(block).toMatch(/WS_DROP_COPY_RECENT_LIMIT:\s*\$\{WS_DROP_COPY_RECENT_LIMIT:-\}/);
    expect(block).toMatch(/WS_MARKETS_REFRESH_MS:\s*\$\{WS_MARKETS_REFRESH_MS:-30000\}/);
    expect(block).toMatch(/WS_TRADES_DURABLE:\s*\$\{WS_TRADES_DURABLE:-ws-trade-tape\}/);
    expect(block).toMatch(/WS_PRIVATE_ORDERS_DURABLE:\s*\$\{WS_PRIVATE_ORDERS_DURABLE:-ws-private-orders\}/);
    expect(WS_MAX_LAG_TICKS_UNSET).toBe('ws.max_lag_ticks_unset');
  });
});

describe('svc-ws WS_MAX_LAG_TICKS refuse-closed', () => {
  it('unset WS_MAX_LAG_TICKS is unpublished (no invent 20)', async () => {
    const parsed = await loadWith({ WS_MAX_LAG_TICKS: undefined });
    expect(parsed.WS_MAX_LAG_TICKS).toBeUndefined();
  });

  it('blank WS_MAX_LAG_TICKS is unpublished', async () => {
    const parsed = await loadWith({ WS_MAX_LAG_TICKS: '' });
    expect(parsed.WS_MAX_LAG_TICKS).toBeUndefined();
  });

  it('whitespace WS_MAX_LAG_TICKS is unpublished', async () => {
    const parsed = await loadWith({ WS_MAX_LAG_TICKS: '   ' });
    expect(parsed.WS_MAX_LAG_TICKS).toBeUndefined();
  });

  it('0 WS_MAX_LAG_TICKS refuses (min is 1, not a silent skip)', async () => {
    await expect(loadWith({ WS_MAX_LAG_TICKS: '0' })).rejects.toThrow(/WS_MAX_LAG_TICKS/);
  });

  it('explicit owner pin 20 is accepted (not invented)', async () => {
    const parsed = await loadWith({ WS_MAX_LAG_TICKS: '20' });
    expect(parsed.WS_MAX_LAG_TICKS).toBe(20);
  });
});

describe('isPublishedMaxLagTicks pin', () => {
  it('unset / NaN / 0 refuse by name — never invent 20; 20 is a published bound', () => {
    expect(isPublishedMaxLagTicks(undefined)).toBe(false);
    expect(isPublishedMaxLagTicks(Number.NaN)).toBe(false);
    expect(isPublishedMaxLagTicks(0)).toBe(false);
    expect(isPublishedMaxLagTicks(20)).toBe(true);
  });
});
