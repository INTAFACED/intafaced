import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { LiquidationsView } from '@/components/trade-ops/liquidations-view';
import { readInsuranceHistory, readLiquidations } from '@/lib/trade-ops/desk-reads';
import { oldestAsOf } from '@/lib/trade-ops/markets-model';
import { readMarkets } from '@/lib/trade-ops/reads';

/**
 * Liquidations: rungs, parked positions, nearest to liquidation, ADL pairs, what winners are owed and the insurance
 * fund, from svc-trade's operator reads. Read only: this room never starts, retries or overrides a liquidation.
 * `?market=<id>` narrows the desk to one futures market. Each read keeps its own state.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LiquidationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { session, config } = await requireFounderPage();
  const ctx = { session, config };
  const raw = (await searchParams).market;
  const market = typeof raw === 'string' && UUID.test(raw) ? raw : undefined;
  const [desk, markets] = await Promise.all([readLiquidations(ctx, market), readMarkets(ctx)]);

  const futures = markets.kind === 'ok' ? markets.data.filter((m) => m.kind === 'futures') : [];
  const assets = [...new Set(futures.map((m) => m.quote))];
  const insurance = await Promise.all(assets.map(async (asset) => ({ asset, history: await readInsuranceHistory(ctx, asset) })));
  const symbols = Object.fromEntries(markets.kind === 'ok' ? markets.data.map((m) => [m.id, m.symbol] as const) : []);

  const asOf = oldestAsOf([
    desk.kind === 'ok' ? desk.asOf : null,
    ...insurance.map((i) => (i.history.kind === 'ok' ? i.history.asOf : null)),
  ]);
  return (
    <DeskPage
      title="Liquidations"
      description="Liquidation steps, positions closest to liquidation, auto-deleveraging and the insurance fund. Read only."
      asOf={asOf}
      state={desk.kind === 'ok' ? 'live' : desk.kind}
      stateReason={desk.kind === 'ok' ? undefined : desk.kind === 'refused' ? desk.code : desk.message}
    >
      <div className="flex flex-col gap-4">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-fg-2">
            Market
            <select name="market" defaultValue={market ?? ''} className="h-8 border border-line bg-transparent px-2 text-sm text-fg">
              <option value="">All futures markets</option>
              {futures.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.symbol}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="h-8 border border-line px-3 text-sm text-fg hover:bg-surface-2">
            Show
          </button>
        </form>
        {markets.kind !== 'ok' ? (
          <p className="text-sm text-fg-2">
            The market list could not be read, so ids are shown instead of symbols and the insurance fund cannot be chosen.
          </p>
        ) : null}
        {desk.kind === 'ok' ? (
          <LiquidationsView desk={desk.data} insurance={insurance} symbols={symbols} />
        ) : (
          <ReadProblem outcome={desk} title="Liquidation desk not read" />
        )}
      </div>
    </DeskPage>
  );
}
