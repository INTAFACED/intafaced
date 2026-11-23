// volt-room: /p2p/access
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../../shared/preferences';
import { payCopy } from '../copy';
import { P2PTabs } from '../p2p-tabs';
import type { PersonalPayApi } from '../pay-api';
import { P2PEligibilityPanel } from '../personal/Eligibility';
import { OwnCompletion } from '../personal/CompletionRates';
import { TradingProgramme } from './Programme';

/**
 * `/p2p/access` (also `/p2p?view=access`), the person's own P2P trading access on the flow template: the P2P rooms above,
 * then the trading checks, their own completion rate with its one appeal, and the trading programme.
 */
export function AccessRoom({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const { layoutMode } = usePreferences();
  return (
    <FlowTemplate
      title={payCopy.t('personToPerson')}
      description={payCopy.t('externalPaymentLedgerEscrowAndARecorded')}
      // Also drawn at /p2p?view=access, so the room names its tab rather than the route.
      section={<P2PTabs current="/p2p/access" />}
      state={{ kind: 'ready' }}
      mode={layoutMode === 'pro' ? 'pro' : 'simple'}
      step={
        <div className="lt-stack">
          <P2PEligibilityPanel pay={pay} userId={userId} />
          <OwnCompletion pay={pay} userId={userId} />
          <TradingProgramme pay={pay} userId={userId} />
        </div>
      }
    />
  );
}
