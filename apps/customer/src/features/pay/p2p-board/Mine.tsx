// volt-room: /uc/ad
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../../shared/preferences';
import { payCopy } from '../copy';
import { P2PTabs } from '../p2p-tabs';
import type { PersonalPayApi } from '../pay-api';
import { P2POffers } from '../P2POffers';

/**
 * `/uc/ad` (also `/p2p/offers`), the person's own offers, on the flow template: the P2P rooms above, then their offers,
 * paused and closed ads, edits today, their hours and bulk changes as one step in the kit's rhythm.
 */
export function P2PMine({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const { layoutMode } = usePreferences();
  return (
    <FlowTemplate
      title={payCopy.t('personToPerson')}
      // Also drawn at /p2p/offers, so the room names its tab rather than the route.
      section={<P2PTabs current="/uc/ad" />}
      state={{ kind: 'ready' }}
      mode={layoutMode === 'pro' ? 'pro' : 'simple'}
      step={<P2POffers pay={pay} userId={userId} mine />}
    />
  );
}
