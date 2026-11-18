import './money.css';
import type { ScreenProps } from '../../app/screen-types';
import BalanceEntries from './BalanceEntries';
import Activity from './Activity';
import ActivityDetail from './ActivityDetail';
import Pnl from './Pnl';
import Portfolio from './Portfolio';
import { WhereItSits } from './WhereItSits';
import { SourceEntries, asksForSourceRecords } from './SourceEntries';
import { useVenueMode } from '../../features/trade/use-venue-mode';

/** Money tab (UI-SPEC 5.3 and 5.4): the portfolio at `/money`, the activity list at `/money/activity`, profit and loss at `/money/pnl`, one transaction at `/money/activity/:id`, the entries behind one coin's balance at `/money/balance/:asset`. */
export default function MoneyScreen({ path, search, params }: ScreenProps) {
  if (path.startsWith('/money/balance/'))
    return <Entries rawAsset={params.asset ?? path.slice('/money/balance/'.length)} search={search} />;
  if (path === '/money/pnl') return <Pnl search={search} />;
  if (path === '/money/activity') return <Activity search={search} />;
  if (path.startsWith('/money/activity/')) return <ActivityDetail rawId={params.id ?? path.slice('/money/activity/'.length)} />;
  return <MoneyHome />;
}

/**
 * `/money`, Assets. With svc-trade's user-venue door on (the launch model, OWNER 226), what the person holds is where it
 * sits: their own wallet, read from the chain, and their venue account, read from the venue (J-wallet-01). With the door
 * off, and while its first answer is on its way, today's portfolio.
 */
function MoneyHome() {
  const venue = useVenueMode();
  if (venue.mode === 'on' && venue.status.available) return <WhereItSits status={venue.status} />;
  return <Portfolio />;
}

/**
 * `/money/balance/:asset`, what makes one figure. With the user-venue door on and a source named in the link (every
 * Assets row names one), the records of the place that holds it (J-portfolio-01 #6); otherwise, our ledger's entries
 * for the coin (the custodial branch, and the asset list's history link for a retired coin, J-wallet-01 #5).
 */
function Entries({ rawAsset, search }: { rawAsset: string; search: string }) {
  const venue = useVenueMode();
  if (venue.mode === 'on' && venue.status.available && asksForSourceRecords(search))
    return <SourceEntries status={venue.status} rawAsset={rawAsset} search={search} />;
  return <BalanceEntries rawAsset={rawAsset} search={search} />;
}
