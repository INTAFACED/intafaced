import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { LaunchLiquidityRoom } from '@/components/trade-ops/launch-liquidity-room';
import { readMarketPlans, readMembers } from '@/lib/trade-ops/maker-programme-calls';

/**
 * Launch liquidity (J-cex-spot-20 #8, RC-cex-spot-09): one record per spot market, its latest launch-liquidity plan
 * (makers from the maker programme, capital per maker, spread, depth, uptime, inventory band and exit criteria) or "No
 * plan recorded". A plan version is a two-person write. Capital figures are plan records, not balances.
 */
export const dynamic = 'force-dynamic';

export default async function LaunchLiquidityPage() {
  const { session, config } = await requireFounderPage();
  const ctx = { session, config };
  const [plans, members] = await Promise.all([readMarketPlans(ctx), readMembers(ctx)]);
  const failing = plans.kind !== 'ok' ? plans : members.kind !== 'ok' ? members : null;
  return (
    <DeskPage
      title="Launch liquidity"
      description="The launch-liquidity plan per market: makers, capital, spread, depth, uptime, inventory band and exit criteria. A new version needs a second founder."
      asOf={plans.kind === 'ok' ? plans.asOf : null}
      state={failing ? (failing.kind === 'unknown' ? 'unknown' : 'refused') : 'live'}
      stateReason={failing ? (failing.kind === 'unknown' ? failing.message : failing.code) : undefined}
    >
      {plans.kind === 'ok' && members.kind === 'ok' ? (
        <LaunchLiquidityRoom markets={plans.data} members={members.data} />
      ) : (
        <ReadProblem outcome={failing!} title="The launch-liquidity plans could not be read" />
      )}
    </DeskPage>
  );
}
