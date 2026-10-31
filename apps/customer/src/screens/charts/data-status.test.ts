import { describe, expect, it } from 'vitest';
import { dataStatus, feedStaleAfterMs, STATE_POLL_MS, tradeRefusal, type StatusInputs } from './data-status';

const NOW = 1_800_000_000_000;
const POLL = 10_000;
/** A good read: the value and the time it was read (the poll time, on the client clock). */
const ready = <T>(data: T, asOf = NOW) => ({ status: 'ready' as const, data, asOf });
const failed = { status: 'error' as const, retry: () => {} };
const open = ready({ state: 'OPEN', effectiveAt: NOW - 3_600_000, evidenceRefs: ['trade.lifecycle.evidence:x'] });
const liveBook = ready({ halted: false, venueHalted: false });
const owner = (dataClass: 'real_time' | 'delayed' | 'end_of_day' | null, delayedBoundarySeconds: number | null) =>
  ready({ dataClass, delayedBoundarySeconds });
const fresh = ready([], NOW - 1_000);
/** A trade stamped on the server clock: the server clock is read equal to the client clock unless a case says otherwise. */
const tradeAt = (secondsAgo: number) => ready(NOW - secondsAgo * 1000);
const sameClock = ready(0);

function inputs(over: Partial<StatusInputs> = {}): StatusInputs {
  return {
    now: NOW,
    serverClock: sameClock,
    owner: owner('real_time', 30),
    lifecycle: open,
    bookHalt: liveBook,
    candles: fresh,
    lastTrade: tradeAt(5),
    pollIntervalMs: POLL,
    ...over,
  };
}

describe('dataStatus: the chip names the real state of the data', () => {
  it('a real-time market whose newest trade is inside the boundary is live, with its age', () => {
    const s = dataStatus(inputs());
    expect(s).toMatchObject({ chip: 'live', ageSeconds: 5, orderEntry: 'open', feed: 'connected', test: false });
  });

  it('a real-time market with no trade inside the boundary is quiet, not delayed: nothing is behind', () => {
    const s = dataStatus(inputs({ lastTrade: tradeAt(95) }));
    expect(s).toMatchObject({ chip: 'quiet', ageSeconds: 95, orderEntry: 'open' });
  });

  it('the trade age is judged on the server clock: a server ahead by a minute does not make a fresh trade look old', () => {
    const serverAhead = ready(60_000);
    const trade = ready(NOW + 60_000 - 5_000);
    const s = dataStatus(inputs({ serverClock: serverAhead, lastTrade: trade }));
    expect(s).toMatchObject({ chip: 'live', ageSeconds: 5 });
  });

  it('a clock that has not been read is loading, and a failed clock read is tick unread, never a guessed age', () => {
    expect(dataStatus(inputs({ serverClock: { status: 'loading' } })).chip).toBe('loading');
    expect(dataStatus(inputs({ serverClock: failed })).chip).toBe('tick_unread');
  });

  it('a blank boundary claims neither live nor quiet: the chip names the unset threshold and keeps the age', () => {
    const s = dataStatus(inputs({ owner: owner('real_time', null), lastTrade: tradeAt(95) }));
    expect(s).toMatchObject({ chip: 'threshold_unset', ageSeconds: 95, thresholdSeconds: null });
  });

  it('a delayed class is delayed whatever the age, and end of day is its own word', () => {
    expect(dataStatus(inputs({ owner: owner('delayed', 30) })).chip).toBe('delayed');
    expect(dataStatus(inputs({ owner: owner('end_of_day', 30) })).chip).toBe('end_of_day');
  });

  it('no data class set is class not set, and no class is claimed', () => {
    expect(dataStatus(inputs({ owner: owner(null, 30) })).chip).toBe('class_unset');
  });

  it('a candle read older than two polls is stale; a failed read is down', () => {
    expect(dataStatus(inputs({ candles: { status: 'ready', data: [], asOf: NOW - feedStaleAfterMs(POLL) } })).chip).toBe('stale');
    expect(dataStatus(inputs({ candles: failed })).chip).toBe('down');
    expect(dataStatus(inputs({ candles: failed })).feed).toBe('down');
  });

  it('a halted market is halted, names its state, and refuses order entry', () => {
    const halted = ready({ state: 'HALTED', effectiveAt: NOW - 60_000, evidenceRefs: [] });
    const s = dataStatus(inputs({ lifecycle: halted }));
    expect(s).toMatchObject({ chip: 'halted', state: 'HALTED', stateSinceMs: NOW - 60_000, orderEntry: 'refused' });
  });

  it('a book halted on matching is halted even when the lifecycle reads OPEN, and refuses order entry', () => {
    const s = dataStatus(inputs({ bookHalt: ready({ halted: true, venueHalted: false }) }));
    expect(s).toMatchObject({ chip: 'halted', state: 'OPEN', orderEntry: 'refused' });
  });

  it('a book halt gives the halt time matching names, not the lifecycle opening time; none named reads unknown', () => {
    const at = NOW - 90_000;
    expect(dataStatus(inputs({ bookHalt: ready({ halted: true, venueHalted: false, haltedSinceMs: at }) })).stateSinceMs).toBe(at);
    expect(dataStatus(inputs({ bookHalt: ready({ halted: true, venueHalted: false, haltedSinceMs: null }) })).stateSinceMs).toBeNull();
    expect(dataStatus(inputs({ bookHalt: ready({ halted: true, venueHalted: false }) })).stateSinceMs).toBeNull();
    expect(
      dataStatus(inputs({ bookHalt: ready({ halted: false, venueHalted: true, haltedSinceMs: null, venueHaltedSinceMs: at }) }))
        .stateSinceMs,
    ).toBe(at);
  });

  it('a venue-wide halt on matching halts every market', () => {
    expect(dataStatus(inputs({ bookHalt: ready({ halted: false, venueHalted: true }) })).chip).toBe('halted');
  });

  it('a book whose halt state cannot be read is refused, never live', () => {
    expect(dataStatus(inputs({ bookHalt: failed }))).toMatchObject({ chip: 'book_unavailable', orderEntry: 'refused' });
  });

  it('a market that is not OPEN is not open and refuses order entry', () => {
    const post = ready({ state: 'POST_ONLY', effectiveAt: null, evidenceRefs: [] });
    expect(dataStatus(inputs({ lifecycle: post }))).toMatchObject({ chip: 'not_open', orderEntry: 'refused' });
  });

  it('an unreadable market state is refused, never open', () => {
    expect(dataStatus(inputs({ lifecycle: failed }))).toMatchObject({
      chip: 'lifecycle_unavailable',
      orderEntry: 'refused',
    });
  });

  it('a lifecycle read older than the state poll allows is lifecycle unavailable, never open', () => {
    const stale = ready({ state: 'OPEN', effectiveAt: null, evidenceRefs: [] }, NOW - feedStaleAfterMs(STATE_POLL_MS) - 1);
    expect(dataStatus(inputs({ lifecycle: stale }))).toMatchObject({ chip: 'lifecycle_unavailable', orderEntry: 'refused' });
  });

  it('a market with no trades says so instead of claiming a live tick', () => {
    expect(dataStatus(inputs({ lastTrade: ready(null) })).chip).toBe('no_data');
    expect(dataStatus(inputs({ lastTrade: failed })).chip).toBe('tick_unread');
  });

  it('a local test market is flagged from its lifecycle evidence', () => {
    const test = ready({
      state: 'OPEN',
      effectiveAt: NOW,
      evidenceRefs: ['local-test:approval: LOCAL TEST — not an owner or legal approval'],
    });
    expect(dataStatus(inputs({ lifecycle: test })).test).toBe(true);
  });

  it('a stale or down feed is not called live even when the trade read is fresh', () => {
    expect(dataStatus(inputs({ candles: failed })).chip).toBe('down');
    expect(dataStatus(inputs({ candles: { status: 'ready', data: [], asOf: NOW - 60_000 } })).chip).toBe('stale');
  });
});

describe('tradeRefusal: one rule for the chip and the trade link', () => {
  it('is null only when the state and the book both read open and current', () => {
    expect(tradeRefusal(open, liveBook, NOW)).toBeNull();
  });

  it('is loading while either read is still loading', () => {
    expect(tradeRefusal({ status: 'loading' }, liveBook, NOW)).toMatchObject({ code: 'loading' });
    expect(tradeRefusal(open, { status: 'loading' }, NOW)).toMatchObject({ code: 'loading' });
  });

  it('names the halted book and the unreadable book', () => {
    expect(tradeRefusal(open, ready({ halted: true, venueHalted: false }), NOW)).toMatchObject({ code: 'book_halted' });
    expect(tradeRefusal(open, failed, NOW)).toMatchObject({ code: 'book_unavailable' });
  });
});
