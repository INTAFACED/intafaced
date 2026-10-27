import { useEffect, useState } from 'react';
import { useResource, type Resource } from '../../../../shared/resource';
import { Button } from '@intafaced/ui';
import { EmptyState } from '../../ui-kit';
import { PaySection } from '../../components';
import { Gate, HaltBanner, PortalFailure, PortalLoading, SpanText } from '../components';
import { isNotLive, portalRefusal } from '../refusal';
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
import { MoneyAction } from '../access/MoneyAction';
import { describeDestination, railWords } from './destination';
import {
  isApprovedToSend,
  latestApproval,
  limitRows,
  overRemaining,
  payoutHeadroom,
  payoutRowState,
  payoutState,
  waitingFrom,
  type RoleLike,
} from './model';
import { pictureCount, usePayoutPicture } from './payout-picture';
import { settlementHref } from './Settlements';
import { fallbackEvents, LifecycleTrail, Trail } from './Trail';
import type { Lifecycle, PayoutItem } from './schemas';
import { Facts, NotConfigured, UsageBar } from '../components';
import type { PayoutState } from '../model';
import { PAYOUT_RETRY_ENABLED } from './payout-retry';

/**
 * The status filter offers the same states as the tiles, in the tiles' words. The service filters by its own four
 * statuses; "ready", "waiting" and "approved" are all `posted` there, so the page narrows those by the state it shows.
 */
const FILTER_STATES = [
  ['ready', 'payReady', 'posted'],
  ['awaiting_approval', 'payWaiting', 'posted'],
  ['approved', 'payApproved', 'posted'],
  ['paid_out', 'payPaid', 'paid_out'],
  ['failed', 'payFailed', 'failed'],
  ['not_ready', 'payNotReady', 'pending'],
] as const;

/**
 * A payout that was sent without an approval on file is still named for where it went, as its page does: the list
 * does not carry the destination, so each such row's lifecycle is read once (at most 25, the page size) and kept.
 */
function useSentDestinations(portal: PortalApi, rows: PayoutItem[], approvals: ReadonlyMap<string, unknown> | null) {
  const [found, setFound] = useState<ReadonlyMap<string, { destinationMasked: string }>>(new Map());
  const ids = approvals
    ? rows
        .filter((r) => r.status === 'paid_out' && !approvals.get(r.id) && !found.has(r.id))
        .map((r) => r.id)
        .slice(0, 25)
    : [];
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    void Promise.all(
      key.split(',').map(async (id) => {
        const res = await portal.settlementLifecycle(id, controller.signal);
        return res.ok && res.data.destination ? ([id, { destinationMasked: res.data.destination.destinationMasked }] as const) : null;
      }),
    ).then((pairs) => {
      if (controller.signal.aborted) return;
      setFound((prev) => new Map([...prev, ...pairs.filter((x): x is NonNullable<typeof x> => x !== null)]));
    });
    return () => controller.abort();
  }, [key, portal]);
  return found;
}

/** `/pay/payouts`: money leaving your balance, and where each payout is in approval. */
export function Payouts({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const test = useTestMode();
  const filters = useListFilters();
  const stateFilter = FILTER_STATES.find(([state]) => state === filters.status) ?? null;
  const query = useListQuery(filters, stateFilter ? { status: stateFilter[2] } : {});
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `money:halts:${merchantId}`);
  // One read behind the counts and every row's state, shared with Settlements and Balances.
  const picture = usePayoutPicture(portal, merchantId);
  // Where the payouts list is not released, the page falls back to settlements that are no longer pending, headed "Newest".
  const list = useServerList(
    async (f, cursor, signal) => {
      const direct = await portal.payoutPage(
        { status: f.status, assetId: f.assetId, from: f.from, to: f.to, search: f.search },
        cursor,
        signal,
      );
      if (direct.ok || !isNotLive(direct)) return direct;
      const derived = await portal.settlementPage(
        merchantId,
        { status: f.status, assetId: f.assetId, from: f.from, to: f.to, search: f.search },
        cursor,
        signal,
      );
      if (!derived.ok) return derived;
      return {
        ok: true as const,
        data: {
          items: derived.data.items.map((s): PayoutItem => ({
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
          })),
          nextCursor: derived.data.nextCursor,
        },
      };
    },
    { status: query.status ?? '', assetId: query.assetId ?? '', from: query.from ?? '', to: query.to ?? '', search: query.search ?? '' },
    (p: PayoutItem) => p.id,
  );
  const readAt = useReadAt(list.state.status === 'ready', list.state);
  const pic = picture.resource.status === 'ready' ? picture.resource.data : null;
  const approvals = pic?.approvals ?? null;
  const rows = (list.state.status === 'ready' ? list.state.items : []).filter(
    (r) => !stateFilter || payoutRowState(r, approvals) === stateFilter[0],
  );
  const shownState = list.state.status === 'ready' ? { ...list.state, items: rows } : list.state;
  const sentTo = useSentDestinations(portal, rows, approvals);
  const destinationOf = (id: string) => approvals?.get(id) ?? sentTo.get(id);
  const assets = [...new Set(rows.map((r) => r.assetId))].sort();
  const count = (state: 'ready' | 'awaiting_approval' | 'approved' | 'paid_out' | 'failed' | 'not_ready') => {
    if (!pic) return '—';
    const c = pictureCount(pic, state);
    return c.newest ? t('mnCountNewest', { n: c.n }) : String(c.n);
  };
  return (
    <div className="stack">
      <HaltBanner resource={halts.resource} scopes={['payout']} />
      <TestBanner />
      <Freshness asOf={readAt} />
      <KpiStrip
        label={t('payTiles')}
        tiles={[
          { label: t('payReady'), period: t('mnPeriodNow'), href: '/pay/payouts?status=ready', value: count('ready') },
          {
            label: t('payWaiting'),
            period: t('mnPeriodNow'),
            href: '/pay/approvals?status=pending',
            value: count('awaiting_approval'),
            tone: pic && pic.tally.awaiting_approval > 0 ? 'attention' : undefined,
          },
          {
            label: t('payApproved'),
            period: t('mnPeriodNow'),
            href: '/pay/approvals?status=approved',
            value: count('approved'),
            note: pic && pic.tally.approved > 0 ? t('payApprovedNote') : undefined,
            tone: pic && pic.tally.approved > 0 ? 'attention' : undefined,
          },
          { label: t('payPaid'), period: t('mnPeriodNewest'), href: '/pay/payouts?status=paid_out', value: count('paid_out') },
          {
            label: t('payFailed'),
            period: t('mnPeriodNow'),
            href: '/pay/payouts?status=failed',
            value: count('failed'),
            tone: pic && pic.tally.failed > 0 ? 'attention' : undefined,
          },
          { label: t('payNotReady'), period: t('mnPeriodNow'), href: '/pay/payouts?status=not_ready', value: count('not_ready') },
        ]}
      />
      <FilterRow
        filters={filters}
        label={t('payFilters')}
        statuses={FILTER_STATES.map(([state, word]) => [state, t(word)] as const)}
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
            {t('mnExportPage')}
          </Button>
        }
      />
      <ListBody
        state={shownState}
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
          { header: t('colPayout'), cell: (r) => payoutName(t, locale, r, destinationOf(r.id)) },
          { header: t('colAmount'), cell: (r) => <MoneyText value={r.net} asset={r.assetId} test={test} /> },
          {
            header: t('colStatus'),
            cell: (r) => {
              const a = approvals?.get(r.id);
              const w = a ? waitingFrom(a) : null;
              return (
                <>
                  <StatusChip entity="payout" value={payoutRowState(r, approvals)} />
                  {w && r.status === 'posted' && (
                    <small className="pay-cell-note">{w === 'intafaced' ? t('waitingIntafaced') : t('waitingTeam')}</small>
                  )}
                </>
              );
            },
          },
          { header: t('payColSettled'), cell: (r) => <DateTime value={r.createdAt} /> },
          {
            header: t('colTransaction'),
            cell: (r) =>
              r.payoutReference ? (
                <span data-testid="pp-mono" className="pp-mono">
                  {r.payoutReference}
                </span>
              ) : (
                <span className="muted">{t('notPaidYet')}</span>
              ),
          },
        ]}
        card={(r) => ({
          title: payoutName(t, locale, r, destinationOf(r.id)),
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
    return page.ok
      ? { ok: true as const, data: ('items' in page.data ? page.data.items : page.data).filter((a) => a.settlementId === payoutId) }
      : page;
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
          const trail =
            approvals.status === 'ready' ? [...approvals.data].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)) : [];
          const latest = approvals.status === 'ready' ? latestApproval(approvals.data, s.id) : null;
          const state: PayoutState = payoutState(s, latest, approvals.status === 'ready');
          const lc = lifecycle.status === 'ready' ? lifecycle.data : null;
          const dest = lc?.destination
            ? describeDestination(t, lc.destination.kind, lc.destination.destinationMasked, lc.destination.railId)
            : latest
              ? destination(latest)
              : null;
          // The account owner is the only person who can send a payout; a role we could not read is left to the service.
          const maySend = role === null || role === 'owner';
          const waitingToSend = state === 'approved' && isApprovedToSend(latest);
          // Approved, but more than is left of today's payout limit: say so instead of leading into a form that cannot send it.
          const left = usage.status === 'ready' ? (payoutHeadroom(usage.data, s.assetId)?.remaining ?? null) : null;
          const overLimit = waitingToSend && maySend && left !== null && overRemaining(s.net, left);
          const action =
            state === 'ready' || (state === 'failed' && PAYOUT_RETRY_ENABLED) || (waitingToSend && maySend && !overLimit)
              ? // Asking for approval and sending both carry the payout scope; deciding someone else's request (pay:write) is elsewhere.
                (() => {
                  const link = (
                    <LinkButton variant="primary" href={`/pay/payouts/new?settlement=${encodeURIComponent(s.id)}`}>
                      {t(state === 'failed' ? 'pdoRetry' : waitingToSend ? 'pdoSend' : 'pdoRequest')}
                    </LinkButton>
                  );
                  return (
                    <MoneyAction kind="payout" act={waitingToSend ? 'send' : 'request'}>
                      {link}
                    </MoneyAction>
                  );
                })()
              : undefined;
          const reversed = lc?.events.some((e) => e.kind === 'payout.reversed') ?? false;
          return (
            <>
              <DetailHeader
                back={{ href: '/pay/payouts', label: t('mnBackPayouts') }}
                title={<MoneyText value={s.net} asset={s.assetId} />}
                status={<StatusChip entity="payout" value={state} />}
                subtitle={payoutName(
                  t,
                  locale,
                  { createdAt: s.createdAt ?? s.settledAt ?? s.sentAt ?? new Date(0).toISOString() },
                  // A payout sent without an approval is still named for where it went (the lifecycle's destination).
                  latest ?? lc?.destination ?? null,
                )}
                action={action}
              />
              <TestBanner />
              <Freshness asOf={readAt} />
              {latest?.status === 'voided' && state !== 'failed' && (
                <p className="pp-callout pp-callout--warn" role="alert">
                  {t('voidBanner')}
                </p>
              )}
              {waitingToSend && latest && (
                <p className="pp-callout" role="note">
                  {t('apvApprovedBy', { who: whoIs(latest.checkerUserId ?? latest.makerUserId, me, names, t('mnMe')) })}{' '}
                  {maySend ? t('apvSendBefore') : t('apvAskOwner')} <DateTime value={latest.expiresAt} />.
                </p>
              )}
              {overLimit && left !== null && (
                <p className="pp-callout pp-callout--warn" role="alert">
                  {t('pdoOverLimit')} (<MoneyText value={left} asset={s.assetId} test={test} /> {t('pnLimitLeft')}.) {t('pdoOverLimitHow')}{' '}
                  <a className="text-link" href="/pay/limits">
                    {t('pdoOverLimitLink')}
                  </a>
                </p>
              )}
              {state === 'failed' && (
                <p className="pp-callout pp-callout--warn" role="alert">
                  {t('payoutFailedBody')} {lc?.failure?.message ?? s.failure?.message ?? ''}{' '}
                  {reversed ? t('payoutFailedBack', { asset: s.assetId }) : t('payoutFailedBalanceUnknown', { asset: s.assetId })}
                  {!PAYOUT_RETRY_ENABLED && (
                    <>
                      {' '}
                      {t('payoutFailedContactSupport')}{' '}
                      <a className="text-link" href="/support">
                        {t('contactSupport')}
                      </a>
                    </>
                  )}
                </p>
              )}
              {state === 'not_ready' && <p className="pp-callout">{t('payoutNotReadyBody')}</p>}

              <PaySection title={t('pdoFactsTitle')}>
                <Facts
                  items={[
                    [t('colStatus'), <StatusChip entity="payout" value={state} />],
                    [t('colAmount'), <MoneyText value={s.net} asset={s.assetId} test={test} />],
                    [t('apvTo'), dest ?? <span className="muted">{t('apvToUnknown')}</span>],
                    ...(lc?.fee != null
                      ? ([[t('pdoFee'), <MoneyText value={lc.fee} asset={s.assetId} test={test} sign="minus" />]] as const)
                      : []),
                    [t('pdoScreening'), <NotConfigured>{t('pdoScreeningNone')}</NotConfigured>],
                    [t('payoutMethod'), s.payoutMethod ? railWords(t, s.payoutMethod) : <span className="muted">{t('notPaidYet')}</span>],
                    [
                      t('colTransaction'),
                      s.payoutRef ? (
                        <CopyReference value={s.payoutRef} what={t('colTransaction')} />
                      ) : (
                        <span className="muted">{t('notPaidYet')}</span>
                      ),
                    ],
                    [t('stlId'), <CopyReference value={s.id} what={t('stlId')} />],
                  ]}
                />
              </PaySection>

              <PaySection title={t('pdoTimelineTitle')} description={t('pdoTimelineBody')}>
                {lifecycle.status === 'loading' || approvals.status === 'loading' ? (
                  <PortalLoading rows={3} />
                ) : lifecycle.status === 'ready' ? (
                  <LifecycleTrail lifecycle={lifecycle.data} approvals={trail} me={me} names={names} settlement={s} />
                ) : approvals.status === 'failed' && !isNotLive(approvals.failure) ? (
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
                            {t('requestedBy')} {whoIs(a.makerUserId, me, names, t('mnMe'))} · <DateTime value={a.createdAt} />
                          </small>
                          {a.status === 'pending' && (
                            <span className="pp-agechip">
                              {t('expiresIn')} <SpanText ms={Date.parse(a.expiresAt) - now} />
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {latest?.status === 'pending' && (
                  <>
                    <h3 className="pp-sub">{t('decideTitle')}</h3>
                    <ApprovalDecision
                      portal={portal}
                      approval={latest}
                      me={me}
                      role={role}
                      now={now}
                      names={names}
                      remaining={usage.status === 'ready' ? (payoutHeadroom(usage.data, s.assetId)?.remaining ?? null) : null}
                      onDone={reload}
                    />
                    {me !== null && latest.makerUserId === me && (
                      <>
                        <h3 className="pp-sub">{t('cancelTitle')}</h3>
                        <CancelRequest portal={portal} approval={latest} me={me} onDone={reload} />
                      </>
                    )}
                  </>
                )}
              </PaySection>

              <PaySection title={t('capTitle')} description={t('capBody')}>
                <PayoutCap usage={usage} assetId={s.assetId} test={test} retry={reload} />
              </PaySection>

              <RelatedLinks
                links={[
                  { href: settlementHref(s.id), label: t('mnRelSettlement') },
                  { href: '/pay/approvals', label: t('mnRelApprovals') },
                  { href: '/pay/payouts/destinations', label: t('mnRelDestinations') },
                ]}
              />
              <AuditPanel
                who={
                  latest?.checkerUserId
                    ? whoIs(latest.checkerUserId, me, names, t('mnMe'))
                    : latest
                      ? whoIs(latest.makerUserId, me, names, t('mnMe'))
                      : null
                }
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
