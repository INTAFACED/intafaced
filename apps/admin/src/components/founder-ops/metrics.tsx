import type { DashboardData } from '@/lib/merchants/loaders';
import { chartPoints, dashboardAssets } from '@/components/merchants/dashboard';
import { BarChart } from '@/components/merchants/bar-chart';
import { AsOf, Amounts, Card, FailureState, KpiTile, StateBlock } from '@/components/merchants/ui';
import { sumByAsset } from '@/lib/merchants/money';
import { stalestFreshness } from '@/lib/merchants/time';
export function MetricsCharts({ data, path }: { data: DashboardData; path: string }) {
  const assets = dashboardAssets(data.days);
  const valid = data.days.flatMap((d) => (d.result.kind === 'ok' ? [d.result.data] : []));
  const volume = sumByAsset(valid.flatMap((d) => d.volume));
  const revenue = sumByAsset(valid.flatMap((d) => d.revenue));
  const failed = data.days.length - valid.length;
  return (
    <>
      <nav className="mp-pills" aria-label="Reporting period">
        {[
          ['today', 'Today'],
          ['7d', '7 days'],
          ['30d', '30 days'],
        ].map(([key, label]) => (
          <a
            key={key}
            href={`${path}?window=${key}`}
            aria-current={data.days.length === (key === 'today' ? 1 : key === '30d' ? 30 : 7) ? 'page' : undefined}
          >
            {label}
          </a>
        ))}
        <span className="mp-muted" title="Lifetime series is not exposed by this reader.">
          Lifetime · unavailable
        </span>
      </nav>
      <AsOf freshness={stalestFreshness(valid.map((v) => v.freshness))} label="Daily metrics" />
      {failed ? (
        <StateBlock kind="error" title={`${failed} daily snapshots could not be read`} action={<a href={path}>Retry metrics</a>}>
          Totals below cover readable days only. Unread days appear as chart gaps.
        </StateBlock>
      ) : null}
      <div className="mp-kpis">
        <KpiTile
          label="Volume"
          value={valid.length ? <Amounts rows={volume.totals} /> : 'Unavailable'}
          period={`${data.days.length} UTC days${failed ? ' · incomplete' : ''}`}
          href="#daily-metrics"
        />
        <KpiTile
          label="Fee revenue"
          value={valid.length ? <Amounts rows={revenue.totals} /> : 'Unavailable'}
          period={`${data.days.length} UTC days${failed ? ' · incomplete' : ''}`}
          href="#daily-metrics"
        />
        <KpiTile
          label="Daily snapshots read"
          value={`${valid.length} / ${data.days.length}`}
          period="Requested period"
          href="#daily-metrics"
        />
        <KpiTile label="Daily payment count" value="Unavailable" period="No count series read" href="#daily-metrics" />
      </div>
      <Card
        id="daily-metrics"
        title="Daily ledger-backed metrics"
        sub="Amounts stay separated by asset. Expand each chart’s table for the exact daily values."
      >
        {data.today.kind !== 'ok' ? <FailureState failure={data.today} what="Today's metrics" retryHref={path} /> : null}
        {assets.length ? (
          assets.map((asset) => (
            <div key={asset} className="mp-chartpair">
              <BarChart title="Volume" assetCode={asset} points={chartPoints(data.days, asset, 'volume')} tone="volume" />
              <BarChart title="Fee revenue" assetCode={asset} points={chartPoints(data.days, asset, 'revenue')} tone="revenue" />
            </div>
          ))
        ) : (
          <StateBlock kind="empty" title={valid.length ? 'No asset activity in readable snapshots' : 'Daily series unavailable'}>
            Daily figures appear after payments are captured and projected into the read model.
          </StateBlock>
        )}
      </Card>
    </>
  );
}
