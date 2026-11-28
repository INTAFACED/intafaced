/**
 * Unit card — ws L2 top-N window is owner-published; blank refuses
 *
 * 1. Promise: WS_DEPTH_LIMIT from host `.env` reaches the container. Unset /
 *    blank do not become 50. Attach refuses ws.depth_limit_unset. Never
 *    invent a window.
 * 2. Break: compose `:-50` or env.ts `.default(50)` looks published when the
 *    operator never set the product window.
 * 3. Done bar: docker-compose.apps.yml svc-ws has
 *    WS_DEPTH_LIMIT: ${WS_DEPTH_LIMIT:-}
 *    env.ts preprocess blank → undefined, union undefined | int min 1 max 500,
 *    no `.default(50)`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-ws block only), env.ts,
 *    depth-limit.ts, hub attach
 * 6. RED: pin fails if window default is 50, compose bakes 50, or sibling
 *    ws keys are restamped
 * 7. Collision: HEARTBEAT / HIGH_WATER / LAG / GATEWAY / POLL /
 *    MARKETS_REFRESH / MAX_CONNECTIONS / TRADE_URL / JWT / SBE — this pin
 *    does not restamp them. WS_POLL_INTERVAL_MS stays 250. Nginx /ws is
 *    not recut.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPublishedDepthLimit, WS_DEPTH_LIMIT_UNSET } from './depth-limit.js';

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

const DEPTH = /^\s+WS_DEPTH_LIMIT:\s*\$\{WS_DEPTH_LIMIT:-\}\s*$/gm;

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('WS_DEPTH_LIMIT', undefined);
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compose WS_DEPTH_LIMIT for svc-ws', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = wsComposeBlock();

  it('the env loader refuses blank window — no 50 default; poll stays 250', async () => {
    const unset = await loadWith({ WS_DEPTH_LIMIT: undefined, WS_POLL_INTERVAL_MS: undefined });
    expect(unset.WS_DEPTH_LIMIT).toBeUndefined();
    expect(unset.WS_POLL_INTERVAL_MS).toBe(250);
    expect((await loadWith({ WS_DEPTH_LIMIT: '1' })).WS_DEPTH_LIMIT).toBe(1);
    await expect(loadWith({ WS_DEPTH_LIMIT: '0' })).rejects.toThrow(/WS_DEPTH_LIMIT/);
    expect((await loadWith({ WS_DEPTH_LIMIT: '500' })).WS_DEPTH_LIMIT).toBe(500);
    await expect(loadWith({ WS_DEPTH_LIMIT: '501' })).rejects.toThrow(/WS_DEPTH_LIMIT/);
    await expect(loadWith({ WS_DEPTH_LIMIT: '1.5' })).rejects.toThrow(/WS_DEPTH_LIMIT/);
    expect((await loadWith({ WS_POLL_INTERVAL_MS: '50' })).WS_POLL_INTERVAL_MS).toBe(50);
    expect((await loadWith({ WS_POLL_INTERVAL_MS: '60000' })).WS_POLL_INTERVAL_MS).toBe(60_000);
    await expect(loadWith({ WS_POLL_INTERVAL_MS: '49' })).rejects.toThrow(/WS_POLL_INTERVAL_MS/);
    await expect(loadWith({ WS_POLL_INTERVAL_MS: '60001' })).rejects.toThrow(/WS_POLL_INTERVAL_MS/);
  });

  it('compose svc-ws block is the unique home; window is empty pass-through', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-ws/);
    expect(block.match(DEPTH)).toHaveLength(1);
    expect(block).not.toMatch(/WS_DEPTH_LIMIT:\s*\$\{WS_DEPTH_LIMIT:-50\}/);
    expect(countAssignments(block, 'WS_DEPTH_LIMIT')).toBe(1);
    expect(compose.match(/^\s+WS_DEPTH_LIMIT:/gm) ?? []).toHaveLength(1);
  });

  it('does not restamp poll/heartbeat/gateway/max-connections/jwt or invent 50', () => {
    expect(block).toMatch(/WS_POLL_INTERVAL_MS:\s*\$\{WS_POLL_INTERVAL_MS:-250\}/);
    expect(block).toMatch(/WS_HEARTBEAT_MS:\s*\$\{WS_HEARTBEAT_MS:-30000\}/);
    expect(block).toMatch(/WS_HIGH_WATER_BYTES:\s*\$\{WS_HIGH_WATER_BYTES:-\}/);
    expect(block).toMatch(/WS_MAX_LAG_TICKS:\s*\$\{WS_MAX_LAG_TICKS:-\}/);
    expect(block).toMatch(/WS_GATEWAY_ENABLED:\s*\$\{WS_GATEWAY_ENABLED:-true\}/);
    expect(block).toMatch(/WS_MAX_CONNECTIONS:\s*\$\{WS_MAX_CONNECTIONS:-\}/);
    expect(block).toMatch(/WS_MARKETS_REFRESH_MS:\s*\$\{WS_MARKETS_REFRESH_MS:-30000\}/);
    expect(WS_DEPTH_LIMIT_UNSET).toBe('ws.depth_limit_unset');
  });
});

describe('svc-ws WS_DEPTH_LIMIT refuse-closed', () => {
  it('unset WS_DEPTH_LIMIT is unpublished (no invent 50)', async () => {
    const parsed = await loadWith({ WS_DEPTH_LIMIT: undefined });
    expect(parsed.WS_DEPTH_LIMIT).toBeUndefined();
  });

  it('blank WS_DEPTH_LIMIT is unpublished', async () => {
    const parsed = await loadWith({ WS_DEPTH_LIMIT: '' });
    expect(parsed.WS_DEPTH_LIMIT).toBeUndefined();
  });

  it('whitespace WS_DEPTH_LIMIT is unpublished', async () => {
    const parsed = await loadWith({ WS_DEPTH_LIMIT: '   ' });
    expect(parsed.WS_DEPTH_LIMIT).toBeUndefined();
  });

  it('zero WS_DEPTH_LIMIT refuses (no invent 1 level)', async () => {
    await expect(loadWith({ WS_DEPTH_LIMIT: '0' })).rejects.toThrow(/WS_DEPTH_LIMIT/);
  });

  it('501 WS_DEPTH_LIMIT refuses (cap is 500, not a bigger product)', async () => {
    await expect(loadWith({ WS_DEPTH_LIMIT: '501' })).rejects.toThrow(/WS_DEPTH_LIMIT/);
  });

  it('explicit owner pin 50 is accepted (not invented)', async () => {
    const parsed = await loadWith({ WS_DEPTH_LIMIT: '50' });
    expect(parsed.WS_DEPTH_LIMIT).toBe(50);
  });
});

describe('isPublishedDepthLimit pin', () => {
  it('unset / NaN / 0 refuse by name — never invent 50', () => {
    expect(isPublishedDepthLimit(undefined)).toBe(false);
    expect(isPublishedDepthLimit(Number.NaN)).toBe(false);
    expect(isPublishedDepthLimit(0)).toBe(false);
    expect(isPublishedDepthLimit(50)).toBe(true);
  });
});
