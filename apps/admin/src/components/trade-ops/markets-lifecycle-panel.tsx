import { KeyValue } from '@intafaced/ui';
import { lifecycleLook } from '@/lib/trade-ops/markets-model';
import type { Outcome } from '@/lib/trade-ops/outcome';
import type { LifecycleRow } from '@/lib/trade-ops/reads';
import { ReadProblem } from './blocker-panel';
import { LifecycleBadge } from './markets-lifecycle-badge';

/**
 * The market's lifecycle snapshot from the lifecycle authority: state, why, since when, the last good state, what is
 * allowed and the transition id. If the authority refuses (for example trade.lifecycle_authority_unavailable) the
 * refusal is shown here, in this panel only, with its own code.
 */
export function LifecyclePanel({ lifecycle }: { lifecycle: Outcome<LifecycleRow> }) {
  if (lifecycle.kind !== 'ok') return <ReadProblem outcome={lifecycle} title="Lifecycle state could not be read" />;
  const l = lifecycle.data;
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-2 text-sm text-fg-2">
        State: <LifecycleBadge lifecycle={lifecycle} />
      </p>
      <KeyValue
        density="dense"
        items={[
          { label: 'State', value: lifecycleLook(l.state).word },
          { label: 'Reason category', value: l.reasonCategory },
          { label: 'Reason code', value: l.reasonCode, mono: true },
          { label: 'Effective at', value: l.effectiveAt, mono: true },
          { label: 'Observed at', value: l.observedAt, mono: true, asOf: lifecycle.asOf },
          { label: 'Last good state', value: l.lastGoodState ? lifecycleLook(l.lastGoodState).word : null },
          { label: 'Allowed actions', value: l.allowedActions.length ? l.allowedActions.join(', ') : 'none' },
          { label: 'Transition id', value: l.transitionId, mono: true },
        ]}
      />
    </div>
  );
}
