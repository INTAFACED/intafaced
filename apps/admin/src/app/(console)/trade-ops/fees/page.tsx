import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { FeesRoom } from '@/components/trade-ops/fees-room';
import { loadFeesDesk } from '@/lib/trade-ops/fees-calls';

/**
 * Fees and convert (J-cex-spot-17): fee versions by pair group and the two-person write of a new one, VIP thresholds and
 * snapshot runs, maker rebate tiers, the customer's fee-change notice, Convert's state and limits, and finance's read of
 * sell quotes and fiat buy fees. A schedule change moves no money: it prices orders placed after its stated time.
 */
export const dynamic = 'force-dynamic';

export default async function FeesPage() {
  const { session, config } = await requireFounderPage();
  const view = await loadFeesDesk({ session, config });
  const fees = view.fees;
  return (
    <DeskPage
      title="Fees and convert"
      description="Publish and version fees, VIP tiers and convert limits. A new version needs a second founder and takes effect at its stated time; an order already placed keeps its version."
      asOf={view.asOf}
      state={fees.kind === 'ok' ? 'live' : fees.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={fees.kind === 'ok' ? undefined : fees.kind === 'unknown' ? fees.message : fees.code}
    >
      <FeesRoom initial={view} />
    </DeskPage>
  );
}
