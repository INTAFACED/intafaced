import { DataTable } from '@intafaced/ui';
import { PaySection } from '../components';
import { BackLink, ComingSoon } from './components';
import { w3cCopy } from './w3c-copy';

/** The report catalog names only formats the current server export API supports. */
export function Reports() {
  const { t } = w3cCopy.useCopy();
  return (
    <div className="stack">
      <BackLink href="/pay/merchant">{t('backMerchant')}</BackLink>
      <PaySection title={t('reportCatalog')} description={t('reportScope')}>
        <DataTable label={t('reportCatalog')} headers={[t('reportKind'), t('reportContents'), t('reportAction')]}>
          {(['payments', 'settlements', 'payouts'] as const).map((kind) => (
            <tr key={kind}>
              <td>{t(`${kind}Report`)}</td>
              <td>{t(`${kind}Contents`)}</td>
              <td>
                <a className="text-link" href={`/pay/reports/exports?report=${kind}#request`}>
                  {t('reportAction')}
                </a>
              </td>
            </tr>
          ))}
        </DataTable>
      </PaySection>
      <ComingSoon title={t('nextBackend')}>{t('reportGaps')}</ComingSoon>
    </div>
  );
}
