// volt-room: /p2p
import { OverviewTemplate } from '@intafaced/ui/lit/templates';
import { payCopy } from '../copy';
import { P2PTabs } from '../p2p-tabs';
import type { PersonalPayApi } from '../pay-api';
import { P2POffers } from '../P2POffers';
import { P2PEligibilityPanel } from '../personal/Eligibility';

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
      section={<P2PTabs />}
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
