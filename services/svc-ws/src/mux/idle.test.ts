import { afterEach, describe, expect, it, vi } from 'vitest';
import { MUX_IDLE_UNSET, requireMuxIdleMs, resolveMuxIdleMs } from './idle.js';

describe('mux idle resolution', () => {
  it('uses a published mux idle and ignores the fallback', () => {
    expect(resolveMuxIdleMs(5_000, 15_000)).toBe(5_000);
  });

  it('blank mux idle uses a published connection idle setting', () => {
    expect(resolveMuxIdleMs(undefined, 15_000)).toBe(15_000);
  });

  it('blank mux idle with no connection idle setting stays unpublished', () => {
    expect(resolveMuxIdleMs(undefined, undefined)).toBeUndefined();
    expect(resolveMuxIdleMs(undefined, 0)).toBeUndefined();
  });

  it('requireMuxIdleMs names the startup error', () => {
    expect(() => requireMuxIdleMs(undefined)).toThrow(MUX_IDLE_UNSET);
    expect(requireMuxIdleMs(1_000)).toBe(1_000);
  });
});

describe('mux idle and seat env', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('unset seats and unset idle have no default, even with a heartbeat published', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('WS_MUX_MAX_SEATS', undefined);
    vi.stubEnv('WS_MUX_IDLE_MS', undefined);
    vi.stubEnv('WS_HEARTBEAT_MS', '30000');
    const unset = await import('../env.js');
    expect(unset.env.WS_MUX_MAX_SEATS).toBeUndefined();
    expect(unset.env.WS_MUX_IDLE_MS).toBeUndefined();
    expect(unset.env.WS_HEARTBEAT_MS).toBe(30_000);
    expect(resolveMuxIdleMs(unset.env.WS_MUX_IDLE_MS, undefined)).toBeUndefined();
  });

  it('blank seats and blank idle are unpublished, and zero is refused', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('WS_MUX_MAX_SEATS', '');
    vi.stubEnv('WS_MUX_IDLE_MS', '   ');
    const blank = await import('../env.js');
    expect(blank.env.WS_MUX_MAX_SEATS).toBeUndefined();
    expect(blank.env.WS_MUX_IDLE_MS).toBeUndefined();

    vi.resetModules();
    vi.stubEnv('WS_MUX_MAX_SEATS', '4');
    vi.stubEnv('WS_MUX_IDLE_MS', '30000');
    const set = await import('../env.js');
    expect(set.env.WS_MUX_MAX_SEATS).toBe(4);
    expect(set.env.WS_MUX_IDLE_MS).toBe(30_000);

    vi.resetModules();
    vi.stubEnv('WS_MUX_MAX_SEATS', '0');
    await expect(import('../env.js')).rejects.toThrow(/WS_MUX_MAX_SEATS/);
  });
});
