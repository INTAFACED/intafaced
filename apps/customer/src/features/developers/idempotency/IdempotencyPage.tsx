import { DocPage } from '../DocPage';
import { idempotencyCopy } from './idempotency-copy';

/** /developers/idempotency (J-developer-05; DV-auth-03): the rules for placing an order over the API without doubling it. */
export function IdempotencyPage({ title }: { title: string }) {
  const { t } = idempotencyCopy.useCopy();
  return (
    <DocPage id="idempotency" title={title} lead={t('lead')} back={t('back')}>
      <section aria-labelledby="idem-rules" data-testid="developers-idempotency-rules">
        <h2 id="idem-rules">{t('rulesTitle')}</h2>
        <ol>
          <li>{t('rulePrepare')}</li>
          <li>{t('ruleSubmit')}</li>
          <li>{t('ruleReplay')}</li>
          <li>{t('ruleConflict')}</li>
          <li>{t('ruleInProgress')}</li>
        </ol>
      </section>
      <section aria-labelledby="idem-final" data-testid="developers-idempotency-final">
        <h2 id="idem-final">{t('finalTitle')}</h2>
        <p>{t('finalBody')}</p>
        <p>{t('finalRetry')}</p>
      </section>
      <section aria-labelledby="idem-list" data-testid="developers-idempotency-list">
        <h2 id="idem-list">{t('listTitle')}</h2>
        <p>{t('listBody')}</p>
        <p>{t('listMax')}</p>
      </section>
    </DocPage>
  );
}
