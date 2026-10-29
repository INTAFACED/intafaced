/**
 * THE STREAM INVENTORY (`GET /streams`).
 *
 * Every channel this process serves, built from the same lists the doors'
 * parsers accept, so a channel cannot be served without being listed or listed
 * without being served. `stream-inventory.test.ts` holds each door's parser to
 * its entries, exactly once each.
 *
 * The multiplexed door is mounted only when `WS_MUX_IDLE_MS` is set. When it
 * is not, its channels are still listed, with `mounted: false` and the code the
 * service logs at start, so a reader sees the door and why it is down.
 */
import { DROP_COPY_STREAM_PATH } from './drop-copy/gateway.js';
import { DROP_COPY_CHANNEL } from './drop-copy/hub.js';
import { MUX_IDLE_UNSET } from './mux/idle.js';
import { FUTURES_MARK_PREFIX, MUX_CHANNELS } from './mux/protocol.js';
import { PRIVATE_CHANNELS, PRIVATE_STREAM_PATH } from './private/gateway.js';
import { STREAM_CHANNELS, STREAM_PATH } from './ws/gateway.js';

export type StreamDoor = 'market' | 'mux' | 'private' | 'drop-copy';

export interface StreamEntry {
  readonly door: StreamDoor;
  /** Upgrade path on this service. */
  readonly path: string;
  /** The `channel` query value (market, private, drop-copy) or the `ch` a mux frame names; `futures.mark.` takes a symbol after it. */
  readonly channel: string;
  readonly access: 'public' | 'private';
  readonly mounted: boolean;
  /** Why an unmounted door is down: the code the service logs at start. */
  readonly refusal?: string;
}

export function streamInventory(options: { readonly muxMounted: boolean }): readonly StreamEntry[] {
  const mux = options.muxMounted ? { mounted: true } : { mounted: false, refusal: MUX_IDLE_UNSET };
  return [
    ...STREAM_CHANNELS.map((channel) => ({
      door: 'market' as const,
      path: STREAM_PATH,
      channel,
      access: 'public' as const,
      mounted: true,
    })),
    ...[...MUX_CHANNELS, FUTURES_MARK_PREFIX].map((channel) => ({
      door: 'mux' as const,
      path: STREAM_PATH,
      channel,
      access: 'public' as const,
      ...mux,
    })),
    ...PRIVATE_CHANNELS.map((channel) => ({
      door: 'private' as const,
      path: PRIVATE_STREAM_PATH,
      channel,
      access: 'private' as const,
      mounted: true,
    })),
    { door: 'drop-copy', path: DROP_COPY_STREAM_PATH, channel: DROP_COPY_CHANNEL, access: 'private', mounted: true },
  ];
}
