import { useState } from 'react';
import { Button } from '@intafaced/ui';
import type { CatalogCopy as CopyReport } from '@intafaced/contracts/merchant-catalog';
import type { PortalApi } from '../api';
import { EntityList } from '../ui/EntityList';
import { useMayAddProducts } from './access';
import { catalogCopy as c } from './copy';

const productHref = (id: string) => `/pay/products/${encodeURIComponent(id)}`;

/**
 * Copy to live / Copy to test (J-merchant-03 step 6): every active product of this catalogue that has no copy in the
 * other yet goes across with its active prices, after one more press. The report names each product made and each one
 * skipped with why, so a second copy shows what was already there instead of making it again. Copying changes only the
 * other catalogue, so the list on screen stays as it is; the page keys this control by catalogue, so a report never
 * outlives a switch to the other one.
 */
export function CatalogCopyControl({ portal, from }: { portal: PortalApi; from: 'live' | 'test' }) {
  const { t } = c.useCopy();
  const may = useMayAddProducts();
  const to = from === 'test' ? 'live' : 'test';
  const label = t(to === 'live' ? 'copyToLive' : 'copyToTest');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<CopyReport | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  if (!may.allowed) return null;

  async function run() {
    setBusy(true);
    setRefused(null);
    try {
      const result = await portal.copyCatalog(from, to);
      if (result.ok) {
        setReport(result.data);
        setAsking(false);
      } else setRefused(result.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {asking ? (
        <div className="pp-actions" role="group" aria-label={label}>
          <span>{t(to === 'live' ? 'copyAskLive' : 'copyAskTest')}</span>
          <Button variant="primary" disabled={busy} onClick={() => void run()}>
            {busy ? t('copying') : label}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setAsking(false)}>
            {t('copyCancel')}
          </Button>
        </div>
      ) : (
        <div className="pp-actions">
          <Button
            variant="secondary"
            onClick={() => {
              setReport(null);
              setAsking(true);
            }}
          >
            {label}
          </Button>
        </div>
      )}
      {refused && (
        <p className="pp-callout" role="alert">
          {refused}
        </p>
      )}
      {report && <CopyReportView report={report} />}
    </div>
  );
}

function CopyReportView({ report }: { report: CopyReport }) {
  const { t } = c.useCopy();
  const where = t(report.to === 'live' ? 'where_live' : 'where_test');
  return (
    <div className="stack">
      <p className="pp-confirmed" role="status">
        {t('copyDone', { created: String(report.created.length), skipped: String(report.skipped.length), where })}
      </p>
      {report.created.length > 0 && (
        <EntityList
          label={t('copyCreatedLabel')}
          rows={report.created}
          rowKey={(row) => row.sourceId}
          href={(row) => productHref(row.productId)}
          columns={[
            { header: t('colName'), cell: (row) => <strong>{row.name}</strong> },
            { header: t('colId'), cell: (row) => <code>{row.productKey}</code> },
            { header: t('copyColPrices'), cell: (row) => row.prices },
          ]}
          card={(row) => ({ title: row.name, status: <code>{row.productKey}</code> })}
        />
      )}
      {report.skipped.length > 0 && (
        <EntityList
          label={t('copySkippedLabel')}
          rows={report.skipped}
          rowKey={(row) => row.sourceId}
          columns={[
            { header: t('colName'), cell: (row) => <strong>{row.name}</strong> },
            { header: t('colId'), cell: (row) => <code>{row.productKey}</code> },
            { header: t('copyColWhy'), cell: (row) => t(`copySkip_${row.reason}`, { where }) },
          ]}
          card={(row) => ({ title: row.name, status: t(`copySkip_${row.reason}`, { where }) })}
        />
      )}
    </div>
  );
}
