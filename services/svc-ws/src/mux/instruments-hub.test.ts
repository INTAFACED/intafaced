import { describe, expect, it } from 'vitest';
import { CLOSE_POLICY, CLOSE_TRY_LATER, type DepthSink } from '../depth/hub.js';
import { INSTRUMENTS_REPLAY_EVENTS, INSTRUMENTS_UNAVAILABLE, InstrumentsHub, UNLISTED, type InstrumentRow } from './instruments-hub.js';
import { parseChannel, subscriptionKey } from './protocol.js';
import { parseInstrument } from './sources.js';

class FakeSink implements DepthSink {
  bufferedBytes = 0;
  readonly frames: any[] = [];
  closed: { code: number; reason: string } | null = null;
  send(frame: string): void {
    this.frames.push(JSON.parse(frame));
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

const row = (market: string, state: string | null, extra: Partial<InstrumentRow> = {}): InstrumentRow => ({
  market,
  symbol: `${market}/USDT`,
  base: market,
  quote: 'USDT',
  state,
  reasonCode: null,
  ...extra,
});

const hub = (onDemand?: () => void) =>
  new InstrumentsHub({ highWaterBytes: 1000, maxLagTicks: 2, maxConnections: 4, epoch: 'epoch-1', ...(onDemand ? { onDemand } : {}) });

describe('InstrumentsHub: a snapshot, then one event per change, on one sequence', () => {
  it('sends the list as a snapshot, then each state change once, in sequence order', () => {
    const h = hub();
    h.ingest([row('BTC', 'OPEN'), row('ETH', 'OPEN')]);
    const sink = new FakeSink();
    h.attach(sink);
    expect(sink.frames).toEqual([
      expect.objectContaining({ type: 'snapshot', epoch: 'epoch-1', sequence: 0, instruments: [row('BTC', 'OPEN'), row('ETH', 'OPEN')] }),
    ]);

    h.ingest([row('BTC', 'LIMIT_ONLY'), row('ETH', 'OPEN')]);
    h.ingest([row('BTC', 'LIMIT_ONLY'), row('ETH', 'CANCEL_ONLY', { reasonCode: 'market.cancel_only' })]);
    expect(sink.frames.slice(1)).toEqual([
      expect.objectContaining({ type: 'event', sequence: 1, market: 'BTC', from: 'OPEN', to: 'LIMIT_ONLY' }),
      expect.objectContaining({
        type: 'event',
        sequence: 2,
        market: 'ETH',
        from: 'OPEN',
        to: 'CANCEL_ONLY',
        reasonCode: 'market.cancel_only',
      }),
    ]);
  });

  it('ignores a duplicate publish: the same state read again is no event', () => {
    const h = hub();
    h.ingest([row('BTC', 'OPEN')]);
    const sink = new FakeSink();
    h.attach(sink);
    h.ingest([row('BTC', 'LIMIT_ONLY')]);
    h.ingest([row('BTC', 'LIMIT_ONLY')]);
    h.ingest([row('BTC', 'LIMIT_ONLY')]);
    expect(sink.frames.filter((f) => f.type === 'event')).toHaveLength(1);
    expect(h.sequence).toBe(1);
  });

  it('names a market that leaves or joins the list against UNLISTED', () => {
    const h = hub();
    h.ingest([row('BTC', 'OPEN')]);
    const sink = new FakeSink();
    h.attach(sink);
    h.ingest([]);
    h.ingest([row('BTC', 'OPEN')]);
    expect(sink.frames.slice(1).map((f) => [f.sequence, f.from, f.to])).toEqual([
      [1, 'OPEN', UNLISTED],
      [2, UNLISTED, 'OPEN'],
    ]);
  });

  it('gives an event a stable id from the market, the two states and its sequence', () => {
    const h = hub();
    h.ingest([row('BTC', 'OPEN')]);
    const a = new FakeSink();
    const b = new FakeSink();
    h.attach(a);
    h.attach(b);
    h.ingest([row('BTC', 'HALTED')]);
    expect(a.frames[1].id).toMatch(/^[0-9a-f]{32}$/);
    expect(a.frames[1].id).toBe(b.frames[1].id);
  });
});

describe('InstrumentsHub: a reconnect resumes from the last sequence, and a gap forces a snapshot', () => {
  it('replays exactly the events after the sequence the client last applied', () => {
    const h = hub();
    h.ingest([row('BTC', 'OPEN')]);
    const first = new FakeSink();
    const detach = h.attach(first)!;
    h.ingest([row('BTC', 'LIMIT_ONLY')]);
    const last = first.frames.at(-1).sequence;
    expect(last).toBe(1);
    detach();

    // Two changes while it was away.
    h.ingest([row('BTC', 'CANCEL_ONLY')]);
    h.ingest([row('BTC', 'OPEN')]);

    const again = new FakeSink();
    h.attach(again, { epoch: 'epoch-1', sequence: last });
    expect(again.frames).toEqual([
      { type: 'resume', epoch: 'epoch-1', fromSequence: 1, sequence: 3 },
      expect.objectContaining({ type: 'event', sequence: 2, from: 'LIMIT_ONLY', to: 'CANCEL_ONLY' }),
      expect.objectContaining({ type: 'event', sequence: 3, from: 'CANCEL_ONLY', to: 'OPEN' }),
    ]);
  });

  it('resumes with nothing to replay when nothing changed', () => {
    const h = hub();
    h.ingest([row('BTC', 'OPEN')]);
    const sink = new FakeSink();
    h.attach(sink, { epoch: 'epoch-1', sequence: 0 });
    expect(sink.frames).toEqual([{ type: 'resume', epoch: 'epoch-1', fromSequence: 0, sequence: 0 }]);
  });

  it('sends a snapshot marked gap for another epoch, a sequence ahead of the stream, or events no longer held', () => {
    const h = hub();
    h.ingest([row('BTC', 'OPEN')]);
    const other = new FakeSink();
    h.attach(other, { epoch: 'epoch-0', sequence: 0 });
    expect(other.frames).toEqual([expect.objectContaining({ type: 'snapshot', reason: 'gap', epoch: 'epoch-1', sequence: 0 })]);

    const ahead = new FakeSink();
    h.attach(ahead, { epoch: 'epoch-1', sequence: 5 });
    expect(ahead.frames[0]).toMatchObject({ type: 'snapshot', reason: 'gap' });

    for (let n = 0; n <= INSTRUMENTS_REPLAY_EVENTS + 1; n += 1) h.ingest([row('BTC', n % 2 === 0 ? 'HALTED' : 'OPEN')]);
    const old = new FakeSink();
    h.attach(old, { epoch: 'epoch-1', sequence: 0 });
    expect(old.frames).toEqual([expect.objectContaining({ type: 'snapshot', reason: 'gap', sequence: h.sequence })]);
  });
});

describe('InstrumentsHub: availability, limits and backpressure', () => {
  it('asks for a read when a subscriber arrives before any, and snapshots it when the read lands', () => {
    let asked = 0;
    const h = hub(() => (asked += 1));
    const sink = new FakeSink();
    h.attach(sink);
    expect(asked).toBe(1);
    expect(sink.frames).toEqual([]);
    h.ingest([row('BTC', 'OPEN')]);
    expect(sink.frames).toEqual([expect.objectContaining({ type: 'snapshot', sequence: 0 })]);
  });

  it('says the list is unavailable instead of serving it stale, and snapshots again when it is back', () => {
    const h = hub();
    h.ingest([row('BTC', 'OPEN')]);
    const sink = new FakeSink();
    h.attach(sink);
    h.markUnavailable();
    expect(sink.frames.at(-1)).toEqual({ type: 'status', code: INSTRUMENTS_UNAVAILABLE, epoch: 'epoch-1' });
    h.ingest([row('BTC', 'HALTED')]);
    expect(sink.frames.at(-1)).toMatchObject({ type: 'snapshot', instruments: [row('BTC', 'HALTED')] });
  });

  it('refuses when a limit is unset, and at capacity', () => {
    const unset = new InstrumentsHub({ highWaterBytes: undefined, maxLagTicks: 2, maxConnections: 4 });
    const a = new FakeSink();
    expect(unset.attach(a)).toBeNull();
    expect(a.closed?.code).toBe(CLOSE_POLICY);
    const one = new InstrumentsHub({ highWaterBytes: 1000, maxLagTicks: 2, maxConnections: 1 });
    expect(one.attach(new FakeSink())).not.toBeNull();
    const b = new FakeSink();
    expect(one.attach(b)).toBeNull();
    expect(b.closed?.code).toBe(CLOSE_TRY_LATER);
  });

  it('drops an event for a client over the high-water mark, repairs it with a snapshot, and closes one that stays over', () => {
    const h = hub();
    h.ingest([row('BTC', 'OPEN')]);
    const sink = new FakeSink();
    h.attach(sink);
    sink.bufferedBytes = 5000;
    h.ingest([row('BTC', 'HALTED')]);
    expect(sink.frames.filter((f) => f.type === 'event')).toHaveLength(0);
    sink.bufferedBytes = 0;
    h.flush();
    expect(sink.frames.at(-1)).toMatchObject({ type: 'snapshot', sequence: 1, instruments: [row('BTC', 'HALTED')] });

    const slow = new FakeSink();
    h.attach(slow);
    slow.bufferedBytes = 5000;
    h.ingest([row('BTC', 'OPEN')]);
    h.flush();
    h.flush();
    h.flush();
    expect(slow.closed?.code).toBe(CLOSE_TRY_LATER);
  });
});

describe('the instruments channel on the wire', () => {
  it('parses a plain subscribe and a resume, and refuses a market or a bad resume', () => {
    expect(parseChannel({ ch: 'instruments' })).toEqual({ ok: true, spec: { ch: 'instruments' } });
    expect(parseChannel({ ch: 'instruments', resume: { epoch: 'epoch-1', sequence: 7 } })).toEqual({
      ok: true,
      spec: { ch: 'instruments', resume: { epoch: 'epoch-1', sequence: 7 } },
    });
    expect(parseChannel({ ch: 'instruments', market: 'BTC/USDT' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(parseChannel({ ch: 'instruments', resume: { epoch: 'epoch-1', sequence: -1 } })).toMatchObject({ ok: false });
    expect(parseChannel({ ch: 'instruments', resume: { epoch: 'a b', sequence: 1 } })).toMatchObject({ ok: false });
    expect(parseChannel({ ch: 'instruments', resume: { sequence: 1 } })).toMatchObject({ ok: false });
    expect(subscriptionKey({ ch: 'instruments' }, null)).toBe('instruments');
  });

  it('reads a market row: its id, symbol, base, quote and public lifecycle state', () => {
    expect(
      parseInstrument({ id: 'm1', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', lifecycle: { state: 'LIMIT_ONLY', reasonCode: 'x.y' } }),
    ).toEqual({ market: 'm1', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', state: 'LIMIT_ONLY', reasonCode: 'x.y' });
    expect(parseInstrument({ id: 'm1', symbol: 'BTC/USDT', lifecycle: null })).toMatchObject({ state: null, reasonCode: null });
    expect(parseInstrument({ symbol: 'BTC/USDT' })).toBeNull();
  });
});
