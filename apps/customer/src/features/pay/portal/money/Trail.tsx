import type { Approval, Settlement } from '../schemas';
import { DateTime } from '../ui/DateTime';
import { StatusChip } from '../ui/StatusChip';
import { mc } from './copy';
import { whoIs } from './common';
import { describeDestination } from './destination';
import { orderTrail, type TrailEvent } from './model';
import type { Lifecycle } from './schemas';

type Words = ReturnType<typeof mc.useCopy>['t'];
const KINDS = {
  'settlement.opened': 'trSettlementOpened',
  'settlement.posted': 'trSettlementPosted',
  'settlement.released': 'trSettlementReleased',
  'approval.requested': 'trApprovalRequested',
  'approval.approved': 'trApprovalApproved',
  'approval.rejected': 'trApprovalRejected',
  'approval.voided': 'trApprovalVoided',
  'approval.expired': 'trApprovalExpired',
  'approval.consumed': 'trApprovalConsumed',
  'payout.admitted': 'trPayoutAdmitted',
  'rail.sent': 'trRailSent',
  'rail.confirmed': 'trRailConfirmed',
  'rail.refused': 'trRailRefused',
  'payout.reversed': 'trPayoutReversed',
} as const;
export const trailTitle = (t: Words, kind: string) => (kind in KINDS ? t(KINDS[kind as keyof typeof KINDS]) : t('trOther'));
const TERMINAL = new Set(['rail.confirmed', 'rail.refused', 'payout.reversed']);

/** The trail from the payout lifecycle read: every attempt in time order, the final state last. */
export function lifecycleEvents(
  t: Words,
  lifecycle: Lifecycle,
  approvals: readonly Approval[],
  me: string | null,
  names: ReadonlyMap<string, string>,
): TrailEvent[] {
  const byId = new Map(approvals.map((a) => [a.approvalId, a]));
  const you = t('you');
  const events: TrailEvent[] = lifecycle.events.map((e) => {
    const a = e.approvalId ? byId.get(e.approvalId) : undefined;
    const person =
      e.kind === 'approval.requested' ? a?.makerUserId : e.kind === 'approval.approved' || e.kind === 'approval.rejected' ? a?.checkerUserId : null;
    return {
      key: e.id,
      at: e.at,
      kind: e.kind,
      ...(person ? { who: whoIs(person, me, names, you) } : {}),
      destination: e.destinationMasked ? describeDestination(t, e.destinationKind ?? '', e.destinationMasked, e.railId ?? '') : null,
      failure: e.failure?.message ?? null,
      terminal: TERMINAL.has(e.kind),
    };
  });
  return orderTrail(events, lifecycle.status === 'paid_out' ? 'paid_out' : lifecycle.status === 'failed' ? 'failed' : 'other');
}

/**
 * The trail when the lifecycle read is not available: the settlement's own times plus every approval attempt, merged and
 * ordered by time. A rejected request followed by a paid payout reads in that order and ends on "Paid out".
 */
export function fallbackEvents(
  t: Words,
  settlement: Pick<Settlement, 'createdAt' | 'sentAt' | 'settledAt' | 'failedAt' | 'failure' | 'status'>,
  approvals: readonly Approval[],
  me: string | null,
  names: ReadonlyMap<string, string>,
): TrailEvent[] {
  const you = t('you');
  const out: TrailEvent[] = [];
  if (settlement.createdAt) out.push({ key: 'created', at: settlement.createdAt, kind: 'settlement.opened' });
  for (const a of approvals) {
    const to = a.destinationMasked ? describeDestination(t, a.destinationKind ?? '', a.destinationMasked, a.railId ?? '') : null;
    out.push({ key: `${a.approvalId}:req`, at: a.createdAt, kind: 'approval.requested', who: whoIs(a.makerUserId, me, names, you), destination: to });
    if (a.status === 'approved' || a.status === 'consumed')
      out.push({
        key: `${a.approvalId}:ok`,
        at: a.decidedAt ?? a.createdAt,
        kind: 'approval.approved',
        ...(a.checkerUserId ? { who: whoIs(a.checkerUserId, me, names, you) } : {}),
      });
    if (a.status === 'rejected')
      out.push({
        key: `${a.approvalId}:no`,
        at: a.decidedAt ?? a.createdAt,
        kind: 'approval.rejected',
        ...(a.checkerUserId ? { who: whoIs(a.checkerUserId, me, names, you) } : {}),
      });
    if (a.status === 'voided') out.push({ key: `${a.approvalId}:void`, at: a.decidedAt ?? a.expiresAt, kind: 'approval.voided' });
    if (a.status === 'expired') out.push({ key: `${a.approvalId}:exp`, at: a.expiresAt, kind: 'approval.expired' });
  }
  if (settlement.sentAt) out.push({ key: 'sent', at: settlement.sentAt, kind: 'rail.sent' });
  if (settlement.settledAt) out.push({ key: 'paid', at: settlement.settledAt, kind: 'rail.confirmed', terminal: true });
  if (settlement.failedAt) out.push({ key: 'failed', at: settlement.failedAt, kind: 'rail.refused', failure: settlement.failure?.message ?? null, terminal: true });
  return orderTrail(out, settlement.status === 'paid_out' ? 'paid_out' : settlement.status === 'failed' ? 'failed' : 'other');
}

export function Trail({ events }: { events: readonly TrailEvent[] }) {
  const { t } = mc.useCopy();
  return (
    <ol className="pp-timeline" aria-label={t('trailLabel')}>
      {events.map((e) => (
        <li key={e.key}>
          <span className="pp-timeline-dot" aria-hidden="true" />
          <div>
            <strong>{trailTitle(t, e.kind)}</strong>
            {e.who && <p className="muted">{t('trailBy', { who: e.who })}</p>}
            {e.destination && <p className="muted">{e.destination}</p>}
            {e.failure && <p className="muted">{e.failure}</p>}
            <small className="muted">{e.at ? <DateTime value={e.at} /> : t('trailNoTime')}</small>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function LifecycleTrail({
  lifecycle,
  approvals,
  me,
  names,
}: {
  lifecycle: Lifecycle;
  approvals: readonly Approval[];
  me: string | null;
  names: ReadonlyMap<string, string>;
}) {
  const { t } = mc.useCopy();
  return (
    <>
      <p>
        <StatusChip entity="settlement" value={lifecycle.status} />
      </p>
      {lifecycle.failure && (
        <p className="pp-callout pp-callout--warn" role="alert">
          {lifecycle.failure.message}
        </p>
      )}
      {lifecycle.events.length === 0 ? <p className="muted">{t('trailNone')}</p> : <Trail events={lifecycleEvents(t, lifecycle, approvals, me, names)} />}
    </>
  );
}
