import { useResource } from '../../../../shared/resource';
import { formatAmount, parseAmount } from '../../../../shared/money';
import { Button } from '@intafaced/ui';
import { PaySection } from '../../components';
import { isUuid } from '../model';
import { Gate, HaltBanner, PortalFailure, PortalLoading } from '../components';
import { portalRefusal } from '../refusal';
import type { PortalApi } from '../api';
import { buildCsv, downloadText } from '../csv';
import { useReadAt } from '../hooks';
import { AuditPanel } from '../ui/AuditPanel';
import { CopyReference } from '../ui/CopyReference';
import { DateTime } from '../ui/DateTime';
import { DetailHeader } from '../ui/DetailHeader';
import { FilterRow, useListFilters } from '../ui/FilterRow';
import { Freshness } from '../ui/Freshness';
import { KpiStrip } from '../ui/Kpi';
import { MoneyList, MoneyText } from '../ui/MoneyText';
import { RelatedLinks } from '../ui/RelatedLinks';
import { StatusChip } from '../ui/StatusChip';
import { Timeline } from '../ui/Timeline';
import { useServerList } from '../ui/useServerList';
import { uiCopy } from '../ui/copy';
import { ExportButton, ListBody, shortDay, TestBanner, useListQuery, useTestMode } from './common';
import { mc } from './copy';
import { bpsPercent, latestApproval, payoutRowState, payoutState, statementTies } from './model';
import { pictureCount, usePayoutPicture } from './payout-picture';
import { railWords } from './destination';
import { LifecycleTrail } from './Trail';
import type { Settlement, SettlementStatus } from '../schemas';
import { settlementStatuses } from '../schemas';
import type { SettlementLine } from './schemas';

type FullSnapshot = Extract<NonNullable<Settlement['pricingSnapshot']>, { ruleId: string }>;
export const settlementHref = (id: string) => `/pay/settlements/${encodeURIComponent(id)}`;

type Words = ReturnType<typeof mc.useCopy>['t'];
export const settlementName = (t: Words, locale: string, s: Pick<Settlement, 'createdAt'>) =>
  s.createdAt ? t('settlementName', { when: shortDay(s.createdAt, locale) }) : t('settlementNameBare');

/** `/pay/settlements`: the statements that gather paid-in money into your balance, with fees taken. */
export function Settlements({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const test = useTestMode();
  const filters = useListFilters();
  const query = useListQuery(filters);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `money:halts:${merchantId}`);
  const snapshot = useResource((s) => portal.snapshot(merchantId, 'rolling_30d', s), `money:settle-snapshot:${merchantId}`);
  // The counts and the state on each row come from the one payout derivation (Payouts and Balances use it too).
  const picture = usePayoutPicture(portal, merchantId);
  const list = useServerList(
    (f, cursor, signal) =>
      portal.settlementPage(merchantId, { status: f.status, assetId: f.assetId, from: f.from, to: f.to, search: f.search }, cursor, signal),
    { status: query.status ?? '', assetId: query.assetId ?? '', from: query.from ?? '', to: query.to ?? '', search: query.search ?? '' },
    (s: Settlement) => s.id,
  );
  const readAt = useReadAt(list.state.status === 'ready', list.state);
  const items = list.state.status === 'ready' ? list.state.items : [];
  const assets = [...new Set(items.map((s) => s.assetId))].sort();
  const pic = picture.resource.status === 'ready' ? picture.resource.data : null;
  const approvals = pic?.approvals ?? null;
  const count = (state: 'ready' | 'not_ready' | 'failed') => {
    if (!pic) return '—';
    const c = pictureCount(pic, state);
    return c.newest ? t('mnCountNewest', { n: c.n }) : String(c.n);
  };
  /** A finalised settlement is shown by where its payout stands; every other settlement by its own status. */
  const statusOf = (s: Settlement) =>
    s.status === 'posted' && pic ? (
      <StatusChip entity="payout" value={payoutRowState(s, approvals)} />
    ) : (
      <StatusChip entity="settlement" value={s.status} />
    );
  const snap = snapshot.resource.status === 'ready' ? snapshot.resource.data : null;
  return (
    <div className="stack">
      <HaltBanner resource={halts.resource} scopes={['settlement']} />
      <TestBanner />
      <Freshness asOf={snap?.freshness.asOf ?? readAt} lagSeconds={snap?.freshness.lagSeconds ?? 0} />
      <KpiStrip
        label={t('settleTiles')}
        tiles={[
          {
            label: t('settleGross'),
            period: t('mnPeriod30'),
            href: '/pay/settlements?date=30d',
            value: snap ? (
              <MoneyList
                items={snap.settlements.map((s) => ({ assetCode: s.assetCode, amount: s.gross }))}
                emptyLabel={t('noPaymentsInPeriod')}
              />
            ) : (
              '—'
            ),
          },
          {
            label: t('settleFees'),
            period: t('mnPeriod30'),
            href: '/pay/settlements?date=30d',
            value: snap ? (
              <MoneyList
                items={snap.settlements.map((s) => ({ assetCode: s.assetCode, amount: s.fees }))}
                emptyLabel={t('noPaymentsInPeriod')}
                sign="minus"
              />
            ) : (
              '—'
            ),
          },
          {
            label: t('settleNet'),
            period: t('mnPeriod30'),
            href: '/pay/settlements?date=30d',
            value: snap ? (
              <MoneyList
                items={snap.settlements.map((s) => ({ assetCode: s.assetCode, amount: s.net }))}
                emptyLabel={t('noPaymentsInPeriod')}
              />
            ) : (
              '—'
            ),
          },
          { label: t('settleReady'), period: t('mnPeriodNow'), href: '/pay/settlements?status=posted', value: count('ready') },
          { label: t('settlePending'), period: t('mnPeriodNow'), href: '/pay/settlements?status=pending', value: count('not_ready') },
          {
            label: t('settleFailed'),
            period: t('mnPeriodNow'),
            href: '/pay/settlements?status=failed',
            value: count('failed'),
            tone: pic && pic.tally.failed > 0 ? 'attention' : undefined,
          },
        ]}
      />
      <FilterRow
        filters={filters}
        label={t('settleFilters')}
        statuses={settlementStatuses.map(
          (s) => [s, s === 'posted' ? t('payFilterPosted') : t(`chipSettlement_${s}` as 'chipSettlement_posted')] as const,
        )}
        assets={assets}
        shown={items.length}
        hasMore={list.state.status === 'ready' && list.state.hasMore}
      />
      <ExportButton
        portal={portal}
        kind="settlements"
        query={query}
        fallback={
          <Button
            variant="secondary"
            disabled={items.length === 0}
            onClick={() =>
              downloadText(
                'settlements-this-page.csv',
                buildCsv(
                  ['settlement_id', 'created', 'asset', 'gross', 'fees', 'net', 'status', 'payout_method', 'payout_reference'],
                  items.map((s) => [
                    s.id,
                    s.createdAt ?? '',
                    s.assetId,
                    s.gross,
                    s.fees,
                    s.net,
                    s.status,
                    s.payoutMethod ?? '',
                    s.payoutRef ?? '',
                  ]),
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
          title: t('settleEmptyTitle'),
          body: t('settleEmptyBody'),
          action: (
            <a className="text-link" href="/pay/payments">
              {t('settleEmptyAction')}
            </a>
          ),
        }}
        label={t('settleTable')}
        rowKey={(s) => s.id}
        href={(s) => settlementHref(s.id)}
        columns={[
          { header: t('colSettlement'), cell: (s) => settlementName(t, locale, s) },
          { header: t('colNet'), cell: (s) => <MoneyText value={s.net} asset={s.assetId} test={test} /> },
          { header: t('colGross'), cell: (s) => <MoneyText value={s.gross} asset={s.assetId} test={test} /> },
          { header: t('colFees'), cell: (s) => <MoneyText value={s.fees} asset={s.assetId} test={test} sign="minus" /> },
          { header: t('colStatus'), cell: statusOf },
        ]}
        card={(s) => ({
          title: settlementName(t, locale, s),
          time: s.createdAt ? <DateTime value={s.createdAt} /> : undefined,
          amount: <MoneyText value={s.net} asset={s.assetId} test={test} />,
          status: statusOf(s),
        })}
      />
    </div>
  );
}

// ---- detail -------------------------------------------------------------------------------------------

const layerWords = { global: 'feeLayerGlobal', tier: 'feeLayerTier', merchant: 'feeLayerMerchant' } as const;

/** `/pay/settlements/:id`: what came in, the fees as they were recorded, and where the money went. */
export function SettlementDetailPage({
  portal,
  merchantId,
  settlementId,
}: {
  portal: PortalApi;
  merchantId: string;
  settlementId: string;
}) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const test = useTestMode();
  const valid = isUuid(settlementId);
  const settlement = useResource(
    (s) => (valid ? portal.settlement(settlementId, s) : Promise.resolve(portalRefusal('rSettlementNotFound'))),
    `money:settlement:${settlementId}`,
  );
  const lifecycle = useResource(
    (s) => (valid ? portal.settlementLifecycle(settlementId, s) : Promise.resolve(portalRefusal('rSettlementNotFound'))),
    `money:lifecycle:${settlementId}`,
  );
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `money:halts:${merchantId}`);
  // A finalised settlement is "ready" only if nobody has asked for, or been given, an approval on it.
  const approvals = useResource(async (s) => {
    const read = await portal.approvalPage(merchantId, {}, undefined, s);
    return read.ok
      ? { ok: true as const, data: ('items' in read.data ? read.data.items : read.data).filter((a) => a.settlementId === settlementId) }
      : read;
  }, `money:settlement-approvals:${settlementId}`);
  const readAt = useReadAt(settlement.resource.status === 'ready', settlement.resource);
  const lines = useServerList(
    (_f, cursor, signal) =>
      valid ? portal.settlementLines(settlementId, cursor, signal) : Promise.resolve(portalRefusal('rSettlementNotFound')),
    { id: settlementId },
    (l: SettlementLine) => l.paymentId,
  );
  const retry = () => {
    settlement.reload();
    lifecycle.reload();
    halts.reload();
    approvals.reload();
    lines.reload();
  };
  return (
    <div className="stack">
      <HaltBanner resource={halts.resource} scopes={['settlement', 'payout']} />
      <Gate resource={settlement.resource} retry={retry} rows={5}>
        {(s) => {
          const ties = statementTies(s);
          const snap = s.pricingSnapshot ?? null;
          const full = snap && 'ruleId' in snap ? (snap as FullSnapshot) : null;
          // The flat fee is charged once per payment, so it is shown as the sum it made once every payment is in view.
          const flatCount = lines.state.status === 'ready' && !lines.state.hasMore ? lines.state.items.length : null;
          const events = [
            ...(s.createdAt ? [{ at: s.createdAt, title: t('stlEvCreated') }] : []),
            ...(s.sentAt ? [{ at: s.sentAt, title: t('stlEvSent') }] : []),
            ...(s.settledAt ? [{ at: s.settledAt, title: t('stlEvPaidOut') }] : []),
            ...(s.failedAt ? [{ at: s.failedAt, title: t('stlEvFailed'), detail: s.failure?.message }] : []),
          ];
          const lc = lifecycle.resource;
          const chip =
            s.status === 'posted' && approvals.resource.status === 'ready' ? (
              <StatusChip entity="payout" value={payoutState(s, latestApproval(approvals.resource.data, s.id))} />
            ) : (
              <StatusChip entity="settlement" value={s.status as SettlementStatus} />
            );
          return (
            <>
              <DetailHeader
                back={{ href: '/pay/settlements', label: t('mnBackSettlements') }}
                title={
                  <>
                    <MoneyText value={s.net} asset={s.assetId} /> {t('mnNet')}
                  </>
                }
                status={chip}
                subtitle={settlementName(t, locale, s)}
                action={
                  <Button
                    variant="primary"
                    onClick={() =>
                      downloadText(
                        `settlement-${s.id.slice(0, 8)}.csv`,
                        buildCsv(
                          ['line', 'amount', 'asset'],
                          [
                            [t('lineGross'), s.gross, s.assetId],
                            [t('lineFees'), s.fees, s.assetId],
                            [t('lineNet'), s.net, s.assetId],
                          ],
                          { generatedAt: new Date().toISOString(), asOf: readAt ?? '' },
                        ),
                      )
                    }
                  >
                    {t('downloadStatement')}
                  </Button>
                }
              />
              <TestBanner />
              <Freshness asOf={readAt} />
              <PaySection title={t('stlFactsTitle')}>
                <dl data-testid="pp-facts" className="pp-facts">
                  <div>
                    <dt>{t('colStatus')}</dt>
                    <dd>{chip}</dd>
                  </div>
                  {s.createdAt && (
                    <div>
                      <dt>{t('stlCreated')}</dt>
                      <dd>
                        <DateTime value={s.createdAt} />
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>{t('stlMethod')}</dt>
                    <dd>{s.payoutMethod ? railWords(t, s.payoutMethod) : <span className="muted">{t('notPaidYet')}</span>}</dd>
                  </div>
                  <div>
                    <dt>{t('stlReference')}</dt>
                    <dd>
                      {s.payoutRef ? (
                        <CopyReference value={s.payoutRef} what={t('stlReference')} />
                      ) : (
                        <span className="muted">{t('notPaidYet')}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('stlId')}</dt>
                    <dd>
                      <CopyReference value={s.id} what={t('stlId')} />
                    </dd>
                  </div>
                </dl>
              </PaySection>

              <PaySection title={t('stlStatementTitle')} description={t('stlStatementBody')}>
                <dl data-testid="pp-facts" className="pp-facts">
                  <div>
                    <dt>{t('lineGross')}</dt>
                    <dd>
                      <MoneyText value={s.gross} asset={s.assetId} test={test} />
                    </dd>
                  </div>
                  <div>
                    <dt>{t('lineFees')}</dt>
                    <dd>
                      <MoneyText value={s.fees} asset={s.assetId} test={test} sign="minus" />
                    </dd>
                  </div>
                  <div>
                    <dt>{t('lineNet')}</dt>
                    <dd>
                      <MoneyText value={s.net} asset={s.assetId} test={test} />
                    </dd>
                  </div>
                </dl>
                <p className={ties ? 'muted pp-note' : 'pp-callout pp-callout--warn'} role={ties ? undefined : 'alert'}>
                  {ties ? t('statementTies') : t('statementDoesNotTie')}
                </p>
                <h3 className="pp-sub">{t('feeHowTitle')}</h3>
                {snap === null ? (
                  <p className="muted">{t('feeNotRecorded')}</p>
                ) : (
                  <dl data-testid="pp-facts" className="pp-facts">
                    <div>
                      <dt>{t('feeCharged')}</dt>
                      <dd>
                        <MoneyText value={snap.fee} asset={s.assetId} test={test} sign="minus" />
                      </dd>
                    </div>
                    {full && (
                      <>
                        <div>
                          <dt>{t('feeRate')}</dt>
                          <dd>{bpsPercent(full.feeBps)}</dd>
                        </div>
                        {full.flatFee && (
                          <div>
                            <dt>{t('feeFlat')}</dt>
                            <dd>
                              {flatCount === null ? (
                                <>
                                  <MoneyText value={full.flatFee} asset={s.assetId} test={test} /> {t('feeFlatPer')}
                                </>
                              ) : (
                                <>
                                  <MoneyText value={full.flatFee} asset={s.assetId} test={test} /> × {flatCount} ={' '}
                                  <MoneyText
                                    value={formatAmount(parseAmount(full.flatFee) * BigInt(flatCount))}
                                    asset={s.assetId}
                                    test={test}
                                    sign="minus"
                                  />
                                </>
                              )}
                            </dd>
                          </div>
                        )}
                        {full.spreadBps !== null && (
                          <div>
                            <dt>{t('feeSpread')}</dt>
                            <dd>{bpsPercent(full.spreadBps)}</dd>
                          </div>
                        )}
                        <div>
                          <dt>{t('feeSetBy')}</dt>
                          <dd>{t(layerWords[full.appliedLayer])}</dd>
                        </div>
                        <div>
                          <dt>{t('feeRecorded')}</dt>
                          <dd>
                            <DateTime value={full.recordedAt} />
                          </dd>
                        </div>
                      </>
                    )}
                  </dl>
                )}
                {snap !== null && <p className="muted pp-note">{t('feeAsRecorded')}</p>}
              </PaySection>

              <PaySection title={t('stlLifecycleTitle')} description={t('stlLifecycleBody')}>
                {lc.status === 'loading' ? (
                  <PortalLoading rows={3} />
                ) : lc.status === 'ready' ? (
                  <LifecycleTrail lifecycle={lc.data} approvals={[]} me={portal.userId} names={new Map()} settlement={s} />
                ) : events.length > 0 ? (
                  <Timeline label={t('stlLifecycleTitle')} items={events} />
                ) : (
                  <PortalFailure result={lc.failure} retry={lifecycle.reload} />
                )}
              </PaySection>

              <PaySection title={t('stlPaymentsTitle')} description={t('stlPaymentsBody')}>
                <ListBody
                  state={lines.state}
                  retry={() => lines.reload()}
                  onMore={lines.loadMore}
                  empty={{ title: t('stlPaymentsEmptyTitle'), body: t('stlPaymentsEmptyBody') }}
                  label={t('stlPaymentsTitle')}
                  rowKey={(l) => l.paymentId}
                  href={(l) => `/pay/payments/${encodeURIComponent(l.paymentId)}`}
                  columns={[
                    { header: t('mnColPayment'), cell: (l) => t('paymentName', { when: shortDay(l.createdAt, locale) }) },
                    {
                      header: t('colAmount'),
                      cell: (l) =>
                        l.amount !== null ? (
                          <MoneyText value={l.amount} asset={l.assetId} test={test} />
                        ) : (
                          <span className="muted">{t('lineNotRecorded')}</span>
                        ),
                    },
                    { header: t('mnColAdded'), cell: (l) => <DateTime value={l.createdAt} /> },
                  ]}
                  card={(l) => ({
                    title: t('paymentName', { when: shortDay(l.createdAt, locale) }),
                    time: <DateTime value={l.createdAt} />,
                    amount:
                      l.amount !== null ? (
                        <MoneyText value={l.amount} asset={l.assetId} test={test} />
                      ) : (
                        <span className="muted">{t('lineNotRecorded')}</span>
                      ),
                  })}
                />
              </PaySection>

              <RelatedLinks
                links={[
                  { href: `/pay/payouts/${encodeURIComponent(s.id)}`, label: t('mnRelPayout') },
                  { href: '/pay/payments', label: t('mnRelPayments') },
                  { href: '/pay/pricing', label: t('mnRelPricing') },
                ]}
              />
              <AuditPanel who={null} at={s.settledAt ?? s.sentAt ?? s.createdAt ?? null} />
            </>
          );
        }}
      </Gate>
    </div>
  );
}
