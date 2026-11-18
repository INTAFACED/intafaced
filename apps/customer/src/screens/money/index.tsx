import './money.css';
import type { ScreenProps } from '../../app/screen-types';
import BalanceEntries from './BalanceEntries';
import Activity from './Activity';
import ActivityDetail from './ActivityDetail';
import Pnl from './Pnl';
import Portfolio from './Portfolio';
import { WhereItSits } from './WhereItSits';
import { useVenueMode } from '../../features/trade/use-venue-mode';

/** Money tab (UI-SPEC 5.3 and 5.4): the portfolio at `/money`, the activity list at `/money/activity`, profit and loss at `/money/pnl`, one transaction at `/money/activity/:id`, the entries behind one coin's balance at `/money/balance/:asset`. */
export default function MoneyScreen({ path, search, params }: ScreenProps) {
  if (path.startsWith('/money/balance/'))
    return <BalanceEntries rawAsset={params.asset ?? path.slice('/money/balance/'.length)} search={search} />;
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
