import './money.css';
import './volt.css';
import type { ScreenProps } from '../../app/screen-types';
import BalanceEntries from './BalanceEntries';
import Activity from './Activity';
import ActivityDetail from './ActivityDetail';
import Pnl from './pnl/Pnl';
import { MoneyRoom } from './MoneyRoom';
import { SourceEntries, asksForSourceRecords } from './SourceEntries';
import { useVenueMode } from '../../features/trade/use-venue-mode';

/** Money tab (UI-SPEC 5.3 and 5.4): Assets at `/money` (MoneyRoom.tsx), the activity list at `/money/activity`, profit and loss at `/money/pnl`, one transaction at `/money/activity/:id`, the entries behind one coin's balance at `/money/balance/:asset`. */
export default function MoneyScreen({ path, search, params }: ScreenProps) {
  if (path.startsWith('/money/balance/'))
    return <Entries rawAsset={params.asset ?? path.slice('/money/balance/'.length)} search={search} />;
  if (path === '/money/pnl') return <Pnl search={search} />;
  if (path === '/money/activity') return <Activity search={search} />;
  if (path.startsWith('/money/activity/')) return <ActivityDetail rawId={params.id ?? path.slice('/money/activity/'.length)} />;
  return <MoneyRoom />;
}

/**
 * `/money/balance/:asset`, what makes one figure. With the user-venue door on and a source named in the link (every
 * Assets row names one, and so does the asset list's history link for a retired coin, J-wallet-01 #5), the records of
 * the place that holds it (J-portfolio-01 #6); otherwise, our ledger's entries for the coin (the custodial branch).
 */
function Entries({ rawAsset, search }: { rawAsset: string; search: string }) {
  const venue = useVenueMode();
  if (venue.mode === 'on' && venue.status.available && asksForSourceRecords(search))
    return <SourceEntries status={venue.status} rawAsset={rawAsset} search={search} />;
  return <BalanceEntries rawAsset={rawAsset} search={search} />;
}
