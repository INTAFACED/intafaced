import { useEffect, useState } from 'react';
import { Button, DataTable, Field } from '@intafaced/ui';
import { PayTime, PaySection } from '../../components';
import { PortalReview } from '../ui/PortalReview';
import { Chip, ListShell, MoreFooter, SelectField } from '../components';
import { portalCopy } from './copy';
import { useCursorList, useUrlParam, type ListState } from '../hooks';
import { newRequestId } from '../model';
import { refusalText } from '../refusal';
import type { PortalApi } from '../api';
import { exportKinds, paymentStatuses, type ExportJob, type ExportKind } from '../schemas';

const settlementStatuses = ['pending', 'posted', 'paid_out', 'failed'] as const;
const dayStart = (value: string) => (value ? `${value}T00:00:00.000Z` : undefined);

/** `/pay/exports`: ask for a report, watch it build, download it. Only your own rows are ever in it. */
export function Exports({ portal }: { portal: PortalApi }) {
  const [kind, setKind] = useUrlParam('kind', '');
  const [status, setStatus] = useUrlParam('status', '');
  const list = useCursorList(
    (cursor, s) => portal.exportsList(cursor, kind, status, s),
    `portal:exports:${kind}:${status}`,
    (j) => j.jobId,
  );
  const busy = list.state.status === 'ready' && list.state.items.some((job) => job.status === 'queued' || job.status === 'running');
  const { reload } = list;
  // A report that is still building refreshes itself, quietly, until nothing is waiting.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => reload(true), 4000);
    return () => clearInterval(timer);
  }, [busy, reload]);
  return (
    <ExportsView
      portal={portal}
      list={list.state}
      kind={kind}
      setKind={setKind}
      status={status}
      setStatus={setStatus}
      loadMore={list.loadMore}
      reload={() => list.reload()}
    />
  );
}

export function ExportsView({
  portal,
  list,
  kind,
  setKind,
  status,
  setStatus,
  loadMore,
  reload,
}: {
  portal: PortalApi;
  list: ListState<ExportJob>;
  kind: string;
  setKind: (value: string) => void;
  status: string;
  setStatus: (value: string) => void;
  loadMore: () => void;
  reload: () => void;
}) {
  const { t } = portalCopy.useCopy();
  return (
    <div className="stack">
      <div id="request">
        <RequestForm portal={portal} onRequested={reload} />
      </div>
      <PaySection
        title={t('jobsTitle')}
        description={t('jobsBody')}
        action={
          <div className="pp-filter-row">
            <SelectField
              label={t('colKind')}
              value={kind}
              onChange={setKind}
              options={[['', t('filterAll')], ...exportKinds.map((k) => [k, t(`exportKind_${k}` as 'exportKind_payments')] as const)]}
            />
            <SelectField
              label={t('colStatus')}
              value={status}
              onChange={setStatus}
              options={[
                ['', t('filterAll')],
                ...(['queued', 'running', 'ready', 'failed'] as const).map((s) => [s, t(`chipExport_${s}` as 'chipExport_ready')] as const),
              ]}
            />
          </div>
        }
      >
        <ListShell
          state={list}
          retry={reload}
          empty={{
            title: kind || status ? t('jobsNoMatchTitle') : t('jobsEmptyTitle'),
            body: kind || status ? t('jobsNoMatchBody') : t('jobsEmptyBody'),
          }}
        >
          {(rows) => (
            <>
              <DataTable
                label={t('jobsTitle')}
                headers={[t('colKind'), t('colRange'), t('colStatus'), t('colRows'), t('colRequested'), t('colAsOf'), t('colExpires'), '']}
              >
                {rows.map((job) => (
                  <JobRow key={job.jobId} job={job} portal={portal} />
                ))}
              </DataTable>
              {list.status === 'ready' && <MoreFooter state={list} onMore={loadMore} />}
            </>
          )}
        </ListShell>
      </PaySection>
    </div>
  );
}

function rangeText(job: ExportJob, t: ReturnType<typeof portalCopy.useCopy>['t']) {
  const parts: string[] = [];
  if (job.filters.from || job.filters.to)
    parts.push(
      t('rangeFromTo', { from: job.filters.from?.slice(0, 10) ?? t('rangeStart'), to: job.filters.to?.slice(0, 10) ?? t('rangeNow') }),
    );
  else parts.push(t('rangeAll'));
  if (job.filters.status) parts.push(job.filters.status.replaceAll('_', ' '));
  if (job.filters.assetId) parts.push(job.filters.assetId);
  return parts.join(' · ');
}

function JobRow({ job, portal }: { job: ExportJob; portal: PortalApi }) {
  const { t } = portalCopy.useCopy();
  const [state, setState] = useState<'idle' | 'busy' | string>('idle');
  async function download() {
    setState('busy');
    const result = await portal.exportDownload(job.jobId);
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
    <tr>
      <th scope="row">{t(`exportKind_${job.kind}` as 'exportKind_payments')}</th>
      <td>{rangeText(job, t)}</td>
      <td>
        <Chip kind="export" value={job.status} />
        {job.status === 'failed' && <small className="pay-cell-note">{t('exportFailedHelp')}</small>}
      </td>
      <td className="numeric">{job.rowCount ?? '—'}</td>
      <td>
        <PayTime value={job.createdAt} />
      </td>
      <td>{job.asOf ? <PayTime value={job.asOf} /> : '—'}</td>
      <td>{job.status === 'ready' ? job.expiresAt ? <PayTime value={job.expiresAt} /> : t('noExpiry') : '—'}</td>
      <td>
        {job.status === 'ready' ? (
          <>
            <Button
              variant="secondary"
              onClick={() => void download()}
              disabled={state === 'busy'}
              aria-label={t('downloadAria', { name: job.fileName ?? job.kind })}
            >
              {state === 'busy' ? t('downloading') : t('download')}
            </Button>
            {state !== 'idle' && state !== 'busy' && (
              <small className="error-text" role="alert">
                {state}
              </small>
            )}
          </>
        ) : (
          <small className="muted">{job.status === 'failed' ? t('noDownload') : t('buildingNow')}</small>
        )}
      </td>
    </tr>
  );
}

function RequestForm({ portal, onRequested }: { portal: PortalApi; onRequested: () => void }) {
  const { t } = portalCopy.useCopy();
  const [kind, setKind] = useState<ExportKind>(() => {
    const requested = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('report');
    return exportKinds.includes(requested as ExportKind) ? (requested as ExportKind) : 'payments';
  });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const [assetId, setAssetId] = useState('');
  // One id per request: a double click or retry returns the same job instead of building two.
  const [requestId, setRequestId] = useState(newRequestId);
  const statuses = kind === 'payments' ? paymentStatuses : settlementStatuses;
  const bad = from && to && from >= to ? t('err_range') : undefined;
  const filters = {
    ...(dayStart(from) ? { from: dayStart(from) } : {}),
    ...(dayStart(to) ? { to: dayStart(to) } : {}),
    ...(status ? { status } : {}),
    ...(assetId.trim() ? { assetId: assetId.trim().toUpperCase() } : {}),
  };
  return (
    <PaySection title={t('requestTitle')} description={t('requestBody')}>
      <div className="form-stack pp-form">
        <div className="form-row">
          <SelectField
            label={`${t('colKind')} *`}
            value={kind}
            onChange={(v) => {
              setKind(v as ExportKind);
              setStatus('');
            }}
            options={exportKinds.map((k) => [k, t(`exportKind_${k}` as 'exportKind_payments')] as const)}
            hint={t(`exportHint_${kind}` as 'exportHint_payments')}
          />
          <SelectField
            label={t('fStatusFilter')}
            value={status}
            onChange={setStatus}
            options={[['', t('filterAll')], ...statuses.map((s) => [s, s.replaceAll('_', ' ')] as const)]}
          />
        </div>
        <div className="form-row">
          <Field label={t('fFrom')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} hint={t('hFrom')} />
          <Field label={t('fTo')} type="date" value={to} onChange={(e) => setTo(e.target.value)} error={bad} hint={t('hTo')} />
        </div>
        <Field
          label={t('fAsset')}
          value={assetId}
          onChange={(e) => setAssetId(e.target.value.toUpperCase())}
          maxLength={32}
          hint={t('hAsset')}
        />
        <PortalReview
          title={t('requestExport')}
          variant="primary"
          description={t('requestExportBody')}
          review={
            <dl className="pay-details">
              <div>
                <dt>{t('colKind')}</dt>
                <dd>{t(`exportKind_${kind}` as 'exportKind_payments')}</dd>
              </div>
              <div>
                <dt>{t('colRange')}</dt>
                <dd>{from || to ? t('rangeFromTo', { from: from || t('rangeStart'), to: to || t('rangeNow') }) : t('rangeAll')}</dd>
              </div>
              <div>
                <dt>{t('fStatusFilter')}</dt>
                <dd>{status ? status.replaceAll('_', ' ') : t('filterAll')}</dd>
              </div>
              <div>
                <dt>{t('fAsset')}</dt>
                <dd>{assetId.trim() || t('filterAll')}</dd>
              </div>
            </dl>
          }
          perform={() => portal.createExport({ requestId, kind, filters })}
          onConfirmed={() => {
            setRequestId(newRequestId());
            onRequested();
          }}
          disabled={Boolean(bad)}
        />
      </div>
    </PaySection>
  );
}
