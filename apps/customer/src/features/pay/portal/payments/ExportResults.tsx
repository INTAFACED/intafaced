import { useState } from 'react';
import type { PortalApi } from '../api';
import type { ExportKind } from '../schemas';
import { PortalReview } from '../ui/PortalReview';
import { useRequestId } from './invoice-model';
import { paymentsCopy } from './copy';
import { Facts } from '../components';

/**
 * "Export these results": asks for a file with the filters now on the page. The file is built in the background and
 * lands in Exports. Search text is not part of an export, so the review says when it is being left out.
 */
export function ExportResults({
  portal,
  kind,
  filters,
  searchLeftOut,
  summary,
}: {
  portal: PortalApi;
  kind: ExportKind;
  filters: { from?: string; to?: string; status?: string; assetId?: string };
  searchLeftOut: boolean;
  summary: ReadonlyArray<readonly [string, string]>;
}) {
  const { t } = paymentsCopy.useCopy();
  const key = JSON.stringify([kind, filters]);
  const request = useRequestId(`export:${key}`);
  const [done, setDone] = useState(false);
  return (
    <div className="pp-actions">
      <PortalReview
        title={t('exp_title')}
        variant="secondary"
        description={t('exp_body')}
        review={
          <>
            <Facts items={summary} />
            {searchLeftOut && <p className="muted pp-note">{t('exp_searchLeftOut')}</p>}
          </>
        }
        perform={() => portal.createExport({ requestId: request.id, kind, filters })}
        onConfirmed={() => {
          request.renew();
          setDone(true);
        }}
      />
      {done && (
        <span role="status">
          {t('exp_queued')}{' '}
          <a className="text-link" href="/pay/reports/exports">
            {t('exp_open')}
          </a>
        </span>
      )}
    </div>
  );
}
