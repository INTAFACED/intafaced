import type { PersonalPayApi } from '../pay-api';
import { AccessRoom } from './AccessRoom';
import { MyOffersRoom } from './MyOffersRoom';
import { OfferFormRoom } from './OfferFormRoom';

export type P2PFlowRoomId = 'mine' | 'offer' | 'access';

/**
 * The person-to-person rooms on the flow template: My offers (`/uc/ad`), Create offer (`/uc/ad/create`), Edit offer
 * (`/uc/ad/update`) and Trading access (`/p2p/access`). `P2P.tsx` decides which one a path is; each room draws itself.
 */
export function P2PFlowRoom({
  room,
  pay,
  userId,
  current,
  params,
}: {
  room: P2PFlowRoomId;
  pay: PersonalPayApi;
  userId: string | null;
  current: string;
  params: URLSearchParams;
}) {
  if (room === 'access') return <AccessRoom pay={pay} userId={userId} />;
  if (room === 'offer') return <OfferFormRoom pay={pay} userId={userId} current={current} params={params} />;
  return <MyOffersRoom pay={pay} userId={userId} />;
}
