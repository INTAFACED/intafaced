import './money.css';
import type { ScreenProps } from '../../app/screen-types';
import Activity from './Activity';
import Portfolio from './Portfolio';

/** Money tab (UI-SPEC 5.3 and 5.4): the portfolio at `/money`, the activity list at `/money/activity`. */
export default function MoneyScreen({ path, search }: ScreenProps) {
  return path === '/money/activity' ? <Activity search={search} /> : <Portfolio />;
}
