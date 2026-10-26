import { useState } from 'react';
import { Button } from '@intafaced/ui';
import { useResource } from '../../../../shared/resource';
import { HaltBanner, SpanText } from '../components';
import type { PortalApi } from '../api';
import { buildCsv, downloadText } from '../csv';
import { useMemberNames, useNow, useReadAt } from '../hooks';
import { portalRefusal } from '../refusal';
import { approvalStatuses, type Approval } from '../schemas';
import { DateTime } from '../ui/DateTime';
import { FilterRow, useListFilters } from '../ui/FilterRow';
import { Freshness } from '../ui/Freshness';
import { KpiStrip } from '../ui/Kpi';
import { MoneyText } from '../ui/MoneyText';
import { PortalReview } from '../ui/PortalReview';
import { StatusChip } from '../ui/StatusChip';
import { uiCopy } from '../ui/copy';
import { useServerList } from '../ui/useServerList';
import { ListBody, payoutName, TestBanner, useListQuery, useTestMode, whoIs } from './common';
import { mc } from './copy';
import { useMoneyReason } from '../access/MoneyAction';
import { usePayoutPicture } from './payout-picture';
import { describeDestination } from './destination';
import {
  ageOf,
  decisionBlock,
  decisionLanded,
  expiresToday,
  isCheckedPending,
  minReasonOk,
  overRemaining,
  waitingFrom,
  type RoleLike,
} from './model';

export const payoutHref = (settlementId: string) => `/pay/payouts/${encodeURIComponent(settlementId)}`;
const noNames: ReadonlyMap<string, string> = new Map();

/** Where a payout would go, in words: "Wallet 0x1234…abcd · Crypto network". Empty when the request does not say. */
export function useApprovalDestination() {
  const { t } = mc.useCopy();
  return (a: Pick<Approval, 'destinationKind' | 'destinationMasked' | 'railId'>): string | null =>
    a.destinationMasked ? describeDestination(t, a.destinationKind ?? '', a.destinationMasked, a.railId ?? '') : null;
}

/** `/pay/approvals`: payout requests waiting on a second person. Nobody can approve a payout they asked for. */
export function Approvals({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const test = useTestMode();
  const now = useNow();
  const names = useMemberNames(portal);
  const me = portal.userId;
  const filters = useListFilters();
  const query = useListQuery(filters);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `money:halts:${merchantId}`);
  const pending = useResource(
    (s) => portal.approvalPage(merchantId, { status: 'pending' }, undefined, s),
    `money:approvals-pending:${merchantId}`,
  );
  const list = useServerList(
    (f, cursor, signal) => portal.approvalPage(merchantId, { status: f.status, search: f.search, from: f.from, to: f.to }, cursor, signal),
    { status: query.status ?? '', search: query.search ?? '', from: query.from ?? '', to: query.to ?? '' },
    (a: Approval) => a.approvalId,
  );
  const readAt = useReadAt(list.state.status === 'ready', list.state);
  const destination = useApprovalDestination();
  const rows = list.state.status === 'ready' ? list.state.items : [];
  const p = pending.resource.status === 'ready' ? pending.resource.data : null;
  const open = p ? ('items' in p ? p.items : p) : null;
  const more = p && 'items' in p ? p.nextCursor !== null : false;
  const count = (n: number) => (more ? t('mnCountNewest', { n }) : String(n));
  const oldest = open?.length ? open.reduce((a, b) => (Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? a : b)) : null;
  const minePending = open ? open.filter((a) => me !== null && a.makerUserId === me).length : null;
  const expiring = open ? open.filter((a) => expiresToday(a, now)).length : null;
  // A payout is named by its settlement's day, as on Payouts; an approval only knows the day it was asked for.
  const picture = usePayoutPicture(portal, merchantId);
  const settledOn = new Map((picture.resource.status === 'ready' ? picture.resource.data.items : []).map((p) => [p.id, p.createdAt]));
  const name = (a: Approval) => payoutName(t, locale, { createdAt: settledOn.get(a.settlementId) }, a);
  const ageChip = (a: Approval) =>
    a.status === 'pending' ? (
      <span className="pp-agechip" title={t('ageTip')}>
        {t('ageWaiting')} <SpanText ms={ageOf(a, now)} />
      </span>
    ) : null;
  const waiting = (a: Approval) => {
    const w = waitingFrom(a);
    return w ? <small className="pay-cell-note">{w === 'intafaced' ? t('waitingIntafaced') : t('waitingTeam')}</small> : null;
  };
  return (
    <div className="stack">
      <HaltBanner resource={halts.resource} scopes={['payout']} />
      <TestBanner />
      <Freshness asOf={readAt} />
      <KpiStrip
        label={t('apvTiles')}
        tiles={[
          {
            label: t('apvWaiting'),
            period: t('mnPeriodNow'),
            href: '/pay/approvals?status=pending',
            value: open ? count(open.length) : '—',
            tone: open && open.length > 0 ? 'attention' : undefined,
          },
          {
            label: t('apvOldest'),
            period: t('mnPeriodNow'),
            href: '/pay/approvals?status=pending',
            value: oldest ? <SpanText ms={ageOf(oldest, now)} /> : '—',
            note: oldest ? undefined : t('apvOldestNone'),
          },
          {
            label: t('apvExpiring'),
            period: t('mnPeriodNext24'),
            href: '/pay/approvals?status=pending',
            value: expiring === null ? '—' : String(expiring),
          },
          {
            label: t('apvYours'),
            period: t('mnPeriodNow'),
            href: '/pay/approvals?status=pending',
            value: minePending === null ? '—' : String(minePending),
            note: t('apvYoursNote'),
          },
        ]}
      />
      <FilterRow
        filters={filters}
        label={t('apvFilters')}
        statuses={approvalStatuses.map((s) => [s, t(`chipApproval_${s}` as 'chipApproval_pending')] as const)}
        shown={rows.length}
        hasMore={list.state.status === 'ready' && list.state.hasMore}
      />
      <div className="pp-actions">
        <Button
          variant="secondary"
          disabled={rows.length === 0}
          onClick={() =>
            downloadText(
              'approvals-this-page.csv',
              buildCsv(
                ['approval_id', 'settlement_id', 'asset', 'amount', 'status', 'requested', 'expires'],
                rows.map((a) => [a.approvalId, a.settlementId, a.assetCode, a.amount, a.status, a.createdAt, a.expiresAt]),
                { generatedAt: new Date().toISOString(), asOf: readAt ?? '' },
              ),
            )
          }
        >
          {t('mnExportPage')}
        </Button>
        <small className="muted">{t('mnExportPageNote')}</small>
      </div>
      <ListBody
        state={list.state}
        retry={() => list.reload()}
        onMore={list.loadMore}
        filtered={{
          active: Boolean(filters.search || filters.status || filters.date),
          clear: () => {
            filters.setSearch('');
            filters.setStatus('');
            filters.setDate('');
          },
        }}
        empty={{
          title: t('apvEmptyTitle'),
          body: t('apvEmptyBody'),
          action: (
            <a className="text-link" href="/pay/payouts/new">
              {t('apvEmptyAction')}
            </a>
          ),
        }}
        label={t('apvTable')}
        rowKey={(a) => a.approvalId}
        href={(a) => payoutHref(a.settlementId)}
        columns={[
          {
            header: t('colPayout'),
            cell: (a) => (
              <>
                {name(a)}
                {destination(a) && <small className="pay-cell-note">{destination(a)}</small>}
              </>
            ),
          },
          { header: t('colAmount'), cell: (a) => <MoneyText value={a.amount} asset={a.assetCode} test={test} /> },
          { header: t('requestedBy'), cell: (a) => whoIs(a.makerUserId, me, names, t('mnMe')) },
          {
            header: t('colStatus'),
            cell: (a) => (
              <>
                <StatusChip entity="approval" value={a.status} />
                {ageChip(a)}
                {waiting(a)}
              </>
            ),
          },
          { header: t('colExpires'), cell: (a) => <DateTime value={a.expiresAt} /> },
        ]}
        card={(a) => ({
          title: name(a),
          time:
            a.status === 'pending' ? (
              <>
                {t('ageWaiting')} <SpanText ms={ageOf(a, now)} /> · {destination(a) ?? ''}
              </>
            ) : (
              <DateTime value={a.createdAt} />
            ),
          amount: <MoneyText value={a.amount} asset={a.assetCode} test={test} />,
          status: <StatusChip entity="approval" value={a.status} />,
        })}
      />
      <p className="muted pp-note">
        <a className="text-link" href="/pay/settings/notifications">
          {t('apvNotify')}
        </a>
      </p>
      <p className="muted pp-note">{t('apvOpenToDecide')}</p>
    </div>
  );
}

/** Stands in for the amount while the sentence is split around it. */
const LEFT_MARK = '\u0001';

/** Approve or reject one request. The reason is required and is kept with the decision. */
export function ApprovalDecision({
  portal,
  approval,
  me,
  role,
  now,
  names = noNames,
  remaining = null,
  onDone,
}: {
  portal: PortalApi;
  approval: Approval;
  me: string | null;
  role: RoleLike;
  now: number;
  names?: ReadonlyMap<string, string>;
  /** What is left of today's payout limit for this asset, when known. More than this warns before approving. */
  remaining?: string | null;
  onDone: () => void;
}) {
  const { t } = mc.useCopy();
  const destination = useApprovalDestination();
  const [reason, setReason] = useState('');
  const block = decisionBlock(approval, me, role, now);
  const reasonOk = minReasonOk(reason);
  const why = block ? t(`block_${block}` as 'block_own') : reasonOk ? null : t('reasonNeeded');
  const disabled = block !== null || !reasonOk;
  const overLimit = remaining !== null && overRemaining(approval.amount, remaining);
  // The amount left is a <MoneyText>, so inside the review it shows every digit like the other figures there.
  const [overBefore = '', overAfter = ''] = t('apvOverLimit', { left: LEFT_MARK }).split(LEFT_MARK);
  const overWarning = overLimit ? (
    <>
      {overBefore}
      <MoneyText value={remaining!} asset={approval.assetCode} />
      {overAfter}
    </>
  ) : null;
  // A decision the service answered but that did not take effect (voided or ended meanwhile) is shown as a refusal.
  const decide = (decision: 'approve' | 'reject') => async () => {
    const result = await portal.decideApproval({
      approvalId: approval.approvalId,
      decision,
      expectedPayloadHash: approval.payloadHash,
      reason: reason.trim(),
    });
    if (!result.ok || decisionLanded(decision, result.data.status)) return result;
    return portalRefusal(result.data.status === 'voided' ? 'rApprovalVoidedResult' : 'rApprovalNotLanded', 'error');
  };
  const review = (verb: string) => (
    <dl data-testid="pp-facts" className="pp-facts">
      <div>
        <dt>{t('decisionVerb')}</dt>
        <dd>{verb}</dd>
      </div>
      <div>
        <dt>{t('colAmount')}</dt>
        <dd>
          <MoneyText value={approval.amount} asset={approval.assetCode} />
        </dd>
      </div>
      <div>
        <dt>{t('apvTo')}</dt>
        <dd>{destination(approval) ?? t('apvToUnknown')}</dd>
      </div>
      <div>
        <dt>{t('requestedBy')}</dt>
        <dd>{whoIs(approval.makerUserId, me, names, t('mnMe'))}</dd>
      </div>
      {overWarning && verb === t('approve') && (
        <div>
          <dt>{t('apvOverLimitLabel')}</dt>
          <dd>{overWarning}</dd>
        </div>
      )}
      <div>
        <dt>{t('decisionReason')}</dt>
        <dd>{reason.trim()}</dd>
      </div>
    </dl>
  );
  return (
    <div data-testid="form-stack" className="form-stack pp-form pp-decision">
      {isCheckedPending(approval) && (
        <p className="pp-callout" role="note">
          {t('checkedBanner', { who: whoIs(approval.checkerUserId!, me, names, t('mnMe')) })}
        </p>
      )}
      {overWarning && (
        <p className="pp-callout pp-callout--warn" role="note">
          {overWarning}
        </p>
      )}
      <label className="field">
        <span>{t('decisionReason')} *</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} disabled={block !== null} />
        <small>{t('hDecisionReason')}</small>
      </label>
      <div className="pp-actions">
        <PortalReview
          title={t('approve')}
          variant="primary"
          description={t('approveBody')}
          review={review(t('approve'))}
          perform={decide('approve')}
          onConfirmed={onDone}
          disabled={disabled}
          disabledReason={why ?? undefined}
        />
        <PortalReview
          title={t('reject')}
          variant="sell"
          description={t('rejectBody')}
          review={review(t('reject'))}
          perform={decide('reject')}
          onConfirmed={onDone}
          disabled={disabled}
          disabledReason={why ?? undefined}
        />
      </div>
      {why && (
        <p className="muted pp-note" role="note">
          {why}
        </p>
      )}
    </div>
  );
}

/** The person who asked can take the request back while it is still waiting. */
export function CancelRequest({
  portal,
  approval,
  me,
  onDone,
}: {
  portal: PortalApi;
  approval: Approval;
  me: string | null;
  onDone: () => void;
}) {
  const { t } = mc.useCopy();
  const destination = useApprovalDestination();
  const [reason, setReason] = useState('');
  // Taking a request back carries the payout scope, like making it.
  const stepReason = useMoneyReason('payout', 'cancel');
  const mine = me !== null && approval.makerUserId === me;
  if (approval.status !== 'pending') return null;
  const why = !mine ? t('cancelOnlyMaker') : stepReason ? stepReason : !minReasonOk(reason) ? t('reasonNeeded') : undefined;
  return (
    <div data-testid="form-stack" className="form-stack pp-form">
      <label className="field">
        <span>{t('cancelReason')} *</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} disabled={!mine} />
        <small>{t('hDecisionReason')}</small>
      </label>
      <PortalReview
        stepUp="payout"
        title={t('cancelRequest')}
        description={t('cancelRequestBody')}
        review={
          <dl data-testid="pp-facts" className="pp-facts">
            <div>
              <dt>{t('colAmount')}</dt>
              <dd>
                <MoneyText value={approval.amount} asset={approval.assetCode} />
              </dd>
            </div>
            <div>
              <dt>{t('apvTo')}</dt>
              <dd>{destination(approval) ?? t('apvToUnknown')}</dd>
            </div>
            <div>
              <dt>{t('cancelReason')}</dt>
              <dd>{reason.trim()}</dd>
            </div>
          </dl>
        }
        perform={() => portal.cancelApproval({ approvalId: approval.approvalId, reason: reason.trim() })}
        onConfirmed={onDone}
        disabled={!mine || stepReason !== null || !minReasonOk(reason)}
        disabledReason={why}
      />
      {!mine && (
        <p className="muted pp-note" role="note">
          {t('cancelOnlyMaker')}
        </p>
      )}
    </div>
  );
}
