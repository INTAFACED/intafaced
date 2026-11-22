import { Button } from '@intafaced/ui/lit';
import { Checkbox } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../../shared/preferences';
import { walletCopy } from '../wallet/copy';
import { useRepresentationAccept, type RepresentationAsk } from '../wallet/representation';

/**
 * The representation a wallet accepts once per version before its first signing action (D-developer-compliance-03), in
 * a liquidity room on the kit: the published text, the tick and the accept that signs the exact message. The ask and
 * its outcomes are the wallet's own (`useRepresentationAccept`), the same as every other room's.
 */
export function RepresentationStep(props: RepresentationAsk) {
  const { status } = props;
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const { agreed, setAgreed, busy, accept } = useRepresentationAccept(props);
  return (
    <section>
      <h2>{t('reprTitle')}</h2>
      <div data-panel="representation" data-version={status.version}>
        <p className="lt-hint">{t('reprNote')}</p>
        <blockquote data-representation-text>{status.text}</blockquote>
        <p className="lt-hint">{t('reprVersion', { version: status.version })}</p>
        <Checkbox label={t('reprAgree')} checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
        <Button tone="primary" disabled={!agreed || busy} onClick={() => void accept()}>
          {t('reprAccept')}
        </Button>
      </div>
    </section>
  );
}
