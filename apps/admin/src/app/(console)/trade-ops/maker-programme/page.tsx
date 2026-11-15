import { requireFounderPage } from '@/lib/founder-page';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { MakerProgrammeRoom } from '@/components/trade-ops/maker-programme-room';
import { readClawbacks, readMembers, readTerms } from '@/lib/trade-ops/maker-programme-calls';

/**
 * Maker programme (J-cex-spot-20 #8, RC-cex-spot-06): the programme's terms (tiers, rebates, obligations, cancel-to-fill
 * ceiling, clawback window, equal-access criteria) and its members, each a versioned two-person write, and the clawback
 * records, read only. Period settlement and payment are not connected.
 */
export const dynamic = 'force-dynamic';

export default async function MakerProgrammePage() {
  const { session, config } = await requireFounderPage();
  const ctx = { session, config };
  const [terms, members, clawbacks] = await Promise.all([readTerms(ctx), readMembers(ctx), readClawbacks(ctx)]);
  const failing = terms.kind !== 'ok' ? terms : members.kind !== 'ok' ? members : clawbacks.kind !== 'ok' ? clawbacks : null;
  return (
    <DeskPage
      title="Maker programme"
      description="Tiers, rebates and quoting obligations for market makers, the members, and clawback records. Terms and members need a second founder."
      asOf={terms.kind === 'ok' ? terms.asOf : null}
      state={failing ? (failing.kind === 'unknown' ? 'unknown' : 'refused') : 'live'}
      stateReason={failing ? (failing.kind === 'unknown' ? failing.message : failing.code) : undefined}
    >
      {terms.kind === 'ok' && members.kind === 'ok' && clawbacks.kind === 'ok' ? (
        <MakerProgrammeRoom terms={terms.data.terms} members={members.data} clawbacks={clawbacks.data} />
      ) : (
        <ReadProblem outcome={failing!} title="The maker programme could not be read" />
      )}
    </DeskPage>
  );
}
