import Link from 'next/link';
import { EmptyState, PageSection } from '@/components/trade-ops/kit';
import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { HealthRefresh } from '@/components/trade-ops/health-refresh';
import { HaltVsDelist } from '@/components/trade-ops/markets-explainer';
import { LifecyclePanel } from '@/components/trade-ops/markets-lifecycle-panel';
import { MARKET_CONTROL_ACTIONS, MatchingControls } from '@/components/trade-ops/matching-controls';
import { MarketOrders } from '@/components/trade-ops/markets-orders';
import { MarketRules } from '@/components/trade-ops/markets-rules';
import { lifecycleLook, oldestAsOf } from '@/lib/trade-ops/markets-model';
import { readEffectiveFees, readLifecycle, readMarkets, readOpenOrders } from '@/lib/trade-ops/reads';
import { ORDER_READ_LIMIT } from '@/lib/trade-ops/markets-load';

/**
 * One market: its rules, lifecycle snapshot, the orders resting on it and the five actions.
 * The symbol is in the address with its "/" encoded (AUD%2FUSD). The three reads are independent: a refused
 * lifecycle read (or an unknown market) is shown in its own panel and the others still render.
 */
export const dynamic = 'force-dynamic';

function decodeSymbol(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default async function MarketDetailPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { session, config } = await requireFounderPage();
  const ctx = { session, config };
  const symbol = decodeSymbol((await params).symbol);
  const [markets, lifecycle, orders, fees] = await Promise.all([
    readMarkets(ctx),
    readLifecycle(ctx, symbol),
    readOpenOrders(ctx, ORDER_READ_LIMIT),
    readEffectiveFees(ctx),
  ]);

  const market = markets.kind === 'ok' ? (markets.data.find((m) => m.symbol === symbol) ?? null) : null;
  const here = orders.kind === 'ok' ? orders.data.filter((o) => o.symbol === symbol && o.status === 'open') : [];
  const reads = [markets, lifecycle, orders, fees];
  const asOf = oldestAsOf(reads.map((r) => (r.kind === 'ok' ? r.asOf : null)));
  const state = reads.some((r) => r.kind === 'refused') ? 'refused' : reads.some((r) => r.kind === 'unknown') ? 'unknown' : 'live';

  return (
    <DeskPage
      title={symbol}
      description="Rules, lifecycle state, resting orders and the actions that change this market."
      asOf={asOf}
      state={state}
      stateReason={state === 'live' ? undefined : 'Part of this market could not be read; see the panel that says so.'}
      actions={<HealthRefresh />}
    >
      <p className="text-sm">
        <Link
          href="/trade-ops/markets"
          className="text-fg-2 outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-lime"
        >
          ← All markets
        </Link>
      </p>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <PageSection title="Rules">
          {markets.kind !== 'ok' ? (
            <ReadProblem outcome={markets} title="Market rules could not be read" />
          ) : market ? (
            <MarketRules market={market} asOf={markets.asOf} fees={fees} />
          ) : (
            <EmptyState
              variant="refused"
              size="panel"
              title="Market not found"
              reason={`The market list has no market called ${symbol}.`}
              code="trade.market_not_found"
            />
          )}
        </PageSection>

        <PageSection title="Lifecycle">
          <LifecyclePanel lifecycle={lifecycle} />
        </PageSection>
      </div>

      <PageSection title={`Open orders on ${symbol}`}>
        {orders.kind !== 'ok' ? (
          <ReadProblem outcome={orders} title="Open orders could not be read" />
        ) : (
          <div className="flex flex-col gap-2">
            {here.length === 0 ? (
              <p className="text-sm text-fg-2">No open orders on this market in the {orders.data.length} open orders read.</p>
            ) : null}
            {orders.data.length >= ORDER_READ_LIMIT ? (
              <p className="text-xs text-warn">Only the first {ORDER_READ_LIMIT} open orders are read; more may exist.</p>
            ) : null}
            {here.length > 0 ? <MarketOrders orders={here} /> : null}
          </div>
        )}
      </PageSection>

      <PageSection title="Actions">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-2">
            Current lifecycle state:{' '}
            <span className="font-medium text-fg">{lifecycle.kind === 'ok' ? lifecycleLook(lifecycle.data.state).word : 'not known'}</span>.
            Every control needs a two-person approval: you propose, a different operator approves, then you run it.
          </p>
          {market ? (
            <MatchingControls actions={MARKET_CONTROL_ACTIONS} marketId={market.id} symbol={symbol} />
          ) : (
            <EmptyState
              variant="refused"
              size="panel"
              title="Controls are off: the market id is not known"
              reason="svc-matching knows a market by its id, which comes from the market list. That list could not be read, so no control can be sent."
              code={markets.kind === 'ok' ? 'trade.market_not_found' : markets.kind === 'refused' ? markets.code : 'no answer'}
            />
          )}
        </div>
      </PageSection>

      <PageSection title="Halt or delist">
        <HaltVsDelist />
      </PageSection>
    </DeskPage>
  );
}
