import type { ReactNode } from 'react';
import type { FounderMerchantDrilldown, MerchantMetricsSeries, MerchantMetricsSnapshot } from '@intafaced/contracts';
import { daysEndingAt } from '@/lib/merchants/dates';
import type { MerchantDetailData, MetricPreset } from '@/lib/merchants/loaders';
import { haltChip } from '@/lib/merchants/chips';
import { amountFor, compareDecimal, formatAmount, sumByAsset } from '@/lib/merchants/money';
import { BarChart, type BarPoint } from './bar-chart';
import { CopyButton } from './copy-button';
import { AsOf, Amounts, Card, FailureState, KpiTile, PageHead, shortId, StateBlock, StatusChip, UNNAMED_MERCHANT } from './ui';

export const DETAIL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'payments', label: 'Payments' },
  { id: 'settlements', label: 'Settlements' },
  { id: 'notes', label: 'Notes' },
  { id: 'controls', label: 'Controls' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'halts', label: 'Halts' },
] as const;
export type DetailTab = (typeof DETAIL_TABS)[number]['id'];

export function parseTab(value: string | string[] | undefined): DetailTab {
  const one = Array.isArray(value) ? value[0] : value;
  return DETAIL_TABS.find((t) => t.id === one)?.id ?? 'overview';
}

const WINDOWS: readonly { id: MetricPreset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'rolling_7d', label: '7 days' },
  { id: 'rolling_30d', label: '30 days' },
];

const PAYMENT_STATUS_HINT: Record<string, string> = {
  created: 'Started, nothing authorised yet.',
  authorized: 'Authorised, not yet captured.',
  captured: 'Captured. The money is in.',
  settled: 'Settled to the merchant.',
  refunded: 'Refunded to the payer.',
  disputed: 'Under dispute.',
  failed: 'Did not go through.',
};

/** Series for one asset across the whole 30-day range. A day with no row had no activity (the read itself succeeded). */
export function seriesPoints(
  series: MerchantMetricsSeries,
  last: string,
  days: number,
  assetCode: string,
  field: 'volume' | 'feeRevenue',
): BarPoint[] {
  return daysEndingAt(last, days).map((day) => ({
    day,
    value: series.points.find((p) => p.day === day && p.assetCode === assetCode)?.[field] ?? '0',
  }));
}

export function seriesAssets(series: MerchantMetricsSeries): string[] {
  const { totals } = sumByAsset(series.points.map((p) => ({ assetCode: p.assetCode, amount: p.volume })));
  return totals.sort((a, b) => compareDecimal(b.amount, a.amount)).map((t) => t.assetCode);
}

/**
 * What the page knows about the merchant's name. `known` is false when neither the
 * drill-down nor the list lookup answered: the page then falls back to the id alone
 * rather than claiming the merchant is unnamed.
 */
export function merchantNames(data: Pick<MerchantDetailData, 'drilldown' | 'identity'>): {
  known: boolean;
  displayName: string | null;
  legalName: string | null;
} {
  if (data.drilldown.kind === 'ok') {
    return { known: true, displayName: data.drilldown.data.displayName, legalName: data.drilldown.data.legalName };
  }
  const row = data.identity.kind === 'ok' ? data.identity.data.rows[0] : undefined;
  return row ? { known: true, displayName: row.displayName, legalName: null } : { known: false, displayName: null, legalName: null };
}

export function MerchantDetailView({
  merchantId,
  data,
  tab,
  preset,
  asset,
  today,
}: {
  merchantId: string;
  data: MerchantDetailData;
  tab: DetailTab;
  preset: MetricPreset;
  asset?: string | undefined;
  /** `YYYY-MM-DD`, the last day of the series range. */
  today: string;
}) {
  const href = (next: Partial<{ tab: DetailTab; window: MetricPreset; asset: string }>) => {
    const q = new URLSearchParams();
    q.set('tab', next.tab ?? tab);
    q.set('window', next.window ?? preset);
    const a = next.asset ?? asset;
    if (a) q.set('asset', a);
    return `/merchants/${merchantId}?${q.toString()}`;
  };
  const here = href({});
  const names = merchantNames(data);

  return (
    <div className="mp-page">
      <PageHead
        title={
          !names.known ? (
            `Merchant ${shortId(merchantId)}`
          ) : names.displayName === null ? (
            <span className="mp-muted">{UNNAMED_MERCHANT}</span>
          ) : (
            names.displayName
          )
        }
        badge={
          names.known ? (
            <code className="mp-sub mp-merchant__id" title={merchantId}>
              {shortId(merchantId)}
            </code>
          ) : undefined
        }
        purpose="One merchant's money, settlements and operator controls. Figures are the same ones the merchant sees."
        back={{ href: '/merchants/all', label: 'All merchants' }}
      />
      <div className="mp-facts" aria-label="Merchant identity">
        {names.legalName !== null ? (
          <div>
            <span className="mp-facts__k">Legal name</span>
            <span className="mp-facts__v">{names.legalName}</span>
          </div>
        ) : null}
        <div>
          <span className="mp-facts__k">Merchant id</span>
          <span className="mp-facts__v">
            <code>{merchantId}</code> <CopyButton value={merchantId} label="Copy id" />
          </span>
        </div>
        <nav className="mp-pills" aria-label="Time window">
          {WINDOWS.map((w) => (
            <a key={w.id} href={href({ window: w.id })} aria-current={w.id === preset ? 'true' : undefined}>
              {w.label}
            </a>
          ))}
        </nav>
      </div>

      <nav className="mp-tabs" aria-label="Merchant sections">
        {DETAIL_TABS.map((t) => (
          <a key={t.id} href={href({ tab: t.id })} aria-current={t.id === tab ? 'page' : undefined}>
            {t.label}
          </a>
        ))}
      </nav>

      {tab === 'overview' ? <Overview data={data} asset={asset} today={today} here={here} assetHref={(a) => href({ asset: a })} /> : null}
      {tab === 'payments' ? <Payments metrics={data.metrics} here={here} /> : null}
      {tab === 'settlements' ? <Settlements metrics={data.metrics} here={here} /> : null}
      {tab === 'notes' ? <Notes /> : null}
      {tab === 'controls' ? <ControlsTab drilldown={data.drilldown} here={here} /> : null}
      {tab === 'approvals' ? <ApprovalsTab drilldown={data.drilldown} here={here} /> : null}
      {tab === 'halts' ? <HaltsTab drilldown={data.drilldown} here={here} /> : null}
    </div>
  );
}

function MetricsGate({
  metrics,
  here,
  children,
}: {
  metrics: MerchantDetailData['metrics'];
  here: string;
  children: (m: MerchantMetricsSnapshot) => ReactNode;
}) {
  if (metrics.kind !== 'ok') return <FailureState failure={metrics} what="This merchant's figures" retryHref={here} />;
  return (
    <>
      <AsOf freshness={metrics.data.freshness} label="Figures" />
      {children(metrics.data)}
    </>
  );
}

function Overview({
  data,
  asset,
  today,
  here,
  assetHref,
}: {
  data: MerchantDetailData;
  asset?: string | undefined;
  today: string;
  here: string;
  assetHref: (asset: string) => string;
}) {
  return (
    <>
      <MetricsGate metrics={data.metrics} here={here}>
        {(m) => (
          <div className="mp-kpis" role="group" aria-label="Key figures">
            <KpiTile label="Payments" value={<span className="mp-num">{m.paymentCount}</span>} period="In the selected window" />
            <KpiTile label="Captured" value={<Amounts rows={m.captured} empty="No payments" />} period="In the selected window" />
            <KpiTile label="Refunded" value={<Amounts rows={m.refunded} empty="No refunds" />} period="In the selected window" />
            <KpiTile label="Net" value={<Amounts rows={m.net} empty="None" />} period="Captured minus refunded" />
            <KpiTile label="Fee revenue" value={<Amounts rows={m.feeRevenue} empty="No fees" />} period="From settled payments" />
            <KpiTile
              label="Conversion volume"
              value={
                m.conversionVolume === null ? (
                  <span className="mp-muted">Not built yet</span>
                ) : (
                  <Amounts rows={m.conversionVolume} empty="None" />
                )
              }
              period="Arrives with W6"
            />
          </div>
        )}
      </MetricsGate>

      <Card
        id="series"
        title="Volume and fee revenue, last 30 days"
        sub="One asset at a time, whole UTC days. Missing days had no activity."
      >
        {data.series.kind !== 'ok' ? (
          <FailureState failure={data.series} what="The daily series" retryHref={here} />
        ) : (
          <SeriesBody series={data.series.data} asset={asset} today={today} assetHref={assetHref} />
        )}
      </Card>

      <MetricsGate metrics={data.metrics} here={here}>
        {(m) => (
          <Card id="balances" title="Balances" sub="Per asset. Clearing is captured and not yet settled; available can be paid out.">
            {m.balances.length === 0 ? (
              <StateBlock kind="empty" title="No balances yet">
                A balance appears after this merchant's first captured payment.
              </StateBlock>
            ) : (
              <table className="mp-table">
                <caption className="mp-visually-hidden">Merchant balances per asset</caption>
                <thead>
                  <tr>
                    <th scope="col">Asset</th>
                    <th scope="col" className="mp-right">
                      Clearing
                    </th>
                    <th scope="col" className="mp-right">
                      Available
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {m.balances.map((b) => (
                    <tr key={b.assetCode}>
                      <th scope="row">{b.assetCode}</th>
                      <td className="mp-right mp-num">{formatAmount(b.clearing)}</td>
                      <td className="mp-right mp-num">{formatAmount(b.available)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}
      </MetricsGate>
    </>
  );
}

function SeriesBody({
  series,
  asset,
  today,
  assetHref,
}: {
  series: MerchantMetricsSeries;
  asset?: string | undefined;
  today: string;
  assetHref: (a: string) => string;
}) {
  const assets = seriesAssets(series);
  const selected = asset && assets.includes(asset) ? asset : (assets[0] ?? null);
  return (
    <>
      <AsOf freshness={series.freshness} label="Series" />
      {selected === null ? (
        <StateBlock kind="empty" title="No activity in the last 30 days">
          This merchant has not captured or settled anything in this range. The chart fills in when it does.
        </StateBlock>
      ) : (
        <>
          {assets.length > 1 ? (
            <nav className="mp-pills" aria-label="Asset">
              {assets.map((a) => (
                <a key={a} href={assetHref(a)} aria-current={a === selected ? 'true' : undefined}>
                  {a}
                </a>
              ))}
            </nav>
          ) : null}
          <div className="mp-charts">
            <BarChart title="Volume" assetCode={selected} points={seriesPoints(series, today, 30, selected, 'volume')} tone="volume" />
            <BarChart
              title="Fee revenue"
              assetCode={selected}
              points={seriesPoints(series, today, 30, selected, 'feeRevenue')}
              tone="revenue"
            />
          </div>
        </>
      )}
    </>
  );
}

function Payments({ metrics, here }: { metrics: MerchantDetailData['metrics']; here: string }) {
  return (
    <MetricsGate metrics={metrics} here={here}>
      {(m) => (
        <>
          <Card id="status-mix" title="Payments by status" sub="How the payments in this window ended up.">
            {m.paymentCount === 0 ? (
              <StateBlock kind="empty" title="No payments in this window">
                Try a longer window, or wait for this merchant's first payment.
              </StateBlock>
            ) : (
              <table className="mp-table">
                <caption className="mp-visually-hidden">Payment count by status</caption>
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col" className="mp-right">
                      Payments
                    </th>
                    <th scope="col">What it means</th>
                  </tr>
                </thead>
                <tbody>
                  {m.statusMix.map((row) => (
                    <tr key={row.status}>
                      <th scope="row">{row.status}</th>
                      <td className="mp-right mp-num">{row.count}</td>
                      <td className="mp-muted">{PAYMENT_STATUS_HINT[row.status] ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card id="amounts" title="Amounts" sub="Per asset. Not added across assets.">
            <table className="mp-table">
              <caption className="mp-visually-hidden">Payment amounts per asset</caption>
              <thead>
                <tr>
                  <th scope="col">Asset</th>
                  <th scope="col" className="mp-right">
                    Captured
                  </th>
                  <th scope="col" className="mp-right">
                    Refunded
                  </th>
                  <th scope="col" className="mp-right">
                    Net
                  </th>
                  <th scope="col" className="mp-right">
                    Average
                  </th>
                  <th scope="col" className="mp-right">
                    Largest
                  </th>
                </tr>
              </thead>
              <tbody>
                {assetCodes(m).map((code) => (
                  <tr key={code}>
                    <th scope="row">{code}</th>
                    {[m.captured, m.refunded, m.net, m.averagePayment, m.largestPayment].map((list, i) => {
                      const v = amountFor(list, code);
                      return (
                        <td key={i} className="mp-right mp-num">
                          {v === null ? <span className="mp-muted">—</span> : formatAmount(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {assetCodes(m).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="mp-muted">
                      No amounts in this window.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </Card>
          <Card id="links" title="Payment links" sub="How many of these payments came through a payment link.">
            <dl className="mp-kv">
              <div>
                <dt>Links used</dt>
                <dd className="mp-num">{m.linkUsage.linksUsed}</dd>
              </div>
              <div>
                <dt>Payments through links</dt>
                <dd className="mp-num">{m.linkUsage.paymentsViaLinks}</dd>
              </div>
            </dl>
          </Card>
        </>
      )}
    </MetricsGate>
  );
}

function assetCodes(m: MerchantMetricsSnapshot): string[] {
  return [...new Set([...m.captured, ...m.refunded, ...m.net, ...m.averagePayment, ...m.largestPayment].map((a) => a.assetCode))].sort();
}

function Settlements({ metrics, here }: { metrics: MerchantDetailData['metrics']; here: string }) {
  return (
    <MetricsGate metrics={metrics} here={here}>
      {(m) => (
        <Card id="settlements" title="Settlements" sub="What was paid out to this merchant in the window: gross, platform fees and net.">
          {m.settlements.length === 0 ? (
            <StateBlock kind="empty" title="Nothing settled in this window">
              Captured payments settle on the merchant's schedule. Settlements appear here once one completes.
            </StateBlock>
          ) : (
            <table className="mp-table">
              <caption className="mp-visually-hidden">Settlements per asset</caption>
              <thead>
                <tr>
                  <th scope="col">Asset</th>
                  <th scope="col" className="mp-right">
                    Gross
                  </th>
                  <th scope="col" className="mp-right">
                    Fees
                  </th>
                  <th scope="col" className="mp-right">
                    Net
                  </th>
                </tr>
              </thead>
              <tbody>
                {m.settlements.map((s) => (
                  <tr key={s.assetCode}>
                    <th scope="row">{s.assetCode}</th>
                    <td className="mp-right mp-num">{formatAmount(s.gross)}</td>
                    <td className="mp-right mp-num">{formatAmount(s.fees)}</td>
                    <td className="mp-right mp-num">{formatAmount(s.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mp-footnote mp-mt">
            Individual settlements with retry and hold arrive with W1 and W5. This tab is the summary the read model projects.
          </p>
        </Card>
      )}
    </MetricsGate>
  );
}

function Notes() {
  return (
    <Card id="notes" title="Operator notes" sub="Internal notes about this merchant. The merchant never sees them.">
      <StateBlock kind="not_built" title="Notes are not built yet">
        Listing, adding and retracting notes needs the operator notes service (<code>founderAdmin.ops</code>, workstream W15), which is not
        on this deployment. This tab will list notes, add a note with a reason, and retract one while keeping the history, as soon as it is.
        Nothing is stored in the browser in the meantime.
      </StateBlock>
    </Card>
  );
}

function pending(title: string, what: string) {
  return (
    <Card id={title.toLowerCase()} title={title} sub={what}>
      <StateBlock kind="not_built" title={`${title} arrives with W1 and W5`}>
        This tab shows {what.toLowerCase()} once the control-room and halts procedures are on this deployment. It is empty by design until
        then, not because there is nothing to show.
      </StateBlock>
    </Card>
  );
}

function DrilldownGate({
  drilldown,
  here,
  title,
  what,
  children,
}: {
  drilldown: MerchantDetailData['drilldown'];
  here: string;
  title: string;
  what: string;
  children: (d: FounderMerchantDrilldown) => ReactNode;
}) {
  if (drilldown.kind === 'not_built') return pending(title, what);
  if (drilldown.kind !== 'ok') return <FailureState failure={drilldown} what={`${title} for this merchant`} retryHref={here} />;
  return <>{children(drilldown.data)}</>;
}

function ControlsTab({ drilldown, here }: { drilldown: MerchantDetailData['drilldown']; here: string }) {
  return (
    <DrilldownGate drilldown={drilldown} here={here} title="Controls" what="Tier, caps and pricing for this merchant">
      {(d) => (
        <Card id="controls" title="Controls" sub="Read only. Changing a limit, price or tier needs a second founder and arrives with W1.">
          <dl className="mp-kv">
            <div>
              <dt>Tier</dt>
              <dd>{d.control.tierId ?? <span className="mp-muted">Not set</span>}</dd>
            </div>
            <div>
              <dt>Archetype</dt>
              <dd>{d.control.archetypeId ?? <span className="mp-muted">Not set</span>}</dd>
            </div>
            <div>
              <dt>Caps</dt>
              <dd>
                {d.control.caps === null ? (
                  <span className="mp-muted">Not configured (payments refuse)</span>
                ) : (
                  `${d.control.caps.length} set`
                )}
              </dd>
            </div>
            <div>
              <dt>Pricing rules</dt>
              <dd>{d.control.pricing === null ? <span className="mp-muted">Not configured</span> : `${d.control.pricing.length} set`}</dd>
            </div>
            <div>
              <dt>Reserve</dt>
              <dd>{d.control.reserve === null ? <span className="mp-muted">Not configured</span> : 'Set'}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd className="mp-num">{d.control.version}</dd>
            </div>
          </dl>
          <p className="mp-muted mp-mt">
            KYB: {d.operator.kybStatus}. Open fraud reviews: {d.operator.openFraudReviews}.
          </p>
        </Card>
      )}
    </DrilldownGate>
  );
}

function ApprovalsTab({ drilldown, here }: { drilldown: MerchantDetailData['drilldown']; here: string }) {
  return (
    <DrilldownGate drilldown={drilldown} here={here} title="Approvals" what="Payout approvals waiting for a decision">
      {(d) => (
        <Card id="approvals" title="Approvals" sub="Payouts waiting for a second founder.">
          {d.pendingApprovals.length === 0 ? (
            <StateBlock kind="empty" title="Nothing waiting">
              No payout for this merchant is waiting for approval.
            </StateBlock>
          ) : (
            <table className="mp-table">
              <caption className="mp-visually-hidden">Pending payout approvals</caption>
              <thead>
                <tr>
                  <th scope="col">Amount</th>
                  <th scope="col">Status</th>
                  <th scope="col">Requested</th>
                  <th scope="col">Expires</th>
                </tr>
              </thead>
              <tbody>
                {d.pendingApprovals.map((a) => (
                  <tr key={a.approvalId}>
                    <td className="mp-num">
                      {formatAmount(a.amount)} {a.assetCode}
                    </td>
                    <td>{a.status}</td>
                    <td className="mp-num">{a.createdAt}</td>
                    <td className="mp-num">{a.expiresAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </DrilldownGate>
  );
}

function HaltsTab({ drilldown, here }: { drilldown: MerchantDetailData['drilldown']; here: string }) {
  return (
    <DrilldownGate drilldown={drilldown} here={here} title="Halts" what="Paused operations for this merchant">
      {(d) => (
        <Card id="halts" title="Halts" sub="Which operations are paused for this merchant, globally or for it alone.">
          {!d.halts.readable ? (
            <StateBlock kind="error" title="The halt store could not be read">
              An unreadable store counts as halted. Treat every operation as paused until it can be read.
            </StateBlock>
          ) : d.halts.states.length === 0 ? (
            <StateBlock kind="empty" title="No halts recorded">
              Nothing has ever been paused for this merchant.
            </StateBlock>
          ) : (
            <table className="mp-table">
              <caption className="mp-visually-hidden">Halt states</caption>
              <thead>
                <tr>
                  <th scope="col">Operation</th>
                  <th scope="col">Covers</th>
                  <th scope="col">State</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {d.halts.states.map((s) => (
                  <tr key={`${s.scope}-${s.target.level}`}>
                    <th scope="row">{s.scope}</th>
                    <td>{s.target.level === 'global' ? 'Everyone' : 'This merchant'}</td>
                    <td>
                      <StatusChip spec={haltChip(s.halted)} />
                    </td>
                    <td className="mp-muted">{s.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </DrilldownGate>
  );
}
