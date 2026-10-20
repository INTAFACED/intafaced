import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { PositionsBoard } from '@/components/trade-ops/positions-board';

/** Positions room: lookup by user id or position id through svc-trade's operator read; every lookup is audited by the service. */
export const dynamic = 'force-dynamic';

export default async function PositionsPage() {
  await requireFounderPage();
  return (
    <DeskPage title="Positions" description="Look up a user's positions, their size, entry price and status. Every lookup is audited.">
      <PositionsBoard />
    </DeskPage>
  );
}
