// volt-room: /uc/ad
import { OverviewTemplate } from '@intafaced/ui/lit/templates';
import { payCopy } from '../copy';
import { P2PTabs } from '../p2p-tabs';
import type { PersonalPayApi } from '../pay-api';
import { P2POffers } from '../P2POffers';

/**
 * `/uc/ad` (also `/p2p/offers`), the person's own offers, on the overview template like the board: the P2P rooms above,
 * then their offers, paused and closed ads, edits today, their hours and bulk changes as one section in the kit's rhythm.
 */
export function P2PMine({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  return (
    <OverviewTemplate
      title={payCopy.t('personToPerson')}
      state={{ kind: 'ready' }}
      section={<P2PTabs />}
      hero={null}
      sections={<P2POffers pay={pay} userId={userId} mine />}
    />
  );
}
