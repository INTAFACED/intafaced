/**
 * connect.data-lake runtime capture on OMS snapshot polls (P-08).
 *
 * Records measured books and typed holes into fabric CaptureLake, then drains
 * to TSDB when owner env is complete. No invented retention — blank env stays
 * capture-log-only until shutdown flush attempt.
 */
import { CaptureLake, drainFabricCaptureLakeToPersistence } from '@intafaced/venue-adapter';
import { VenueUnavailableError } from '@intafaced/venue-contracts';
import type { OmsSnapshotFn } from './oms-market-snapshot.js';

export type CaptureLakeRuntimeEnv = {
  readonly CONNECT_DATA_LAKE_TSDB_URL?: string;
  readonly CONNECT_DATA_LAKE_RETENTION_DAYS?: string;
  readonly CONNECT_DATA_LAKE_DRAIN_INTERVAL_MS?: string;
};

export type CaptureLakeRuntime = {
  readonly lake: CaptureLake;
  readonly wrapSnapshotMap: (map: Record<string, OmsSnapshotFn>) => Record<string, OmsSnapshotFn>;
  readonly drain: () => ReturnType<typeof drainFabricCaptureLakeToPersistence>;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
};

/** Node stores timer delays in a signed 32-bit int and turns anything larger into a 1ms loop. */
const MAX_DRAIN_INTERVAL_MS = 2_147_483_647;

function drainIntervalMs(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim() ?? '';
  if (trimmed.length === 0) return undefined;
  const ms = Number(trimmed);
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_DRAIN_INTERVAL_MS) return undefined;
  return ms;
}

function captureFailureDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function wrapOmsSnapshotWithCapture(lake: CaptureLake, venueId: string, snapshot: OmsSnapshotFn): OmsSnapshotFn {
  return async (symbol, limit) => {
    let snap: Awaited<ReturnType<OmsSnapshotFn>>;
    try {
      snap = await snapshot(symbol, limit);
    } catch (err) {
      if (err instanceof VenueUnavailableError) {
        lake.recordHole(venueId, symbol, err.reason, err.message);
      } else {
        lake.recordHole(venueId, symbol, 'capture_failed', captureFailureDetail(err));
      }
      throw err;
    }

    // The venue book is already in hand. A failed capture write is a hole beside
    // that book, not a reason to hide it from the OMS caller.
    try {
      lake.recordBook(snap);
    } catch (err) {
      try {
        lake.recordHole(venueId, symbol, 'capture_failed', captureFailureDetail(err));
      } catch {
        // Writing the hole must not replace the fetched book.
      }
    }
    return snap;
  };
}

export function createCaptureLakeRuntime(
  env: CaptureLakeRuntimeEnv = process.env,
  drainToPersistence: typeof drainFabricCaptureLakeToPersistence = drainFabricCaptureLakeToPersistence,
): CaptureLakeRuntime {
  const lake = new CaptureLake();
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;

  return {
    lake,
    wrapSnapshotMap(map) {
      const out: Record<string, OmsSnapshotFn> = {};
      for (const [venueId, fn] of Object.entries(map)) {
        out[venueId] = wrapOmsSnapshotWithCapture(lake, venueId, fn);
      }
      return out;
    },
    drain() {
      return drainToPersistence(lake, env);
    },
    start() {
      const ms = drainIntervalMs(env.CONNECT_DATA_LAKE_DRAIN_INTERVAL_MS);
      if (ms === undefined || timer) return;
      timer = setInterval(() => {
        if (inFlight) return;
        let task: Promise<void>;
        task = drainToPersistence(lake, env)
          .then((result) => {
            // persistence.ok false is a refused drain, same as a rejection: not a successful flush.
            if (!result.persistence.ok) {
              throw result.persistence;
            }
          })
          .catch(() => undefined)
          .finally(() => {
            if (inFlight === task) inFlight = undefined;
          });
        inFlight = task;
      }, ms);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (inFlight) await inFlight;
      await drainToPersistence(lake, env);
    },
  };
}
