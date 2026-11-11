/**
 * Our own order book follows the custody switch (project-state OWNER.md item 288; docs/adr/2026-11-10-launch-money-model.md).
 *
 * Our own matching settles every fill through `tradeFill`, which moves customer balances and svc-ledger refuses with
 * the custodial layer off. So TRADE_SPOT_ENABLED, unset, is on only with LEDGER_CUSTODY_LAYER on, and set on with
 * custody off refuses boot. The kill switch (explicitly off) always loads.
 */
import { loadEnv } from '@intafaced/config';
import { describe, expect, it } from 'vitest';
import { tradeEnvSchema } from './env.js';

function load(overrides: Record<string, string | boolean | undefined>) {
  const source: Record<string, unknown> = { ...process.env };
  delete source.TRADE_SPOT_ENABLED;
  delete source.LEDGER_CUSTODY_LAYER;
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) source[key] = value;
  return loadEnv(tradeEnvSchema, source);
}

describe('TRADE_SPOT_ENABLED follows the custody switch', () => {
  it('unset: our own book is off with custody off or unset, on with custody on', () => {
    expect(load({}).TRADE_SPOT_ENABLED).toBe(false);
    expect(load({ LEDGER_CUSTODY_LAYER: 'off' }).TRADE_SPOT_ENABLED).toBe(false);
    expect(load({ LEDGER_CUSTODY_LAYER: '' }).TRADE_SPOT_ENABLED).toBe(false);
    expect(load({ LEDGER_CUSTODY_LAYER: 'on' }).TRADE_SPOT_ENABLED).toBe(true);
  });

  it('refuses boot when spot is set on with custody off', () => {
    for (const asked of ['true', 'on', '1', true] as const) {
      expect(() => load({ TRADE_SPOT_ENABLED: asked }), String(asked)).toThrow(/TRADE_SPOT_ENABLED is on but LEDGER_CUSTODY_LAYER is off/);
      expect(() => load({ TRADE_SPOT_ENABLED: asked, LEDGER_CUSTODY_LAYER: 'off' }), String(asked)).toThrow(
        /TRADE_SPOT_ENABLED is on but LEDGER_CUSTODY_LAYER is off/,
      );
    }
  });

  it('keeps the kill switch: off loads with either custody value, on loads with custody on', () => {
    for (const custody of ['off', 'on'] as const) {
      for (const asked of ['false', 'off', '0', 'no', false] as const) {
        expect(load({ TRADE_SPOT_ENABLED: asked, LEDGER_CUSTODY_LAYER: custody }).TRADE_SPOT_ENABLED).toBe(false);
      }
    }
    expect(load({ TRADE_SPOT_ENABLED: 'true', LEDGER_CUSTODY_LAYER: 'on' }).TRADE_SPOT_ENABLED).toBe(true);
  });

  it('refuses boot on a custody value that is neither on nor off', () => {
    expect(() => load({ LEDGER_CUSTODY_LAYER: 'true' })).toThrow(/LEDGER_CUSTODY_LAYER must be "on" or "off"/);
  });
});
