import { DataTable, Failure, Loading, Panel } from '../../shared/ui';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import type { createProtocolApi } from './api';
import { auditCopy } from './audit-copy';

/**
 * The audit room's per-product list (/chain/audit, /protocol/audit; D-developer-compliance-02): Swap, Pools, Lending,
 * Orders, Launch and Bridge, each with the external audit the owner recorded or "External audit: not done". No check mark
 * and no positive "audited" claim is ever drawn; the internal checks are named as our own tests.
 */
export function AuditProducts({ api }: { api: Pick<ReturnType<typeof createProtocolApi>, 'auditProducts'> }) {
  const { language } = usePreferences();
  const { t } = auditCopy.forLocale(language);
  const { resource, reload } = useResource((signal) => api.auditProducts(signal), 'protocol:audit-products');
  const headers = [t('hdr_product'), t('hdr_external'), t('hdr_internal')];
  return (
    <Panel title={t('productsTitle')}>
      <p className="muted">{t('productsNote')}</p>
      {resource.status === 'loading' && <Loading />}
      {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
      {resource.status === 'ready' && (
        <DataTable label={t('productsTitle')} headers={headers}>
          {resource.data.products.map((row) => (
            <tr key={row.product}>
              <th scope="row">{t(`product_${row.product}`)}</th>
              <td>
                {row.external ? (
                  <>
                    {t('externalDone', {
                      by: row.external.signedBy,
                      at: row.external.signedAt,
                      scope: row.external.scope ?? row.external.id,
                    })}{' '}
                    {row.external.reportUrl ? (
                      <a href={row.external.reportUrl} rel="noreferrer noopener" target="_blank">
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
              <td>{resource.data.internal.length > 0 ? t('internal') : t('internalNone')}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </Panel>
  );
}
