import { describe, expect, it } from 'vitest';
import { BybitSpotAccount, BybitSpotMarketData } from './bybit-spot.js';
import { mapBybitSpotCoins } from './bybit-spot-account.js';
import { MaintainedBook } from '../book-feed.js';
import { AsyncFrameQueue, type HttpPort, type HttpResponse, type StreamHandle, type StreamPort } from '../transport.js';

/**
 * L109 / L111: Bybit documents the REST orderbook `u` as corresponding to `u` in
 * the 1000-level websocket orderbook stream (docs: market/orderbook). Joining
 * that `u` to a 50-level stream compares two different numberings.
 * L110: `availableToWithdraw` and `free` are deprecated for UNIFIED wallet-balance
 * (docs: account/wallet-balance); free must be walletBalance - locked.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

class Http implements HttpPort {
  readonly requests: string[] = [];
  constructor(private readonly body: unknown) {}
  async get(url: string): Promise<HttpResponse> {
    this.requests.push(url);
    return { status: 200, body: this.body, header: () => null };
  }
  async post(): Promise<HttpResponse> {
    throw new Error('GET only');
  }
}

class Stream implements StreamPort {
  readonly queue = new AsyncFrameQueue<unknown>();
  readonly sent: unknown[] = [];
  async open(): Promise<StreamHandle> {
    return {
      messages: this.queue,
      send: async (p: unknown) => {
        this.sent.push(p);
      },
      close: async () => this.queue.close(),
    };
  }
}

const rest = (u: number) => ({
  retCode: 0,
  retMsg: 'OK',
  result: { s: 'BTCUSDT', b: [['30000.00', '2.00']], a: [['30002.00', '1.00']], ts: 1, u, seq: 9000 + u, cts: 1 },
});

const frame = (topic: string, type: 'snapshot' | 'delta', u: number) => ({
  topic,
  type,
  ts: 1,
  data: { s: 'BTCUSDT', b: type === 'delta' ? [['30001.00', '3.00']] : [], a: [], u, seq: 9000 + u },
  cts: 1,
});

describe('bybit-spot book join: REST u is the 1000-level stream numbering (L109, L111)', () => {
  it('the default stream topic is the same depth tier the REST snapshot numbering belongs to', async () => {
    const http = new Http(rest(100));
    const stream = new Stream();
    const md = new BybitSpotMarketData({ http, stream, clock: () => 1_000_000, heartbeatMs: 0 });
    const book = new MaintainedBook(md, 'BTC/USDT');
    const running = book.run();
    await settle();

    expect(http.requests[0]).toContain('limit=1000');
    expect(stream.sent).toEqual([{ op: 'subscribe', args: ['orderbook.1000.BTCUSDT'] }]);

    stream.queue.push(frame('orderbook.1000.BTCUSDT', 'snapshot', 100));
    stream.queue.push(frame('orderbook.1000.BTCUSDT', 'delta', 101));
    await settle();
    expect(book.status).toEqual({ kind: 'live', sequence: 101 });

    await book.close();
    stream.queue.close();
    await running;
  });

  it('refuses a 50-level stream, whose update ids cannot be joined to the REST snapshot', async () => {
    const md = new BybitSpotMarketData({
      http: new Http(rest(1)),
      stream: new Stream(),
      heartbeatMs: 0,
      wsDepth: 50 as never,
    });
    await expect(md.streamBook('BTC/USDT')).rejects.toThrow(/1000/);
  });
});

describe('bybit-spot wallet-balance: deprecated free fields are ignored (L110)', () => {
  it('free is walletBalance - locked even when deprecated availableToWithdraw says 0', () => {
    const [b] = mapBybitSpotCoins([{ coin: 'USDT', walletBalance: '100', locked: '10', availableToWithdraw: '0' }], new Date(0));
    expect(b!.free).toBe(90n * 10n ** 18n);
    expect(b!.used).toBe(10n * 10n ** 18n);
  });

  it('a deprecated free field does not override walletBalance - locked', () => {
    const [b] = mapBybitSpotCoins([{ coin: 'USDT', walletBalance: '10', locked: '0', availableToWithdraw: '', free: '4' }], new Date(0));
    expect(b!.free).toBe(10n * 10n ** 18n);
  });

  it('balances() over the wire maps the same way', async () => {
    const http = new Http({
      retCode: 0,
      result: {
        list: [{ accountType: 'UNIFIED', coin: [{ coin: 'USDT', walletBalance: '100', locked: '10', availableToWithdraw: '0' }] }],
      },
    });
    const account = new BybitSpotAccount({ venueId: 'bybit-spot', apiKey: 'k', apiSecret: 's', scopes: ['read'] } as never, {
      http,
      clock: () => 1_700_000_000_000,
    });
    const [row] = await account.balances();
    expect(row!.free).toBe(90n * 10n ** 18n);
  });
});
