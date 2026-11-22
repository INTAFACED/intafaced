import { Button } from '@intafaced/ui/lit';
import { Checkbox } from '@intafaced/ui/lit/templates';
import { Panel } from '../volt/parts';
import { usePreferences } from '../../../shared/preferences';
import { walletCopy } from './copy';
import { useRepresentationAccept, type RepresentationAsk } from './representation';

export type { RepresentationEnd } from './representation';

/**
 * The representation a wallet accepts once per version before its first signing action (D-developer-compliance-03). The
 * person reads the published text, ticks the box and signs the exact message the service returned; the service records
 * it with its version and time only after it checks that this address signed it. Nothing else is offered until then.
 */
export function RepresentationPanel(props: RepresentationAsk) {
  const { status } = props;
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const { agreed, setAgreed, busy, accept } = useRepresentationAccept(props);
  return (
    <Panel title={t('reprTitle')}>
      <div data-panel="representation" data-version={status.version}>
        <p className="lt-hint">{t('reprNote')}</p>
        <blockquote data-representation-text>{status.text}</blockquote>
        <p className="lt-hint">{t('reprVersion', { version: status.version })}</p>
        <Checkbox label={t('reprAgree')} checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
        <Button tone="primary" disabled={!agreed || busy} onClick={() => void accept()}>
          {t('reprAccept')}
        </Button>
      </div>
    </Panel>
  );
}
