import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { MemoryEventBus } from '@intafaced/events';
import { installCodFence } from './cod-fence.js';
import { MatchingEngine } from './engine.js';
import { MemoryJournal } from './journal.js';
import { replayHaltedSince } from './halt.js';
import { replayVenueHaltedSince } from './venue-kill.js';
import { registerRoutes } from '../router.js';

installCodFence();

/** When a halt began: the journaled time of its first halt since the last resume, kept across replay and served on the
 * public market list, so a reader can say "halted since" instead of "time unknown". */

const MARKET = 'BTC/USDT';
const OTHER = 'ETH/USDT';
const OPS = { operatorId: 'ops-1', confirmOperatorId: 'ops-2' };

function build() {
  let now = new Date('2026-10-30T10:00:00.000Z');
  const journal = new MemoryJournal();
  const engine = new MatchingEngine({ journal, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0, clock: () => now });
  return { journal, engine, at: (iso: string) => (now = new Date(iso)) };
}

describe('when a halt began', () => {
  it('a market halt records its start; a repeat halt keeps the first; a resume clears it', async () => {
    const { engine, at } = build();
    expect(engine.haltedSinceOf(MARKET)).toBeNull();
    await engine.halt(MARKET, OPS);
    expect(engine.haltedSinceOf(MARKET)).toBe('2026-10-30T10:00:00.000Z');
    at('2026-10-30T10:05:00.000Z');
    await engine.halt(MARKET, OPS);
    expect(engine.haltedSinceOf(MARKET)).toBe('2026-10-30T10:00:00.000Z');
    expect(engine.haltedSinceOf(OTHER)).toBeNull();
    await engine.resume(MARKET, OPS);
    expect(engine.haltedSinceOf(MARKET)).toBeNull();
    at('2026-10-30T11:00:00.000Z');
    await engine.halt(MARKET, OPS);
    expect(engine.haltedSinceOf(MARKET)).toBe('2026-10-30T11:00:00.000Z');
  });

  it('a refused halt (no second operator) records no start', async () => {
    const { engine } = build();
    const refused = await engine.halt(MARKET, { operatorId: 'ops-1' });
    expect(refused.accepted).toBe(false);
    expect(engine.haltedSinceOf(MARKET)).toBeNull();
  });

  it('the venue halt records its start the same way', async () => {
    const { engine, at } = build();
    expect(engine.venueHaltedSince).toBeNull();
    await engine.haltAll(OPS);
    at('2026-10-30T10:07:00.000Z');
    await engine.haltAll(OPS);
    expect(engine.venueHaltedSince).toBe('2026-10-30T10:00:00.000Z');
    await engine.resumeAll(OPS);
    expect(engine.venueHaltedSince).toBeNull();
  });

  it('a recovered engine keeps each start from the journal', async () => {
    const { journal, engine, at } = build();
    await engine.halt(MARKET, OPS);
    at('2026-10-30T10:03:00.000Z');
    await engine.halt(OTHER, OPS);
    await engine.haltAll(OPS);
    at('2026-10-30T10:04:00.000Z');
    await engine.resume(OTHER, OPS);
    const recovered = new MatchingEngine({ journal, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
    recovered.recover();
    expect(recovered.haltedSinceOf(MARKET)).toBe('2026-10-30T10:00:00.000Z');
    expect(recovered.haltedSinceOf(OTHER)).toBeNull();
    expect(recovered.venueHaltedSince).toBe('2026-10-30T10:03:00.000Z');
    expect(Object.fromEntries(replayHaltedSince(journal.read()))).toEqual({ [MARKET]: '2026-10-30T10:00:00.000Z' });
    expect(replayVenueHaltedSince(journal.read())).toBe('2026-10-30T10:03:00.000Z');
  });

  it('the public market list serves each halted market’s start and the venue’s', async () => {
    const { engine } = build();
    await engine.submit(MARKET, {
      orderId: '11111111-1111-4111-8111-111111111111',
      accountId: 'desk',
      type: 'limit',
      side: 'sell',
      qty: 1n,
      price: 100n,
      stopPrice: null,
      tif: 'GTC',
    } as never);
    const app = Fastify({ logger: false });
    registerRoutes(app, engine as never, 'matching-internal-service-secret-32c', {});
    await app.ready();
    const open = (await app.inject({ method: 'GET', url: '/markets' })).json();
    expect(open).toMatchObject({ halted: [], haltedSince: {}, venueHalted: false, venueHaltedSince: null });
    await engine.halt(MARKET, OPS);
    await engine.haltAll(OPS);
    const halted = (await app.inject({ method: 'GET', url: '/markets' })).json();
    expect(halted).toMatchObject({
      halted: [MARKET],
      haltedSince: { [MARKET]: '2026-10-30T10:00:00.000Z' },
      venueHalted: true,
      venueHaltedSince: '2026-10-30T10:00:00.000Z',
    });
    await app.close();
  });
});
