import './money.css';
import type { ScreenProps } from '../../app/screen-types';
import Activity from './Activity';
import ActivityDetail from './ActivityDetail';
import Portfolio from './Portfolio';

/** Money tab (UI-SPEC 5.3 and 5.4): the portfolio at `/money`, the activity list at `/money/activity`, one transaction at `/money/activity/:id`. */
export default function MoneyScreen({ path, search, params }: ScreenProps) {
  if (path === '/money/activity') return <Activity search={search} />;
  if (path.startsWith('/money/activity/')) return <ActivityDetail rawId={params.id ?? path.slice('/money/activity/'.length)} />;
  return <Portfolio />;
}
