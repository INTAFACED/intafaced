import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { parseAmount } from '@intafaced/ledger-client';
import { MatchingEngine } from './engine/engine.js';
// Installed the way boot installs it (index.ts): on MatchingEngine.prototype, before the replay hold check runs.
import { installIfmCrash } from './engine/ifm-crash.js';
import { MemoryJournal } from './engine/journal.js';
import { openAfterReplay } from './open-after-replay.js';
import type { ReplayHoldLookup } from './replay-hold.js';

installIfmCrash();

/**
 * The replay hold check pulls a resting order whose ledger hold is not confirmed, and keeps its market open. It knows
 * the pull worked only when the cancel comes back with reason `hold_unconfirmed`; any other answer halts the market.
 * The crash-unknown wrapper on MatchingEngine.cancel once dropped the reason, so in the running service every pull
 * also halted its market. These tests run the check through that wrapper, as the process does.
 */

const MARKET = 'BTC/USDT';
const REST = '11111111-1111-4111-8111-111111111111';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function engineOn(journal: MemoryJournal): MatchingEngine {
  let tick = 0;
  return new MatchingEngine({
    journal,
    bus: new MemoryEventBus('svc-matching'),
    clock: () => new Date(Date.UTC(2026, 10, 7) + ++tick * 1000),
    snapshotEvery: 0,
    startupSleep: async () => undefined,
  });
}

async function bootWithRestingBuy(holds: ReplayHoldLookup) {
  const journal = new MemoryJournal();
  const writer = engineOn(journal);
  await writer.submit(MARKET, {
    orderId: REST,
    accountId: USER,
    type: 'limit',
    side: 'buy',
    qty: parseAmount('1'),
    price: parseAmount('100'),
    stopPrice: null,
    tif: 'GTC',
  });
  writer.finishStartupAnnounce();
  const engine = engineOn(journal);
  const result = await openAfterReplay({ engine, holds, listen: async () => undefined });
  return { engine, result };
}

describe('the replay hold check through the boot cancel wrapper', () => {
  it('pulls a resting order whose hold is missing, and its market stays open', async () => {
    const { engine, result } = await bootWithRestingBuy({ read: async () => null });
    expect(result.gate).toMatchObject({
      open: true,
      pulled: [{ orderId: REST, marketId: MARKET, verdict: 'missing', reason: 'hold_unconfirmed' }],
      halted: [],
    });
    expect(result.gate?.halted.map((h) => h.marketId)).not.toContain(MARKET);
    expect(engine.restingOrderCount).toBe(0);
  });

  it('pulls a resting order whose hold is short, and its market stays open', async () => {
    const { result } = await bootWithRestingBuy({ read: async () => '99' });
    expect(result.gate).toMatchObject({
      open: true,
      pulled: [{ orderId: REST, verdict: 'short', reason: 'hold_unconfirmed' }],
      halted: [],
    });
  });
});
