// hand-declared-ok: svc-trade's `GET /api/v1/time` answer has no browser-safe schema in packages/contracts.
/**
 * One read of the server clock (`GET /api/v1/time`, svc-trade public-rest.ts: `{ serverTime }` in Unix ms) and the
 * client clock's distance from it. The offset is taken at the middle of the round trip, so the network's delay does not
 * become a clock difference. Used by the charts (a trade's age on the server's clock) and by the developer clock check.
 */
import { z } from 'zod';
import type { ApiClient, ApiResult } from './api';

const serverTimeSchema = z.object({ serverTime: z.number() }).passthrough();

export type ServerClockReading = {
  /** Server clock minus client clock, in whole ms. */
  offsetMs: number;
  /** How long the read took, in whole ms. */
  roundTripMs: number;
};

export async function readServerClock(
  api: Pick<ApiClient, 'rest'>,
  options: { signal?: AbortSignal; now?: () => number } = {},
): Promise<ApiResult<ServerClockReading>> {
  const now = options.now ?? Date.now;
  const sent = now();
  const result = await api.rest('/time', serverTimeSchema, options.signal ? { signal: options.signal } : {});
  const received = now();
  if (!result.ok) return result;
  return {
    ok: true,
    data: { offsetMs: result.data.serverTime - Math.round((sent + received) / 2), roundTripMs: Math.max(0, received - sent) },
  };
}
