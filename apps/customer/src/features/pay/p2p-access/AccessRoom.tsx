// volt-room: /p2p/access
import { FlowTemplate, Tabs } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../../shared/preferences';
import { payCopy } from '../copy';
import type { PersonalPayApi } from '../pay-api';
import { P2PEligibilityPanel } from '../personal/Eligibility';
import { OwnCompletion } from '../personal/CompletionRates';
import { TradingProgramme } from './Programme';

/** The P2P rooms, in the order every P2P page lists them (`personal/MethodsRoom.tsx`). */
const P2P_ROOMS = [
  ['/p2p', 'offers'],
  ['/uc/order', 'yourOrders'],
  ['/uc/ad', 'yourOffers'],
  ['/p2p/methods', 'paymentMethods'],
  ['/p2p/access', 'tradingAccess'],
] as const;

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
      state={{ kind: 'ready' }}
      mode={layoutMode === 'pro' ? 'pro' : 'simple'}
      step={
        <div className="lt-stack">
          <Tabs
            label={payCopy.t('p2pRooms')}
            current="/p2p/access"
            items={P2P_ROOMS.map(([href, key]) => ({ href, label: payCopy.t(key) }))}
          />
          <P2PEligibilityPanel pay={pay} userId={userId} />
          <OwnCompletion pay={pay} userId={userId} />
          <TradingProgramme pay={pay} userId={userId} />
        </div>
      }
    />
  );
}
