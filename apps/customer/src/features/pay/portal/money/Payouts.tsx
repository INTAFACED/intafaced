import { useResource, type Resource } from '../../../../shared/resource';
import { Button, EmptyState } from '@intafaced/ui';
import { PaySection } from '../../components';
import { Gate, HaltBanner, Money, PortalFailure, PortalLoading, SpanText } from '../components';
import { isComingSoon, portalRefusal } from '../refusal';
import type { PortalApi } from '../api';
import { buildCsv, downloadText } from '../csv';
import { useMemberNames, useNow, useReadAt } from '../hooks';
import { isUuid } from '../model';
import type { Approval, Settlement, Usage } from '../schemas';
import { AuditPanel } from '../ui/AuditPanel';
import { CopyReference } from '../ui/CopyReference';
import { DateTime } from '../ui/DateTime';
import { DetailHeader } from '../ui/DetailHeader';
import { FilterRow, useListFilters } from '../ui/FilterRow';
import { Freshness } from '../ui/Freshness';
import { KpiStrip } from '../ui/Kpi';
import { MoneyText } from '../ui/MoneyText';
import { RelatedLinks } from '../ui/RelatedLinks';
import { StatusChip } from '../ui/StatusChip';
import { uiCopy } from '../ui/copy';
import { useServerList } from '../ui/useServerList';
import { ApprovalDecision, CancelRequest, useApprovalDestination } from './Approvals';
import { ExportButton, LinkButton, ListBody, payoutName, TestBanner, useListQuery, useTestMode, whoIs } from './common';
import { mc } from './copy';
import { describeDestination } from './destination';
import {
  approvalsBySettlement,
  latestApproval,
  limitRows,
  payoutHeadroom,
  payoutRowState,
  payoutState,
  waitingFrom,
  type RoleLike,
} from './model';
import { settlementHref } from './Settlements';
import { fallbackEvents, LifecycleTrail, Trail } from './Trail';
import type { Lifecycle, PayoutItem } from './schemas';
import { Facts, NotConfigured, UsageBar } from '../components';
import type { PayoutState } from '../model';

const PAYOUT_STATUSES = ['pending', 'posted', 'paid_out', 'failed'] as const;
const stateOfStatus = { pending: 'not_ready', posted: 'ready', paid_out: 'paid_out', failed: 'failed' } as const;

/** `/pay/payouts`: money leaving your balance, and where each payout is in approval. */
export function Payouts({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const test = useTestMode();
  const filters = useListFilters();
  const query = useListQuery(filters);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `money:halts:${merchantId}`);
  const pending = useResource((s) => portal.approvalPage(merchantId, { status: 'pending' }, undefined, s), `money:approvals-pending:${merchantId}`);
  const counts = useResource(async (s) => {
    const reads = await Promise.all(PAYOUT_STATUSES.map((status) => portal.payoutPage({ status }, undefined, s, 25)));
    const bad = reads.find((r) => !r.ok);
    if (bad && !bad.ok) return bad;
    const n = (i: number) => {
      const r = reads[i]!;
      if (!r.ok) return { n: 0, more: false };
      const page = 'items' in r.data ? r.data : { items: r.data, nextCursor: null };
      return { n: page.items.length, more: page.nextCursor !== null };
    };
    return { ok: true as const, data: { pending: n(0), posted: n(1), paid_out: n(2), failed: n(3) } };
  }, `money:payout-counts:${merchantId}`);
  // Where the payouts list is not released, the page falls back to settlements that are no longer pending, headed "Newest".
  const list = useServerList(
    async (f, cursor, signal) => {
      const direct = await portal.payoutPage(
        { status: f.status, assetId: f.assetId, from: f.from, to: f.to, search: f.search },
        cursor,
        signal,
      );
      if (direct.ok || !isComingSoon(direct)) return direct;
      const derived = await portal.settlementPage(merchantId, { status: f.status, assetId: f.assetId, from: f.from, to: f.to, search: f.search }, cursor, signal);
      if (!derived.ok) return derived;
      return {
        ok: true as const,
        data: {
          items: derived.data.items.map(
            (s): PayoutItem => ({
              id: s.id,
              window: s.window,
              assetId: s.assetId,
              gross: s.gross,
              fees: s.fees,
              net: s.net,
              status: s.status,
              payoutMethod: s.payoutMethod,
              payoutReference: s.payoutRef,
              createdAt: s.createdAt ?? new Date(0).toISOString(),
            }),
          ),
          nextCursor: derived.data.nextCursor,
        },
      };
    },
    { status: query.status ?? '', assetId: query.assetId ?? '', from: query.from ?? '', to: query.to ?? '', search: query.search ?? '' },
    (p: PayoutItem) => p.id,
  );
  const readAt = useReadAt(list.state.status === 'ready', list.state);
  const rows = list.state.status === 'ready' ? list.state.items : [];
  const assets = [...new Set(rows.map((r) => r.assetId))].sort();
  const p = pending.resource.status === 'ready' ? pending.resource.data : null;
  const approvals = p ? approvalsBySettlement('items' in p ? p.items : p) : null;
  const c = counts.resource.status === 'ready' ? counts.resource.data : undefined;
  const count = (x: { n: number; more: boolean } | undefined) => (x ? (x.more ? t('countNewest', { n: x.n }) : String(x.n)) : '—');
  const waitingN = p ? ('items' in p ? p.items : p).length : null;
  return (
    <div className="stack">
      <HaltBanner resource={halts.resource} scopes={['payout']} />
      <TestBanner />
      <Freshness asOf={readAt} />
      <KpiStrip
        label={t('payTiles')}
        tiles={[
          { label: t('payReady'), period: t('periodNow'), href: '/pay/payouts?status=posted', value: count(c?.posted) },
          {
            label: t('payWaiting'),
            period: t('periodNow'),
            href: '/pay/approvals?status=pending',
            value: waitingN === null ? '—' : String(waitingN),
            tone: waitingN ? 'attention' : undefined,
          },
          { label: t('payPaid'), period: t('periodNewest'), href: '/pay/payouts?status=paid_out', value: count(c?.paid_out) },
          {
            label: t('payFailed'),
            period: t('periodNow'),
            href: '/pay/payouts?status=failed',
            value: count(c?.failed),
            tone: c && c.failed.n > 0 ? 'attention' : undefined,
          },
          { label: t('payNotReady'), period: t('periodNow'), href: '/pay/payouts?status=pending', value: count(c?.pending) },
        ]}
      />
      <FilterRow
        filters={filters}
        label={t('payFilters')}
        statuses={PAYOUT_STATUSES.map((s) => [s, t(`chipPayout_${stateOfStatus[s]}` as 'chipPayout_ready')] as const)}
        assets={assets}
        shown={rows.length}
        hasMore={list.state.status === 'ready' && list.state.hasMore}
      />
      <ExportButton
        portal={portal}
        kind="payouts"
        query={query}
        fallback={
          <Button
            variant="secondary"
            disabled={rows.length === 0}
            onClick={() =>
              downloadText(
                'payouts-this-page.csv',
                buildCsv(
                  ['settlement_id', 'created', 'asset', 'net_paid', 'status', 'payout_method', 'payout_reference'],
                  rows.map((r) => [r.id, r.createdAt, r.assetId, r.net, r.status, r.payoutMethod ?? '', r.payoutReference ?? '']),
                  { generatedAt: new Date().toISOString(), asOf: readAt ?? '' },
                ),
              )
            }
          >
            {t('exportThisPage')}
          </Button>
        }
      />
      <ListBody
        state={list.state}
        retry={() => list.reload()}
        onMore={list.loadMore}
        filtered={{
          active: Boolean(filters.search || filters.status || filters.date || filters.asset),
          clear: () => {
            filters.setSearch('');
            filters.setStatus('');
            filters.setDate('');
            filters.setAsset('');
          },
        }}
        empty={{
          title: t('payEmptyTitle'),
          body: t('payEmptyBody'),
          action: <LinkButton href="/pay/settlements">{t('payEmptyAction')}</LinkButton>,
        }}
        label={t('payTable')}
        rowKey={(r) => r.id}
        href={(r) => `/pay/payouts/${encodeURIComponent(r.id)}`}
        columns={[
          { header: t('colPayout'), cell: (r) => payoutName(t, locale, r, approvals?.get(r.id)) },
          { header: t('colAmount'), cell: (r) => <MoneyText value={r.net} asset={r.assetId} test={test} /> },
          {
            header: t('colStatus'),
            cell: (r) => {
              const a = approvals?.get(r.id);
              const w = a ? waitingFrom(a) : null;
              return (
                <>
                  <StatusChip entity="payout" value={payoutRowState(r, approvals)} />
                  {w && r.status === 'posted' && <small className="pay-cell-note">{w === 'intafaced' ? t('waitingIntafaced') : t('waitingTeam')}</small>}
                </>
              );
            },
          },
          { header: t('colCreated'), cell: (r) => <DateTime value={r.createdAt} /> },
          { header: t('colTransaction'), cell: (r) => (r.payoutReference ? <span className="pp-mono">{r.payoutReference}</span> : <span className="muted">{t('notPaidYet')}</span>) },
        ]}
        card={(r) => ({
          title: payoutName(t, locale, r, approvals?.get(r.id)),
          time: <DateTime value={r.createdAt} />,
          amount: <MoneyText value={r.net} asset={r.assetId} test={test} />,
          status: <StatusChip entity="payout" value={payoutRowState(r, approvals)} />,
        })}
      />
    </div>
  );
}

// ---- detail ---------------------------------------------------------------------------------------------

/** `/pay/payouts/:id` (the id is the settlement's): who asked, who approved, your limit, and what happened to the money. */
export function PayoutDetailPage({
  portal,
  merchantId,
  payoutId,
  role,
}: {
  portal: PortalApi;
  merchantId: string;
  payoutId: string;
  role: RoleLike;
}) {
  const valid = isUuid(payoutId);
  const settlement = useResource(
    (s) => (valid ? portal.settlement(payoutId, s) : Promise.resolve(portalRefusal('rPayoutNotFound'))),
    `money:payout:${payoutId}`,
  );
  const lifecycle = useResource(
    (s) => (valid ? portal.settlementLifecycle(payoutId, s) : Promise.resolve(portalRefusal('rPayoutNotFound'))),
    `money:payout-lifecycle:${payoutId}`,
  );
  const approvals = useResource(async (s) => {
    const page = await portal.approvalPage(merchantId, {}, undefined, s);
    return page.ok ? { ok: true as const, data: ('items' in page.data ? page.data.items : page.data).filter((a) => a.settlementId === payoutId) } : page;
  }, `money:payout-approvals:${payoutId}`);
  const usage = useResource((s) => portal.usage(merchantId, s), `money:usage:${merchantId}`);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `money:halts:${merchantId}`);
  const now = useNow();
  const names = useMemberNames(portal);
  const readAt = useReadAt(settlement.resource.status === 'ready', settlement.resource);
  const reload = () => {
    settlement.reload();
    lifecycle.reload();
    approvals.reload();
    usage.reload();
    halts.reload();
  };
  return (
    <PayoutDetailView
      portal={portal}
      settlement={settlement.resource}
      lifecycle={lifecycle.resource}
      approvals={approvals.resource}
      usage={usage.resource}
      halts={halts.resource}
      role={role}
      now={now}
      names={names}
      readAt={readAt}
      reload={reload}
    />
  );
}

export function PayoutDetailView({
  portal,
  settlement,
  lifecycle,
  approvals,
  usage,
  halts,
  role,
  now,
  names,
  readAt,
  reload,
}: {
  portal: PortalApi;
  settlement: Resource<Settlement>;
  lifecycle: Resource<Lifecycle>;
  approvals: Resource<Approval[]>;
  usage: Resource<Usage>;
  halts: Resource<import('../schemas').HaltStatus>;
  role: RoleLike;
  now: number;
  names: ReadonlyMap<string, string>;
  readAt: string | null;
  reload: () => void;
}) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const test = useTestMode();
  const me = portal.userId;
  const destination = useApprovalDestination();
  return (
    <div className="stack">
      <HaltBanner resource={halts} scopes={['payout']} />
      <Gate resource={settlement} retry={reload} rows={5}>
        {(s) => {
          const trail = approvals.status === 'ready' ? [...approvals.data].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)) : [];
          const latest = approvals.status === 'ready' ? latestApproval(approvals.data, s.id) : null;
          const state: PayoutState = payoutState(s, latest, approvals.status === 'ready');
          const lc = lifecycle.status === 'ready' ? lifecycle.data : null;
          const dest = lc?.destination
            ? describeDestination(t, lc.destination.kind, lc.destination.destinationMasked, lc.destination.railId)
            : latest
              ? destination(latest)
              : null;
          const action =
            state === 'ready' ? (
              <LinkButton variant="primary" href={`/pay/payouts/new?settlement=${encodeURIComponent(s.id)}`}>
                {t('pdoRequest')}
              </LinkButton>
            ) : state === 'awaiting_approval' ? (
              <LinkButton variant="primary" href="/pay/approvals?status=pending">
                {t('pdoReview')}
              </LinkButton>
            ) : undefined;
          return (
            <>
              <DetailHeader
                back={{ href: '/pay/payouts', label: t('backPayouts') }}
                title={<Money value={s.net} asset={s.assetId} />}
                status={<StatusChip entity="payout" value={state} />}
                subtitle={payoutName(t, locale, { createdAt: s.createdAt ?? s.settledAt ?? s.sentAt ?? new Date(0).toISOString() }, latest)}
                action={action}
              />
              <TestBanner />
              <Freshness asOf={readAt} />
              {latest?.status === 'voided' && (
                <p className="pp-callout pp-callout--warn" role="alert">
                  {t('voidBanner')}
                </p>
              )}
              {state === 'failed' && (
                <p className="pp-callout pp-callout--warn" role="alert">
                  {lc?.failure?.message ?? s.failure?.message ?? t('payoutFailedBody')}
                </p>
              )}
              {state === 'not_ready' && <p className="pp-callout">{t('payoutNotReadyBody')}</p>}

              <PaySection title={t('pdoFactsTitle')}>
                <Facts
                  items={[
                    [t('colStatus'), <StatusChip entity="payout" value={state} />],
                    [t('colAmount'), <MoneyText value={s.net} asset={s.assetId} test={test} />],
                    [t('apvTo'), dest ?? <span className="muted">{t('apvToUnknown')}</span>],
                    ...(lc?.fee != null ? ([[t('pdoFee'), <MoneyText value={lc.fee} asset={s.assetId} test={test} />]] as const) : []),
                    [t('pdoScreening'), <NotConfigured>{t('pdoScreeningNone')}</NotConfigured>],
                    [t('payoutMethod'), s.payoutMethod ?? <span className="muted">{t('notPaidYet')}</span>],
                    [
                      t('colTransaction'),
                      s.payoutRef ? <CopyReference value={s.payoutRef} what={t('colTransaction')} /> : <span className="muted">{t('notPaidYet')}</span>,
                    ],
                    [t('stlId'), <CopyReference value={s.id} what={t('stlId')} />],
                  ]}
                />
              </PaySection>

              <PaySection title={t('pdoTimelineTitle')} description={t('pdoTimelineBody')}>
                {lifecycle.status === 'loading' || approvals.status === 'loading' ? (
                  <PortalLoading rows={3} />
                ) : lifecycle.status === 'ready' ? (
                  <LifecycleTrail lifecycle={lifecycle.data} approvals={trail} me={me} names={names} />
                ) : approvals.status === 'failed' && !isComingSoon(approvals.failure) ? (
                  <PortalFailure result={approvals.failure} retry={reload} />
                ) : (
                  <Trail events={fallbackEvents(t, s, trail, me, names)} />
                )}
              </PaySection>

              <PaySection title={t('pdoAttemptsTitle')} description={t('pdoAttemptsBody')}>
                {approvals.status === 'ready' && trail.length === 0 && <p className="muted">{t('noApprovalYet')}</p>}
                {approvals.status === 'ready' && trail.length > 0 && (
                  <ul className="pp-approvals" aria-label={t('pdoAttemptsTitle')}>
                    {trail.map((a) => (
                      <li key={a.approvalId} className="pp-approval">
                        <div className="pp-approval-head">
                          <strong className="pp-approval-amount">
                            <MoneyText value={a.amount} asset={a.assetCode} test={test} />
                          </strong>
                          <StatusChip entity="approval" value={a.status} />
                          <small className="muted">
                            {t('requestedBy')} {whoIs(a.makerUserId, me, names, t('you'))} · <DateTime value={a.createdAt} />
                          </small>
                          {a.status === 'pending' && (
                            <span className="pp-agechip">
                              {t('expiresIn')} <SpanText ms={Date.parse(a.expiresAt) - now} />
                            </span>
                          )}
                        </div>
                        <small className="pp-mono" title={a.payloadHash}>
                          {a.payloadHash.slice(0, 19)}…
                        </small>
                      </li>
                    ))}
                  </ul>
                )}
                {latest?.status === 'pending' && (
                  <>
                    <h3 className="pp-sub">{t('decideTitle')}</h3>
                    <ApprovalDecision portal={portal} approval={latest} me={me} role={role} now={now} names={names} onDone={reload} />
                    <h3 className="pp-sub">{t('cancelTitle')}</h3>
                    <CancelRequest portal={portal} approval={latest} me={me} onDone={reload} />
                  </>
                )}
              </PaySection>

              <PaySection title={t('capTitle')} description={t('capBody')}>
                <PayoutCap usage={usage} assetId={s.assetId} test={test} retry={reload} />
              </PaySection>

              <RelatedLinks
                links={[
                  { href: settlementHref(s.id), label: t('relSettlement') },
                  { href: '/pay/approvals', label: t('relApprovals') },
                  { href: '/pay/payouts/destinations', label: t('relDestinations') },
                ]}
              />
              <AuditPanel
                who={latest?.checkerUserId ? whoIs(latest.checkerUserId, me, names, t('you')) : latest ? whoIs(latest.makerUserId, me, names, t('you')) : null}
                at={latest?.decidedAt ?? latest?.createdAt ?? null}
              />
            </>
          );
        }}
      </Gate>
    </div>
  );
}

function PayoutCap({ usage, assetId, test, retry }: { usage: Resource<Usage>; assetId: string; test: boolean; retry: () => void }) {
  const { t } = mc.useCopy();
  if (usage.status === 'loading') return <PortalLoading rows={2} />;
  if (usage.status === 'failed') return <PortalFailure result={usage.failure} retry={retry} />;
  const row = limitRows(usage.data, null).find((r) => r.kind === 'daily_payout' && r.assetCode === assetId && r.configured);
  if (!row) {
    return (
      <p>
        <NotConfigured /> {t('capNotConfigured')}
      </p>
    );
  }
  return (
    <>
      {row.pct !== null && <UsageBar pct={row.pct} label={t('capDailyPayout')} />}
      <Facts
        items={[
          [t('capDailyPayout'), row.limit ? <MoneyText value={row.limit} asset={assetId} test={test} /> : '—'],
          [t('capUsed'), row.used ? <MoneyText value={row.used} asset={assetId} test={test} /> : '—'],
          [t('capRemaining'), row.remaining ? <MoneyText value={row.remaining} asset={assetId} test={test} /> : '—'],
          [t('capResets'), row.resetsAt ? <DateTime value={row.resetsAt} /> : '—'],
        ]}
      />
    </>
  );
}
export { payoutHeadroom, EmptyState };
