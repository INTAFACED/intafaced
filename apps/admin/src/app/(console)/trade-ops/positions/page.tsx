import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { PositionsBoard } from '@/components/trade-ops/positions-board';

/** Positions room: lookup form and table are built; the read is refused until svc-trade offers an operator lookup. */
export const dynamic = 'force-dynamic';

export default async function PositionsPage() {
  // No operator read exists yet, so the session is only checked, not used for a call.
  const { session, config } = await requireFounderPage();
  const ctx = { session, config };
  void ctx;
  return (
    <DeskPage
      title="Positions"
      description="Look up a user's positions, margin ratio and liquidation state."
      state="refused"
      stateReason="positions_cross_user_missing: positions are readable only by their owner"
    >
      <PositionsBoard />
    </DeskPage>
  );
}
