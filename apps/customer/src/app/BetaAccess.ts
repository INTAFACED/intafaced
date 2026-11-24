import { useMemo } from 'react';
import { useSession } from '../features/session/session';
import { useVenueMode } from '../features/trade/use-venue-mode';
import { venueApi } from '../features/trade/venue-api';
import { useResource } from '../shared/resource';
import { betaRooms, setBetaAccess } from './beta-volt';

/**
 * App's read of what the account can use, for the beta's menus (beta-volt.ts). App draws again whenever the session's
 * profiles or the venue's answers change, and the menus draw after it, so they always see the latest. With the door on,
 * the venue's own staking terms and vault list are read once each: a room the venue offers is one it answers. Other
 * builds ask the venue nothing and set nothing.
 */
export function useBetaAccess(): void {
  const beta = betaRooms() !== undefined;
  const { api, profiles, userId } = useSession();
  const venue = useVenueMode(!beta);
  const status = beta && venue.mode === 'on' && venue.status.available ? venue.status : null;
  const reads = useMemo(() => venueApi(api), [api]);
  const key = status ? `${userId ?? ''}:${status.venue.id}` : 'off';
  /** Whether the venue answers this read: a refusal (`not_offered` among them) or no answer yet is no. */
  const answers = (read: (signal: AbortSignal) => Promise<{ ok: boolean }>) => async (signal: AbortSignal) => ({
    ok: true as const,
    data: status !== null && (await read(signal)).ok,
  });
  const staking = useResource(answers(reads.staking), `beta-staking:${key}`);
  const vaults = useResource(answers(reads.vaults), `beta-vaults:${key}`);
  const offered = (read: typeof staking.resource) => read.status === 'ready' && read.data;
  if (beta)
    setBetaAccess({
      business: profiles.status === 'ready' && profiles.businesses.length > 0,
      venue: venue.mode === 'on',
      staking: offered(staking.resource),
      vaults: offered(vaults.resource),
    });
}
