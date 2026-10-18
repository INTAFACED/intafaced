import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MUX_IDLE_UNSET, requireMuxIdleMs, resolveMuxIdleMs } from './idle.js';

const HERE = dirname(fileURLToPath(import.meta.url));

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
  const indexTs = readFileSync(join(HERE, '../index.ts'), 'utf8');
  const envTs = readFileSync(join(HERE, '../env.ts'), 'utf8');

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('startup does not borrow the heartbeat as an idle timeout', () => {
    expect(indexTs).toMatch(/resolveMuxIdleMs\(env\.WS_MUX_IDLE_MS,\s*undefined\)/);
    expect(indexTs).not.toMatch(/resolveMuxIdleMs\(env\.WS_MUX_IDLE_MS,\s*env\.WS_HEARTBEAT_MS\)/);
    expect(envTs).not.toMatch(/WS_MUX_IDLE_MS:[\s\S]{0,400}\.default\(/);
    expect(envTs).not.toMatch(/WS_MUX_MAX_SEATS:[\s\S]{0,400}\.default\(/);
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
