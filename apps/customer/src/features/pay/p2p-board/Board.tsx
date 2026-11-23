// volt-room: /p2p
import { OverviewTemplate, Tabs } from '@intafaced/ui/lit/templates';
import { payCopy } from '../copy';
import type { PersonalPayApi } from '../pay-api';
import { P2POffers } from '../P2POffers';
import { P2PEligibilityPanel } from '../personal/Eligibility';

/** The P2P rooms, in the order every P2P page lists them (`personal/MethodsRoom.tsx`). */
const P2P_ROOMS = [
  ['/p2p', 'offers'],
  ['/uc/order', 'yourOrders'],
  ['/uc/ad', 'yourOffers'],
  ['/p2p/methods', 'paymentMethods'],
  ['/p2p/access', 'tradingAccess'],
] as const;

/**
 * `/p2p`, the offer board, on the overview template: the P2P rooms above, the trading checks and the board as its
 * sections. An open offer (`?offerId=`) has the same checks beside its take form, so the board lists them only when no
 * offer is open.
 */
export function P2PBoard({ pay, userId, offerOpen }: { pay: PersonalPayApi; userId: string | null; offerOpen: boolean }) {
  return (
    <OverviewTemplate
      title={payCopy.t('personToPerson')}
      state={{ kind: 'ready' }}
      rooms={
        <Tabs label={payCopy.t('p2pRooms')} current="/p2p" items={P2P_ROOMS.map(([href, key]) => ({ href, label: payCopy.t(key) }))} />
      }
      hero={null}
      sections={
        <>
          {offerOpen ? null : <P2PEligibilityPanel pay={pay} userId={userId} />}
          <P2POffers pay={pay} userId={userId} mine={false} />
        </>
      }
    />
  );
}
