/**
 * Unit card — ws drop-copy session replay length is owner-published; blank refuses
 *
 * 1. Promise: WS_DROP_COPY_RECENT_LIMIT from host `.env` reaches the container.
 *    Unset / blank do not become 50. Attach refuses ws.drop_copy_recent_limit_unset.
 *    Never invent a replay window. Not durable history.
 * 2. Break: compose `:-50` or env.ts `.default(50)` looks published when the
 *    operator never set the product window.
 * 3. Done bar: docker-compose.apps.yml svc-ws has
 *    WS_DROP_COPY_RECENT_LIMIT: ${WS_DROP_COPY_RECENT_LIMIT:-}
 *    env.ts preprocess blank → undefined, union undefined | int min 0 max 1000,
 *    no `.default(50)`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-ws block only), env.ts,
 *    drop-copy-recent-limit.ts, drop-copy hub attach
 * 6. RED: pin fails if window default is 50, compose bakes 50, or sibling
 *    ws keys are restamped
 * 7. Collision: HEARTBEAT / HIGH_WATER / LAG / GATEWAY / POLL /
 *    MARKETS_REFRESH / MAX_CONNECTIONS / DEPTH / TRADE_URL / JWT / SBE /
 *    TRADES_DURABLE / PRIVATE_ORDERS_DURABLE / TRADE_RECENT — this pin does
 *    not restamp them.
 *    WS_POLL_INTERVAL_MS stays 250. Nginx /ws is not recut.
 *    WS_TRADE_RECENT_LIMIT stays refuse-closed; this mill does not restamp it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPublishedDropCopyRecentLimit, WS_DROP_COPY_RECENT_LIMIT_UNSET } from './drop-copy-recent-limit.js';

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

const LIMIT = /^\s+WS_DROP_COPY_RECENT_LIMIT:\s*\$\{WS_DROP_COPY_RECENT_LIMIT:-\}\s*$/gm;

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('WS_DROP_COPY_RECENT_LIMIT', undefined);
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compose WS_DROP_COPY_RECENT_LIMIT for svc-ws', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = wsComposeBlock();

  it('the env loader refuses blank window — no 50 default; poll stays 250', async () => {
    const unset = await loadWith({ WS_DROP_COPY_RECENT_LIMIT: undefined, WS_POLL_INTERVAL_MS: undefined });
    expect(unset.WS_DROP_COPY_RECENT_LIMIT).toBeUndefined();
    expect(unset.WS_POLL_INTERVAL_MS).toBe(250);
    expect((await loadWith({ WS_DROP_COPY_RECENT_LIMIT: '0' })).WS_DROP_COPY_RECENT_LIMIT).toBe(0);
    await expect(loadWith({ WS_DROP_COPY_RECENT_LIMIT: '-1' })).rejects.toThrow(/WS_DROP_COPY_RECENT_LIMIT/);
    expect((await loadWith({ WS_DROP_COPY_RECENT_LIMIT: '1000' })).WS_DROP_COPY_RECENT_LIMIT).toBe(1000);
    await expect(loadWith({ WS_DROP_COPY_RECENT_LIMIT: '1001' })).rejects.toThrow(/WS_DROP_COPY_RECENT_LIMIT/);
    await expect(loadWith({ WS_DROP_COPY_RECENT_LIMIT: '0.5' })).rejects.toThrow(/WS_DROP_COPY_RECENT_LIMIT/);
    expect((await loadWith({ WS_POLL_INTERVAL_MS: '50' })).WS_POLL_INTERVAL_MS).toBe(50);
    expect((await loadWith({ WS_POLL_INTERVAL_MS: '60000' })).WS_POLL_INTERVAL_MS).toBe(60_000);
    await expect(loadWith({ WS_POLL_INTERVAL_MS: '49' })).rejects.toThrow(/WS_POLL_INTERVAL_MS/);
    await expect(loadWith({ WS_POLL_INTERVAL_MS: '60001' })).rejects.toThrow(/WS_POLL_INTERVAL_MS/);
  });

  it('compose svc-ws block is the unique home; window is empty pass-through', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-ws/);
    expect(block.match(LIMIT)).toHaveLength(1);
    expect(block).not.toMatch(/WS_DROP_COPY_RECENT_LIMIT:\s*\$\{WS_DROP_COPY_RECENT_LIMIT:-50\}/);
    expect(countAssignments(block, 'WS_DROP_COPY_RECENT_LIMIT')).toBe(1);
    expect(compose.match(/^\s+WS_DROP_COPY_RECENT_LIMIT:/gm) ?? []).toHaveLength(1);
  });

  it('does not restamp poll/heartbeat/gateway/max-connections/depth/jwt/trade-recent or invent 50', () => {
    expect(block).toMatch(/WS_POLL_INTERVAL_MS:\s*\$\{WS_POLL_INTERVAL_MS:-250\}/);
    expect(block).toMatch(/WS_HEARTBEAT_MS:\s*\$\{WS_HEARTBEAT_MS:-30000\}/);
    expect(block).toMatch(/WS_HIGH_WATER_BYTES:\s*\$\{WS_HIGH_WATER_BYTES:-\}/);
    expect(block).toMatch(/WS_MAX_LAG_TICKS:\s*\$\{WS_MAX_LAG_TICKS:-\}/);
    expect(block).toMatch(/WS_GATEWAY_ENABLED:\s*\$\{WS_GATEWAY_ENABLED:-true\}/);
    expect(block).toMatch(/WS_MAX_CONNECTIONS:\s*\$\{WS_MAX_CONNECTIONS:-\}/);
    expect(block).toMatch(/WS_DEPTH_LIMIT:\s*\$\{WS_DEPTH_LIMIT:-\}/);
    expect(block).toMatch(/WS_TRADE_RECENT_LIMIT:\s*\$\{WS_TRADE_RECENT_LIMIT:-\}/);
    expect(block).toMatch(/WS_MARKETS_REFRESH_MS:\s*\$\{WS_MARKETS_REFRESH_MS:-30000\}/);
    expect(block).toMatch(/WS_TRADES_DURABLE:\s*\$\{WS_TRADES_DURABLE:-ws-trade-tape\}/);
    expect(block).toMatch(/WS_PRIVATE_ORDERS_DURABLE:\s*\$\{WS_PRIVATE_ORDERS_DURABLE:-ws-private-orders\}/);
    expect(WS_DROP_COPY_RECENT_LIMIT_UNSET).toBe('ws.drop_copy_recent_limit_unset');
  });
});

describe('svc-ws WS_DROP_COPY_RECENT_LIMIT refuse-closed', () => {
  it('unset WS_DROP_COPY_RECENT_LIMIT is unpublished (no invent 50)', async () => {
    const parsed = await loadWith({ WS_DROP_COPY_RECENT_LIMIT: undefined });
    expect(parsed.WS_DROP_COPY_RECENT_LIMIT).toBeUndefined();
  });

  it('blank WS_DROP_COPY_RECENT_LIMIT is unpublished', async () => {
    const parsed = await loadWith({ WS_DROP_COPY_RECENT_LIMIT: '' });
    expect(parsed.WS_DROP_COPY_RECENT_LIMIT).toBeUndefined();
  });

  it('whitespace WS_DROP_COPY_RECENT_LIMIT is unpublished', async () => {
    const parsed = await loadWith({ WS_DROP_COPY_RECENT_LIMIT: '   ' });
    expect(parsed.WS_DROP_COPY_RECENT_LIMIT).toBeUndefined();
  });

  it('1001 WS_DROP_COPY_RECENT_LIMIT refuses (cap is 1000, not a bigger product)', async () => {
    await expect(loadWith({ WS_DROP_COPY_RECENT_LIMIT: '1001' })).rejects.toThrow(/WS_DROP_COPY_RECENT_LIMIT/);
  });

  it('explicit owner pin 50 is accepted (not invented)', async () => {
    const parsed = await loadWith({ WS_DROP_COPY_RECENT_LIMIT: '50' });
    expect(parsed.WS_DROP_COPY_RECENT_LIMIT).toBe(50);
  });

  it('explicit owner pin 0 is accepted (no replay, not unpublished)', async () => {
    const parsed = await loadWith({ WS_DROP_COPY_RECENT_LIMIT: '0' });
    expect(parsed.WS_DROP_COPY_RECENT_LIMIT).toBe(0);
  });
});

describe('isPublishedDropCopyRecentLimit pin', () => {
  it('unset / NaN / 1001 refuse by name — never invent 50; 0 is a published empty ring', () => {
    expect(isPublishedDropCopyRecentLimit(undefined)).toBe(false);
    expect(isPublishedDropCopyRecentLimit(Number.NaN)).toBe(false);
    expect(isPublishedDropCopyRecentLimit(1001)).toBe(false);
    expect(isPublishedDropCopyRecentLimit(0)).toBe(true);
    expect(isPublishedDropCopyRecentLimit(50)).toBe(true);
  });
});
