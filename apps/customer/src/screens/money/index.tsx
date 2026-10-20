import './money.css';
import type { ScreenProps } from '../../app/screen-types';
import BalanceEntries from './BalanceEntries';
import Activity from './Activity';
import ActivityDetail from './ActivityDetail';
import Pnl from './Pnl';
import Portfolio from './Portfolio';

/** Money tab (UI-SPEC 5.3 and 5.4): the portfolio at `/money`, the activity list at `/money/activity`, profit and loss at `/money/pnl`, one transaction at `/money/activity/:id`, the entries behind one coin's balance at `/money/balance/:asset`. */
export default function MoneyScreen({ path, search, params }: ScreenProps) {
  if (path.startsWith('/money/balance/'))
    return <BalanceEntries rawAsset={params.asset ?? path.slice('/money/balance/'.length)} search={search} />;
  if (path === '/money/pnl') return <Pnl />;
  if (path === '/money/activity') return <Activity search={search} />;
  if (path.startsWith('/money/activity/')) return <ActivityDetail rawId={params.id ?? path.slice('/money/activity/'.length)} />;
  return <Portfolio />;
}
