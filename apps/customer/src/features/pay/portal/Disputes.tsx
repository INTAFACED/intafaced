import { useRef, useState } from 'react';
import { useResource, type Resource } from '../../../shared/resource';
import { Button, DataTable, EmptyState } from '@intafaced/ui';
import { PayTime, PaySection } from '../components';
import { PortalReview } from './ui/PortalReview';
import {
  BackLink,
  Chip,
  ComingSoon,
  Facts,
  Gate,
  Kpi,
  KpiGrid,
  ListShell,
  MoneyLines,
  Money,
  MoreFooter,
  PortalFailure,
  SelectField,
  Timeline,
} from './components';
import { portalCopy } from './copy';
import { useCursorList, useUrlParam, type ListState } from './hooks';
import { newRequestId, nextDueSoonest, shortId } from './model';
import type { PortalApi } from './api';
import type { z } from 'zod';
import { disputeStatuses, evidenceKinds, type Dispute, type DisputeDetail, type EvidenceKind } from './schemas';
import type { disputeSummarySchema } from './schemas';

type Summary = z.infer<typeof disputeSummarySchema>;

/** `/pay/disputes`: every dispute on this account, newest first, with what is at risk and what is due. */
export function Disputes({ portal }: { portal: PortalApi }) {
  const [status, setStatus] = useUrlParam('status', '');
  const summary = useResource((s) => portal.disputeSummary(s), 'portal:dispute-summary');
  const list = useCursorList(
    (cursor, s) => portal.disputes(cursor, status, s),
    `portal:disputes:${status}`,
    (d) => d.disputeId,
  );
  return (
    <DisputesView
      summary={summary.resource}
      list={list.state}
      status={status}
      setStatus={setStatus}
      loadMore={list.loadMore}
      retry={() => {
        summary.reload();
        list.reload();
      }}
    />
  );
}

export function DisputesView({
  summary,
  list,
  status,
  setStatus,
  loadMore,
  retry,
}: {
  summary: Resource<Summary>;
  list: ListState<Dispute>;
  status: string;
  setStatus: (value: string) => void;
  loadMore: () => void;
  retry: () => void;
}) {
  const { t } = portalCopy.useCopy();
  // If the dispute reads are not live, say so once; do not paint empty tiles. The failure becomes the Coming soon card when unmounted.
  const notLive = list.status === 'failed' && summary.status === 'failed';
  if (notLive) return <PortalFailure result={list.failure} retry={retry} />;
  const due = list.status === 'ready' ? nextDueSoonest(list.items) : null;
  return (
    <div className="stack">
      <Gate resource={summary} retry={retry} rows={2}>
        {(s) => (
          <KpiGrid label={t('disputeKpis')}>
            <Kpi
              label={t('kpiOpen')}
              value={s.byStatus.open + s.byStatus.contested}
              note={t('kpiOpenNote', { open: s.byStatus.open, contested: s.byStatus.contested })}
            />
            <Kpi label={t('kpiWon')} value={s.byStatus.won} />
            <Kpi label={t('kpiLost')} value={s.byStatus.lost} tone={s.byStatus.lost > 0 ? 'attention' : undefined} />
            <Kpi
              label={t('kpiAtRisk')}
              value={
                <MoneyLines
                  items={s.amountAtRisk.map((a) => ({ assetCode: a.assetId, amount: a.amount }))}
                  emptyLabel={t('nothingAtRisk')}
                />
              }
              note={t('kpiAtRiskNote')}
            />
            <Kpi
              label={t('kpiDue')}
              value={due?.responseDueAt ? <PayTime value={due.responseDueAt} /> : '—'}
              note={due ? undefined : t('kpiDueNone')}
            />
          </KpiGrid>
        )}
      </Gate>
      <PaySection
        title={t('disputesTitle')}
        description={t('disputesBody')}
        action={
          <SelectField
            label={t('filterStatus')}
            value={status}
            onChange={setStatus}
            options={[['', t('filterAll')], ...disputeStatuses.map((s) => [s, t(`chipDispute_${s}` as 'chipDispute_open')] as const)]}
          />
        }
      >
        <ListShell
          state={list}
          retry={retry}
          empty={{
            title: status ? t('disputesNoMatchTitle') : t('disputesEmptyTitle'),
            body: status ? t('disputesNoMatchBody') : t('disputesEmptyBody'),
          }}
        >
          {(rows) => (
            <>
              <DataTable
                label={t('disputesTitle')}
                headers={[t('colDispute'), t('colPayment'), t('colAmount'), t('colReason'), t('colStatus'), t('colOpened'), t('colDue')]}
              >
                {rows.map((d) => (
                  <tr key={d.disputeId}>
                    <th scope="row">
                      <a
                        className="text-link pp-mono"
                        href={`/pay/disputes/${encodeURIComponent(d.disputeId)}`}
                        aria-label={t('openDisputeAria', { id: d.disputeId })}
                      >
                        {shortId(d.disputeId)}
                      </a>
                    </th>
                    <td className="pp-mono">{shortId(d.paymentId)}</td>
                    <td>
                      <Money value={d.amount} asset={d.assetId} />
                    </td>
                    <td>{d.reasonCode ?? t('notGiven')}</td>
                    <td>
                      <Chip kind="dispute" value={d.status} />
                    </td>
                    <td>
                      <PayTime value={d.openedAt} />
                    </td>
                    <td>{d.responseDueAt ? <PayTime value={d.responseDueAt} /> : <span className="muted">{t('noDeadline')}</span>}</td>
                  </tr>
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
                  [t('colDispute'), <span className="pp-mono pp-copy">{d.disputeId}</span>],
                  [t('colPayment'), <span className="pp-mono pp-copy">{d.paymentId}</span>],
                  [t('colAmount'), <Money value={d.amount} asset={d.assetId} />],
                  [t('colReason'), d.reasonCode ?? t('notGiven')],
                  [t('colStatus'), <Chip kind="dispute" value={d.status} />],
                  [t('colDue'), d.responseDueAt ? <PayTime value={d.responseDueAt} /> : t('noDeadline')],
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
                    [t('colPayment'), <span className="pp-mono">{d.payment.paymentId}</span>],
                    [t('colAmount'), <Money value={d.payment.amount} asset={d.payment.assetId} />],
                    [t('colStatus'), <Chip kind="payment" value={d.payment.status} />],
                    [t('colOpened'), <PayTime value={d.payment.createdAt} />],
                  ]}
                />
                <a className="text-link" href="/pay/payments">
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

function EvidenceSection({ portal, dispute, reload }: { portal: PortalApi; dispute: DisputeDetail; reload: () => void }) {
  const { t } = portalCopy.useCopy();
  const [kind, setKind] = useState<EvidenceKind>('receipt');
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState<Awaited<ReturnType<typeof fingerprintFile>> | null>(null);
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <PaySection title={t('evidenceTitle')} description={t('evidenceBody')}>
      {dispute.evidence.length === 0 ? (
        <EmptyState title={t('evidenceEmptyTitle')}>{t('evidenceEmptyBody')}</EmptyState>
      ) : (
        <DataTable
          label={t('evidenceTitle')}
          headers={[t('colKind'), t('colFile'), t('colSize'), t('colFingerprint'), t('colNote'), t('colAdded')]}
        >
          {dispute.evidence.map((e) => (
            <tr key={e.evidenceId}>
              <th scope="row">{t(`evidence_${e.kind}` as 'evidence_receipt')}</th>
              <td>
                {e.fileName}
                <small className="pay-cell-note">{e.contentType}</small>
              </td>
              <td className="numeric">{formatBytes(e.sizeBytes)}</td>
              <td className="pp-mono" title={e.sha256}>
                {e.sha256.slice(0, 12)}…
              </td>
              <td>{e.note ?? '—'}</td>
              <td>
                <PayTime value={e.createdAt} />
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      {dispute.canRespond ? (
        <div className="form-stack pp-form pp-add-evidence">
          <h3 className="pp-sub">{t('addEvidence')}</h3>
          <p className="pp-callout" role="note">
            {t('evidenceMetaOnly')}
          </p>
          <label className="field">
            <span>{t('fFile')} *</span>
            <input
              ref={input}
              type="file"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return setPicked(null);
                setReading(true);
                try {
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
            title={t('addEvidence')}
            variant="primary"
            description={t('addEvidenceBody')}
            review={
              picked && (
                <Facts
                  items={[
                    [t('colKind'), t(`evidence_${kind}` as 'evidence_receipt')],
                    [t('colFile'), picked.fileName],
                    [t('colSize'), formatBytes(String(picked.sizeBytes))],
                    [t('colFingerprint'), <span className="pp-mono">{picked.sha256}</span>],
                  ]}
                />
              )
            }
            perform={() =>
              portal.addEvidence({ disputeId: dispute.disputeId, kind, ...picked!, ...(note.trim() ? { note: note.trim() } : {}) })
            }
            onConfirmed={() => {
              setPicked(null);
              setNote('');
              if (input.current) input.current.value = '';
              reload();
            }}
            disabled={!picked || reading}
          />
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
  // One id per decision: a retried click replays the first answer instead of deciding twice.
  const [contestId] = useState(newRequestId);
  const [acceptId] = useState(newRequestId);
  const canContest = dispute.status === 'open' && dispute.evidence.length > 0;
  return (
    <PaySection title={t('respondTitle')} description={t('respondBody')}>
      {!dispute.canRespond ? (
        <p className="pp-callout" role="note">
          {dispute.responses.length > 0 ? t('respondedAlready') : t('respondClosed')}
        </p>
      ) : (
        <div className="form-stack pp-form">
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
                  requestId: contestId,
                  disputeId: dispute.disputeId,
                  action: 'contest',
                  ...(note.trim() ? { note: note.trim() } : {}),
                })
              }
              onConfirmed={reload}
              disabled={!canContest}
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
                  requestId: acceptId,
                  disputeId: dispute.disputeId,
                  action: 'accept_liability',
                  ...(note.trim() ? { note: note.trim() } : {}),
                })
              }
              onConfirmed={reload}
            />
          </div>
          {!canContest && (
            <p className="muted pp-note">{dispute.status !== 'open' ? t('whyNoContestStatus') : t('whyNoContestEvidence')}</p>
          )}
        </div>
      )}
    </PaySection>
  );
}
