import type { FounderGlobalMetrics } from '@intafaced/contracts';
import type { DashboardData } from '@/lib/merchants/loaders';
import { amountFor, sumByAsset, compareDecimal, type AssetAmount } from '@/lib/merchants/money';
import { railChip } from '@/lib/merchants/chips';
import { stalestFreshness, type Freshness } from '@/lib/merchants/time';
import type { PayCallResult } from '@/lib/merchants/pay-call';
import { BarChart, type BarPoint } from './bar-chart';
import { AsOf, Amounts, Card, FailureState, KpiTile, PageHead, StateBlock, StatusChip } from './ui';

type Global = FounderGlobalMetrics;

const STEP_LABEL: Record<string, string> = {
  'status.pending': 'Created, not yet active',
  'status.active': 'Active',
  'status.suspended': 'Suspended',
  'status.closed': 'Closed',
  'kyb.none': 'No KYB submitted',
  'kyb.pending': 'KYB waiting for a decision',
  'kyb.approved': 'KYB approved',
  'kyb.rejected': 'KYB rejected',
};

/** Assets seen in the daily reads, biggest total volume first. */
export function dashboardAssets(days: readonly { result: PayCallResult<Global> }[]): string[] {
  const rows: AssetAmount[] = [];
  for (const d of days) if (d.result.kind === 'ok') rows.push(...d.result.data.volume);
  const { totals } = sumByAsset(rows);
  return totals.sort((a, b) => compareDecimal(b.amount, a.amount)).map((t) => t.assetCode);
}

export function chartPoints(days: DashboardData['days'], assetCode: string, field: 'volume' | 'revenue'): BarPoint[] {
  return days.map(({ day, result }) => {
    if (result.kind !== 'ok') return { day, value: null };
    // A day with no row for this asset had no activity in it. That is a real zero, because the read itself succeeded.
    return { day, value: amountFor(result.data[field], assetCode) ?? '0' };
  });
}

export function DashboardView({ data, asset }: { data: DashboardData; asset?: string | undefined }) {
  const today = data.today;
  const assets = dashboardAssets(data.days);
  const selected = asset && assets.includes(asset) ? asset : (assets[0] ?? null);

  return (
    <div className="mp-page">
      <PageHead
        title="Merchants dashboard"
        purpose="Money moving through every merchant: volume, revenue, what is waiting to settle and what needs a founder's attention."
        actions={
          <a className="mp-btn" href="/merchants">
            Refresh
          </a>
        }
      />
      {today.kind !== 'ok' ? (
        <FailureState failure={today} what="The dashboard" retryHref="/merchants" />
      ) : (
        <DashboardBody data={data} metrics={today.data} assets={assets} selected={selected} />
      )}
    </div>
  );
}

function DashboardBody({
  data,
  metrics,
  assets,
  selected,
}: {
  data: DashboardData;
  metrics: Global;
  assets: string[];
  selected: string | null;
}) {
  const reads: Freshness[] = [metrics.freshness];
  for (const d of data.days) if (d.result.kind === 'ok') reads.push(d.result.data.freshness);
  const failedDays = data.days.filter((d) => d.result.kind !== 'ok').length;
  const week = sumByAsset(data.days.flatMap((d) => (d.result.kind === 'ok' ? d.result.data.volume : [])));
  const weekRevenue = sumByAsset(data.days.flatMap((d) => (d.result.kind === 'ok' ? d.result.data.revenue : [])));

  const status = metrics.onboardingFunnel.filter((s) => s.step.startsWith('status.'));
  const kyb = metrics.onboardingFunnel.filter((s) => s.step.startsWith('kyb.'));
  const funnelMax = Math.max(1, ...metrics.onboardingFunnel.map((s) => s.count));

  return (
    <>
      <AsOf freshness={stalestFreshness(reads)} label="Numbers on this page" />

      <div className="mp-kpis" role="group" aria-label="Key figures">
        <KpiTile
          label="Volume today"
          value={<Amounts rows={metrics.volume} empty="No payments yet" />}
          period="Today, UTC day"
          href="/merchants/all"
        />
        <KpiTile
          label="Revenue today"
          value={<Amounts rows={metrics.revenue} empty="No fees yet" />}
          period="Today, UTC day"
          note="Fees from settled payments"
        />
        <KpiTile
          label="Active merchants"
          value={<span className="mp-num">{metrics.activeMerchants}</span>}
          period="Took a payment today"
          href="/merchants/all?status=active"
        />
        <KpiTile
          label="Pending settlement"
          value={<Amounts rows={metrics.pendingSettlement} empty="Nothing waiting" />}
          period="Right now, not windowed"
          note="Captured, not yet settled"
        />
        <KpiTile
          label="Pending KYB"
          value={<span className="mp-num">{metrics.pendingKyb}</span>}
          period="Right now"
          href="/kyb"
          note="Business verification waiting"
        />
        <KpiTile
          label="Open fraud reviews"
          value={<span className="mp-num">{metrics.openFraudReviews}</span>}
          period="Right now"
          note="Open the bounded review queue"
          href="/fraud"
        />
      </div>

      <Card
        id="by-day"
        title="Volume and revenue by day"
        sub={`Last ${data.days.length} UTC days, all merchants, one asset at a time. Assets are never added together.`}
        actions={
          assets.length > 1 ? (
            <nav className="mp-pills" aria-label="Asset">
              {assets.map((a) => (
                <a key={a} href={`/merchants?asset=${encodeURIComponent(a)}`} aria-current={a === selected ? 'true' : undefined}>
                  {a}
                </a>
              ))}
            </nav>
          ) : undefined
        }
      >
        {failedDays > 0 ? (
          <StateBlock kind="error" title={`${failedDays} of ${data.days.length} days could not be read`}>
            Those days show as gaps, not zeros. Refresh to try again.
          </StateBlock>
        ) : null}
        {selected === null ? (
          <StateBlock kind="empty" title={`No payments in the last ${data.days.length} days`}>
            This fills in as soon as any merchant captures a payment. Merchants appear in the funnel below once they are created.
          </StateBlock>
        ) : (
          <>
            <div className="mp-charts">
              <BarChart title="Volume" assetCode={selected} points={chartPoints(data.days, selected, 'volume')} tone="volume" />
              <BarChart title="Revenue" assetCode={selected} points={chartPoints(data.days, selected, 'revenue')} tone="revenue" />
            </div>
            <p className="mp-muted mp-mt">
              {data.days.length}-day totals, each asset on its own: volume <Amounts rows={week.totals} empty="none" inline />; revenue{' '}
              <Amounts rows={weekRevenue.totals} empty="none" inline />.
            </p>
          </>
        )}
      </Card>

      <div className="mp-two">
        <Card
          id="funnel"
          title="Onboarding funnel"
          sub="Merchants by account status and by business verification (KYB). Each row opens that filtered list."
        >
          {metrics.onboardingFunnel.length === 0 ? (
            <StateBlock kind="empty" title="No merchants yet">
              Merchants are counted here once they are created.
            </StateBlock>
          ) : (
            <>
              <FunnelGroup title="Account status" rows={status} max={funnelMax} param="status" />
              <FunnelGroup title="Business verification (KYB)" rows={kyb} max={funnelMax} param="kyb" />
            </>
          )}
        </Card>

        <Card id="rails" title="Payment rails" sub="Whether each payment rail is answering right now.">
          {metrics.railHealth.length === 0 ? (
            <StateBlock kind="empty" title="No rails reported">
              The service did not list any payment rail. That is not the same as every rail being healthy.
            </StateBlock>
          ) : (
            <table className="mp-table">
              <caption className="mp-visually-hidden">Payment rail health</caption>
              <thead>
                <tr>
                  <th scope="col">Rail</th>
                  <th scope="col">State</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {metrics.railHealth.map((rail) => (
                  <tr key={rail.railId}>
                    <th scope="row">{rail.railId}</th>
                    <td>
                      <StatusChip spec={railChip(rail.ok)} />
                    </td>
                    <td className="mp-muted">{rail.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card id="more" title="Go deeper" sub="Each of these opens its own page.">
        <ul className="mp-links">
          <li>
            <a href="/merchants/all">All merchants</a>
            <span className="mp-muted"> Search, filter and export the merchant list.</span>
          </li>
          <li>
            <a href="/merchants/registries/venues">Venues, networks and wallet routes</a>
            <span className="mp-muted"> Where conversions and payouts may go.</span>
          </li>
          <li>
            <a href="/merchants/treasury">Treasury and halts</a>
            <span className="mp-muted"> Exposure and paused operations.</span>
          </li>
        </ul>
      </Card>
      <p className="mp-footnote">
        These figures are what the read model has projected, with its own as-of time. They are not the ledger. Money is shown exactly as the
        service sent it, never rounded.
      </p>
    </>
  );
}

function FunnelGroup({
  title,
  rows,
  max,
  param,
}: {
  title: string;
  rows: { step: string; count: number }[];
  max: number;
  param: 'status' | 'kyb';
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mp-funnel">
      <h3>{title}</h3>
      <ul>
        {rows.map((row) => {
          const key = row.step.split('.')[1] ?? row.step;
          return (
            <li key={row.step}>
              <a href={`/merchants/all?${param}=${encodeURIComponent(key)}`}>
                <span className="mp-funnel__label">{STEP_LABEL[row.step] ?? row.step}</span>
                <span className="mp-funnel__bar" aria-hidden="true">
                  <span style={{ width: `${Math.round((row.count / max) * 100)}%` }} />
                </span>
                <span className="mp-num mp-funnel__count">{row.count}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
