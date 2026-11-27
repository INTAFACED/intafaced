import { useState } from 'react';
import { consumeMenuSpotNavigation, defaultDeskPair } from '../../../app/navigation';
import { useResource } from '../../../shared/resource';
import type { VenueMode } from '../../../features/trade/use-venue-mode';
import type { VenueMarket, VenueUp } from '../../../features/trade/venue-api';
import { DeskTemplate } from '@intafaced/ui/lit/templates';
import { VenueFrame, useOwner, useVenueApi } from '../../../features/trade/venue/VenueKit';
import { DeskSessionProvider } from '../../../features/trade/venue/VenueSession';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { deskCopy } from './copy';
import { KYC_REQUIRED } from './venue-access';
import { VenueSpotDesk } from './VenueSpotDesk';
import { VenueVerifyDesk } from './VenueVerifyDesk';

/** The desk's own symbol form ("BTC-USDC"), whichever way the address writes it. */
const venueSymbolOf = (pair: string) => pair.replace(/[/_]/g, '-').toUpperCase();

/**
 * Picks the venue spot market for `symbol`. Exact matches always win. When opened from a generic menu link
 * (`Trade › Spot` or phone Pro `Trade` tab on the default desk pair `BTC-USDT`) and the venue quotes spot in another
 * currency (e.g. `BTC-USDC`), resolves to the venue's spot market on the same base asset or its first listed spot
 * market; explicit `/trade/spot/*` addresses stay on exact matching so custodial pairs remain reachable.
 */
export function pickVenueSpotMarket<M extends Pick<VenueMarket, 'kind' | 'symbol' | 'baseAsset'>>(
  markets: readonly M[],
  symbol: string,
  fromMenu = false,
): M | undefined {
  const spot = markets.filter((m) => m.kind === 'spot');
  const exact = spot.find((m) => m.symbol === symbol);
  if (exact) return exact;
  if (!fromMenu || symbol !== defaultDeskPair) return undefined;
  const base = defaultDeskPair.split('-')[0];
  return spot.find((m) => m.baseAsset === base) ?? spot[0];
}

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

/**
 * The spot desk's trading session, for the wallet the desk's own frame connects: the owner is read inside `VenueFrame`,
 * whose wallet it is, so on a venue whose orders a session key signs the desk offers the session and signs with it.
 */
function SpotDeskSession({ status, children }: { status: VenueUp; children: React.ReactNode }) {
  const owner = useOwner();
  return (
    <DeskSessionProvider owner={owner} status={status}>
      {children}
    </DeskSessionProvider>
  );
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
  const d = deskCopy.useCopy().t;
  const venue = useVenueApi();
  const markets = useResource((signal) => venue.markets(signal), 'venue-markets');
  const symbol = venueSymbolOf(pair);
  const [fromMenu] = useState(consumeMenuSpotNavigation);
  const r = markets.resource;
  const market = r.status === 'ready' ? pickVenueSpotMarket(r.data.value, symbol, fromMenu) : undefined;
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
    // The venue's markets are still being read: the desk's own loading state, with the words it reads them in.
    return (
      <div data-testid="if-desk" data-venue="on">
        <DeskTemplate
          title={d('Spot desk')}
          description={v('Reading markets')}
          mode="pro"
          state={{ kind: 'loading' }}
          instrument={null}
          chart={null}
          ticket={null}
        />
      </div>
    );
  }
  if (choice === 'down' || !market || !mode.status.available) {
    // The venue is off, or its markets can't be read: the whole desk is that refusal, in the venue's own words.
    const failure = r.status === 'failed' ? r.failure : null;
    const body = !mode.status.available
      ? v('Venue unavailable', { detail: mode.status.refusal.detail })
      : failure
        ? failure.code === 'trade.venue.venue_down'
          ? v('Venue down', { venue: mode.status.venue.displayName, detail: failure.message })
          : v('Read failed', { detail: failure.message })
        : '';
    return (
      <div data-testid="if-desk" data-venue="on">
        <DeskTemplate
          title={d('Spot desk')}
          mode="pro"
          state={{
            kind: 'refused',
            refusal: {
              variant: 'unreachable',
              title: d('Couldn’t load this market'),
              body,
            },
          }}
          instrument={null}
          chart={null}
          ticket={null}
        />
      </div>
    );
  }
  return (
    <VenueFrame mode={mode}>
      {/* A venue whose orders a trading session's key signs (status `tradesSignedBy`): the desk signs with this tab's key. */}
      <SpotDeskSession status={mode.status}>
        <VenueSpotDesk status={mode.status} market={market} markets={r.status === 'ready' ? r.data.value : [market]} />
      </SpotDeskSession>
    </VenueFrame>
  );
}
