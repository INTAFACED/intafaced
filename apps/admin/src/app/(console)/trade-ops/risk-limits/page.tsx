import { PageSection } from '@/components/trade-ops/kit';
import { requireFounderPage } from '@/lib/founder-page';
import { BlockerPanel, ReadProblem } from '@/components/trade-ops/blocker-panel';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { FeeScheduleNote } from '@/components/trade-ops/fee-schedule-note';
import { RiskLimitsChecks } from '@/components/trade-ops/risk-limits-checks';
import { RiskLimitsEdit } from '@/components/trade-ops/risk-limits-edit';
import { RiskLimitsTable } from '@/components/trade-ops/risk-limits-table';
import { BLOCKERS } from '@/lib/trade-ops/blockers';
import { readEffectiveFees, readMarkets } from '@/lib/trade-ops/reads';
import { FUTURES_NOTE } from '@/lib/trade-ops/risk-limits-model';

/** Risk limits room: the market rules the desk can read, the operator limits svc-trade enforces (read and change with a two-person approval), and a built (blocked) edit form for market rules. */
export const dynamic = 'force-dynamic';

export default async function RiskLimitsPage() {
  const { session, config } = await requireFounderPage();
  const ctx = { session, config };
  const [markets, fees] = await Promise.all([readMarkets(ctx), readEffectiveFees(ctx)]);

  return (
    <DeskPage
      title="Risk limits"
      description="What the engine enforces on each market. Changing an operator limit needs a second founder and an audit."
      asOf={markets.asOf}
      state={markets.kind === 'ok' ? 'live' : markets.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={markets.kind === 'ok' ? undefined : markets.kind === 'unknown' ? markets.message : markets.code}
    >
      <div className="flex flex-col gap-6">
        <PageSection title="Limits per market (readable)">
          {markets.kind === 'ok' ? (
            <div className="flex flex-col gap-3">
              <FeeScheduleNote fees={fees} />
              <RiskLimitsTable markets={markets.data} fees={fees} />
            </div>
          ) : (
            <ReadProblem outcome={markets} title="Market limits not read" />
          )}
        </PageSection>
        <PageSection title="Operator limits (engine-side checks)">
          {markets.kind === 'ok' && markets.data.length > 0 ? (
            <RiskLimitsChecks markets={markets.data} />
          ) : (
            <p className="text-sm text-fg-2">The limits need the market list above, which could not be read.</p>
          )}
        </PageSection>
        <PageSection title="Change a market rule">
          <div className="flex flex-col gap-3">
            <BlockerPanel blocker={BLOCKERS.market_rules_no_operator_api} title="No operator write exists for market rules" size="inline" />
            {markets.kind === 'ok' && markets.data.length > 0 ? (
              <RiskLimitsEdit markets={markets.data} signedInUserId={session.userId} />
            ) : (
              <p className="text-sm text-fg-2">The form needs the market list above, which could not be read.</p>
            )}
          </div>
        </PageSection>
        <PageSection title="Futures">
          <p className="text-sm text-fg-2">{FUTURES_NOTE}</p>
        </PageSection>
      </div>
    </DeskPage>
  );
}
