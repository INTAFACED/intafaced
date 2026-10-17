/**
 * The Execution room's reads. All polled through the tab's one scheduler (rooms/read.ts), private ones keyed by user.
 * The service publishes no list of algo schedules (ALG-1), so the parents shown are the ids this device remembers plus any
 * id opened by hand; each one is re-read from the service every time and never trusted from storage.
 */
import { useMemo } from 'react';
import { z } from 'zod';
import { useDataEnv, useTicker } from '../../../data';
import type { Decimal, Loadable } from '../../../data/types';
import { createTradeApi } from '../../../features/trade/trade-api';
import { useSession } from '../rooms/ui';
import { deskListingSchema, toDeskMarket, type DeskMarket } from '../desk/market';
import { ROOM_INTERVALS, usePrivateRead, usePublicRead, useRoomApi } from '../rooms/read';
import type { AlgoParent, AlgoPolicy, AlgoProgress } from '../rooms/api';

/** Same shape as `executionSpine` in features/trade/tool-api.ts, kept here so this room reads it without the legacy client. */
export const spineSchema = z.object({
  doors: z.array(z.object({ id: z.string(), module: z.string(), kind: z.string(), callerSubmit: z.boolean() })),
  externalOnly: z.boolean(),
  houseInternalRefuse: z.boolean(),
});
export type Spine = z.infer<typeof spineSchema>;

/** A real spot market with its rules and the listing's fee rates (decimal fractions: 0.001 = 10 bps). */
export interface ExecMarket extends DeskMarket {
  taker: Decimal;
  maker: Decimal;
}

const SPINE_INTERVAL_MS = 300_000;

export function useExecMarkets(): Loadable<ExecMarket[]> {
  const { api } = useSession();
  return usePublicRead<ExecMarket[]>(
    'exec-markets',
    async (signal) => {
      const result = await api.rest('/markets', z.array(deskListingSchema), { query: { limit: 500 }, signal });
      if (!result.ok) return result;
      const rows = result.data
        .filter((m) => m.spot && !m.paper)
        .map((m) => ({ ...toDeskMarket(m), taker: m.taker, maker: m.maker }))
        .sort((a, b) => Number(b.open) - Number(a.open));
      return { ok: true, data: rows };
    },
    ROOM_INTERVALS.markets,
  );
}

export function useAlgoPolicy(): Loadable<AlgoPolicy> {
  const room = useRoomApi();
  return usePrivateRead('exec-policy', (signal) => room.algoPolicy(signal), ROOM_INTERVALS.policy);
}

export function useSpine(): Loadable<Spine> {
  const { api } = useSession();
  return usePrivateRead(
    'exec-spine',
    (signal) => api.query('execution', 'execution.spine', undefined, spineSchema, { signal }),
    SPINE_INTERVAL_MS,
  );
}

/** What one stored id turned out to be when the service was asked. */
export type ParentRead =
  { id: string; ok: true; parent: AlgoParent; progress: AlgoProgress | null } | { id: string; ok: false; code: string | null };

async function readParent(room: ReturnType<typeof useRoomApi>, id: string, signal: AbortSignal): Promise<ParentRead> {
  const [parent, progress] = await Promise.all([room.algoGet(id, signal), room.algoProgress(id, signal)]);
  if (!parent.ok) return { id, ok: false, code: parent.code ?? null };
  return { id, ok: true, parent: parent.data, progress: progress.ok ? progress.data : null };
}

/** Re-reads every known parent, one `get` and one `progress` each, every 10 s. One failure never hides the others. */
export function useParents(ids: readonly string[]): Loadable<ParentRead[]> {
  const room = useRoomApi();
  const key = ids.join(',');
  return usePrivateRead<ParentRead[]>(
    `exec-parents:${key}`,
    async (signal) => ({ ok: true, data: await Promise.all(ids.map((id) => readParent(room, id, signal))) }),
    ROOM_INTERVALS.progress,
    ids.length > 0,
  );
}

/** Re-reads the known parents now, so a pause, resume or cancel shows without waiting for the next 10 s poll. */
export function useRefreshParents(ids: readonly string[]): () => void {
  const env = useDataEnv();
  return () => {
    if (env.userId) env.poller.refresh(`exec-parents:${ids.join(',')}:${env.userId}`);
  };
}

export function useLast(symbol: string): Decimal | null {
  const ticker = useTicker(symbol);
  return ticker.status === 'ready' ? ticker.data.last : null;
}

/** The trade client bound to the session, for the order lists and per-order cancel and read-back. */
export function useTradeApi() {
  const { api } = useSession();
  return useMemo(() => createTradeApi(api), [api]);
}
