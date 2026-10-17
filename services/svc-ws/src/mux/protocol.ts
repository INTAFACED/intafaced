/**
 * THE MULTIPLEX PROTOCOL (one socket, many channels).
 *
 * `GET /stream` with NO `market` query parameter upgrades to a multiplexed
 * session. `GET /stream?market=<id>[&channel=trades]` is the original
 * one-market socket and is unchanged — it still ignores every inbound frame.
 *
 * ── Why inbound frames are parsed here and not on the legacy door ──────────
 *
 * The legacy door's whole safety argument was "no inbound surface at all".
 * This door has one, on an unauthenticated public port, so the surface is
 * kept as small as it can be and every bound is enforced before anything is
 * allocated for it:
 *
 *   · text frames only, at most `MUX_MAX_PAYLOAD_BYTES` (the `ws` library
 *     closes the socket with 1009 above that),
 *   · three verbs (`subscribe`, `unsubscribe`, `resync`), each with a bounded
 *     `channels` array,
 *   · every string is length-checked and pattern-checked, every channel name
 *     and interval is a closed set, and nothing a client sends is ever echoed
 *     back unvalidated,
 *   · a per-connection operation budget and subscription ceiling that are
 *     owner-published (blank refuses — see `session.ts`).
 *
 * This file is pure: no sockets, no timers, no hubs.
 */

/** Candle intervals this door serves. A subset of `TIMEFRAMES` in `@intafaced/exchange-contract` (same spellings, same spans). */
export const MUX_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type MuxInterval = (typeof MUX_INTERVALS)[number];

export const MUX_INTERVAL_MS: Readonly<Record<MuxInterval, number>> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export function isMuxInterval(value: unknown): value is MuxInterval {
  return typeof value === 'string' && (MUX_INTERVALS as readonly string[]).includes(value);
}

/** Protocol bounds. These are wire-format constants, not tunable ceilings. */
export const MUX_MAX_PAYLOAD_BYTES = 8 * 1024;
export const MUX_MAX_CHANNELS_PER_OP = 64;
/** Operations accepted but not yet answered. Past this the client is not waiting for answers. */
export const MUX_MAX_PENDING_OPS = 16;
export const MUX_MAX_ID_LENGTH = 64;

/** A market id (`BTC-USDT`, a uuid) or a unified symbol (`BTC/USDT`). Bounded before any lookup. */
export const MUX_MARKET = /^[A-Za-z0-9._:/-]{1,64}$/;

export type MuxChannelName = 'book' | 'trades' | 'ticker' | 'candles';
export const MUX_CHANNELS: readonly MuxChannelName[] = ['book', 'trades', 'ticker', 'candles'];

export type MuxVerb = 'subscribe' | 'unsubscribe' | 'resync';

/** Typed refusal codes. Every one is a string a client can branch on. */
export type MuxErrorCode =
  | 'bad_json'
  | 'bad_request'
  | 'unknown_channel'
  | 'unknown_market'
  | 'bad_interval'
  | 'subscription_limit'
  | 'not_subscribed'
  | 'unsupported'
  | 'at_capacity'
  | 'unavailable';

export type ChannelSpec =
  | { readonly ch: 'book'; readonly market: string }
  | { readonly ch: 'trades'; readonly market: string }
  | { readonly ch: 'candles'; readonly market: string; readonly interval: MuxInterval }
  /** `market` omitted = every market. */
  | { readonly ch: 'ticker'; readonly market?: string };

export type ParsedOp =
  | { readonly ok: true; readonly verb: MuxVerb; readonly id: string | undefined; readonly channels: readonly unknown[] }
  | { readonly ok: false; readonly code: 'bad_json' | 'bad_request'; readonly message: string; readonly id: string | undefined };

const VERBS: readonly MuxVerb[] = ['subscribe', 'unsubscribe', 'resync'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse one inbound text frame. Never throws. */
export function parseOp(text: string): ParsedOp {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, code: 'bad_json', message: 'frame is not JSON', id: undefined };
  }
  if (!isRecord(body)) return { ok: false, code: 'bad_request', message: 'frame must be a JSON object', id: undefined };

  let id: string | undefined;
  if (body.id !== undefined) {
    if (typeof body.id !== 'string' || body.id.length === 0 || body.id.length > MUX_MAX_ID_LENGTH) {
      return { ok: false, code: 'bad_request', message: `id must be a string of 1..${MUX_MAX_ID_LENGTH} characters`, id: undefined };
    }
    id = body.id;
  }

  const verb = body.op;
  if (typeof verb !== 'string' || !(VERBS as readonly string[]).includes(verb)) {
    return { ok: false, code: 'bad_request', message: `op must be one of: ${VERBS.join(', ')}`, id };
  }
  const channels = body.channels;
  if (!Array.isArray(channels) || channels.length === 0 || channels.length > MUX_MAX_CHANNELS_PER_OP) {
    return { ok: false, code: 'bad_request', message: `channels must be an array of 1..${MUX_MAX_CHANNELS_PER_OP} entries`, id };
  }
  return { ok: true, verb: verb as MuxVerb, id, channels };
}

export type ParsedChannel =
  | { readonly ok: true; readonly spec: ChannelSpec }
  | { readonly ok: false; readonly code: 'bad_request' | 'unknown_channel' | 'bad_interval'; readonly message: string };

/** Validate one entry of a `channels` array. Never throws. */
export function parseChannel(raw: unknown): ParsedChannel {
  if (!isRecord(raw)) return { ok: false, code: 'bad_request', message: 'channel entry must be an object' };
  const ch = raw.ch;
  if (typeof ch !== 'string' || !(MUX_CHANNELS as readonly string[]).includes(ch)) {
    return { ok: false, code: 'unknown_channel', message: `ch must be one of: ${MUX_CHANNELS.join(', ')}` };
  }
  const market = raw.market;
  if (market !== undefined && (typeof market !== 'string' || !MUX_MARKET.test(market))) {
    return { ok: false, code: 'bad_request', message: 'market must be a market id or symbol (1..64 characters)' };
  }

  switch (ch as MuxChannelName) {
    case 'ticker':
      return { ok: true, spec: market === undefined ? { ch: 'ticker' } : { ch: 'ticker', market } };
    case 'book':
    case 'trades':
      if (market === undefined) return { ok: false, code: 'bad_request', message: `${ch} needs a market` };
      return { ok: true, spec: { ch: ch as 'book' | 'trades', market } };
    case 'candles': {
      if (market === undefined) return { ok: false, code: 'bad_request', message: 'candles needs a market' };
      if (!isMuxInterval(raw.interval)) {
        return { ok: false, code: 'bad_interval', message: `interval must be one of: ${MUX_INTERVALS.join(', ')}` };
      }
      return { ok: true, spec: { ch: 'candles', market, interval: raw.interval } };
    }
  }
}

/** Blank / non-integer / below 1 is unpublished. Same rule as every other owner-published ceiling here. */
export function isPublishedMuxLimit(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** A hub closes a lagging sink with a reason that starts with this. The mux door turns it into a whole-connection close. */
export const SLOW_CONSUMER_PREFIX = 'slow consumer';

export function isSlowConsumerReason(reason: string): boolean {
  return reason.startsWith(SLOW_CONSUMER_PREFIX);
}

/** Subscription identity inside one connection. `market` is the canonical id, never the alias the client typed. */
export function subscriptionKey(spec: ChannelSpec, marketId: string | null): string {
  switch (spec.ch) {
    case 'book':
    case 'trades':
      return `${spec.ch}|${marketId}`;
    case 'candles':
      return `candles|${marketId}|${spec.interval}`;
    case 'ticker':
      return `ticker|${marketId ?? '*'}`;
  }
}
