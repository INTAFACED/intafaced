import { networkLabel } from '../../features/protocol/blockers';
import { APP_CHAIN_ID } from '../../features/protocol/wallet/eip1193';
import { WalletProvider } from '../../features/protocol/wallet/WalletProvider';
import { WalletBar, useOwner } from '../../features/trade/venue/VenueKit';
import type { VenueUp } from '../../features/trade/venue-api';
import { useVenueMode } from '../../features/trade/use-venue-mode';
import { usePreferences } from '../../shared/preferences';
import { useStanding } from '../money/standing-data';
import { StandingTotal } from '../money/StandingTotal';
import { standingCopy } from '../money/standing-copy';

/**
 * The launch model on Home (OWNER 226; J-home-ia-01 #1): with svc-trade's user-venue door on, Home's total is where the
 * person stands, read from their wallet, venue account and partner account, exactly as Assets reads and values them
 * (`useStanding`, `StandingTotal`). Null while the door is off or its first answer is on its way: Home then shows today's
 * total, as Assets does.
 */
export function useLaunchVenue(): VenueUp | null {
  const venue = useVenueMode();
  return venue.mode === 'on' && venue.status.available ? venue.status : null;
}

export function HomeStanding({ status, hidden, pro = false }: { status: VenueUp; hidden: boolean; pro?: boolean }) {
  const chainId = status.chainId ?? APP_CHAIN_ID;
  return (
    <WalletProvider chainId={chainId} scope="home">
      <Standing status={status} chainId={chainId} hidden={hidden} pro={pro} />
    </WalletProvider>
  );
}

function Standing({ status, chainId, hidden, pro }: { status: VenueUp; chainId: number; hidden: boolean; pro: boolean }) {
  const { t } = standingCopy.useCopy();
  const owner = useOwner();
  if (!owner)
    return (
      <div data-testid="home-standing-connect" className="form-stack">
        <p className="muted">{t('Connect first')}</p>
        <WalletBar />
      </div>
    );
  return <Read owner={owner} status={status} chainId={chainId} hidden={hidden} pro={pro} />;
}

function Read({ owner, status, chainId, hidden, pro }: { owner: string; status: VenueUp; chainId: number; hidden: boolean; pro: boolean }) {
  const { displayCurrency } = usePreferences();
  const { standing, pricesFailed } = useStanding(
    owner,
    chainId,
    { network: networkLabel(chainId).name, venue: status.venue.displayName, venueTest: status.test },
    displayCurrency === 'BTC' ? 'BTC' : 'USD',
  );
  return (
    <StandingTotal
      standing={standing}
      pricesFailed={pricesFailed}
      displayCurrency={displayCurrency}
      hidden={hidden}
      pro={pro}
      testId="home-standing"
    />
  );
}
