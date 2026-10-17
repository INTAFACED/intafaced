import { Badge, KeyValue, PageSection } from '@/components/trade-ops/kit';
import { requireFounderPage } from '@/lib/founder-page';
import { KillSwitchAudit } from '@/components/trade-ops/kill-switch-audit';
import { KillSwitchExplainer } from '@/components/trade-ops/kill-switch-explainer';
import { KillSwitchMassCancel } from '@/components/trade-ops/kill-switch-mass-cancel';
import { KillSwitchToggle } from '@/components/trade-ops/kill-switch-toggle';
import { KillSwitchVenue } from '@/components/trade-ops/kill-switch-venue';
import { BlockerPanel, ReadProblem } from '@/components/trade-ops/blocker-panel';
import { DeskPage } from '@/components/trade-ops/desk-page';
import { tradeAudit, tradeSwitchState, MASS_CANCEL_TODAY } from '@/lib/trade-ops/kill-switch-model';
import { BLOCKERS } from '@/lib/trade-ops/blockers';
import { readKillSwitchSnapshot } from '@/lib/trade-ops/reads';

/** Kill switch room: stop or resume new trade orders for the whole module, with two people; venue halt and mass cancel are built but blocked. */
export const dynamic = 'force-dynamic';

export default async function KillSwitchPage() {
  const { session, config } = await requireFounderPage();
  const ctx = { session, config };
  const snapshot = await readKillSwitchSnapshot(ctx);
  const state = snapshot.kind === 'ok' ? tradeSwitchState(snapshot.data) : null;

  return (
    <DeskPage
      title="Kill switch"
      description="Stop new trade orders for the whole module and bring them back. Two people are needed for every change."
      asOf={snapshot.asOf}
      state={snapshot.kind === 'ok' ? 'live' : snapshot.kind === 'unknown' ? 'unknown' : 'refused'}
      stateReason={snapshot.kind === 'ok' ? undefined : snapshot.kind === 'unknown' ? snapshot.message : snapshot.code}
    >
      <div className="flex flex-col gap-6">
        <PageSection title="Trade module">
          {snapshot.kind !== 'ok' ? (
            <ReadProblem outcome={snapshot} title="Kill switch state not read" />
          ) : (
            state && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone={state.stopped ? 'warn' : 'lime'} density="dense">
                    {state.stopped ? 'Stopped' : 'Open'}
                  </Badge>
                  <span className="text-sm text-fg-2">
                    {state.stopped
                      ? 'New trade orders are refused with edge.module_killed (503), the expected state while stopped. Cancels and reads still pass.'
                      : 'The edge is accepting new trade orders.'}
                  </span>
                </div>
                <KeyValue
                  density="dense"
                  items={[
                    { label: 'State', value: state.stopped ? 'Stopped' : 'Open' },
                    { label: 'Reason', value: state.stopped ? state.reason || null : null },
                    {
                      label: 'Since (UTC)',
                      value: state.since ? state.since.replace('T', ' ').slice(0, 19) : null,
                      hint: 'From the newest audit entry that changed this state.',
                    },
                    { label: 'Changed by', value: state.by, mono: true },
                    { label: 'Confirmed by', value: state.confirmedBy, mono: true },
                  ]}
                />
                <KillSwitchToggle stopped={state.stopped} signedInUserId={session.userId} />
              </div>
            )
          )}
        </PageSection>

        <PageSection title="Audit (trade module, newest first)">
          {snapshot.kind === 'ok' ? (
            <KillSwitchAudit entries={tradeAudit(snapshot.data)} />
          ) : (
            <ReadProblem outcome={snapshot} title="Audit not read" />
          )}
        </PageSection>

        <div className="grid gap-6 lg:grid-cols-2">
          <PageSection title="Venue halt all / resume all">
            <div className="flex flex-col gap-3">
              <BlockerPanel blocker={BLOCKERS.matching_not_routed} title="Not routed to operators" size="inline" />
              <KillSwitchVenue signedInUserId={session.userId} />
            </div>
          </PageSection>
          <PageSection title="Mass cancel">
            <div className="flex flex-col gap-3">
              <BlockerPanel blocker={BLOCKERS.mass_cancel_operator_missing} title="No operator cancel exists" size="inline" />
              <p className="text-sm text-fg-2">{MASS_CANCEL_TODAY}</p>
              <KillSwitchMassCancel signedInUserId={session.userId} />
            </div>
          </PageSection>
        </div>

        <PageSection title="What each switch does not do">
          <KillSwitchExplainer />
        </PageSection>
      </div>
    </DeskPage>
  );
}
