import { PaySection } from '../../../components';
import { Gate } from '../../components';
import { DateTime } from '../../ui/DateTime';
import { EntityList } from '../../ui/EntityList';
import { useResource } from '../../../../../shared/resource';
import type { SettingsBApi } from '../b-client';
import { reportsCopy as c } from './copy';
import { Covers } from './Exports';
import { columnsFor, hasDateRange, statusesFor } from './model';
import { exportKinds, type ExportJob, type ExportKind } from './schemas';

/** Every report INTAFACED can build for this account, what is in it, and when you last made one. */
export function Reports({ api, role }: { api: SettingsBApi; role: string | null }) {
  const jobs = useResource((signal) => api.reportJobs(undefined, {}, signal), 'reports:catalog');
  return (
    <Gate resource={jobs.resource} retry={jobs.reload}>
      {(page) => <ReportsView jobs={page.items} hasMore={page.nextCursor !== null} role={role} />}
    </Gate>
  );
}

export function ReportsView({ jobs, hasMore, role }: { jobs: readonly ExportJob[]; hasMore: boolean; role: string | null }) {
  const { t } = c.useCopy();
  const latest = (kind: ExportKind) => jobs.find((j) => j.kind === kind && j.status === 'ready');
  return (
    <div className="stack">
      <PaySection title={t('catalogTitle')} description={t('catalogBody')}>
        <EntityList
          label={t('catalogTitle')}
          rows={exportKinds}
          rowKey={(k) => k}
          href={(k) => `/pay/reports/exports?report=${k}#request`}
          columns={[
            { header: t('colReport'), cell: (k) => <strong>{t(`kind_${k}`)}</strong> },
            { header: t('colContents'), cell: (k) => t(`kindHint_${k}`) },
            { header: t('colFilters'), cell: (k) => <Filters kind={k} /> },
            { header: t('colColumns'), cell: (k) => t('columnCount', { n: columnsFor(k, role).length }) },
            {
              header: t('colLastReport'),
              cell: (k) => {
                const job = latest(k);
                return job ? (
                  <>
                    <Covers job={job} />
                    {job.generatedAt && (
                      <small className="pay-cell-note">
                        {t('generated')} <DateTime value={job.generatedAt} />
                      </small>
                    )}
                    {job.asOf && (
                      <small className="pay-cell-note">
                        {t('asOf')} <DateTime value={job.asOf} />
                      </small>
                    )}
                  </>
                ) : (
                  <span className="muted">{hasMore ? t('notInNewest') : t('neverRequested')}</span>
                );
              },
            },
          ]}
          card={(k) => ({
            title: t(`kind_${k}`),
            time: t(`kindHint_${k}`),
            amount: t('columnCount', { n: columnsFor(k, role).length }),
          })}
        />
        <p className="muted">{t('catalogNote')}</p>
      </PaySection>
    </div>
  );
}

function Filters({ kind }: { kind: ExportKind }) {
  const { t } = c.useCopy();
  const parts = [hasDateRange(kind) ? t('filterDates') : null, statusesFor(kind) ? t('filterStatus') : null, t('filterAsset')].filter(Boolean);
  return <>{parts.join(', ')}</>;
}
