import { describe, expect, it } from 'vitest';
import type { FetchLike, Json, VenueWeightMinute } from './core.js';
import { BOOK_FRESH_MS, IDLE_MS, PING_MS, REST_TRADES, SILENT_MS, type MarketStreamSocket } from './market-stream.js';
import { HyperliquidTestnetUserVenue } from './venue.js';

/**
 * On the beta at 60871f0, five desks on five markets spent 1,330 weight in one minute (28 Nov 2026 03:28 UTC)
 * from each market's `l2Book`, `candleSnapshot` and `recentTrades` read by REST. With the market stream, a viewed
 * market's reads are answered from one WebSocket and weigh nothing. The shapes below are the test network's own, as
 * read live on 28 Nov 2026.
 */
class Probe extends HyperliquidTestnetUserVenue {
  read(body: Record<string, Json>) {
    return this.info(body);
  }
}

class FakeSocket implements MarketStreamSocket {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
  }
  push(channel: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ channel, data }) });
  }
  /** The venue confirms every subscription it was sent. */
  confirmAll() {
    for (const m of this.sent) if (m.method === 'subscribe') this.push('subscriptionResponse', m);
  }
}

const BOOK = (time: number, px = '60534.0') => ({
  coin: 'BTC',
  time,
  levels: [[{ px, sz: '0.001', n: 1 }], [{ px: '60600.0', sz: '0.002', n: 1 }]],
});
const TRADE = (tid: number, time: number) => ({
  coin: 'BTC',
  side: 'A',
  px: '60515.0',
  sz: '0.00025',
  time,
  hash: `0x${tid}`,
  tid,
  users: ['0xa', '0xb'],
});
const CANDLE = (t: number, n: number, c = '60534.0') => ({
  t,
  T: t + 59_999,
  s: 'BTC',
  i: '1m',
  o: '60524.0',
  c,
  h: '60547.0',
  l: '60524.0',
  v: '0.004',
  n,
});

function setup() {
  let now = Date.parse('2026-11-28T03:30:10.000Z');
  const calls: Array<Record<string, Json>> = [];
  const restAnswers: Record<string, Json> = {};
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as Record<string, Json>;
    calls.push(body);
    return { ok: true, status: 200, text: async () => JSON.stringify(restAnswers[String(body.type)] ?? []) };
  };
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const ticks: Array<() => void> = [];
  const minutes: VenueWeightMinute[] = [];
  const venue = new Probe({
    appEnv: 'test',
    fetch,
    clock: () => new Date(now),
    shareReads: true,
    onWeightMinute: (m) => minutes.push(m),
    warn: () => {},
    marketStream: {
      connect: (url) => {
        urls.push(url);
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      every: (_ms, tick) => {
        ticks.push(tick);
        return () => ticks.splice(ticks.indexOf(tick), 1);
      },
    },
  });
  return {
    venue,
    calls,
    restAnswers,
    sockets,
    urls,
    minutes,
    socket: () => sockets[sockets.length - 1]!,
    tick: (ms: number) => {
      now += ms;
    },
    runTicks: () => [...ticks].forEach((t) => t()),
    now: () => now,
  };
}

/** Opens the stream on `body`, confirms it, and returns the setup. */
async function live(s: ReturnType<typeof setup>, body: Record<string, Json>) {
  await s.venue.read(body);
  s.socket().onopen?.();
  s.socket().confirmAll();
}

describe('the public market stream', () => {
  it('opens one socket to the test network and subscribes to what is read; until it is live, reads go to REST', async () => {
    const s = setup();
    s.restAnswers.l2Book = BOOK(1);
    expect(await s.venue.read({ type: 'l2Book', coin: 'BTC' })).toEqual(BOOK(1));
    expect(s.urls).toEqual(['wss://api.hyperliquid-testnet.xyz/ws']);
    s.socket().onopen?.();
    expect(s.socket().sent).toEqual([{ method: 'subscribe', subscription: { type: 'l2Book', coin: 'BTC' } }]);
    expect(s.calls.map((c) => c.type)).toEqual(['l2Book']);
  });

  it("answers a book from the subscription's snapshot, with no REST read, while the newest is fresh", async () => {
    const s = setup();
    await live(s, { type: 'l2Book', coin: 'BTC' });
    s.socket().push('l2Book', BOOK(2, '60700.0'));
    s.tick(5_000);
    expect(await s.venue.read({ type: 'l2Book', coin: 'BTC' })).toEqual(BOOK(2, '60700.0'));
    expect(s.calls).toHaveLength(1);
    s.tick(BOOK_FRESH_MS);
    s.restAnswers.l2Book = BOOK(3);
    expect(await s.venue.read({ type: 'l2Book', coin: 'BTC' })).toEqual(BOOK(3));
    expect(s.calls).toHaveLength(2);
  });

  it('answers recent trades newest first, at most as many as the REST read, from the snapshot and each push', async () => {
    const s = setup();
    await live(s, { type: 'recentTrades', coin: 'BTC' });
    // The subscription's first message: the market's last 30 trades, oldest first.
    s.socket().push(
      'trades',
      Array.from({ length: 30 }, (_, i) => TRADE(100 + i, 1_000 + i)),
    );
    s.socket().push('trades', [TRADE(200, 5_000)]);
    s.socket().push('trades', [TRADE(200, 5_000)]);
    const rows = (await s.venue.read({ type: 'recentTrades', coin: 'BTC' })) as Array<{ tid: number }>;
    expect(rows.map((r) => r.tid)).toEqual([200, 129, 128, 127, 126, 125, 124, 123, 122, 121]);
    expect(rows).toHaveLength(REST_TRADES);
    expect(s.calls).toHaveLength(1);
  });

  it('seeds candles from one REST answer read after the subscription is live, then keeps them whole from pushes', async () => {
    const s = setup();
    const t0 = Date.parse('2026-11-28T03:28:00.000Z');
    const req = (startTime: number) => ({
      type: 'candleSnapshot',
      req: { coin: 'BTC', interval: '1m', startTime, endTime: t0 + 3 * 60_000 - 1 },
    });
    s.restAnswers.candleSnapshot = [CANDLE(t0, 5), CANDLE(t0 + 60_000, 3)];
    // The first read went to REST before the subscription was live, so it seeds nothing: the next read goes to REST too.
    await live(s, req(t0));
    // A push the venue sends before the seed's answer is in, newer than the seed's own copy, wins over it.
    s.socket().push('candle', CANDLE(t0 + 60_000, 4, '60999.0'));
    s.tick(15_001);
    expect(await s.venue.read(req(t0))).toEqual([CANDLE(t0, 5), CANDLE(t0 + 60_000, 3)]);
    expect(s.calls).toHaveLength(2);
    // From here the series is the stream's: the seed, the push above, and each push after.
    s.socket().push('candle', CANDLE(t0 + 120_000, 1, '61000.0'));
    s.tick(15_001);
    expect(await s.venue.read(req(t0))).toEqual([CANDLE(t0, 5), CANDLE(t0 + 60_000, 4, '60999.0'), CANDLE(t0 + 120_000, 1, '61000.0')]);
    expect(await s.venue.read(req(t0 + 60_000))).toEqual([CANDLE(t0 + 60_000, 4, '60999.0'), CANDLE(t0 + 120_000, 1, '61000.0')]);
    expect(s.calls).toHaveLength(2);
    // A window reaching before the seeded start reads REST.
    s.restAnswers.candleSnapshot = [CANDLE(t0 - 60_000, 2), CANDLE(t0, 5)];
    await s.venue.read(req(t0 - 60_000));
    expect(s.calls).toHaveLength(3);
  });

  it('counts what it answered in the minute line, weighing nothing, with its live subscriptions', async () => {
    const s = setup();
    await live(s, { type: 'l2Book', coin: 'BTC' });
    s.socket().push('l2Book', BOOK(2));
    await s.venue.read({ type: 'l2Book', coin: 'BTC' });
    await s.venue.read({ type: 'l2Book', coin: 'BTC' });
    s.tick(60_000);
    s.restAnswers.meta = { universe: [] };
    await s.venue.read({ type: 'meta' });
    expect(s.minutes).toEqual([
      {
        minute: '2026-11-28T03:30:00.000Z',
        weight: 2,
        byType: { l2Book: { requests: 1, weight: 2 } },
        streamed: { l2Book: 2 },
        subscriptions: 1,
      },
    ]);
  });

  it('a socket that closes drops everything: reads go to REST, and a new socket opens no sooner than 5 s after', async () => {
    const s = setup();
    await live(s, { type: 'l2Book', coin: 'BTC' });
    s.socket().push('l2Book', BOOK(2));
    s.socket().onclose?.();
    s.tick(2_001);
    s.restAnswers.l2Book = BOOK(9);
    expect(await s.venue.read({ type: 'l2Book', coin: 'BTC' })).toEqual(BOOK(9));
    expect(s.sockets).toHaveLength(1);
    s.tick(5_000 - 2_001);
    await s.venue.read({ type: 'l2Book', coin: 'BTC' });
    expect(s.sockets).toHaveLength(2);
  });

  it('a socket silent for 40 s is treated as gone; pings every tick; a subscription nobody asks for in 2 minutes is dropped', async () => {
    const s = setup();
    await live(s, { type: 'l2Book', coin: 'BTC' });
    await s.venue.read({ type: 'recentTrades', coin: 'BTC' });
    s.socket().confirmAll();
    s.tick(PING_MS);
    s.socket().push('pong', null);
    s.runTicks();
    expect(s.socket().sent.at(-1)).toEqual({ method: 'ping' });
    // Book asked again; trades not.
    s.tick(IDLE_MS - PING_MS);
    await s.venue.read({ type: 'l2Book', coin: 'BTC' });
    s.tick(PING_MS);
    s.socket().push('pong', null);
    s.runTicks();
    expect(s.socket().sent).toContainEqual({ method: 'unsubscribe', subscription: { type: 'trades', coin: 'BTC' } });
    expect(s.socket().sent).not.toContainEqual({ method: 'unsubscribe', subscription: { type: 'l2Book', coin: 'BTC' } });
    s.tick(SILENT_MS);
    s.runTicks();
    expect(s.socket().closed).toBe(true);
    s.restAnswers.l2Book = BOOK(7);
    expect(await s.venue.read({ type: 'l2Book', coin: 'BTC' })).toEqual(BOOK(7));
  });

  it('serves no account read and no read with options it does not subscribe to', async () => {
    const s = setup();
    await live(s, { type: 'l2Book', coin: 'BTC' });
    s.socket().push('l2Book', BOOK(2));
    await s.venue.read({ type: 'l2Book', coin: 'BTC', nSigFigs: 3 });
    await s.venue.read({ type: 'clearinghouseState', user: '0xa' });
    expect(s.calls.map((c) => c.type)).toEqual(['l2Book', 'l2Book', 'clearinghouseState']);
  });

  it('is off unless asked for, and never without shared reads', async () => {
    let opened = 0;
    const fetch: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(BOOK(1)) });
    const connect = () => {
      opened += 1;
      return new FakeSocket();
    };
    await new Probe({ appEnv: 'test', fetch, shareReads: true }).read({ type: 'l2Book', coin: 'BTC' });
    await new Probe({ appEnv: 'test', fetch, marketStream: { connect } }).read({ type: 'l2Book', coin: 'BTC' });
    expect(opened).toBe(0);
  });
});
