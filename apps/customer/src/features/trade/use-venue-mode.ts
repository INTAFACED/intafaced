import { useEffect, useMemo, useState } from 'react';
import { isServiceNotConnected, type ApiResult } from '../../shared/api';
import { useSession } from '../session';
import { venueApi, type VenueStatus } from './venue-api';

/**
 * Venue mode (B1): the desks trade on the customer's own venue account only when svc-trade's `/api/v1/venue/status` says
 * the user-venue door is on. Anything else (off, signed out, a route that is not there, an unwired service, an answer
 * that does not parse, or an unreachable service) settles to `off`, so today's own-book desks and risk controls stay
 * reachable. On a transient unreachable failure (timeout or 5xx, excluding `edge.upstream_unwired`), the hook settles
 * `off` at once and retries in the background over a bounded back-off schedule (5 retries: 1 s, 2 s, 4 s, 8 s, 15 s),
 * switching to `on` if the door answers before the retries run out. Across a `reload()` from `on`, it stays `on` while
 * retrying and settles to `off` once the retries are exhausted. `skip` asks nothing and answers `off`.
 */
export type VenueMode =
  { mode: 'off' } | { mode: 'checking' } | { mode: 'on'; status: Exclude<VenueStatus, { enabled: false }>; reload: () => void };

/** Bounded back-off between background retries of a transient `unreachable` status read (timeout or 5xx). */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

const isTransient = (result: ApiResult<VenueStatus>): boolean =>
  !result.ok && result.reason === 'unreachable' && !isServiceNotConnected(result.code);

export function useVenueMode(skip = false): VenueMode {
  const { api, userId } = useSession();
  const venue = useMemo(() => venueApi(api), [api]);
  const [state, setState] = useState<{ key: string; status: VenueStatus | null } | null>(null);
  const [revision, setRevision] = useState(0);
  const key = `${userId ?? ''}:${revision}`;
  useEffect(() => {
    if (!userId || skip) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const read = () => {
      void venue.status(controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        if (isTransient(result)) {
          const wait = RETRY_DELAYS_MS[attempt];
          if (wait !== undefined) {
            if (attempt === 0) setState((previous) => (revision > 0 && previous?.status?.enabled ? previous : { key, status: null }));
            attempt += 1;
            timer = setTimeout(read, wait);
            return;
          }
          setState({ key, status: null });
          return;
        }
        setState({ key, status: result.ok ? result.data : null });
      });
    };
    read();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [venue, userId, key, revision, skip]);
  if (!userId || skip) return { mode: 'off' };
  if (!state || state.key !== key) return revision > 0 && state?.status?.enabled ? onOf(state.status, setRevision) : { mode: 'checking' };
  if (!state.status || !state.status.enabled) return { mode: 'off' };
  return onOf(state.status, setRevision);
}

function onOf(status: Exclude<VenueStatus, { enabled: false }>, setRevision: (next: (n: number) => number) => void): VenueMode {
  return { mode: 'on', status, reload: () => setRevision((n) => n + 1) };
}
