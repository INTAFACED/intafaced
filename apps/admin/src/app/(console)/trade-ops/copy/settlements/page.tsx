import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { CopySettlements } from '@/components/trade-ops/copy-settlements';
import { readSettlements } from '@/lib/trade-ops/copy-settlements-calls';

export const dynamic = 'force-dynamic';

/**
 * Copy settlements (CB-ops-02, J-copy-bots-otc-11 #1 #2 #3): every lead fee share owed, "Settled" when its ledger posts
 * and the builder fee the venue reported for the fill agree with it, "Held" with its key and the reason otherwise, and a
 * reconcile of one chosen window. Read only: a held row is resolved by its owner, never from this page.
 */
export default async function CopySettlementsPage() {
  const { session, config } = await requireFounderPage();
  const read = await readSettlements({ session, config });
  return (
    <DeskPage
      title="Copy settlements"
      description="Lead fee shares against the ledger and the builder fee the venue reports for each fill. Read only."
      asOf={read.asOf}
      state={read.kind === 'ok' ? 'live' : read.kind}
      stateReason={read.kind === 'ok' ? undefined : read.kind === 'refused' ? read.code : read.message}
    >
      <CopySettlements read={read} />
    </DeskPage>
  );
}
