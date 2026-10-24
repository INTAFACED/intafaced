import type { ReactNode } from 'react';
import { DRILLDOWN } from '@/lib/founder-ops/screens';
import type { MerchantMetricsSeries, MerchantMetricsSnapshot } from '@intafaced/contracts';
import { daysEndingAt } from '@/lib/merchants/dates';
import type { ControlsData, MerchantApprovalsData, MerchantDetailData, MerchantHaltsData, MetricPreset } from '@/lib/merchants/loaders';
import { amountFor, compareDecimal, formatAmount, sumByAsset } from '@/lib/merchants/money';
import { BarChart, type BarPoint } from './bar-chart';
import { ApprovalsTable } from './approvals-queue';
import { ControlsTab } from './controls-tab';
import { CopyButton } from './copy-button';
import { NotesPanel } from '@/components/founder-ops/notes-panel';
import type { KybDocumentReviewView } from '@intafaced/contracts/kyb-documents';
import { VerificationTab } from './verification-tab';
import type { NotePage } from '@/lib/founder-ops/notes';
import type { PayCallResult } from '@/lib/merchants/pay-call';
import { feeLines, FEE_ACCOUNT_RATE, FEE_NOT_CONFIGURED } from '@/lib/merchants/fee-story';
import { Chip } from '@/components/chip';
import { AutoTripCard, haltAppliesToMerchant, HaltHistoryTable, HaltStatesTable, PendingClearsPanel } from './halts-panels';
import { AsOf, Amounts, Card, FailureState, KpiTile, PageHead, shortId, StateBlock, UNNAMED_MERCHANT } from './ui';

export const DETAIL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'payments', label: 'Payments' },
  { id: 'settlements', label: 'Settlements' },
  { id: 'notes', label: 'Notes' },
  { id: 'verification', label: 'Verification' },
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
  tabData = {},
  query = {},
  currentUserId,
  now = new Date(),
  testData = false,
}: {
  merchantId: string;
  data: MerchantDetailData;
  tab: DetailTab;
  preset: MetricPreset;
  asset?: string | undefined;
  /** `YYYY-MM-DD`, the last day of the series range. */
  today: string;
  tabData?: DetailTabData;
  /** The page's own query string, so a tab can keep its filters and cursor. */
  query?: Record<string, string | string[] | undefined>;
  /** The signed-in founder, so rows they took part in say they cannot sign them. */
  currentUserId?: string | undefined;
  now?: Date;
  /** True outside production. The fee shown is then a test value, whatever the rule says. */
  testData?: boolean;
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
            <bdi>{names.displayName}</bdi>
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
            <span className="mp-facts__v">
              <bdi>{names.legalName}</bdi>
            </span>
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

      <nav className="mp-pills" aria-label="Full merchant drilldown">
        {DRILLDOWN.map((row) => (
          <a key={row[1]} href={`/merchants/${merchantId}/${row[1]}`}>
            {row[2]}
          </a>
        ))}
      </nav>
      {tab === 'overview' ? (
        <Overview data={data} asset={asset} today={today} here={here} testData={testData} assetHref={(a) => href({ asset: a })} />
      ) : null}
      {tab === 'payments' ? <Payments metrics={data.metrics} here={here} /> : null}
      {tab === 'settlements' ? <Settlements metrics={data.metrics} here={here} /> : null}
      {tab === 'notes' ? (
        <NotesPanel merchantId={merchantId} result={tabData.notes} path={`/merchants/${merchantId}`} query={{ ...query, tab: 'notes' }} />
      ) : null}
      {tab === 'verification' ? <VerificationTab result={tabData.verification} here={href({ tab: 'verification' })} /> : null}
      {tab === 'controls' ? tabData.controls ? <ControlsTab data={tabData.controls} merchantId={merchantId} here={here} /> : null : null}
      {tab === 'approvals' ? (
        <ApprovalsTab
          data={tabData.approvals}
          merchantId={merchantId}
          merchantName={names.displayName}
          currentUserId={currentUserId}
          now={now}
          here={here}
        />
      ) : null}
      {tab === 'halts' ? <HaltsTab data={tabData.halts} merchantId={merchantId} currentUserId={currentUserId} here={here} /> : null}
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

/** A pending ask whose stored caps are not a cap. The raw JSON is not shown. */
function UnreadableLimitAsks({ drilldown }: { drilldown: MerchantDetailData['drilldown'] }) {
  if (drilldown.kind !== 'ok') return null;
  const rows = drilldown.data.pendingLimitRequests.filter((request) => !Array.isArray(request.caps));
  if (rows.length === 0) return null;
  return (
    <Card id="limit-asks" title="Open limit requests" sub="Stored asks for higher caps. They are not the caps this merchant can use.">
      <ul>
        {rows.map((request) => (
          <li key={request.requestId}>caps unreadable</li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * The pricing rule in force, in percent. It is not the fee taken: that is the rate on the merchant's account (read by the
 * portal, not by this console), and the rule only writes the snapshot kept with each payment.
 */
function FeeCard({ data, here, testData }: { data: MerchantDetailData; here: string; testData: boolean }) {
  const { drilldown } = data;
  return (
    <Card
      id="fee"
      title="Pricing rule"
      sub="The rule in force for this merchant, as a percent. Steps follow the merchant’s monthly volume."
    >
      {drilldown.kind !== 'ok' ? (
        <FailureState failure={drilldown} what="The pricing rule" retryHref={here} />
      ) : (
        (() => {
          const lines = feeLines(drilldown.data.control.pricing);
          return (
            <>
              {lines.length === 0 ? (
                <p className="mp-warn">{FEE_NOT_CONFIGURED}</p>
              ) : (
                <ul data-testid="fee-lines">
                  {lines.map((line) => (
                    <li key={line.assetCode}>
                      <strong className="mp-num">{line.percent}</strong> on {line.assetCode} payments, from {line.layerWords}.{' '}
                      {testData ? (
                        <Chip tone="info" title="A test value in a non-production environment. It is not INTAFACED pricing.">
                          TEST
                        </Chip>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mp-muted">{FEE_ACCOUNT_RATE}</p>
            </>
          );
        })()
      )}
    </Card>
  );
}

function Overview({
  data,
  asset,
  today,
  here,
  assetHref,
  testData = false,
}: {
  testData?: boolean;
  data: MerchantDetailData;
  asset?: string | undefined;
  today: string;
  here: string;
  assetHref: (asset: string) => string;
}) {
  return (
    <>
      <UnreadableLimitAsks drilldown={data.drilldown} />
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
                  <span className="mp-muted">Not available</span>
                ) : (
                  <Amounts rows={m.conversionVolume} empty="None" />
                )
              }
              period="No conversion order reader"
            />
          </div>
        )}
      </MetricsGate>

      <FeeCard data={data} here={here} testData={testData} />

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
            Individual settlements with retry and hold are not connected here. This tab is the summary the read model projects.
          </p>
        </Card>
      )}
    </MetricsGate>
  );
}

/** What a tab needs beyond the metrics: loaded by the page only for the tab that is open. */
export interface DetailTabData {
  readonly controls?: ControlsData;
  readonly approvals?: MerchantApprovalsData;
  readonly halts?: MerchantHaltsData;
  readonly notes?: PayCallResult<NotePage>;
  readonly verification?: PayCallResult<KybDocumentReviewView>;
}

function ApprovalsTab({
  data,
  merchantId,
  merchantName,
  currentUserId,
  now,
  here,
}: {
  data: MerchantApprovalsData | undefined;
  merchantId: string;
  merchantName: string | null;
  currentUserId: string | undefined;
  now: Date;
  here: string;
}) {
  if (!data)
    return (
      <Card id="approvals" title="Approvals">
        {null}
      </Card>
    );
  const rows = data.queue.kind === 'ok' ? data.queue.data.approvals.filter((a) => a.merchantId === merchantId) : [];
  return (
    <Card
      id="approvals"
      title="Payout approvals"
      sub="Payouts for this merchant that its own team approved and that now wait for two different founders."
      actions={
        <a className="mp-btn" href="/merchants/approvals">
          Open the full queue
        </a>
      }
    >
      {data.queue.kind !== 'ok' ? (
        <FailureState failure={data.queue} what="This merchant's approvals" retryHref={here} />
      ) : (
        <>
          <AsOf freshness={{ asOf: data.readAt, lagSeconds: 0 }} label="Approvals" />
          {data.queue.data.truncated ? (
            <StateBlock kind="info" title="This merchant may have more waiting">
              The queue is longer than one read covers. Open the full queue to see everything.
            </StateBlock>
          ) : null}
          {rows.length === 0 ? (
            <StateBlock kind="empty" title="Nothing waiting for founders">
              No payout for this merchant is waiting at the founder step. Payouts still waiting for the merchant’s own team are not listed
              here: the service has no founder-readable list for that earlier step.
            </StateBlock>
          ) : (
            <ApprovalsTable
              rows={rows}
              names={new Map([[merchantId, merchantName]])}
              now={now}
              currentUserId={currentUserId}
              showMerchant={false}
            />
          )}
        </>
      )}
    </Card>
  );
}

function HaltsTab({
  data,
  merchantId,
  currentUserId,
  here,
}: {
  data: MerchantHaltsData | undefined;
  merchantId: string;
  currentUserId: string | undefined;
  here: string;
}) {
  if (!data)
    return (
      <Card id="halts" title="Halts">
        {null}
      </Card>
    );
  const fresh = { asOf: data.readAt, lagSeconds: 0 };
  return (
    <>
      <Card
        id="halts"
        title="Halts that apply to this merchant"
        sub="Which operations are paused, for everyone or for this merchant alone. Either one stops the operation here."
      >
        {data.status.kind !== 'ok' ? (
          <FailureState failure={data.status} what="The halt switches" retryHref={here} />
        ) : !data.status.data.readable ? (
          <StateBlock kind="error" title="The halt store could not be read">
            An unreadable store counts as halted. Treat every operation as paused until it can be read.
          </StateBlock>
        ) : (
          <>
            <AsOf freshness={fresh} label="Switches" />
            <HaltStatesTable
              states={data.status.data.states.filter((s) => haltAppliesToMerchant(s.target, merchantId))}
              caption="Halt switches that apply to this merchant"
            />
            <p className="mp-footnote mp-mt">
              A merchant-specific halt that was never set does not appear: only switches that exist are listed, plus the global switch of
              each operation.
            </p>
          </>
        )}
      </Card>
      <Card id="auto-trip" title="Automatic trip" sub="Platform-wide setting.">
        {data.status.kind !== 'ok' ? (
          <FailureState failure={data.status} what="The automatic trip setting" retryHref={here} />
        ) : (
          <AutoTripCard autoTrip={data.status.data.autoTrip} />
        )}
      </Card>
      <Card id="pending-clears" title="Clears waiting for a second founder" sub="A halt only comes off when two different founders agree.">
        <PendingClearsPanel result={data.pending} currentUserId={currentUserId} merchantId={merchantId} retryHref={here} />
      </Card>
      <Card
        id="halt-history"
        title="Halt history for this merchant"
        sub="Halts set on this merchant alone, newest first. Platform-wide halts are on the Treasury and halts page."
      >
        {data.history.kind !== 'ok' ? (
          <FailureState failure={data.history} what="This merchant's halt history" retryHref={here} />
        ) : data.history.data.length === 0 ? (
          <StateBlock kind="empty" title="No halts recorded for this merchant">
            Nothing has ever been paused for this merchant alone.
          </StateBlock>
        ) : (
          <>
            <AsOf freshness={fresh} label="History" />
            <HaltHistoryTable events={data.history.data} currentUserId={currentUserId} showTarget={false} />
          </>
        )}
        <p className="mp-footnote mp-mt">
          <a href="/merchants/treasury#halts">Platform-wide halt history</a>
        </p>
      </Card>
    </>
  );
}
