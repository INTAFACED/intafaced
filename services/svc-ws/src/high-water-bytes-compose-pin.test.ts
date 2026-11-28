/**
 * Unit card — ws outbound high-water is owner-published; blank refuses
 *
 * 1. Promise: WS_HIGH_WATER_BYTES from host `.env` reaches the container.
 *    Unset / blank do not become 1048576. Attach refuses ws.high_water_bytes_unset.
 *    Never invent a lag buffer bound. Owner may set 1048576.
 * 2. Break: compose `:-1048576` or env.ts `.default(1_048_576)` looks published
 *    when the operator never set the buffer bound.
 * 3. Done bar: docker-compose.apps.yml svc-ws has
 *    WS_HIGH_WATER_BYTES: ${WS_HIGH_WATER_BYTES:-}
 *    env.ts preprocess blank → undefined, union undefined | int min 4096,
 *    no `.default(1_048_576)`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-ws block only), env.ts,
 *    high-water-bytes.ts, hub attach
 * 6. RED: pin fails if high-water default is 1048576, compose bakes 1048576,
 *    or sibling ws keys are restamped
 * 7. Collision: HEARTBEAT / LAG / GATEWAY / POLL /
 *    MARKETS_REFRESH / MAX_CONNECTIONS / DEPTH / TRADE_URL / JWT / SBE /
 *    TRADES_DURABLE / PRIVATE_ORDERS_DURABLE / TRADE_RECENT / DROP_COPY_RECENT
 *    — this pin does not restamp them.
 *    WS_POLL_INTERVAL_MS stays 250. Nginx /ws is not recut.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPublishedHighWaterBytes, WS_HIGH_WATER_BYTES_UNSET } from './high-water-bytes.js';

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

const HIGH = /^\s+WS_HIGH_WATER_BYTES:\s*\$\{WS_HIGH_WATER_BYTES:-\}\s*$/gm;

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('WS_HIGH_WATER_BYTES', undefined);
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compose WS_HIGH_WATER_BYTES for svc-ws', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = wsComposeBlock();

  it('the env loader refuses blank high-water — no 1048576 default; poll stays 250', async () => {
    const unset = await loadWith({ WS_HIGH_WATER_BYTES: undefined, WS_POLL_INTERVAL_MS: undefined });
    expect(unset.WS_HIGH_WATER_BYTES).toBeUndefined();
    expect(unset.WS_POLL_INTERVAL_MS).toBe(250);
    expect((await loadWith({ WS_HIGH_WATER_BYTES: '4096' })).WS_HIGH_WATER_BYTES).toBe(4096);
    await expect(loadWith({ WS_HIGH_WATER_BYTES: '4095' })).rejects.toThrow(/WS_HIGH_WATER_BYTES/);
    await expect(loadWith({ WS_HIGH_WATER_BYTES: '4096.5' })).rejects.toThrow(/WS_HIGH_WATER_BYTES/);
    expect((await loadWith({ WS_POLL_INTERVAL_MS: '50' })).WS_POLL_INTERVAL_MS).toBe(50);
    expect((await loadWith({ WS_POLL_INTERVAL_MS: '60000' })).WS_POLL_INTERVAL_MS).toBe(60_000);
    await expect(loadWith({ WS_POLL_INTERVAL_MS: '49' })).rejects.toThrow(/WS_POLL_INTERVAL_MS/);
    await expect(loadWith({ WS_POLL_INTERVAL_MS: '60001' })).rejects.toThrow(/WS_POLL_INTERVAL_MS/);
  });

  it('compose svc-ws block is the unique home; high-water is empty pass-through', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-ws/);
    expect(block.match(HIGH)).toHaveLength(1);
    expect(block).not.toMatch(/WS_HIGH_WATER_BYTES:\s*\$\{WS_HIGH_WATER_BYTES:-1048576\}/);
    expect(countAssignments(block, 'WS_HIGH_WATER_BYTES')).toBe(1);
    expect(compose.match(/^\s+WS_HIGH_WATER_BYTES:/gm) ?? []).toHaveLength(1);
  });

  it('does not restamp poll/heartbeat/gateway/max-connections/depth/jwt or invent 1048576', () => {
    expect(block).toMatch(/WS_POLL_INTERVAL_MS:\s*\$\{WS_POLL_INTERVAL_MS:-250\}/);
    expect(block).toMatch(/WS_HEARTBEAT_MS:\s*\$\{WS_HEARTBEAT_MS:-30000\}/);
    expect(block).toMatch(/WS_MAX_LAG_TICKS:\s*\$\{WS_MAX_LAG_TICKS:-\}/);
    expect(block).toMatch(/WS_GATEWAY_ENABLED:\s*\$\{WS_GATEWAY_ENABLED:-true\}/);
    expect(block).toMatch(/WS_MAX_CONNECTIONS:\s*\$\{WS_MAX_CONNECTIONS:-\}/);
    expect(block).toMatch(/WS_DEPTH_LIMIT:\s*\$\{WS_DEPTH_LIMIT:-\}/);
    expect(block).toMatch(/WS_TRADE_RECENT_LIMIT:\s*\$\{WS_TRADE_RECENT_LIMIT:-\}/);
    expect(block).toMatch(/WS_DROP_COPY_RECENT_LIMIT:\s*\$\{WS_DROP_COPY_RECENT_LIMIT:-\}/);
    expect(block).toMatch(/WS_MARKETS_REFRESH_MS:\s*\$\{WS_MARKETS_REFRESH_MS:-30000\}/);
    expect(block).toMatch(/WS_TRADES_DURABLE:\s*\$\{WS_TRADES_DURABLE:-ws-trade-tape\}/);
    expect(block).toMatch(/WS_PRIVATE_ORDERS_DURABLE:\s*\$\{WS_PRIVATE_ORDERS_DURABLE:-ws-private-orders\}/);
    expect(WS_HIGH_WATER_BYTES_UNSET).toBe('ws.high_water_bytes_unset');
  });
});

describe('svc-ws WS_HIGH_WATER_BYTES refuse-closed', () => {
  it('unset WS_HIGH_WATER_BYTES is unpublished (no invent 1048576)', async () => {
    const parsed = await loadWith({ WS_HIGH_WATER_BYTES: undefined });
    expect(parsed.WS_HIGH_WATER_BYTES).toBeUndefined();
  });

  it('blank WS_HIGH_WATER_BYTES is unpublished', async () => {
    const parsed = await loadWith({ WS_HIGH_WATER_BYTES: '' });
    expect(parsed.WS_HIGH_WATER_BYTES).toBeUndefined();
  });

  it('whitespace WS_HIGH_WATER_BYTES is unpublished', async () => {
    const parsed = await loadWith({ WS_HIGH_WATER_BYTES: '   ' });
    expect(parsed.WS_HIGH_WATER_BYTES).toBeUndefined();
  });

  it('4095 WS_HIGH_WATER_BYTES refuses (min is 4096, not a silent skip)', async () => {
    await expect(loadWith({ WS_HIGH_WATER_BYTES: '4095' })).rejects.toThrow(/WS_HIGH_WATER_BYTES/);
  });

  it('explicit owner pin 1048576 is accepted (not invented)', async () => {
    const parsed = await loadWith({ WS_HIGH_WATER_BYTES: '1048576' });
    expect(parsed.WS_HIGH_WATER_BYTES).toBe(1_048_576);
  });
});

describe('isPublishedHighWaterBytes pin', () => {
  it('unset / NaN / 0 refuse by name — never invent 1048576; 1048576 is a published bound', () => {
    expect(isPublishedHighWaterBytes(undefined)).toBe(false);
    expect(isPublishedHighWaterBytes(Number.NaN)).toBe(false);
    expect(isPublishedHighWaterBytes(0)).toBe(false);
    expect(isPublishedHighWaterBytes(1_048_576)).toBe(true);
  });
});
