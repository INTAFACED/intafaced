import { Button } from '@intafaced/ui/lit';
import { RefusalBox } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { uiCopy } from '../../../shared/ui-copy';
import type { createProtocolApi } from '../api';
import { auditCopy } from './audit-copy';
import { canRetry, failureRefusal } from './failure';

/**
 * The audit room's per-product list (/chain/audit, /protocol/audit; D-developer-compliance-02): Swap, Pools, Lending,
 * Orders, Launch and Bridge, each with the external audit the owner recorded or "External audit: not done". No check mark
 * and no positive "audited" claim is ever drawn; the internal checks are named as our own tests.
 */
export function AuditProducts({ api }: { api: Pick<ReturnType<typeof createProtocolApi>, 'auditProducts'> }) {
  const { language } = usePreferences();
  const { t } = auditCopy.forLocale(language);
  const ui = uiCopy.forLocale(language);
  const { resource, reload } = useResource((signal) => api.auditProducts(signal), 'protocol:audit-products');
  return (
    <section aria-labelledby="audit-products-title">
      <h2 id="audit-products-title">{t('productsTitle')}</h2>
      <p className="lt-hint">{t('productsNote')}</p>
      {resource.status === 'loading' && (
        <p className="lt-hint" role="status">
          {ui.t('loading')}…
        </p>
      )}
      {resource.status === 'failed' && (
        <div data-testid="failure">
          <RefusalBox refusal={failureRefusal(resource.failure, language)} />
          {canRetry(resource.failure) ? <Button onClick={reload}>{ui.t('retry')}</Button> : null}
        </div>
      )}
      {resource.status === 'ready' && (
        <table className="lt-table">
          <caption className="lt-sr">{t('productsTitle')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('hdr_product')}</th>
              <th scope="col">{t('hdr_external')}</th>
              <th scope="col">{t('hdr_internal')}</th>
            </tr>
          </thead>
          <tbody>
            {resource.data.products.map((row) => (
              <tr key={row.product}>
                <th scope="row">{t(`product_${row.product}`)}</th>
                <td data-label={t('hdr_external')}>
                  {row.external ? (
                    <>
                      {t('externalDone', {
                        by: row.external.signedBy,
                        at: row.external.signedAt,
                        scope: row.external.scope ?? row.external.id,
                      })}{' '}
                      {row.external.reportUrl ? (
                        <a className="lt-link" href={row.external.reportUrl} rel="noreferrer noopener" target="_blank">
                          {t('externalReport')}
                        </a>
                      ) : (
                        t('externalNoLink', { path: row.external.packagePath })
                      )}
                    </>
                  ) : (
                    t('externalNone')
                  )}
                </td>
                <td data-label={t('hdr_internal')}>{resource.data.internal.length > 0 ? t('internal') : t('internalNone')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
