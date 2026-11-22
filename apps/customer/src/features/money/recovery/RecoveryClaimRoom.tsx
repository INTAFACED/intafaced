import { FlowTemplate, Tabs } from '@intafaced/ui/lit/templates';
import { useBankNav } from '../bank-nav';
import { recoveryClaimCopy } from '../recovery-claim-copy';
import { RecoveryClaim } from './RecoveryClaim';

/**
 * `/bank/recovery` (RC-identity-08): where a person named to receive someone's account claims it with their keys, on
 * the flow template. The bank's room row and the way back to the overview stay as the old bank page drew them.
 */
export function RecoveryClaimRoom() {
  const { t } = recoveryClaimCopy.useCopy();
  const nav = useBankNav('Recovery');
  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      roomAction={
        <a className="lt-link" href="/bank">
          {nav.overview}
        </a>
      }
      state={{ kind: 'ready' }}
      step={
        <>
          <Tabs data-testid="money-bank-nav" label={nav.label} items={nav.items} current={nav.current} />
          <RecoveryClaim />
        </>
      }
    />
  );
}
