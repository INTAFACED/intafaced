import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../session/session';
import { venueApi, type VenueStatus } from './venue-api';

/**
 * Venue mode (B1): the desks trade on the customer's own venue account only when svc-trade's `/api/v1/venue/status` says
 * the user-venue door is on. Anything else (off, signed out, a route that is not there, an answer that does not parse)
 * is `off`, and the desks render exactly as they do today. While the first answer is on its way the mode is `checking`,
 * and a desk renders today's view, so a deployment with the door off never shows anything different.
 */
export type VenueMode =
  { mode: 'off' } | { mode: 'checking' } | { mode: 'on'; status: Exclude<VenueStatus, { enabled: false }>; reload: () => void };

export function useVenueMode(): VenueMode {
  const { api, userId } = useSession();
  const venue = useMemo(() => venueApi(api), [api]);
  const [state, setState] = useState<{ key: string; status: VenueStatus | null } | null>(null);
  const [revision, setRevision] = useState(0);
  const key = `${userId ?? ''}:${revision}`;
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void venue.status(controller.signal).then((result) => {
      if (!controller.signal.aborted) setState({ key, status: result.ok ? result.data : null });
    });
    return () => controller.abort();
  }, [venue, userId, key]);
  if (!userId) return { mode: 'off' };
  if (!state || state.key !== key) return revision > 0 && state?.status?.enabled ? onOf(state.status, setRevision) : { mode: 'checking' };
  if (!state.status || !state.status.enabled) return { mode: 'off' };
  return onOf(state.status, setRevision);
}

function onOf(status: Exclude<VenueStatus, { enabled: false }>, setRevision: (next: (n: number) => number) => void): VenueMode {
  return { mode: 'on', status, reload: () => setRevision((n) => n + 1) };
}
