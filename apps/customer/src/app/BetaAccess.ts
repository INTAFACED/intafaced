import { useSession } from '../features/session/session';
import { useVenueMode } from '../features/trade/use-venue-mode';
import { betaRooms, setBetaAccess } from './beta-volt';

/**
 * App's read of what the account can use, for the beta's menus (beta-volt.ts). App draws again whenever the session's
 * profiles or the venue's answer change, and the menus draw after it, so they always see the latest. Other builds ask
 * the venue nothing and set nothing.
 */
export function useBetaAccess(): void {
  const beta = betaRooms() !== undefined;
  const { profiles } = useSession();
  const venue = useVenueMode(!beta);
  if (beta) setBetaAccess({ business: profiles.status === 'ready' && profiles.businesses.length > 0, venue: venue.mode === 'on' });
}
