import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox } from '@intafaced/ui';
import { Field } from '../../../ui-kit';
import { PaySection } from '../../../components';
import { ListShell, MoreFooter, SelectField } from '../../components';
import { ToneChip, type StatusTone } from '../../ui/StatusChip';
import { DateTime, useDayText } from '../../ui/DateTime';
import { dateRange, type DatePreset } from '../../ui/FilterRow';
import { EntityList } from '../../ui/EntityList';
import { PortalReview } from '../../ui/PortalReview';
import { useServerList } from '../../ui/useServerList';
import { useUrlParam } from '../../hooks';
import { newRequestId } from '../../model';
import { refusalText } from '../../refusal';
import { useResource } from '../../../../../shared/resource';
import { useSession } from '../../../../session/session';
import type { SettingsBApi } from '../b-client';
import { reportsCopy as c } from './copy';
import {
  canDelete,
  columnLabel,
  columnsFor,
  formatBytes,
  hasDateRange,
  isBuilding,
  isKnownKind,
  rangeParts,
  statusesFor,
  statusWord,
  windowOf,
  windowProblem,
} from './model';
import { exportKinds, exportStatuses, type ExportJob, type ExportKind, type ExportStatus } from './schemas';

const tone: Record<ExportStatus, StatusTone> = {
  queued: 'progress',
  running: 'progress',
  ready: 'done',
  failed: 'failed',
  expired: 'progress',
};
export function JobChip({ status }: { status: ExportStatus }) {
  const { t } = c.useCopy();
  return <ToneChip tone={tone[status]} label={t(`job_${status}`)} tip={t(`jobTip_${status}`)} />;
}
export const kindName = (t: ReturnType<typeof c.useCopy>['t'], kind: string) => (isKnownKind(kind) ? t(`kind_${kind}`) : kind);

/** `/pay/reports/exports`: ask for a report, watch it build, download it, delete it. Only your own account's rows are in it. */
export function Exports({ api, role, now = Date.now() }: { api: SettingsBApi; role: string | null; now?: number }) {
  const { t } = c.useCopy();
  const { userId } = useSession();
  const [kind, setKind] = useUrlParam('kind');
  const [status, setStatus] = useUrlParam('status');
  const [date, setDate] = useUrlParam('date');
  const [from, setFrom] = useUrlParam('from');
  const [to, setTo] = useUrlParam('to');
  const [q, setQ] = useUrlParam('q');
  const range = dateRange(date as DatePreset, now, { from, to });
  const people = useResource((signal) => api.reportPeople(signal), 'reports:people');
  const names = useMemo(() => {
    const map = new Map<string, string>();
    if (people.resource.status === 'ready') for (const m of people.resource.data.items) if (m.label) map.set(m.userId, m.label);
    return map;
  }, [people.resource]);
  const list = useServerList<ExportJob, Record<string, string>>(
    (f, cursor, signal) => api.reportJobs(cursor, { kind: f.kind, status: f.status, from: f.from, to: f.to, search: f.q }, signal),
    { kind, status, from: range.from ?? '', to: range.to ?? '', q: q.trim() },
    (j) => j.jobId,
  );
  const busy = list.state.status === 'ready' && list.state.items.some(isBuilding);
  const { reload } = list;
  // A report that is still being built refreshes itself, quietly, until nothing is waiting.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => reload(true), 4000);
    return () => clearInterval(timer);
  }, [busy, reload]);
  const filtered = Boolean(kind || status || date || q);
  const shown = list.state.status === 'ready' ? list.state.items.length : 0;
  return (
    <div className="stack">
      <div id="request">
        <RequestForm api={api} role={role} onRequested={() => reload()} />
      </div>
      <PaySection title={t('jobsTitle')} description={t('jobsBody')}>
        <div className="pp-filterbar" role="search" aria-label={t('jobsTitle')}>
          <div className="pp-filter-row">
            <Field label={t('search')} value={q} onChange={(e) => setQ(e.target.value)} hint={t('searchHint')} />
            <SelectField
              label={t('colReport')}
              value={kind}
              onChange={setKind}
              options={[['', t('allReports')], ...exportKinds.map((k) => [k, t(`kind_${k}`)] as const)]}
            />
            <SelectField
              label={t('colStatus')}
              value={status}
              onChange={setStatus}
              options={[['', t('allStatuses')], ...exportStatuses.map((s) => [s, t(`job_${s}`)] as const)]}
            />
            <SelectField
              label={t('colRequested')}
              value={date}
              onChange={setDate}
              options={[
                ['', t('anyDate')],
                ['today', t('today')],
                ['7d', t('last7')],
                ['30d', t('last30')],
                ['custom', t('custom')],
              ]}
            />
          </div>
          {date === 'custom' && (
            <div className="pp-filter-row">
              <Field label={t('from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              <Field label={t('to')} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          )}
          <p className="muted pp-count" role="status">
            {list.state.status === 'ready' ? (list.state.hasMore ? t('newestMore', { n: shown }) : t('newestAll', { n: shown })) : ''}
            {filtered && (
              <>
                {' '}
                <button
                  type="button"
                  className="text-link"
                  onClick={() => {
                    setKind('');
                    setStatus('');
                    setDate('');
                    setFrom('');
                    setTo('');
                    setQ('');
                  }}
                >
                  {t('clearFilters')}
                </button>
              </>
            )}
          </p>
        </div>
        <ListShell
          state={list.state}
          retry={() => reload()}
          empty={{
            title: filtered ? t('jobsNoMatchTitle') : t('jobsEmptyTitle'),
            body: filtered ? t('jobsNoMatchBody') : t('jobsEmptyBody'),
          }}
        >
          {(rows) => (
            <>
              <EntityList
                label={t('jobsTitle')}
                rows={rows}
                rowKey={(j) => j.jobId}
                columns={[
                  { header: t('colReport'), cell: (j) => <strong>{kindName(t, j.kind)}</strong> },
                  { header: t('colCovers'), cell: (j) => <Covers job={j} /> },
                  {
                    header: t('colStatus'),
                    cell: (j) => (
                      <>
                        <JobChip status={j.status} />
                        {j.status === 'failed' && <small className="pay-cell-note">{t('failedHelp')}</small>}
                      </>
                    ),
                  },
                  {
                    header: t('colSize'),
                    cell: (j) =>
                      j.status === 'ready' ? (
                        <span className="numeric pp-nowrap">{`${j.rowCount ?? '—'} · ${formatBytes(j.sizeBytes)}`}</span>
                      ) : (
                        '—'
                      ),
                  },
                  {
                    header: t('colRequestedBy'),
                    cell: (j) => (j.requestedBy === userId ? t('you') : (names.get(j.requestedBy) ?? t('teammate'))),
                  },
                  {
                    header: t('colGenerated'),
                    cell: (j) =>
                      j.generatedAt ? (
                        <>
                          <DateTime value={j.generatedAt} />
                          {j.asOf && (
                            <small className="pay-cell-note">
                              {t('asOf')} <DateTime value={j.asOf} />
                            </small>
                          )}
                        </>
                      ) : (
                        <DateTime value={j.createdAt} />
                      ),
                  },
                  {
                    header: t('colExpires'),
                    cell: (j) =>
                      j.status === 'expired' ? (
                        t('deleted')
                      ) : j.expiresAt ? (
                        <DateTime value={j.expiresAt} />
                      ) : j.status === 'ready' ? (
                        t('noExpiry')
                      ) : (
                        '—'
                      ),
                  },
                  {
                    header: <span className="pp-sr">{t('colActions')}</span>,
                    cell: (j) => <JobActions api={api} job={j} onDone={() => reload()} />,
                  },
                ]}
                card={(j) => ({
                  title: kindName(t, j.kind),
                  time: j.generatedAt ? <DateTime value={j.generatedAt} /> : <DateTime value={j.createdAt} />,
                  amount: j.status === 'ready' ? formatBytes(j.sizeBytes) : undefined,
                  status: <JobChip status={j.status} />,
                })}
              />
              {list.state.status === 'ready' && <MoreFooter state={list.state} onMore={list.loadMore} />}
            </>
          )}
        </ListShell>
      </PaySection>
    </div>
  );
}

export function Covers({ job }: { job: Pick<ExportJob, 'filters' | 'kind'> }) {
  const { t } = c.useCopy();
  const dayText = useDayText();
  const p = rangeParts(job);
  const range =
    job.kind === 'ledger_statement'
      ? t('atGeneration')
      : p.from || p.to
        ? t('rangeFromTo', { from: p.from ? dayText(p.from) : t('rangeStart'), to: p.to ? dayText(p.to) : t('rangeNow') })
        : t('rangeAll');
  return <>{[range, p.status ? statusWord(job.kind, p.status) : null, p.asset].filter(Boolean).join(' · ')}</>;
}

export function JobActions({
  api,
  job,
  onDone,
}: {
  api: Pick<SettingsBApi, 'reportDownload' | 'reportDelete'>;
  job: ExportJob;
  onDone: () => void;
}) {
  const { t } = c.useCopy();
  const [state, setState] = useState<'idle' | 'busy' | string>('idle');
  async function download() {
    setState('busy');
    const result = await api.reportDownload(job.jobId);
    if (!result.ok) return setState(refusalText(result));
    const url = URL.createObjectURL(new Blob([result.data.content], { type: result.data.contentType }));
    const link = document.createElement('a');
    link.href = url;
    link.download = result.data.fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setState('idle');
  }
  return (
    <div className="pp-actions">
      {job.status === 'ready' && (
        <Button
          variant="secondary"
          onClick={() => void download()}
          disabled={state === 'busy'}
          aria-label={t('downloadAria', { name: job.fileName ?? kindName(t, job.kind) })}
        >
          {state === 'busy' ? t('downloading') : t('download')}
        </Button>
      )}
      {isBuilding(job) && <small className="muted">{t('buildingNow')}</small>}
      {canDelete(job) && (
        <PortalReview
          title={t('deleteAction')}
          description={t('deleteReview')}
          review={
            <dl className="pay-details">
              <div>
                <dt>{t('colReport')}</dt>
                <dd>{kindName(t, job.kind)}</dd>
              </div>
              <div>
                <dt>{t('colCovers')}</dt>
                <dd>
                  <Covers job={job} />
                </dd>
              </div>
            </dl>
          }
          perform={() => api.reportDelete(job.jobId)}
          onConfirmed={onDone}
        />
      )}
      {state !== 'idle' && state !== 'busy' && (
        <small className="error-text" role="alert">
          {state}
        </small>
      )}
    </div>
  );
}

export function RequestForm({
  api,
  role,
  onRequested,
  initialKind,
}: {
  api: Pick<SettingsBApi, 'reportRequest'>;
  role: string | null;
  onRequested: () => void;
  initialKind?: string;
}) {
  const { t } = c.useCopy();
  const [kind, setKind] = useState<ExportKind>(() => {
    const asked = initialKind ?? (typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('report'));
    return asked && isKnownKind(asked) ? asked : 'payments';
  });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const [assetId, setAssetId] = useState('');
  const available = columnsFor(kind, role);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const columns = chosen ? available.filter((col) => chosen.includes(col)) : [...available];
  // One id per request: a double click, or sending it again after a lost reply, returns the same job instead of building two.
  const [requestId, setRequestId] = useState(newRequestId);
  const bad = hasDateRange(kind) && windowProblem(from, to) ? t('errRange') : undefined;
  const statuses = statusesFor(kind);
  const filters = {
    ...(hasDateRange(kind) ? windowOf(from, to) : {}),
    ...(statuses && status ? { status } : {}),
    ...(assetId.trim() ? { assetId: assetId.trim().toUpperCase() } : {}),
  };
  const allColumns = columns.length === available.length;
  return (
    <PaySection title={t('requestTitle')} description={t('requestBody')}>
      <div data-testid="form-stack" className="form-stack pp-form">
        <div className="form-row">
          <SelectField
            label={t('colReport')}
            value={kind}
            onChange={(v) => {
              setKind(v as ExportKind);
              setStatus('');
              setChosen(null);
              setRequestId(newRequestId());
            }}
            options={exportKinds.map((k) => [k, t(`kind_${k}`)] as const)}
            hint={t(`kindHint_${kind}`)}
          />
          {statuses && (
            <SelectField
              label={t('statusFilter')}
              value={status}
              onChange={(v) => {
                setStatus(v);
                setRequestId(newRequestId());
              }}
              options={[['', t('allStatuses')], ...statuses.map((s) => [s, statusWord(kind, s)] as const)]}
            />
          )}
        </div>
        {hasDateRange(kind) ? (
          <div className="form-row">
            <Field
              label={t('from')}
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setRequestId(newRequestId());
              }}
              hint={t('fromHint')}
            />
            <Field
              label={t('to')}
              type="date"
              value={to}
              error={bad}
              onChange={(e) => {
                setTo(e.target.value);
                setRequestId(newRequestId());
              }}
              hint={t('toHint')}
            />
          </div>
        ) : (
          <p className="muted">{t('noRangeForKind')}</p>
        )}
        <Field
          label={t('assetLabel')}
          value={assetId}
          maxLength={32}
          hint={t('assetHint')}
          onChange={(e) => {
            setAssetId(e.target.value.toUpperCase());
            setRequestId(newRequestId());
          }}
        />
        <fieldset className="pp-fieldset">
          <legend>{t('columnsTitle')}</legend>
          <div className="pp-columns">
            {available.map((col) => (
              <label key={col} className="pp-check">
                <Checkbox
                  checked={columns.includes(col)}
                  onCheckedChange={(on) => {
                    const next = on ? [...columns, col] : columns.filter((x) => x !== col);
                    setChosen(next);
                    setRequestId(newRequestId());
                  }}
                />
                <span>{columnLabel(col)}</span>
              </label>
            ))}
          </div>
          {kind === 'fees' && (role === 'viewer' || role === 'developer') && <small className="muted">{t('feeLevelHidden')}</small>}
        </fieldset>
        <PortalReview
          title={t('requestAction')}
          variant="primary"
          description={t('requestReview')}
          disabled={Boolean(bad) || columns.length === 0}
          disabledReason={columns.length === 0 ? t('errNoColumns') : t('errRange')}
          review={
            <dl className="pay-details">
              <div>
                <dt>{t('colReport')}</dt>
                <dd>{t(`kind_${kind}`)}</dd>
              </div>
              <div>
                <dt>{t('colCovers')}</dt>
                <dd>
                  <Covers job={{ kind, filters }} />
                </dd>
              </div>
              <div>
                <dt>{t('columnsTitle')}</dt>
                <dd>{allColumns ? t('allColumns', { n: columns.length }) : columns.map(columnLabel).join(', ')}</dd>
              </div>
            </dl>
          }
          perform={() => api.reportRequest({ requestId, kind, filters, ...(allColumns ? {} : { columns }) })}
          onConfirmed={() => {
            setRequestId(newRequestId());
            onRequested();
          }}
        />
      </div>
    </PaySection>
  );
}
