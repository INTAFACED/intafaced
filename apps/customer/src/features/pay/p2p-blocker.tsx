import { useResource } from '../../shared/resource';
import { PayNotice } from './components';
import { blockerCopy } from './p2p-blocker-copy';
import type { PersonalPayApi } from './pay-api';

/**
 * The P2P rooms' registry blocker (`feature-registry.ts`, row `p2p`), named where the person sees it: svc-p2p has no
 * owner instrument encryption provider (its health says `instrumentKmsConfigured: false`, always, until one is wired).
 * On the test stack payment details are sealed with a TEST key; with no provider, or when health cannot be read, new
 * details and ads refuse. The rooms that save details or post ads (methods, publish) carry their own notice instead.
 */
export function P2PBlocker({ pay }: { pay: PersonalPayApi }) {
  const { t } = blockerCopy.useCopy();
  const health = useResource((signal) => pay.health(signal), 'pay:p2p-health');
  if (health.resource.status === 'loading') return null;
  const localTest = health.resource.status === 'ready' && health.resource.data.instrumentKeyProvider === 'local-test';
  return (
    <div data-testid="p2p-blocker">
      <PayNotice title={t('title')}>{t(localTest ? 'localTest' : 'none')}</PayNotice>
    </div>
  );
}
