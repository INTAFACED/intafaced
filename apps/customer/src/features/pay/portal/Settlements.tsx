import { useState } from 'react';
import { useResource, type Resource } from '../../../shared/resource';
import { Button, DataTable, EmptyState, Field, ChoiceGroup as Tabs } from '@intafaced/ui';
import { PaySection } from '../components';
import {
  AsOf,
  BackLink,
  Chip,
  ComingSoon,
  Facts,
  Gate,
  HaltBanner,
  Kpi,
  KpiGrid,
  Money,
  MoneyLines,
  NotConfigured,
  PortalFailure,
  PortalLoading,
  ReadAt,
  SelectField,
  Steps,
} from './components';
import { portalCopy } from './copy';
import { buildCsv, downloadText } from './csv';
import { useReadAt, useUrlParam } from './hooks';
import { assetsIn, bpsPercent, isUuid, matchesSearch, MAX_LIMIT, nextLimit, readLimit, shortId, statementTies } from './model';
import { portalRefusal } from './refusal';
import type { PortalApi } from './api';
import { settlementStatuses, type ControlProfile, type HaltStatus, type MetricPreset, type Settlement, type Snapshot } from './schemas';

export const settlementHref = (id: string) => `/pay/settlements/${encodeURIComponent(id)}`;

/** `/pay/settlements`: the statements that gather paid-in money into your balance, with fees taken. */
export function Settlements({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const [period, setPeriod] = useState<MetricPreset>('rolling_30d');
  const [status, setStatus] = useUrlParam('status', '');
  const [q, setQ] = useUrlParam('q', '');
  const [asset, setAsset] = useUrlParam('asset', '');
  const [limitRaw, setLimitRaw] = useUrlParam('limit', '25');
  const limit = readLimit(limitRaw);
  const snapshot = useResource((s) => portal.snapshot(merchantId, period, s), `portal:settlements-kpi:${merchantId}:${period}`);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `portal:halts:${merchantId}`);
  const list = useResource((s) => portal.settlements(merchantId, status, limit, s), `portal:settlements:${merchantId}:${status}:${limit}`);
  const loadedAt = useReadAt(list.resource.status === 'ready', list.resource);
  return (
    <SettlementsView
      snapshot={snapshot.resource}
      period={period}
      setPeriod={setPeriod}
      halts={halts.resource}
      list={list.resource}
      loadedAt={loadedAt}
      status={status}
      setStatus={setStatus}
      asset={asset}
      setAsset={setAsset}
      q={q}
      setQ={setQ}
      limit={limit}
      setLimit={(n) => setLimitRaw(String(n))}
      retry={() => {
        snapshot.reload();
        list.reload();
        halts.reload();
      }}
    />
  );
}

export function SettlementsView({
  snapshot,
  period,
  setPeriod,
  halts,
  list,
  loadedAt,
  status,
  setStatus,
  asset,
  setAsset,
  q,
  setQ,
  limit,
  setLimit,
  retry,
}: {
  snapshot: Resource<Snapshot>;
  period: MetricPreset;
  setPeriod: (value: MetricPreset) => void;
  halts: Resource<HaltStatus>;
  list: Resource<Settlement[]>;
  loadedAt: string | null;
  status: string;
  setStatus: (value: string) => void;
  asset: string;
  setAsset: (value: string) => void;
  q: string;
  setQ: (value: string) => void;
  limit: number;
  setLimit: (value: number) => void;
  retry: () => void;
}) {
  const { t } = portalCopy.useCopy();
  const labels: Record<MetricPreset, string> = { today: t('periodToday'), rolling_7d: t('period7d'), rolling_30d: t('period30d') };
  const loaded = list.status === 'ready' ? list.data : [];
  const rows = loaded.filter((s) => (!asset || s.assetId === asset) && matchesSearch([s.id, s.window, s.payoutRef], q));
  const narrowed = Boolean(asset || q);
  const clear = () => {
    setStatus('');
    setAsset('');
    setQ('');
  };
  const exportCsv = () =>
    downloadText(
      'settlements.csv',
      buildCsv(
        ['settlement_id', 'window', 'asset', 'gross', 'fees', 'net', 'status', 'payout_method', 'payout_reference'],
        rows.map((r) => [r.id, r.window, r.assetId, r.gross, r.fees, r.net, r.status, r.payoutMethod ?? '', r.payoutRef ?? '']),
        { generatedAt: new Date().toISOString(), asOf: loadedAt ?? '' },
      ),
    );
  return (
    <div className="stack">
      <HaltBanner resource={halts} scopes={['settlement']} />
      <PaySection
        title={t('settlementsKpiTitle')}
        description={t('settlementsKpiBody')}
        action={
          <Tabs
            items={['today', 'rolling_7d', 'rolling_30d']}
            value={period}
            onChange={(v) => setPeriod(v as MetricPreset)}
            label={t('periodLabel')}
            labels={labels}
          />
        }
      >
        <Gate resource={snapshot} retry={retry} rows={2}>
          {(snap) => (
            <>
              <AsOf freshness={snap.freshness} />
              <KpiGrid label={t('kpiGroup', { period: labels[period] })}>
                <Kpi
                  label={t('kpiGross')}
                  period={labels[period]}
                  value={<MoneyLines items={snap.settlements.map((s) => ({ assetCode: s.assetCode, amount: s.gross }))} />}
                />
                <Kpi
                  label={t('kpiFees')}
                  period={labels[period]}
                  value={<MoneyLines items={snap.settlements.map((s) => ({ assetCode: s.assetCode, amount: s.fees }))} />}
                  note={t('kpiFeesNote')}
                />
                <Kpi
                  label={t('kpiNet')}
                  period={labels[period]}
                  value={<MoneyLines items={snap.settlements.map((s) => ({ assetCode: s.assetCode, amount: s.net }))} />}
                />
                <Kpi
                  label={t('kpiWaiting')}
                  value={list.status === 'ready' ? loaded.filter((s) => s.status === 'pending' || s.status === 'posted').length : '—'}
                  note={t('kpiWaitingNote', { count: loaded.length })}
                  href="/pay/payouts"
                />
                <Kpi
                  label={t('kpiFailedSettlements')}
                  value={list.status === 'ready' ? loaded.filter((s) => s.status === 'failed').length : '—'}
                  note={t('kpiWaitingNote', { count: loaded.length })}
                  tone={loaded.some((s) => s.status === 'failed') ? 'attention' : undefined}
                  href="/pay/settlements?status=failed"
                />
              </KpiGrid>
            </>
          )}
        </Gate>
      </PaySection>

      <PaySection title={t('settlementsTitle')} description={t('settlementsBody')}>
        <div className="pp-filter-row" role="search" aria-label={t('settlementsFilters')}>
          <SelectField
            label={t('filterStatus')}
            value={status}
            onChange={setStatus}
            options={[
              ['', t('filterAll')],
              ...settlementStatuses.map((s) => [s, t(`chipSettlement_${s}` as 'chipSettlement_pending')] as const),
            ]}
          />
          <SelectField
            label={t('filterAsset')}
            value={asset}
            onChange={setAsset}
            options={[['', t('filterAll')], ...assetsIn(loaded).map((a) => [a, a] as const)]}
          />
          <Field
            label={t('searchSettlements')}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={200}
            hint={t('searchSettlementsHint')}
          />
          <Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0}>
            {t('downloadCsv')}
          </Button>
        </div>
        <p className="muted pp-note">{t('settlementsNoDates')}</p>
        <ReadAt at={loadedAt} />
        {list.status === 'loading' ? (
          <PortalLoading />
        ) : list.status === 'failed' ? (
          <PortalFailure result={list.failure} retry={retry} />
        ) : loaded.length === 0 ? (
          <EmptyState
            title={status ? t('settlementsNoStatusTitle') : t('settlementsEmptyTitle')}
            action={
              status ? (
                <Button variant="secondary" onClick={clear}>
                  {t('clearFilters')}
                </Button>
              ) : undefined
            }
          >
            {status ? t('settlementsNoStatusBody') : t('settlementsEmptyBody')}
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState
            title={t('settlementsNoMatchTitle')}
            action={
              <Button variant="secondary" onClick={clear}>
                {t('clearFilters')}
              </Button>
            }
          >
            {t('settlementsNoMatchBody', { count: loaded.length })}
          </EmptyState>
        ) : (
          <>
            <DataTable
              label={t('settlementsTitle')}
              headers={[t('colWindow'), t('colAsset'), t('colGross'), t('colFees'), t('colNet'), t('colStatus'), t('colPayoutRef')]}
            >
              {rows.map((s) => (
                <tr key={s.id}>
                  <th scope="row">
                    <a className="text-link" href={settlementHref(s.id)} aria-label={t('openSettlementAria', { window: s.window })}>
                      {s.window}
                    </a>
                    <small className="pay-cell-note pp-mono">{shortId(s.id)}</small>
                  </th>
                  <td>{s.assetId}</td>
                  <td>
                    <Money value={s.gross} asset={s.assetId} />
                  </td>
                  <td>
                    <Money value={s.fees} asset={s.assetId} />
                  </td>
                  <td>
                    <Money value={s.net} asset={s.assetId} />
                  </td>
                  <td>
                    <Chip kind="settlement" value={s.status} />
                    {s.status === 'failed' && <small className="pay-cell-note">{t('failedNextStep')}</small>}
                  </td>
                  <td className="pp-mono">{s.payoutRef ?? <span className="muted">{t('notPaidYet')}</span>}</td>
                </tr>
              ))}
            </DataTable>
            <div className="pp-more">
              <p className="muted" role="status">
                {narrowed
                  ? t('settlementsNarrowed', { shown: rows.length, loaded: loaded.length })
                  : loaded.length >= limit && limit < MAX_LIMIT
                    ? t('rowsSoFar', { count: loaded.length })
                    : t('rowsAll', { count: loaded.length })}
              </p>
              {loaded.length >= limit && limit < MAX_LIMIT && (
                <Button variant="secondary" onClick={() => setLimit(nextLimit(limit))}>
                  {t('loadMore')}
                </Button>
              )}
              {loaded.length >= MAX_LIMIT && (
                <a className="text-link" href="/pay/exports">
                  {t('olderInExports', { max: MAX_LIMIT })}
                </a>
              )}
            </div>
          </>
        )}
      </PaySection>
    </div>
  );
}

// ---- detail (the statement) -------------------------------------------------------------------------------

export function SettlementDetailPage({
  portal,
  merchantId,
  settlementId,
}: {
  portal: PortalApi;
  merchantId: string;
  settlementId: string;
}) {
  const valid = isUuid(settlementId);
  const settlement = useResource(
    (s) => (valid ? portal.settlement(settlementId, s) : Promise.resolve(portalRefusal('rSettlementNotFound'))),
    `portal:settlement:${settlementId}`,
  );
  const control = useResource((s) => portal.control(merchantId, s), `portal:control:${merchantId}`);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `portal:halts:${merchantId}`);
  const readAt = useReadAt(settlement.resource.status === 'ready', settlement.resource);
  return (
    <SettlementDetailView
      settlement={settlement.resource}
      readAt={readAt}
      control={control.resource}
      halts={halts.resource}
      retry={() => {
        settlement.reload();
        control.reload();
        halts.reload();
      }}
    />
  );
}

export function SettlementDetailView({
  settlement,
  control,
  halts,
  readAt = null,
  retry,
}: {
  settlement: Resource<Settlement>;
  control: Resource<ControlProfile>;
  halts: Resource<HaltStatus>;
  /** When the statement was read: the "as of" of a downloaded copy. */
  readAt?: string | null;
  retry: () => void;
}) {
  const { t } = portalCopy.useCopy();
  return (
    <div className="stack">
      <BackLink href="/pay/settlements">{t('backToSettlements')}</BackLink>
      <HaltBanner resource={halts} scopes={['settlement', 'payout']} />
      <Gate resource={settlement} retry={retry} rows={5}>
        {(s) => {
          const ties = statementTies(s);
          const steps = [
            { title: t('stlWindow', { window: s.window }), state: 'done' as const },
            {
              title: t('stlPosted'),
              state: s.status === 'pending' ? ('current' as const) : s.status === 'failed' ? ('bad' as const) : ('done' as const),
              detail: s.status === 'pending' ? t('stlPostedWaiting') : s.status === 'failed' ? t('stlFailedDetail') : undefined,
            },
            {
              title: s.status === 'failed' ? t('stlFailed') : t('stlPaidOut'),
              state:
                s.status === 'paid_out'
                  ? ('done' as const)
                  : s.status === 'failed'
                    ? ('bad' as const)
                    : s.status === 'posted'
                      ? ('current' as const)
                      : ('todo' as const),
              detail: s.status === 'posted' ? t('stlPaidOutWaiting') : undefined,
            },
          ];
          return (
            <>
              <PaySection title={t('keyFacts')} description={t('settlementFactsBody')}>
                <Facts
                  items={[
                    [t('colSettlement'), <span className="pp-mono pp-copy">{s.id}</span>],
                    [t('colWindow'), s.window],
                    [t('colAsset'), s.assetId],
                    [t('colStatus'), <Chip kind="settlement" value={s.status} />],
                    [t('payoutMethod'), s.payoutMethod ?? <span className="muted">{t('notPaidYet')}</span>],
                    [
                      t('colPayoutRef'),
                      s.payoutRef ? (
                        <span className="pp-mono pp-copy">{s.payoutRef}</span>
                      ) : (
                        <span className="muted">{t('notPaidYet')}</span>
                      ),
                    ],
                  ]}
                />
              </PaySection>

              <PaySection
                title={t('statementTitle')}
                description={t('statementBody')}
                action={
                  <Button
                    variant="secondary"
                    onClick={() =>
                      downloadText(
                        `settlement-${s.window.replace(/[^A-Za-z0-9._-]+/g, '_')}.csv`,
                        buildCsv(
                          ['settlement_id', 'window', 'asset', 'gross', 'fees', 'net', 'status', 'payout_method', 'payout_reference'],
                          [[s.id, s.window, s.assetId, s.gross, s.fees, s.net, s.status, s.payoutMethod ?? '', s.payoutRef ?? '']],
                          { generatedAt: new Date().toISOString(), asOf: readAt ?? '' },
                        ),
                      )
                    }
                  >
                    {t('downloadStatement')}
                  </Button>
                }
              >
                <DataTable label={t('statementTitle')} headers={[t('colLine'), t('colAmount')]}>
                  <tr>
                    <th scope="row">{t('lineGross')}</th>
                    <td>
                      <Money value={s.gross} asset={s.assetId} />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">{t('lineFees')}</th>
                    <td>
                      <Money value={s.fees} asset={s.assetId} />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">{t('lineNet')}</th>
                    <td>
                      <Money value={s.net} asset={s.assetId} />
                    </td>
                  </tr>
                </DataTable>
                <p className={ties ? 'muted pp-note' : 'pp-callout pp-callout--warn'} role={ties ? undefined : 'alert'}>
                  {ties ? t('statementTies') : t('statementDoesNotTie')}
                </p>
                <ReserveLine control={control} retry={retry} />
                <ComingSoon title={t('feeLinesSoonTitle')}>
                  {t('feeLinesSoonBody')}{' '}
                  <a className="text-link" href="/pay/pricing">
                    {t('seePricing')}
                  </a>
                </ComingSoon>
              </PaySection>

              <PaySection title={t('stlTimelineTitle')} description={t('stlTimelineBody')}>
                <Steps label={t('stlTimelineTitle')} items={steps} />
              </PaySection>

              <ComingSoon title={t('stlPaymentsSoonTitle')}>{t('stlPaymentsSoonBody')}</ComingSoon>

              <PaySection title={t('stlLinksTitle')}>
                <ul className="pp-links">
                  <li>
                    <a className="text-link" href={`/pay/payouts/${encodeURIComponent(s.id)}`}>
                      {t('linkPayout')}
                    </a>
                  </li>
                  <li>
                    <a className="text-link" href="/pay/payments">
                      {t('linkPayments')}
                    </a>
                  </li>
                </ul>
              </PaySection>
            </>
          );
        }}
      </Gate>
    </div>
  );
}

/** What the account is set up to hold back. How much was held on this statement is not published yet, and the page says so. */
function ReserveLine({ control, retry }: { control: Resource<ControlProfile>; retry: () => void }) {
  const { t } = portalCopy.useCopy();
  if (control.status === 'loading') return <PortalLoading rows={1} />;
  if (control.status === 'failed') return <PortalFailure result={control.failure} retry={retry} />;
  const reserve = control.data.reserve;
  const bps = reserve?.rollingReserveBps ?? null;
  return (
    <div className="pp-reserve">
      <h3 className="pp-sub">{t('reserveTitle')}</h3>
      {bps === null ? (
        <p>
          <NotConfigured /> {t('reserveNone')}
        </p>
      ) : (
        <p>
          {t('reserveSet', { pct: bpsPercent(bps) })}
          {reserve && reserve.holdDays !== null ? ` ${t('reserveDays', { days: reserve.holdDays })}` : ` ${t('reserveDaysNone')}`}
        </p>
      )}
      <p className="muted pp-note">{t('reserveHeldSoon')}</p>
    </div>
  );
}
