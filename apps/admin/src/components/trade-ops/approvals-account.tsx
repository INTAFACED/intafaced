import { Badge, KeyValue } from '@intafaced/ui';
import type { AccountControlState } from '@intafaced/contracts';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { historyRows, stateWords } from '@/lib/trade-ops/restrictions';
import type { AccountControlResult } from '@intafaced/contracts';
import { ReadProblem } from './blocker-panel';
import { ApprovalsHistory } from './approvals-history';

/** Panel (a): what the service says about one account right now, and its restriction history. Each half has its own state. */
export function ApprovalsAccount(props: {
  userId: string;
  state: Outcome<{ readonly state: AccountControlState | null }>;
  history: Outcome<readonly AccountControlResult[]>;
}) {
  const { state, history } = props;
  return (
    <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
      <section aria-label="Current restriction" className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-fg">Current state</h3>
        {state.kind !== 'ok' ? (
          <ReadProblem outcome={state} title="Restriction state not read" />
        ) : state.data.state === null ? (
          <p className="text-sm text-fg-2">The service has no trading account for this user id. Check the id.</p>
        ) : (
          <>
            <p className="flex items-center gap-2 text-sm">
              <Badge tone={state.data.state.restricted ? 'error' : 'neutral'} density="dense">
                {state.data.state.restricted ? 'Restricted' : 'Not restricted'}
              </Badge>
              <span className="text-fg-2">{stateWords(state.data.state)}</span>
            </p>
            <KeyValue
              density="dense"
              items={[
                { label: 'User id', value: props.userId, mono: true },
                {
                  label: 'Version',
                  value: state.data.state.version,
                  mono: true,
                  hint: 'Use this as the expected version when you propose a change.',
                },
                { label: 'Read at', value: `${state.asOf.slice(11, 19)} UTC` },
              ]}
            />
          </>
        )}
      </section>
      <section aria-label="Restriction history" className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-medium text-fg">History</h3>
        {history.kind !== 'ok' ? (
          <ReadProblem outcome={history} title="Restriction history not read" />
        ) : (
          <ApprovalsHistory rows={historyRows(history.data)} />
        )}
      </section>
    </div>
  );
}
