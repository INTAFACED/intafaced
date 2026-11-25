// volt-room: /pay/reports
// volt-room: portal:reports
import { FinePrint } from '@intafaced/ui/lit';
import { DateTime } from '../../ui/DateTime';
import { EntityList, Gate, Section } from '../../volt/parts';
import { RecordListRoom } from '../../volt/RecordListRoom';
import { useResource } from '../../../../../shared/resource';
import { useSettingsBApi, type SettingsBApi } from '../b-client';
import { reportsCopy as c } from './copy';
import { Covers } from './Exports';
import { columnsFor, hasDateRange, statusesFor } from './model';
import { exportKinds, type ExportJob, type ExportKind } from './schemas';

/** `/pay/reports` on the record-list template: the report catalog, for the account the access resolved. */
export function ReportsRoom() {
  return <RecordListRoom>{({ role }) => ({ list: <LiveReports role={role} /> })}</RecordListRoom>;
}

function LiveReports({ role }: { role: string }) {
  return <Reports api={useSettingsBApi()} role={role} />;
}

/** Every report INTAFACED can build for this account, what is in it, and when you last made one. */
function Reports({ api, role }: { api: SettingsBApi; role: string | null }) {
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
    <div className="lt-stack">
      <Section title={t('catalogTitle')} description={t('catalogBody')}>
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
                      <small className="lt-hint">
                        {t('generated')} <DateTime value={job.generatedAt} />
                      </small>
                    )}
                    {job.asOf && (
                      <small className="lt-hint">
                        {t('asOf')} <DateTime value={job.asOf} />
                      </small>
                    )}
                  </>
                ) : (
                  <span className="lt-muted">{hasMore ? t('notInNewest') : t('neverRequested')}</span>
                );
              },
            },
          ]}
        />
        <p>
          <FinePrint>{t('catalogNote')}</FinePrint>
        </p>
      </Section>
    </div>
  );
}

function Filters({ kind }: { kind: ExportKind }) {
  const { t } = c.useCopy();
  const parts = [hasDateRange(kind) ? t('filterDates') : null, statusesFor(kind) ? t('filterStatus') : null, t('filterAsset')].filter(
    Boolean,
  );
  return <>{parts.join(', ')}</>;
}
