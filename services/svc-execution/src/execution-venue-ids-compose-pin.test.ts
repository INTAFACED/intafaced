/**
 * Unit card — compose stack does not invent public venue ids for svc-execution
 *
 * 1. Promise: host `.env` EXECUTION_VENUE_IDS reaches the container. Unset /
 *    blank stay unpublished (env.ts already defaults ''). Never invent
 *    binance-spot,bybit-spot,okx-spot.
 * 2. Break: compose `:-binance-spot,bybit-spot,okx-spot` publishes three
 *    public venues as wired when the operator never set the list.
 * 3. Done bar: docker-compose.apps.yml svc-execution has
 *    EXECUTION_VENUE_IDS: ${EXECUTION_VENUE_IDS:-}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-execution block only)
 * 6. RED: pin fails if compose bakes :-binance-spot or env.ts default is
 *    a venue list
 * 7. Collision: TRADE_URL / EMS store / VENUE_AGGREGATION_* / letter→bps /
 *    spread-skew / arb age — this pin does not restamp them. /ready
 *    constructed≠wired is not recut.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadExecutionEnv } from './testing/boot.js';
import { executionComposeBlock } from './execution-compose-wiring.js';
import { parseExecutionVenueIds } from './venue-adapters.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const KEY = 'EXECUTION_VENUE_IDS';
const EMPTY = /^\s+EXECUTION_VENUE_IDS:\s*\$\{EXECUTION_VENUE_IDS:-\}\s*$/gm;

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

describe('compose EXECUTION_VENUE_IDS for svc-execution', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = executionComposeBlock();

  it('env.ts still defaults empty — no invented venue list', async () => {
    const unset = await loadExecutionEnv({ EXECUTION_VENUE_IDS: undefined });
    expect(unset.EXECUTION_VENUE_IDS).toBe('');
    expect(parseExecutionVenueIds(unset.EXECUTION_VENUE_IDS)).toEqual([]);
    expect((await loadExecutionEnv({ EXECUTION_VENUE_IDS: 'okx-spot' })).EXECUTION_VENUE_IDS).toBe('okx-spot');
  });

  it('compose svc-execution block is the unique home; empty pass-through', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-execution/);
    expect(block.match(EMPTY)).toHaveLength(1);
    expect(block).not.toContain(':-binance-spot');
    expect(countAssignments(block, KEY)).toBe(1);
    expect(compose.match(/^\s+EXECUTION_VENUE_IDS:/gm) ?? []).toHaveLength(1);
  });

  it('does not restamp TRADE_URL, EMS store, operator creds, or letter→bps', () => {
    expect(block).toMatch(/TRADE_URL:\s*http:\/\/svc-trade:4004/);
    expect(block).toMatch(/EXECUTION_EMS_STORE_PATH:\s*\$\{EXECUTION_EMS_STORE_PATH:-\/data\/execution\/ems-journal\.jsonl\}/);
    expect(block).toMatch(/VENUE_AGGREGATION_BINANCE_SPOT_API_KEY:\s*\$\{VENUE_AGGREGATION_BINANCE_SPOT_API_KEY:-\}/);
    expect(block).toMatch(/EXECUTION_SOR_LETTER_BPS_SCHEDULE:\s*\$\{EXECUTION_SOR_LETTER_BPS_SCHEDULE:-\}/);
    expect(block).toMatch(/EXECUTION_MM_SPREAD_SKEW_BANDS:\s*\$\{EXECUTION_MM_SPREAD_SKEW_BANDS:-\}/);
    expect(block).toMatch(/EXECUTION_ARB_MAX_QUOTE_AGE_MS:\s*\$\{EXECUTION_ARB_MAX_QUOTE_AGE_MS:-\}/);
  });
});
