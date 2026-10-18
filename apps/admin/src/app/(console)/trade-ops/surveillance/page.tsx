import { PageSection } from '@/components/trade-ops/kit';
import { requireFounderPage } from '@/lib/founder-page';
import { ReadProblem } from '@/components/trade-ops/blocker-panel';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { SurveillanceCases } from '@/components/trade-ops/surveillance-cases';
import { readSurveillanceCases } from '@/lib/trade-ops/matching-edge';
import { LAW } from '@/lib/trade-ops/surveillance-model';

/**
 * Surveillance room: open cases and the spoofing / layering detector state, read from svc-matching through svc-edge. A detector
 * that is off (today both are, detector_gap) is named above the table, and an empty list then does not read as "no abuse". When the read does not
 * come back (matching unconfigured, upstream error, no answer) the service's own refusal is drawn in place of rows, never
 * an empty table that reads as "no cases". Recording a decision stays refused: svc-edge exposes no adjudicate route.
 */
export const dynamic = 'force-dynamic';

export default async function SurveillancePage() {
  const { session, config } = await requireFounderPage();
  const read = await readSurveillanceCases({ session, config });

  return (
    <DeskPage
      title="Surveillance"
      description="Open cases from the matching engine, and whether its spoofing and layering detectors are running. A person decides every case."
      asOf={read.kind === 'ok' ? read.asOf : null}
      state={read.kind === 'ok' ? 'live' : read.kind}
      stateReason={read.kind === 'ok' ? undefined : read.kind === 'refused' ? read.code : 'no answer'}
    >
      <div className="flex flex-col gap-6">
        <p className="text-sm text-fg-2">{LAW}</p>
        <PageSection title="Cases">
          {read.kind === 'ok' && read.data.cases.length >= read.data.limit ? (
            <p className="mb-2 text-xs text-warn">Only the first {read.data.limit} open cases are read; more may exist.</p>
          ) : null}
          <SurveillanceCases
            cases={read.kind === 'ok' ? read.data.cases : []}
            unreadable={read.kind === 'ok' ? null : <ReadProblem outcome={read} title="Cases cannot be read, so none are shown" />}
            noCases={read.kind === 'ok' && read.data.cases.length === 0}
            detectors={read.kind === 'ok' ? read.data.detectors : undefined}
          />
        </PageSection>
      </div>
    </DeskPage>
  );
}
