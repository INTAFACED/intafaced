/**
 * Unit card — compose stack passes TRADE_SPOT_ENABLED into svc-trade
 *
 * 1. Promise: host `.env` can halt new spot places (OFF stops new orders,
 *    cancels still work); unset, env.ts follows the custody switch (OWNER 288).
 * 2. Break: compose named slippage/convert/algo/futures/mm/otc/copy/options/
 *    candle/reconcile but not TRADE_SPOT_ENABLED → host kill is a no-op and
 *    the container keeps the schema default forever.
 * 3. Done bar: docker-compose.apps.yml svc-trade has
 *    TRADE_SPOT_ENABLED: ${TRADE_SPOT_ENABLED:-false} and the custody switch,
 *    so our own book runs only where the host turns custody on too.
 * 4. Class N/P
 * 5. Paths: docker-compose.apps.yml (svc-trade block only)
 * 6. RED: pin fails if the key drops, is duplicated, or defaults true
 * 7. Collision: this pin does not restamp slippage, convert, algo, futures,
 *    MM seed, OTC, copy, options, candle, or reconcile.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tradeEnvOf } from './__tests__/entry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const SPOT = 'TRADE_SPOT_ENABLED';

function tradeComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const start = compose.indexOf('\n  svc-trade:');
  expect(start, 'svc-trade service missing from docker-compose.apps.yml').toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n  svc-[a-z]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

describe('compose passes spot kill-switch into svc-trade', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = tradeComposeBlock();

  it('env.ts leaves an unset TRADE_SPOT_ENABLED to the custody switch (no default of its own)', () => {
    // Unset: our own book follows the custodial layer, off by default.
    expect(tradeEnvOf().TRADE_SPOT_ENABLED).toBe(false);
    expect(tradeEnvOf({ LEDGER_CUSTODY_LAYER: 'off' }).TRADE_SPOT_ENABLED).toBe(false);
    expect(tradeEnvOf({ LEDGER_CUSTODY_LAYER: 'on' }).TRADE_SPOT_ENABLED).toBe(true);
    // Set: the operator's word, but never our book on with the custodial layer off.
    expect(tradeEnvOf({ TRADE_SPOT_ENABLED: 'false', LEDGER_CUSTODY_LAYER: 'on' }).TRADE_SPOT_ENABLED).toBe(false);
    expect(tradeEnvOf({ TRADE_SPOT_ENABLED: 'true', LEDGER_CUSTODY_LAYER: 'on' }).TRADE_SPOT_ENABLED).toBe(true);
    expect(() => tradeEnvOf({ TRADE_SPOT_ENABLED: 'true', LEDGER_CUSTODY_LAYER: 'off' })).toThrow(/LEDGER_CUSTODY_LAYER is off/);
    expect(() => tradeEnvOf({ TRADE_SPOT_ENABLED: 'true' })).toThrow(/LEDGER_CUSTODY_LAYER is off/);
  });

  it('compose svc-trade block passes the kill from the host with default false, and the custody switch default off', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-trade/);
    expect(block, `${SPOT} missing false-default pass-through`).toMatch(new RegExp(`${SPOT}:\\s*\\$\\{${SPOT}:-false\\}`));
    expect(block).not.toMatch(new RegExp(`${SPOT}:\\s*\\$\\{${SPOT}:-true\\}`));
    expect(block).toMatch(/LEDGER_CUSTODY_LAYER:\s*\$\{LEDGER_CUSTODY_LAYER:-off\}/);
  });

  it('names TRADE_SPOT_ENABLED once in compose (no duplicate assignments)', () => {
    expect(countAssignments(compose, SPOT), `${SPOT} must appear once`).toBe(1);
    expect(countAssignments(block, SPOT), `${SPOT} must appear once on svc-trade`).toBe(1);
  });
});
