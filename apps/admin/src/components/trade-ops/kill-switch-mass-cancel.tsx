'use client';

import { useState } from 'react';
import { Field, Input, SegmentedControl } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import { checkMassCancel } from '@/lib/trade-ops/kill-switch-model';
import { ConfirmAction } from './confirm-action';

/**
 * Mass cancel of resting orders by market or by account. Fully built and checked; today the console answers with the
 * typed blocker mass_cancel_operator_missing, because the service has no operator-scoped cancel. Nothing is cancelled.
 */
export function KillSwitchMassCancel({ signedInUserId }: { signedInUserId: string }) {
  const [scope, setScope] = useState<'market' | 'account'>('market');
  const [target, setTarget] = useState('');
  const [confirmOperatorId, setConfirm] = useState('');
  const check = checkMassCancel({ scope, target, reason: 'x'.repeat(12), confirmOperatorId }, signedInUserId);
  const problem = check.ok ? null : check;
  const shown = (target !== '' || confirmOperatorId !== '') && problem ? problem.message : undefined;
  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        aria-label="Cancel by"
        size={28}
        value={scope}
        onValueChange={(v) => {
          setScope(v === 'account' ? 'account' : 'market');
          setTarget('');
        }}
        items={[
          { value: 'market', label: 'By market' },
          { value: 'account', label: 'By account' },
        ]}
      />
      <div className="grid gap-3 md:grid-cols-2">
        <Field
          label={scope === 'market' ? 'Market' : 'Account (user id)'}
          hint={scope === 'market' ? 'For example BTC/USDT.' : 'The account’s user id.'}
          density="dense"
        >
          <Input value={target} onValueChange={setTarget} density="dense" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Confirming operator id" hint="A different operator than you." density="dense" error={shown}>
          <Input value={confirmOperatorId} onValueChange={setConfirm} density="dense" autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      <div>
        <ConfirmAction
          trigger="Cancel all resting orders"
          title={
            scope === 'market'
              ? `Cancel every resting order on ${target || 'this market'}?`
              : 'Cancel every resting order for this account?'
          }
          consequence="Every resting order in scope is cancelled and its held funds are released. Fills that already happened stay."
          confirmLabel="Cancel orders"
          tone="danger"
          disabled={problem !== null}
          disabledReason={problem?.message}
          run={(reason) => tradeOpsAction('kill-switch', { action: 'mass_cancel', scope, target, reason, confirmOperatorId })}
        />
      </div>
    </div>
  );
}
