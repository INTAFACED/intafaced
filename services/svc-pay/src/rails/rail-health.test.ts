import { parseAmount } from '@intafaced/ledger-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeFailure } from '../merchant-failure.js';
import { railHealthRows } from '../metrics/runtime.js';
import { CardSandboxAdapter } from './card-sandbox.js';
import { MemoryChain } from './chain-port.js';
import { CryptoNativeAdapter } from './crypto-native.js';
import { nextProbeDelayMs, RailHealthProbeLoop } from './rail-health-probe.js';
import { RailRegistry } from './registry.js';
import { isUsable, RAIL_HEALTH_STALE, RAIL_MARKED_DOWN, RAIL_PROBE_FAILED, RAIL_RPC_UNSET, RAIL_SANDBOX_ONLY } from './rail-adapter.js';

const SECRET = 'rail-health-secret-at-least-32-characters';

const cardIntent = {
  paymentId: 'p-rail-health',
  merchantId: 'm-1',
  amount: parseAmount('10'),
  assetId: 'USDT',
  method: 'card',
};

describe('rail health agrees with usability', () => {
  it('a stale rail is not usable and names rail.health_stale with the age', async () => {
    let t = 1_000;
    const now = () => new Date(t);
    const card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300, now });
    t += 31_000;

    const health = card.health();
    expect(health.healthy).toBe(false);
    expect(health.reason).toContain(RAIL_HEALTH_STALE);
    expect(health.reason).toContain('ageMs=31000');
    expect(isUsable(card, now())).toBe(health.healthy);

    const refused = await card.authorize(cardIntent);
    expect(refused.ok).toBe(false);
    expect(refused.failureCode).toBe(RAIL_HEALTH_STALE);
    expect(refused.failureReason).toContain('ageMs=31000');
    expect(isUsable(card, now())).toBe(false);
    expect(safeFailure(refused.failureCode)?.code).toBe(RAIL_HEALTH_STALE);
  });

  it('a fresh probe makes the same rail usable', async () => {
    let t = 1_000;
    const now = () => new Date(t);
    const card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300, now });
    t += 31_000;
    expect(isUsable(card, now())).toBe(false);

    const probed = await card.probe();
    expect(probed.ok).toBe(true);
    const health = card.health();
    expect(health.healthy).toBe(true);
    expect(health.reason).toBe(RAIL_SANDBOX_ONLY);
    expect(isUsable(card, now())).toBe(true);

    const accepted = await card.authorize(cardIntent);
    expect(accepted.ok).toBe(true);
  });

  it('crypto-native without an RPC in dev carries rail.rpc_unset and stays usable while fresh', () => {
    const crypto = new CryptoNativeAdapter({
      chain: new MemoryChain(),
      secret: SECRET,
      minConfirmations: 1,
      toleranceSeconds: 300,
    });
    expect(crypto.mode).toBe('sandbox');
    const health = crypto.health();
    expect(health.healthy).toBe(true);
    expect(health.reason).toBe(RAIL_RPC_UNSET);
    expect(isUsable(crypto)).toBe(true);
  });

  it('a failed probe is not usable and refuses the payment with rail.probe_failed', async () => {
    class DeadPing extends MemoryChain {
      override async ping(): Promise<void> {
        throw new Error('rpc down');
      }
    }
    const crypto = new CryptoNativeAdapter({
      chain: new DeadPing(),
      secret: SECRET,
      minConfirmations: 1,
      toleranceSeconds: 300,
    });
    expect((await crypto.probe()).ok).toBe(false);
    expect(crypto.health().healthy).toBe(false);
    expect(crypto.health().reason).toBe(RAIL_PROBE_FAILED);
    expect(isUsable(crypto)).toBe(false);
    const refused = await crypto.authorize({ ...cardIntent, method: 'crypto', paymentId: 'p-probe' });
    expect(refused.ok).toBe(false);
    expect(refused.failureCode).toBe(RAIL_PROBE_FAILED);
  });

  it('a marked-down rail refuses instead of taking the payment', async () => {
    const card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
    card.setHealthy(false);
    expect(card.health().reason).toBe(RAIL_MARKED_DOWN);
    expect(isUsable(card)).toBe(false);
    const refused = await card.authorize(cardIntent);
    expect(refused.failureCode).toBe(RAIL_MARKED_DOWN);
  });

  it('projects the reason onto founder metrics, including a stale rail', () => {
    let t = 1_000;
    const now = () => new Date(t);
    const card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300, now });
    const crypto = new CryptoNativeAdapter({
      chain: new MemoryChain(),
      secret: SECRET,
      minConfirmations: 1,
      toleranceSeconds: 300,
      now,
    });
    const rails = new RailRegistry([card, crypto]);
    const fresh = railHealthRows({ health: () => rails.health(now()) });
    expect(fresh.find((row) => row.railId === 'crypto-native')).toMatchObject({ ok: true, detail: RAIL_RPC_UNSET });
    expect(fresh.find((row) => row.railId === 'card-sandbox')).toMatchObject({ ok: true, detail: RAIL_SANDBOX_ONLY });

    t += 31_000;
    const stale = railHealthRows({ health: () => rails.health(now()) });
    const cardRow = stale.find((row) => row.railId === 'card-sandbox');
    expect(cardRow?.ok).toBe(false);
    expect(cardRow?.detail).toContain(RAIL_HEALTH_STALE);
    expect(cardRow?.detail).not.toBeNull();
    const cryptoRow = stale.find((row) => row.railId === 'crypto-native');
    expect(cryptoRow?.ok).toBe(false);
    expect(cryptoRow?.detail).toContain(RAIL_HEALTH_STALE);
  });
});

describe('rail probe loop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('doubles the delay after a failure, caps it, and resets after a success', () => {
    expect(nextProbeDelayMs(10_000, true, 10_000, 60_000)).toBe(10_000);
    expect(nextProbeDelayMs(10_000, false, 10_000, 60_000)).toBe(20_000);
    expect(nextProbeDelayMs(40_000, false, 10_000, 60_000)).toBe(60_000);
    expect(nextProbeDelayMs(60_000, false, 10_000, 60_000)).toBe(60_000);
  });

  it('probes immediately, backs off, and stops', async () => {
    vi.useFakeTimers();
    let ok = false;
    let calls = 0;
    const loop = new RailHealthProbeLoop([{ id: 'card-sandbox', probe: async () => ((calls += 1), { ok }) }], {
      intervalMs: 10_000,
      maxIntervalMs: 60_000,
    });
    await loop.start();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(2);
    ok = true;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(4);
    loop.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(4);
  });
});
