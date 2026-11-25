import { Suspense, createContext, lazy, useContext, type ReactNode } from 'react';
import { Surface } from '@intafaced/ui/lit';
import { classifyRefusal } from '../../data/refusal-codes';
import { networkLabel } from '../../features/protocol/blockers';
import { APP_CHAIN_ID } from '../../features/protocol/wallet/eip1193';
import { WalletProvider } from '../../features/protocol/wallet/WalletProvider';
import { useOwner } from '../../features/trade/venue/VenueKit';
import { WalletBar } from '../../features/trade/venue/WalletBar';
import type { VenueUp } from '../../features/trade/venue-api';
import { useVenueMode } from '../../features/trade/use-venue-mode';
import { usePreferences } from '../../shared/preferences';
import { usePartnerStanding, useStanding } from '../money/standing-data';
import { StandingTotal } from '../money/StandingTotal';
import { standingCopy } from '../money/standing-copy';
import type { Loadable } from './deps';

const PayYourself = lazy(() => import('./PayYourself'));

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

/**
 * The launch model's total, unless the person is not verified yet: while the bank refuses Home's summary for that, Home
 * keeps asking for verification where the total would be, with its Verify now (J-cex-spot-01 #1), and shows today's
 * Home until they are.
 */
export function launchStanding(venue: VenueUp | null, portfolio: Loadable<unknown>): VenueUp | null {
  if (!venue) return null;
  return portfolio.status === 'refused' && classifyRefusal(portfolio.code) === 'verify' ? null : venue;
}

/** Where the person stands, read once for the whole page: the hero draws the total, the side column Spendable now. */
type Read = {
  status: VenueUp;
  owner: string | null;
  standing?: ReturnType<typeof useStanding>;
};
const StandingContext = createContext<Read | null>(null);

/**
 * The wallet and the standing read for everything inside it: Home's hero and its side column share one read. Without
 * the launch model (`status` null) it draws its children as they are.
 */
export function StandingScope({ status, children }: { status: VenueUp | null; children: ReactNode }) {
  if (!status) return <>{children}</>;
  const chainId = status.chainId ?? APP_CHAIN_ID;
  return (
    <WalletProvider chainId={chainId} scope="home">
      <Owner status={status} chainId={chainId}>
        {children}
      </Owner>
    </WalletProvider>
  );
}

function Owner({ status, chainId, children }: { status: VenueUp; chainId: number; children: ReactNode }) {
  const owner = useOwner();
  if (!owner) return <StandingContext.Provider value={{ status, owner: null }}>{children}</StandingContext.Provider>;
  return (
    <OwnerRead owner={owner} status={status} chainId={chainId}>
      {children}
    </OwnerRead>
  );
}

function OwnerRead({ owner, status, chainId, children }: { owner: string; status: VenueUp; chainId: number; children: ReactNode }) {
  const { displayCurrency } = usePreferences();
  const standing = useStanding(
    owner,
    chainId,
    { network: networkLabel(chainId).name, venue: status.venue.displayName, venueTest: status.test },
    displayCurrency === 'BTC' ? 'BTC' : 'USD',
  );
  return <StandingContext.Provider value={{ status, owner, standing }}>{children}</StandingContext.Provider>;
}

/** Where the person stands, as Home's hero reads it (inside a `StandingScope`); null before a wallet or without the launch model. */
export function useHomeStanding(): ReturnType<typeof useStanding>['standing'] | null {
  return useContext(StandingContext)?.standing?.standing ?? null;
}

/** The total where the person stands (inside a `StandingScope`): before a wallet, the partner's part and Connect. */
export function StandingFigure({
  hidden,
  pro = false,
  face,
  how,
}: {
  hidden: boolean;
  pro?: boolean;
  face?: ReactNode;
  how?: { id: string; open: boolean; lead?: ReactNode };
}) {
  const { t } = standingCopy.useCopy();
  const { displayCurrency } = usePreferences();
  const read = useContext(StandingContext);
  if (!read) return null;
  if (!read.owner || !read.standing)
    return (
      <>
        <PartnerBeforeWallet hidden={hidden} pro={pro} how={how} />
        <div data-testid="home-standing-connect" className="lt-stack">
          <p className="lt-hint">{t('Connect first')}</p>
          <WalletBar />
        </div>
      </>
    );
  return (
    <StandingTotal
      standing={read.standing.standing}
      pricesFailed={read.standing.pricesFailed}
      displayCurrency={displayCurrency}
      hidden={hidden}
      pro={pro}
      testId="home-standing"
      face={face}
      how={how}
    />
  );
}

/** J-bank-31: Spendable now and Pay yourself (inside a `StandingScope`), loaded with its own copy once a wallet is read. */
export function StandingSpendable({ hidden, panel, fold = false }: { hidden: boolean; panel?: string; fold?: boolean }) {
  const read = useContext(StandingContext);
  if (!read?.owner || !read.standing || hidden) return null;
  const { partner, venue, wallet } = read.standing;
  const body = (
    <Suspense fallback={null}>
      <PayYourself owner={read.owner} status={read.status} partner={partner} venue={venue} wallet={wallet} fold={fold} />
    </Suspense>
  );
  return panel ? <Surface className={panel}>{body}</Surface> : body;
}

/** Home Pro's total: the figure and Spendable now together, as one block. */
export function HomeStanding({ status, hidden, pro = false }: { status: VenueUp; hidden: boolean; pro?: boolean }) {
  return (
    <StandingScope status={status}>
      <StandingFigure hidden={hidden} pro={pro} />
      <StandingSpendable hidden={hidden} />
    </StandingScope>
  );
}

/**
 * Before a wallet is connected: the partner account needs no wallet to be read, so a person whose money the
 * partner holds sees its total at once, the part named with its source and time, exactly as Assets shows it. The wallet
 * and the venue account are not in it until a wallet is connected, and the line under it says so. Nothing while the
 * partner holds none of this person's money or its first answer is on its way.
 */
function PartnerBeforeWallet({
  hidden,
  pro,
  how,
}: {
  hidden: boolean;
  pro: boolean;
  how?: { id: string; open: boolean; lead?: ReactNode };
}) {
  const { displayCurrency } = usePreferences();
  const { partner, standing, pricesFailed } = usePartnerStanding(displayCurrency === 'BTC' ? 'BTC' : 'USD');
  if (partner.state === 'none' || partner.state === 'reading') return null;
  return (
    <StandingTotal
      standing={standing}
      pricesFailed={pricesFailed}
      displayCurrency={displayCurrency}
      hidden={hidden}
      pro={pro}
      testId="home-standing-before-wallet"
      how={how}
    />
  );
}
