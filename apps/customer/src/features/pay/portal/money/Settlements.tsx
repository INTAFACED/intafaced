import { useResource } from '../../../../shared/resource';
import { Button } from '@intafaced/ui';
import { PaySection } from '../../components';
import { isUuid } from '../model';
import { Gate, HaltBanner, Money, MoneyLines, PortalFailure, PortalLoading } from '../components';
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
import { MoneyText } from '../ui/MoneyText';
import { RelatedLinks } from '../ui/RelatedLinks';
import { StatusChip } from '../ui/StatusChip';
import { Timeline } from '../ui/Timeline';
import { useServerList } from '../ui/useServerList';
import { uiCopy } from '../ui/copy';
import { ExportButton, ListBody, shortDay, TestBanner, useListQuery, useTestMode } from './common';
import { mc } from './copy';
import { bpsPercent, statementTies } from './model';
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
  const counts = useResource(async (s) => {
    const reads = await Promise.all(
      (['posted', 'pending', 'failed'] as const).map((status) => portal.settlementPage(merchantId, { status }, undefined, s)),
    );
    const bad = reads.find((r) => !r.ok);
    if (bad && !bad.ok) return bad;
    const pick = (i: number) => {
      const r = reads[i]!;
      return r.ok ? { n: r.data.items.length, more: r.data.nextCursor !== null } : { n: 0, more: false };
    };
    return { ok: true as const, data: { posted: pick(0), pending: pick(1), failed: pick(2) } };
  }, `money:settle-counts:${merchantId}`);
  const list = useServerList(
    (f, cursor, signal) =>
      portal.settlementPage(merchantId, { status: f.status, assetId: f.assetId, from: f.from, to: f.to, search: f.search }, cursor, signal),
    { status: query.status ?? '', assetId: query.assetId ?? '', from: query.from ?? '', to: query.to ?? '', search: query.search ?? '' },
    (s: Settlement) => s.id,
  );
  const readAt = useReadAt(list.state.status === 'ready', list.state);
  const items = list.state.status === 'ready' ? list.state.items : [];
  const assets = [...new Set(items.map((s) => s.assetId))].sort();
  const count = (c: { n: number; more: boolean } | undefined) => (c ? (c.more ? t('mnCountNewest', { n: c.n }) : String(c.n)) : '—');
  const c = counts.resource.status === 'ready' ? counts.resource.data : undefined;
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
            value: snap ? <MoneyLines items={snap.settlements.map((s) => ({ assetCode: s.assetCode, amount: s.gross }))} /> : '—',
          },
          {
            label: t('settleFees'),
            period: t('mnPeriod30'),
            href: '/pay/settlements?date=30d',
            value: snap ? <MoneyLines items={snap.settlements.map((s) => ({ assetCode: s.assetCode, amount: s.fees }))} /> : '—',
          },
          {
            label: t('settleNet'),
            period: t('mnPeriod30'),
            href: '/pay/settlements?date=30d',
            value: snap ? <MoneyLines items={snap.settlements.map((s) => ({ assetCode: s.assetCode, amount: s.net }))} /> : '—',
          },
          { label: t('settleReady'), period: t('mnPeriodNow'), href: '/pay/settlements?status=posted', value: count(c?.posted) },
          { label: t('settlePending'), period: t('mnPeriodNow'), href: '/pay/settlements?status=pending', value: count(c?.pending) },
          {
            label: t('settleFailed'),
            period: t('mnPeriodNow'),
            href: '/pay/settlements?status=failed',
            value: count(c?.failed),
            tone: c && c.failed.n > 0 ? 'attention' : undefined,
          },
        ]}
      />
      <FilterRow
        filters={filters}
        label={t('settleFilters')}
        statuses={settlementStatuses.map((s) => [s, t(`chipSettlement_${s}` as 'chipSettlement_posted')] as const)}
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
          { header: t('colFees'), cell: (s) => <MoneyText value={s.fees} asset={s.assetId} test={test} /> },
          { header: t('colStatus'), cell: (s) => <StatusChip entity="settlement" value={s.status} /> },
        ]}
        card={(s) => ({
          title: settlementName(t, locale, s),
          time: s.createdAt ? <DateTime value={s.createdAt} /> : undefined,
          amount: <MoneyText value={s.net} asset={s.assetId} test={test} />,
          status: <StatusChip entity="settlement" value={s.status} />,
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
          const events = [
            ...(s.createdAt ? [{ at: s.createdAt, title: t('stlEvCreated') }] : []),
            ...(s.sentAt ? [{ at: s.sentAt, title: t('stlEvSent') }] : []),
            ...(s.settledAt ? [{ at: s.settledAt, title: t('stlEvPaidOut') }] : []),
            ...(s.failedAt ? [{ at: s.failedAt, title: t('stlEvFailed'), detail: s.failure?.message }] : []),
          ];
          const lc = lifecycle.resource;
          return (
            <>
              <DetailHeader
                back={{ href: '/pay/settlements', label: t('mnBackSettlements') }}
                title={
                  <>
                    <Money value={s.net} asset={s.assetId} /> {t('mnNet')}
                  </>
                }
                status={<StatusChip entity="settlement" value={s.status} />}
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
                <dl className="pp-facts">
                  <div>
                    <dt>{t('colStatus')}</dt>
                    <dd>
                      <StatusChip entity="settlement" value={s.status as SettlementStatus} />
                    </dd>
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
                <dl className="pp-facts">
                  <div>
                    <dt>{t('lineGross')}</dt>
                    <dd>
                      <MoneyText value={s.gross} asset={s.assetId} test={test} />
                    </dd>
                  </div>
                  <div>
                    <dt>{t('lineFees')}</dt>
                    <dd>
                      <MoneyText value={s.fees} asset={s.assetId} test={test} />
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
                  <dl className="pp-facts">
                    <div>
                      <dt>{t('feeCharged')}</dt>
                      <dd>
                        <MoneyText value={snap.fee} asset={s.assetId} test={test} />
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
                              <MoneyText value={full.flatFee} asset={s.assetId} test={test} />
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
                  <LifecycleTrail lifecycle={lc.data} approvals={[]} me={portal.userId} names={new Map()} />
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
