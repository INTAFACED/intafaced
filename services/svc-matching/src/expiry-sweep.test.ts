import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine/engine.js';
// The process installs this wrapper on MatchingEngine.cancel at boot (index.ts); the sweep must pass through it.
import { installIfmCrash } from './engine/ifm-crash.js';

installIfmCrash();
import { MemoryJournal } from './engine/journal.js';
import { startExpirySweep } from './expiry-sweep.js';

const MARKET = 'BTC/USDT';
const GTD = '88888888-8888-4888-8888-888888888888';

function build(clock: () => Date) {
  const journal = new MemoryJournal();
  const bus = new MemoryEventBus('svc-matching');
  const engine = new MatchingEngine({ journal, bus, snapshotEvery: 0, clock });
  return { journal, bus, engine };
}

async function restGtd(engine: MatchingEngine): Promise<void> {
  const rested = await engine.submit(MARKET, {
    orderId: GTD,
    accountId: 'desk',
    type: 'limit',
    side: 'buy',
    qty: parseAmount('0.001'),
    price: parseAmount('100'),
    stopPrice: null,
    tif: 'GTD',
    expireAt: '2026-11-07T16:03:00.000Z',
  });
  expect(rested.accepted).toBe(true);
}

describe('the expiry sweep runs on its own timer (J-cex-spot-03 #7)', () => {
  it('expires a due GTD rest in a quiet market, with no later order, and publishes the cancel with reason expired', async () => {
    let now = new Date('2026-11-07T16:01:30.000Z');
    const { engine, bus, journal } = build(() => now);
    await restGtd(engine);
    const sweep = startExpirySweep({ engine, everyMs: 5 });
    try {
      // Not due yet: the timer runs and the order stays.
      await new Promise((r) => setTimeout(r, 30));
      expect(engine.book(MARKET).toState().bids[0]!.orders[0]!.orderId).toBe(GTD);
      expect(bus.emitted('orderCancelled')).toEqual([]);

      now = new Date('2026-11-07T16:03:00.000Z');
      await expect.poll(() => engine.book(MARKET).toState().bids, { timeout: 2000, interval: 5 }).toEqual([]);
      const cancelled = bus.emitted('orderCancelled').map((e) => [e.payload.orderId, e.payload.reason]);
      expect(cancelled).toEqual([[GTD, 'expired']]);
      expect(
        journal
          .read()
          .filter((e) => e.kind === 'cancel')
          .map((e) => (e as { reason?: string }).reason),
      ).toEqual(['expired']);
    } finally {
      sweep.stop();
    }
  });

  it('expires once: later ticks find nothing more to cancel', async () => {
    let now = new Date('2026-11-07T16:01:30.000Z');
    const { engine, bus } = build(() => now);
    await restGtd(engine);
    const sweep = startExpirySweep({ engine, everyMs: 60_000 });
    try {
      now = new Date('2026-11-07T16:04:00.000Z');
      await sweep.tick();
      await sweep.tick();
      await sweep.tick();
      expect(bus.emitted('orderCancelled')).toHaveLength(1);
    } finally {
      sweep.stop();
    }
  });

  it('does not sweep a disabled engine, so nothing is journalled while it drains', async () => {
    let now = new Date('2026-11-07T16:01:30.000Z');
    const { engine, journal } = build(() => now);
    await restGtd(engine);
    engine.setEnabled(false);
    const before = journal.length;
    const sweep = startExpirySweep({ engine, everyMs: 60_000 });
    try {
      now = new Date('2026-11-07T16:04:00.000Z');
      await sweep.tick();
      expect(journal.length).toBe(before);
      expect(engine.book(MARKET).toState().bids[0]!.orders[0]!.orderId).toBe(GTD);
    } finally {
      sweep.stop();
    }
  });

  it('reports a failed pass and keeps running the next one', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const engine = {
      isEnabled: true,
      sweepExpiry: async () => {
        calls += 1;
        if (calls === 1) throw new Error('journal write failed');
        return { accepted: true, cancelled: [], misses: [] };
      },
    };
    const sweep = startExpirySweep({ engine, everyMs: 60_000, onError: (err) => errors.push(err) });
    try {
      await sweep.tick();
      await sweep.tick();
      expect(calls).toBe(2);
      expect(errors).toHaveLength(1);
    } finally {
      sweep.stop();
    }
  });
});
