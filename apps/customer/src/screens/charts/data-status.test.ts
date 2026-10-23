import { describe, expect, it } from 'vitest';
import { dataStatus, feedStaleAfterMs, type StatusInputs } from './data-status';

const NOW = 1_800_000_000_000;
const POLL = 10_000;
/** A good read: the value and the time it was read (the poll time). */
const ready = <T>(data: T, asOf = NOW) => ({ status: 'ready' as const, data, asOf });
const open = ready({ state: 'OPEN', effectiveAt: NOW - 3_600_000, evidenceRefs: ['trade.lifecycle.evidence:x'] });
const owner = (dataClass: 'real_time' | 'delayed' | 'end_of_day' | null, delayedBoundarySeconds: number | null) =>
  ready({ dataClass, delayedBoundarySeconds });
const fresh = ready([], NOW - 1_000);
const tradeAt = (secondsAgo: number) => ready(NOW - secondsAgo * 1000);

function inputs(over: Partial<StatusInputs> = {}): StatusInputs {
  return {
    now: NOW,
    owner: owner('real_time', 30),
    lifecycle: open,
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

  it('a real-time market whose newest trade is older than the boundary is delayed, with the age in seconds', () => {
    const s = dataStatus(inputs({ lastTrade: tradeAt(95) }));
    expect(s).toMatchObject({ chip: 'delayed', ageSeconds: 95 });
  });

  it('a blank boundary claims neither live nor delayed: the chip names the unset threshold and keeps the age', () => {
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
    expect(dataStatus(inputs({ candles: { status: 'error', retry: () => {} } })).chip).toBe('down');
    expect(dataStatus(inputs({ candles: { status: 'error', retry: () => {} } })).feed).toBe('down');
  });

  it('a halted market is halted, names its state, and refuses order entry', () => {
    const halted = ready({ state: 'HALTED', effectiveAt: NOW - 60_000, evidenceRefs: [] });
    const s = dataStatus(inputs({ lifecycle: halted }));
    expect(s).toMatchObject({ chip: 'halted', state: 'HALTED', stateSinceMs: NOW - 60_000, orderEntry: 'refused' });
  });

  it('a market that is not OPEN is not open and refuses order entry', () => {
    const post = ready({ state: 'POST_ONLY', effectiveAt: null, evidenceRefs: [] });
    expect(dataStatus(inputs({ lifecycle: post }))).toMatchObject({ chip: 'not_open', orderEntry: 'refused' });
  });

  it('an unreadable market state is refused, never open', () => {
    expect(dataStatus(inputs({ lifecycle: { status: 'error', retry: () => {} } }))).toMatchObject({
      chip: 'lifecycle_unavailable',
      orderEntry: 'refused',
    });
  });

  it('a market with no trades says so instead of claiming a live tick', () => {
    expect(dataStatus(inputs({ lastTrade: ready(null) })).chip).toBe('no_data');
    expect(dataStatus(inputs({ lastTrade: { status: 'error', retry: () => {} } })).chip).toBe('tick_unread');
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
    expect(dataStatus(inputs({ candles: { status: 'error', retry: () => {} } })).chip).toBe('down');
    expect(dataStatus(inputs({ candles: { status: 'ready', data: [], asOf: NOW - 60_000 } })).chip).toBe('stale');
  });
});
