import { PageSection } from '@intafaced/ui';
import { requireFounderPage } from '@/lib/founder-page';
import { BlockerPanel } from '@/components/trade-ops/blocker-panel';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { SurveillanceCases } from '@/components/trade-ops/surveillance-cases';
import { LAW, readCasesOutcome } from '@/lib/trade-ops/surveillance-model';

/**
 * Surveillance room: spoofing and layering cases. The case store is not routed to operators, so the list shows the
 * blocker in place of rows (never an empty table that reads as "no cases"). The decision form is built.
 */
export const dynamic = 'force-dynamic';

export default async function SurveillancePage() {
  await requireFounderPage();
  const read = readCasesOutcome();
  const blocker = read.kind === 'refused' ? read.blocker : null;

  return (
    <DeskPage
      title="Surveillance"
      description="Review spoofing and layering cases and record a human decision."
      asOf={read.asOf}
      state="refused"
      stateReason={read.kind === 'refused' ? read.code : undefined}
    >
      <div className="flex flex-col gap-6">
        <p className="text-sm text-fg-2">{LAW}</p>
        <PageSection title="Cases">
          <SurveillanceCases
            cases={[]}
            unreadable={blocker ? <BlockerPanel blocker={blocker} title="Cases cannot be read, so none are shown" size="inline" /> : null}
          />
        </PageSection>
      </div>
    </DeskPage>
  );
}
