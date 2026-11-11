/**
 * Unit card — MATCHING_ENGINE_ENABLED trims, then applies the kill tokens.
 *
 * 1. Promise: the kill switch refuses submissions before the journal when the
 *    parsed value is false. After trim, 0 / false / off / no disable. Blank
 *    and whitespace disable. true / yes / on / 1 enable. Boolean false
 *    disables. Boolean true enables. Unset follows the custody switch: enabled
 *    only with LEDGER_CUSTODY_LAYER on; enabled with custody off refuses boot
 *    (OWNER 288: our own book settles fills as customer money in our ledger).
 * 2. Break: the transform lowercases the raw string and checks exact
 *    membership, so 'false ', 'off ', 'no ', and '' leave the engine on.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) trims first.
 * 4. Class N
 * 5. Paths: env.ts via loadEnv at import (same as boot)
 * 6. RED: a padded or blank kill token parses enabled
 */
import { loadEnv } from '@intafaced/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SECRET = 's'.repeat(32);

/**
 * Minimum boot env. Snapshot cadence is the owner-published fixture the sibling card already uses. The token cards run
 * with custody on (the TEST stack's custodial journeys), so they test the parser and nothing else.
 */
const BASE_ENV = {
  LEDGER_CUSTODY_LAYER: 'on',
  INTERNAL_SERVICE_SECRET: SECRET,
  MATCHING_SNAPSHOT_EVERY: '500',
  MATCHING_OPERATOR_IDS: 'op-a,op-b',
};

/**
 * Load production env.ts the way the process does.
 *
 * `vi.resetModules` + an explicit clear are load-bearing: env.ts calls
 * `loadEnv(process.env)` at import, and a host shell may already export the kill.
 */
async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('MATCHING_ENGINE_ENABLED', undefined);
  vi.stubEnv('LEDGER_CUSTODY_LAYER', undefined);
  vi.stubEnv('MATCHING_SNAPSHOT_EVERY', undefined);
  vi.stubEnv('INTERNAL_SERVICE_SECRET', SECRET);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MATCHING_ENGINE_ENABLED kill switch', () => {
  it('trims kill tokens, and blank or whitespace disables the engine', async () => {
    for (const token of ['0', 'false', 'off', 'no', 'false ', 'off ', 'no ', ' 0 ', ' FALSE ', ' OFF ', ' NO ', '', '   ', '\t']) {
      const loaded = await loadWith({ MATCHING_ENGINE_ENABLED: token });
      expect(loaded.env.MATCHING_ENGINE_ENABLED, JSON.stringify(token)).toBe(false);
    }
  });

  it('with custody on, keeps an unset value enabled, and trimmed true / yes / on / 1 enable', async () => {
    const unset = await loadWith({});
    expect(unset.env.MATCHING_ENGINE_ENABLED).toBe(true);

    for (const token of ['true', 'yes', 'on', '1', ' true ', ' yes ', ' on ', ' 1 ', 'TRUE', 'YES', 'ON']) {
      const loaded = await loadWith({ MATCHING_ENGINE_ENABLED: token });
      expect(loaded.env.MATCHING_ENGINE_ENABLED, JSON.stringify(token)).toBe(true);
    }
  });

  it('boolean false disables and boolean true enables', async () => {
    const loaded = await loadWith({});
    const off = loadEnv(loaded.matchingEnvSchema, { ...BASE_ENV, MATCHING_ENGINE_ENABLED: false });
    const on = loadEnv(loaded.matchingEnvSchema, { ...BASE_ENV, MATCHING_ENGINE_ENABLED: true });
    expect(off.MATCHING_ENGINE_ENABLED).toBe(false);
    expect(on.MATCHING_ENGINE_ENABLED).toBe(true);
  });

  it('with custody off or unset, an unset value leaves our own engine off', async () => {
    for (const custody of [undefined, '', 'off', ' OFF ']) {
      const loaded = await loadWith({ LEDGER_CUSTODY_LAYER: custody });
      expect(loaded.env.MATCHING_ENGINE_ENABLED, JSON.stringify(custody)).toBe(false);
      expect(loaded.env.LEDGER_CUSTODY_LAYER).toBe('off');
    }
  });

  it('refuses boot when the engine is set on with custody off, and lets the kill switch stay off', async () => {
    for (const token of ['true', 'on', '1']) {
      await expect(loadWith({ LEDGER_CUSTODY_LAYER: 'off', MATCHING_ENGINE_ENABLED: token }), token).rejects.toThrow(
        /MATCHING_ENGINE_ENABLED is on but LEDGER_CUSTODY_LAYER is off/,
      );
    }
    const loaded = await loadWith({});
    expect(() =>
      loadEnv(loaded.matchingEnvSchema, { ...BASE_ENV, LEDGER_CUSTODY_LAYER: undefined, MATCHING_ENGINE_ENABLED: true }),
    ).toThrow(/MATCHING_ENGINE_ENABLED is on but LEDGER_CUSTODY_LAYER is off/);
    const killed = await loadWith({ LEDGER_CUSTODY_LAYER: 'off', MATCHING_ENGINE_ENABLED: 'false' });
    expect(killed.env.MATCHING_ENGINE_ENABLED).toBe(false);
  });

  it('refuses boot on a custody value that is neither on nor off', async () => {
    await expect(loadWith({ LEDGER_CUSTODY_LAYER: 'true' })).rejects.toThrow(/LEDGER_CUSTODY_LAYER must be "on" or "off"/);
  });
});
