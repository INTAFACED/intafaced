import { useResource } from '../../../shared/resource';
import type { VenueMode } from '../../../features/trade/use-venue-mode';
import { ReadProblem, VenueFrame, useVenueApi } from '../../../features/trade/venue/VenueKit';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { KYC_REQUIRED } from './venue-access';
import { VenueSpotDesk } from './VenueSpotDesk';
import { VenueVerifyDesk } from './VenueVerifyDesk';

/** The desk's own symbol form ("BTC-USDC"), whichever way the address writes it. */
const venueSymbolOf = (pair: string) => pair.replace(/[/_]/g, '-').toUpperCase();

/**
 * The spot page in venue mode: loading, today's desk for a pair the venue doesn't list, the Verify desk, the venue's
 * notice when its markets can't be read, else the venue desk.
 */
export function spotGateChoice(
  available: boolean,
  markets: { status: 'loading' } | { status: 'failed'; code?: string } | { status: 'ready'; listed: boolean },
): 'loading' | 'today' | 'down' | 'verify' | 'venue' {
  if (!available) return 'down';
  if (markets.status === 'loading') return 'loading';
  if (markets.status === 'failed') return markets.code === KYC_REQUIRED ? 'verify' : 'down';
  return markets.listed ? 'venue' : 'today';
}

/** The spot desk in venue mode: on when `/venue/status` says the door is on and the venue lists this pair as spot. */
export function VenueSpotGate({
  mode,
  pair,
  fallback,
}: {
  mode: Extract<VenueMode, { mode: 'on' }>;
  pair: string;
  fallback: React.ReactNode;
}) {
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const markets = useResource((signal) => venue.markets(signal), 'venue-markets');
  const symbol = venueSymbolOf(pair);
  const r = markets.resource;
  const market = r.status === 'ready' ? r.data.value.find((m) => m.kind === 'spot' && m.symbol === symbol) : undefined;
  const choice = spotGateChoice(
    mode.status.available,
    r.status === 'ready'
      ? { status: 'ready', listed: market !== undefined }
      : r.status === 'failed'
        ? { status: 'failed', code: r.failure.code }
        : { status: 'loading' },
  );
  if (choice === 'today') return <>{fallback}</>;
  if (choice === 'verify' && mode.status.available)
    return (
      <VenueFrame mode={mode}>
        <VenueVerifyDesk status={mode.status} symbol={symbol} />
      </VenueFrame>
    );
  if (choice === 'loading') {
    return (
      <div data-testid="if-desk" className="if-desk" data-venue="on">
        <p role="status" aria-busy="true" data-testid="venue-reading">
          {v('Reading markets')}
        </p>
      </div>
    );
  }
  if (choice === 'down' || !market || !mode.status.available) {
    return (
      <div data-testid="if-desk" className="if-desk" data-venue="on">
        {!mode.status.available ? (
          <p className="failure" role="alert" data-testid="venue-down">
            {v('Venue unavailable', { detail: mode.status.refusal.detail })}
          </p>
        ) : (
          <ReadProblem failure={r.status === 'failed' ? r.failure : null} venueName={mode.status.venue.displayName} />
        )}
      </div>
    );
  }
  return (
    <VenueFrame mode={mode}>
      <VenueSpotDesk status={mode.status} market={market} markets={r.status === 'ready' ? r.data.value : [market]} />
    </VenueFrame>
  );
}
