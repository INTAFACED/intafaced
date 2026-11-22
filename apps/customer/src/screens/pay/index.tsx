import './pay-screen.css';
import './personal.css';
import '../trade/buy/buy.css';
import type { ScreenProps } from '../../app/screen-types';
import { personalRoomFor } from './deps';
import { PersonalRoom } from '../../features/pay/personal/rooms/PersonalRoom';
import { PayTabs } from './PayTabs';

export { payRooms, tabOf } from './PayTabs';

/** Pay: Send, Receive, Request, Bills and Global (UI-SPEC 5.10). The tab routes are drawn by PayTabs. */
export default function PayScreen(props: ScreenProps) {
  const room = personalRoomFor(props.path);
  return room ? <PersonalRoom match={room} /> : <PayTabs {...props} />;
}
