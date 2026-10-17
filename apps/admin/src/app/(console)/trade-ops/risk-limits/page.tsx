import { PageSection } from '@intafaced/ui';
import { requireFounderPage } from '@/lib/founder-page';
import { BlockerPanel, ReadProblem } from '@/components/trade-ops/blocker-panel';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { RiskLimitsChecks } from '@/components/trade-ops/risk-limits-checks';
import { RiskLimitsEdit } from '@/components/trade-ops/risk-limits-edit';
import { RiskLimitsTable } from '@/components/trade-ops/risk-limits-table';
import { BLOCKERS } from '@/lib/trade-ops/blockers';
import { readMarkets } from '@/lib/trade-ops/reads';
import { FUTURES_NOTE } from '@/lib/trade-ops/risk-limits-model';

/** Risk limits room: the limits the desk can read per market, the engine checks it cannot read, and a built (blocked) edit form. */
export const dynamic = 'force-dynamic';

export default async function RiskLimitsPage() {
  const { session, config } = await requireFounderPage();
  const ctx = { session, config };
  const markets = await readMarkets(ctx);

  return (
    <DeskPage
      title="Risk limits"
      description="What the engine enforces on each market. Changing a limit needs two people and an audit."
      asOf={markets.asOf}
      state={markets.kind === 'ok' ? 'live' : markets.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={markets.kind === 'ok' ? undefined : markets.kind === 'unknown' ? markets.message : markets.code}
    >
      <div className="flex flex-col gap-6">
        <PageSection title="Limits per market (readable)">
          {markets.kind === 'ok' ? (
            <RiskLimitsTable markets={markets.data} />
          ) : (
            <ReadProblem outcome={markets} title="Market limits not read" />
          )}
        </PageSection>
        <PageSection title="Engine-side checks">
          <RiskLimitsChecks />
        </PageSection>
        <PageSection title="Change a limit">
          <div className="flex flex-col gap-3">
            <BlockerPanel blocker={BLOCKERS.risk_limits_no_operator_api} title="No operator write exists" size="inline" />
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
