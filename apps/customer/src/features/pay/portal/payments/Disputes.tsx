import { useRef, useState } from 'react';
import { plainCode } from '../ui/plain-code';
import { useResource, type Resource } from '../../../../shared/resource';
import { Button, DataTable } from '@intafaced/ui';
import { EmptyState } from '../../ui-kit';
import { PaySection } from '../../components';
import { PortalReview } from '../ui/PortalReview';
import { BackLink, Chip, Facts, Gate, MoneyLines, Money, PortalFailure, PortalLoading, SelectField, Timeline } from '../components';
import { portalCopy } from './copy';
import { useNow, useUrlParam, type ListState } from '../hooks';
import { shortId } from '../model';
import { useOptionalMerchantAccess } from '../access/MerchantAccess';
import { useRequestId } from './invoice-model';
import { refusalText } from '../refusal';
import type { PortalApi } from '../api';
import type { z } from 'zod';
import { disputeStatuses, evidenceKinds, type Dispute, type DisputeDetail, type EvidenceKind } from '../schemas';
import type { disputeSummarySchema } from '../schemas';
import { DateTime } from '../ui/DateTime';
import { PaymentCell } from './PaymentCell';
import { EntityList } from '../ui/EntityList';
import { dateRange, FilterRow, useListFilters, type DatePreset, type ListFilters } from '../ui/FilterRow';
import { KpiStrip } from '../ui/Kpi';
import { StatusChip, ToneChip } from '../ui/StatusChip';
import { useServerList } from '../ui/useServerList';
import { bySoonestDue, countdown, disputeReason, fileProblem, fromBase64, toBase64 } from './dispute-model';

type Summary = z.infer<typeof disputeSummarySchema>;

/** `/pay/disputes`: every dispute, filtered by the service, with the answer deadline counted down on each row. */
export function Disputes({ portal }: { portal: PortalApi }) {
  const filters = useListFilters();
  const [due, setDue] = useUrlParam('due', '');
  const range = dateRange(filters.date as DatePreset, Date.now(), { from: filters.from, to: filters.to });
  const days = due === '3d' ? 3 : due === '7d' ? 7 : 0;
  const query = {
    status: filters.status,
    search: filters.search.trim(),
    from: range.from ?? '',
    to: range.to ?? '',
    dueBefore: days ? new Date(Date.now() + days * 86_400_000).toISOString() : '',
    deadline: due === 'none' ? 'unset' : '',
  };
  const summary = useResource((s) => portal.disputeSummary(s), 'portal:dispute-summary');
  const list = useServerList(
    (f, cursor, s) => portal.disputePage(f, cursor, s),
    query,
    (d: Dispute) => d.disputeId,
  );
  return (
    <DisputesView
      portal={portal}
      summary={summary.resource}
      list={list.state}
      filters={filters}
      due={due}
      setDue={setDue}
      loadMore={list.loadMore}
      retry={() => {
        summary.reload();
        list.reload();
      }}
    />
  );
}

export function DueChip({ dispute, now }: { dispute: Pick<Dispute, 'status' | 'responseDueAt'>; now: number }) {
  const { t } = portalCopy.useCopy();
  const c = countdown(dispute, now);
  if (c.kind === 'closed') return <span className="muted">—</span>;
  if (c.kind === 'none') return <span className="muted">{t('noDeadline')}</span>;
  const tone = c.kind === 'overdue' ? 'failed' : c.kind === 'today' || c.kind === 'soon' ? 'action' : 'progress';
  const label =
    c.kind === 'overdue' ? t('dueOverdue', { days: c.days }) : c.kind === 'today' ? t('dueToday') : t('dueIn', { days: c.days });
  return <ToneChip tone={tone} label={label} />;
}

export function DisputesView({
  portal,
  summary,
  list,
  filters,
  due,
  setDue,
  loadMore,
  retry,
}: {
  /** Reads each dispute's payment for its customer. Without it (a static preview) rows show the payment reference only. */
  portal?: PortalApi;
  summary: Resource<Summary>;
  list: ListState<Dispute>;
  filters: ListFilters;
  due: string;
  setDue: (value: string) => void;
  loadMore: () => void;
  retry: () => void;
}) {
  const { t } = portalCopy.useCopy();
  const now = useNow();
  // If the dispute reads are not live, say so once; do not paint empty tiles. The failure becomes the not-live card when unmounted.
  const notLive = list.status === 'failed' && summary.status === 'failed';
  if (notLive) return <PortalFailure result={list.failure} retry={retry} />;
  const filtered = Boolean(filters.status || filters.search || filters.date || due);
  const period = t('periodAllTime');
  return (
    <div className="stack">
      <Gate resource={summary} retry={retry} rows={2}>
        {(s) => (
          <KpiStrip
            label={t('disputeKpis')}
            tiles={[
              {
                label: t('kpiOpen'),
                period,
                href: '/pay/disputes?status=open',
                value: s.byStatus.open,
                tone: s.byStatus.open > 0 ? 'attention' : undefined,
              },
              { label: t('kpiContested'), period, href: '/pay/disputes?status=contested', value: s.byStatus.contested },
              { label: t('kpiWon'), period, href: '/pay/disputes?status=won', value: s.byStatus.won },
              { label: t('kpiLost'), period, href: '/pay/disputes?status=lost', value: s.byStatus.lost },
              {
                label: t('kpiAtRisk'),
                period,
                href: '/pay/disputes',
                value: (
                  <MoneyLines
                    items={s.amountAtRisk.map((a) => ({ assetCode: a.assetId, amount: a.amount }))}
                    emptyLabel={t('nothingAtRisk')}
                  />
                ),
                note: t('kpiAtRiskNote'),
              },
            ]}
          />
        )}
      </Gate>
      <FilterRow
        label={t('disputesTitle')}
        filters={filters}
        statuses={disputeStatuses.map((s) => [s, t(`chipDispute_${s}` as 'chipDispute_open')] as const)}
        more={
          <SelectField
            label={t('filterDue')}
            value={due}
            onChange={setDue}
            options={[
              ['', t('dueAny')],
              ['3d', t('dueWithin3')],
              ['7d', t('dueWithin7')],
              ['none', t('dueNone')],
            ]}
          />
        }
        {...(list.status === 'ready' ? { shown: list.items.length, hasMore: list.hasMore } : {})}
      />
      {list.status === 'loading' && <PortalLoading />}
      {list.status === 'failed' && <PortalFailure result={list.failure} retry={retry} />}
      {list.status === 'ready' &&
        (list.items.length === 0 ? (
          <EmptyState title={filtered ? t('disputesNoMatchTitle') : t('disputesEmptyTitle')}>
            {filtered ? t('disputesNoMatchBody') : t('disputesEmptyBody')}
          </EmptyState>
        ) : (
          <>
            <p className="muted pp-note">{t('soonestFirst')}</p>
            <EntityList
              label={t('disputesTitle')}
              rows={bySoonestDue(list.items)}
              rowKey={(d) => d.disputeId}
              href={(d) => `/pay/disputes/${encodeURIComponent(d.disputeId)}`}
              columns={[
                {
                  header: t('colReason'),
                  cell: (d) => (
                    <>
                      <strong>{d.reasonCode ? disputeReason(d.reasonCode) : t('notGiven')}</strong>
                      <small className="pay-cell-note">{shortId(d.disputeId)}</small>
                    </>
                  ),
                },
                {
                  header: t('colPayment'),
                  cell: (d) => <PaymentCell portal={portal} paymentId={d.paymentId} />,
                },
                { header: t('colAmount'), cell: (d) => <Money value={d.amount} asset={d.assetId} /> },
                { header: t('colStatus'), cell: (d) => <StatusChip entity="dispute" value={d.status} /> },
                { header: t('colDue'), cell: (d) => <DueChip dispute={d} now={now} /> },
                { header: t('colOpened'), cell: (d) => <DateTime value={d.openedAt} /> },
              ]}
              card={(d) => ({
                title: d.reasonCode ? disputeReason(d.reasonCode) : t('notGiven'),
                time: <DueChip dispute={d} now={now} />,
                amount: <Money value={d.amount} asset={d.assetId} />,
                status: <StatusChip entity="dispute" value={d.status} />,
              })}
            />
            <div className="pp-actions">
              {list.hasMore && (
                <Button variant="secondary" onClick={loadMore} disabled={list.more === 'loading'}>
                  {list.more === 'loading' ? t('loadingMore') : t('loadMore')}
                </Button>
              )}
            </div>
          </>
        ))}
    </div>
  );
}

// ---- detail ---------------------------------------------------------------------------------------------

export function DisputeDetailPage({ portal, disputeId }: { portal: PortalApi; disputeId: string }) {
  const dispute = useResource((s) => portal.dispute(disputeId, s), `portal:dispute:${disputeId}`);
  return <DisputeDetailView portal={portal} dispute={dispute.resource} reload={dispute.reload} />;
}

export function DisputeDetailView({
  portal,
  dispute,
  reload,
}: {
  portal: PortalApi;
  dispute: Resource<DisputeDetail>;
  reload: () => void;
}) {
  const { t } = portalCopy.useCopy();
  return (
    <div className="stack">
      <BackLink href="/pay/disputes">{t('backToDisputes')}</BackLink>
      <Gate resource={dispute} retry={reload} rows={5}>
        {(d) => (
          <>
            <PaySection title={t('keyFacts')} description={t('disputeFactsBody')}>
              <Facts
                items={[
                  [
                    t('colDispute'),
                    <span data-testid="pp-mono" className="pp-mono pp-copy">
                      {d.disputeId}
                    </span>,
                  ],
                  [
                    t('colPayment'),
                    <a className="text-link" href={`/pay/payments/${encodeURIComponent(d.paymentId)}`}>
                      {t('openPayment')}
                    </a>,
                  ],
                  [t('colAmount'), <Money value={d.amount} asset={d.assetId} />],
                  [t('colReason'), d.reasonCode ? disputeReason(d.reasonCode) : t('notGiven')],
                  [t('colStatus'), <Chip kind="dispute" value={d.status} />],
                  [
                    t('colDue'),
                    d.responseDueAt ? (
                      <>
                        <DateTime value={d.responseDueAt} /> <DueChip dispute={d} now={Date.now()} />
                      </>
                    ) : (
                      t('noDeadline')
                    ),
                  ],
                  [t('ledgerWire'), d.ledgerWire === 'posted' ? t('ledgerPosted') : t('ledgerNotConnected')],
                ]}
              />
            </PaySection>

            <PaySection title={t('timelineTitle')}>
              <Timeline
                label={t('timelineTitle')}
                items={[
                  { at: d.openedAt, title: t('tlOpened') },
                  ...d.evidence.map((e) => ({
                    at: e.createdAt,
                    title: t('tlEvidence', { kind: t(`evidence_${e.kind}` as 'evidence_receipt') }),
                    detail: e.fileName,
                  })),
                  ...d.responses.map((r) => ({
                    at: r.createdAt,
                    title: r.action === 'contest' ? t('tlContested') : t('tlAccepted'),
                    detail: t('byActor', { actor: r.respondedBy }) + (r.note ? ` · ${r.note}` : ''),
                  })),
                  ...(d.closedAt
                    ? [{ at: d.closedAt, title: t('tlClosed', { outcome: t(`chipDispute_${d.status}` as 'chipDispute_open') }) }]
                    : []),
                ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))}
              />
            </PaySection>

            {d.payment && (
              <PaySection title={t('relatedPayment')}>
                <Facts
                  items={[
                    [t('colAmount'), <Money value={d.payment.amount} asset={d.payment.assetId} />],
                    [t('colStatus'), <Chip kind="payment" value={d.payment.status} />],
                    [t('colOpened'), <DateTime value={d.payment.createdAt} />],
                  ]}
                />
                <a className="text-link" href={`/pay/payments/${encodeURIComponent(d.payment.paymentId)}`}>
                  {t('seePayments')}
                </a>
              </PaySection>
            )}

            <EvidenceSection portal={portal} dispute={d} reload={reload} />
            <RespondSection portal={portal} dispute={d} reload={reload} />
          </>
        )}
      </Gate>
    </div>
  );
}

export const formatBytes = (value: string): string => {
  // A byte count, not money: a number is fine for display.
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export async function fingerprintFile(file: File): Promise<{ fileName: string; contentType: string; sizeBytes: number; sha256: string }> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { fileName: file.name, contentType: file.type || 'application/octet-stream', sizeBytes: file.size, sha256 };
}

function EvidenceDownload({ portal, evidenceId, fileName }: { portal: PortalApi; evidenceId: string; fileName: string }) {
  const { t } = portalCopy.useCopy();
  const [state, setState] = useState<'idle' | 'busy' | string>('idle');
  return (
    <>
      <Button
        variant="ghost"
        disabled={state === 'busy'}
        aria-label={t('evDownloadFile', { name: fileName })}
        onClick={async () => {
          setState('busy');
          const result = await portal.evidenceFile(evidenceId);
          if (!result.ok) return setState(refusalText(result));
          const bytes = fromBase64(result.data.contentBase64);
          const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: result.data.contentType }));
          const link = document.createElement('a');
          link.href = url;
          link.download = result.data.fileName;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          setState('idle');
        }}
      >
        {t('evDownload')}
      </Button>
      {state !== 'idle' && state !== 'busy' && (
        <small className="error-text" role="alert">
          {state}
        </small>
      )}
    </>
  );
}

/**
 * Whether this role may answer disputes (`disputes.respond`: owner, admin, finance). Outside the business frame, as in a
 * static preview, there is no role to read, so the service's own `canRespond` on each dispute decides.
 */
function useMayRespond(): boolean {
  const access = useOptionalMerchantAccess();
  return access ? access.can('disputes.respond') : true;
}

function EvidenceSection({ portal, dispute, reload }: { portal: PortalApi; dispute: DisputeDetail; reload: () => void }) {
  const { t } = portalCopy.useCopy();
  const [kind, setKind] = useState<EvidenceKind>('receipt');
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState<Awaited<ReturnType<typeof fingerprintFile>> | null>(null);
  const [reading, setReading] = useState(false);
  const [fileRef, setFileRef] = useState<File | null>(null);
  // Once the service says file storage is off, the page stops trying it and records details only.
  const [storageOff, setStorageOff] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const problem = picked ? fileProblem(picked) : null;
  const mayRespond = useMayRespond();
  const detailsOnly = storageOff || problem !== null;
  return (
    <PaySection title={t('evidenceTitle')} description={t('evidenceBody')}>
      {dispute.evidence.length === 0 ? (
        <EmptyState title={t('evidenceEmptyTitle')}>{t('evidenceEmptyBody')}</EmptyState>
      ) : (
        <DataTable
          label={t('evidenceTitle')}
          headers={[t('colKind'), t('colFile'), t('colSize'), t('colFingerprint'), t('colNote'), t('colAdded'), t('evDownload')]}
        >
          {dispute.evidence.map((e) => (
            <tr key={e.evidenceId}>
              <th scope="row">{t(`evidence_${e.kind}` as 'evidence_receipt')}</th>
              <td>
                {e.fileName}
                <small className="pay-cell-note">{e.contentType}</small>
              </td>
              <td className="numeric">{formatBytes(e.sizeBytes)}</td>
              <td data-testid="pp-mono" className="pp-mono" title={e.sha256}>
                {e.sha256.slice(0, 12)}…
              </td>
              <td>{e.note ?? '—'}</td>
              <td>
                <DateTime value={e.createdAt} />
              </td>
              <td>
                <EvidenceDownload portal={portal} evidenceId={e.evidenceId} fileName={e.fileName} />
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      {dispute.canRespond ? (
        <div data-testid="form-stack" className="form-stack pp-form pp-add-evidence">
          <h3 className="pp-sub">{t('addEvidence')}</h3>
          <p className="pp-callout" role="note">
            {detailsOnly ? (problem ? t(`evProblem_${problem}`) + ' ' : '') + t('evidenceMetaOnly') : t('evUploadNote')}
          </p>
          <label className="field">
            <span>{t('fFile')} *</span>
            <input
              ref={input}
              type="file"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return (setFileRef(null), setPicked(null));
                setReading(true);
                try {
                  setFileRef(file);
                  setPicked(await fingerprintFile(file));
                } finally {
                  setReading(false);
                }
              }}
            />
            <small>
              {reading
                ? t('readingFile')
                : picked
                  ? t('fileReady', { name: picked.fileName, size: formatBytes(String(picked.sizeBytes)) })
                  : t('hFile')}
            </small>
          </label>
          <SelectField
            label={`${t('colKind')} *`}
            value={kind}
            onChange={(v) => setKind(v as EvidenceKind)}
            options={evidenceKinds.map((k) => [k, t(`evidence_${k}` as 'evidence_receipt')] as const)}
          />
          <label className="field">
            <span>{t('colNote')}</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} />
            <small>{t('hEvidenceNote')}</small>
          </label>
          <PortalReview
            title={detailsOnly ? t('evRecordOnly') : t('addEvidence')}
            variant="primary"
            description={t('addEvidenceBody')}
            review={
              picked && (
                <Facts
                  items={[
                    [t('colKind'), t(`evidence_${kind}` as 'evidence_receipt')],
                    [t('colFile'), picked.fileName],
                    [t('colSize'), formatBytes(String(picked.sizeBytes))],
                    [
                      t('colFingerprint'),
                      <span data-testid="pp-mono" className="pp-mono">
                        {picked.sha256}
                      </span>,
                    ],
                  ]}
                />
              )
            }
            perform={async () => {
              const extra = note.trim() ? { note: note.trim() } : {};
              if (detailsOnly || !fileRef) return portal.addEvidence({ disputeId: dispute.disputeId, kind, ...picked!, ...extra });
              const contentBase64 = toBase64(new Uint8Array(await fileRef.arrayBuffer()));
              const result = await portal.uploadEvidence({
                disputeId: dispute.disputeId,
                kind,
                fileName: picked!.fileName,
                contentType: picked!.contentType,
                contentBase64,
                sha256: picked!.sha256,
                ...extra,
              });
              if (
                !result.ok &&
                (result.code === 'pay.dispute_evidence_upload_off' || result.code === 'pay.dispute_evidence_scan_unconfigured')
              )
                setStorageOff(true);
              return result;
            }}
            onConfirmed={() => {
              setPicked(null);
              setFileRef(null);
              setNote('');
              if (input.current) input.current.value = '';
              reload();
            }}
            disabled={!picked || reading || problem === 'empty' || !mayRespond}
            disabledReason={mayRespond ? undefined : t('disp_noRespond')}
          />
          {!mayRespond && <p className="muted pp-note">{t('disp_noRespond')}</p>}
        </div>
      ) : (
        <p className="muted pp-note">{t('evidenceClosed')}</p>
      )}
    </PaySection>
  );
}

function RespondSection({ portal, dispute, reload }: { portal: PortalApi; dispute: DisputeDetail; reload: () => void }) {
  const { t } = portalCopy.useCopy();
  const [note, setNote] = useState('');
  // One id per decision, kept for this tab (so a reload reuses it): a retried click replays the first answer instead of deciding twice.
  const contest = useRequestId(`dispute:${dispute.disputeId}:contest`);
  const accept = useRequestId(`dispute:${dispute.disputeId}:accept`);
  const mayRespond = useMayRespond();
  const why = mayRespond ? undefined : t('disp_noRespond');
  const canContest = dispute.status === 'open' && dispute.evidence.length > 0;
  return (
    <PaySection title={t('respondTitle')} description={t('respondBody')}>
      {!dispute.canRespond ? (
        <p className="pp-callout" role="note">
          {dispute.responses.length > 0 ? t('respondedAlready') : t('respondClosed')}
        </p>
      ) : (
        <div data-testid="form-stack" className="form-stack pp-form">
          <label className="field">
            <span>{t('colNote')}</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} />
            <small>{t('hRespondNote')}</small>
          </label>
          <div className="pp-actions">
            <PortalReview
              title={t('contest')}
              variant="primary"
              description={t('contestBody')}
              review={
                <Facts
                  items={[
                    [t('colAmount'), <Money value={dispute.amount} asset={dispute.assetId} />],
                    [t('evidenceTitle'), String(dispute.evidence.length)],
                    [t('colNote'), note.trim() || '—'],
                  ]}
                />
              }
              perform={() =>
                portal.respond({
                  requestId: contest.id,
                  disputeId: dispute.disputeId,
                  action: 'contest',
                  ...(note.trim() ? { note: note.trim() } : {}),
                })
              }
              onConfirmed={reload}
              disabled={!canContest || !mayRespond}
              disabledReason={why}
            />
            <PortalReview
              title={t('acceptLiability')}
              variant="sell"
              description={t('acceptLiabilityBody')}
              review={
                <Facts
                  items={[
                    [t('colAmount'), <Money value={dispute.amount} asset={dispute.assetId} />],
                    [t('colNote'), note.trim() || '—'],
                  ]}
                />
              }
              perform={() =>
                portal.respond({
                  requestId: accept.id,
                  disputeId: dispute.disputeId,
                  action: 'accept_liability',
                  ...(note.trim() ? { note: note.trim() } : {}),
                })
              }
              onConfirmed={reload}
              disabled={!mayRespond}
              disabledReason={why}
            />
          </div>
          {!mayRespond && <p className="muted pp-note">{t('disp_noRespond')}</p>}
          {mayRespond && !canContest && (
            <p className="muted pp-note">{dispute.status !== 'open' ? t('whyNoContestStatus') : t('whyNoContestEvidence')}</p>
          )}
        </div>
      )}
    </PaySection>
  );
}
