import { describe, expect, it } from 'vitest';
import {
  isMuxInterval,
  isPublishedMuxLimit,
  isSlowConsumerReason,
  MUX_INTERVAL_MS,
  MUX_INTERVALS,
  MUX_MAX_CHANNELS_PER_OP,
  parseChannel,
  parseOp,
  subscriptionKey,
} from './protocol.js';

describe('mux protocol — parseOp', () => {
  it('accepts the three verbs with a bounded channels array and an optional id', () => {
    for (const op of ['subscribe', 'unsubscribe', 'resync']) {
      const parsed = parseOp(JSON.stringify({ op, id: 'r1', channels: [{ ch: 'ticker' }] }));
      expect(parsed).toMatchObject({ ok: true, verb: op, id: 'r1' });
    }
  });

  it('refuses anything that is not a JSON object with a known op', () => {
    expect(parseOp('not json')).toMatchObject({ ok: false, code: 'bad_json' });
    expect(parseOp('[1,2]')).toMatchObject({ ok: false, code: 'bad_request' });
    expect(parseOp('"subscribe"')).toMatchObject({ ok: false, code: 'bad_request' });
    expect(parseOp('null')).toMatchObject({ ok: false, code: 'bad_request' });
    expect(parseOp(JSON.stringify({ op: 'dance', channels: [{}] }))).toMatchObject({ ok: false, code: 'bad_request' });
    expect(parseOp(JSON.stringify({ channels: [{}] }))).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('bounds the channels array: non-empty and at most the protocol cap', () => {
    expect(parseOp(JSON.stringify({ op: 'subscribe', channels: [] }))).toMatchObject({ ok: false, code: 'bad_request' });
    expect(parseOp(JSON.stringify({ op: 'subscribe', channels: 'book' }))).toMatchObject({ ok: false });
    const many = Array.from({ length: MUX_MAX_CHANNELS_PER_OP + 1 }, () => ({ ch: 'ticker' }));
    expect(parseOp(JSON.stringify({ op: 'subscribe', channels: many }))).toMatchObject({ ok: false, code: 'bad_request' });
    const max = Array.from({ length: MUX_MAX_CHANNELS_PER_OP }, () => ({ ch: 'ticker' }));
    expect(parseOp(JSON.stringify({ op: 'subscribe', channels: max }))).toMatchObject({ ok: true });
  });

  it('refuses an id that is not a short string, and never echoes one it refused', () => {
    for (const id of [1, '', 'x'.repeat(65), {}, null]) {
      const parsed = parseOp(JSON.stringify({ op: 'subscribe', id, channels: [{ ch: 'ticker' }] }));
      expect(parsed).toMatchObject({ ok: false, code: 'bad_request', id: undefined });
    }
  });
});

describe('mux protocol — parseChannel', () => {
  it('parses each channel shape', () => {
    expect(parseChannel({ ch: 'book', market: 'BTC-USDT' })).toEqual({ ok: true, spec: { ch: 'book', market: 'BTC-USDT' } });
    expect(parseChannel({ ch: 'trades', market: 'BTC/USDT' })).toEqual({ ok: true, spec: { ch: 'trades', market: 'BTC/USDT' } });
    expect(parseChannel({ ch: 'ticker' })).toEqual({ ok: true, spec: { ch: 'ticker' } });
    expect(parseChannel({ ch: 'ticker', market: 'BTC-USDT' })).toEqual({ ok: true, spec: { ch: 'ticker', market: 'BTC-USDT' } });
    expect(parseChannel({ ch: 'candles', market: 'BTC-USDT', interval: '1m' })).toEqual({
      ok: true,
      spec: { ch: 'candles', market: 'BTC-USDT', interval: '1m' },
    });
  });

  it('serves exactly the six intervals the product asked for, with their real spans', () => {
    expect([...MUX_INTERVALS]).toEqual(['1m', '5m', '15m', '1h', '4h', '1d']);
    expect(MUX_INTERVAL_MS).toEqual({ '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 });
    expect(isMuxInterval('3m')).toBe(false);
    expect(isMuxInterval(60)).toBe(false);
  });

  it('refuses unknown channels, missing markets, bad intervals and hostile market strings', () => {
    expect(parseChannel({ ch: 'orders', market: 'X' })).toMatchObject({ ok: false, code: 'unknown_channel' });
    expect(parseChannel({ market: 'X' })).toMatchObject({ ok: false, code: 'unknown_channel' });
    expect(parseChannel({ ch: 'book' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(parseChannel({ ch: 'candles', market: 'X' })).toMatchObject({ ok: false, code: 'bad_interval' });
    expect(parseChannel({ ch: 'candles', market: 'X', interval: '2m' })).toMatchObject({ ok: false, code: 'bad_interval' });
    expect(parseChannel({ ch: 'book', market: 'x'.repeat(65) })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(parseChannel({ ch: 'book', market: '../etc' })).toMatchObject({ ok: true }); // charset allows ., /, - — the listing check refuses it
    expect(parseChannel({ ch: 'book', market: 'a b' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(parseChannel({ ch: 'book', market: 5 })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(parseChannel('book')).toMatchObject({ ok: false, code: 'bad_request' });
    expect(parseChannel(null)).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('keys a subscription by its canonical market id', () => {
    expect(subscriptionKey({ ch: 'book', market: 'BTC/USDT' }, 'id-1')).toBe('book|id-1');
    expect(subscriptionKey({ ch: 'candles', market: 'BTC/USDT', interval: '1h' }, 'id-1')).toBe('candles|id-1|1h');
    expect(subscriptionKey({ ch: 'ticker' }, null)).toBe('ticker|*');
    expect(subscriptionKey({ ch: 'ticker', market: 'x' }, 'id-1')).toBe('ticker|id-1');
  });

  it('treats ceilings the way every other owner-published ceiling here is treated', () => {
    expect(isPublishedMuxLimit(undefined)).toBe(false);
    expect(isPublishedMuxLimit(0)).toBe(false);
    expect(isPublishedMuxLimit(1.5)).toBe(false);
    expect(isPublishedMuxLimit(3)).toBe(true);
    expect(isSlowConsumerReason('slow consumer: outbound buffer over 4096 bytes for 5 ticks')).toBe(true);
    expect(isSlowConsumerReason('depth unavailable')).toBe(false);
  });
});
