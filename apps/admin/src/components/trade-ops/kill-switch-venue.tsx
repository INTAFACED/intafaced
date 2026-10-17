'use client';

import { useState } from 'react';
import { Field, Input } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import { checkVenue } from '@/lib/trade-ops/kill-switch-model';
import { ConfirmAction } from './confirm-action';

/**
 * Venue halt-all / resume-all (matching). Fully built with its two-person field; today the console answers with the
 * typed blocker matching_not_routed, because svc-edge has no route an operator session can use. Nothing is halted.
 */
export function KillSwitchVenue({ signedInUserId }: { signedInUserId: string }) {
  const [confirmOperatorId, setConfirm] = useState('');
  const probe = (action: 'halt_all' | 'resume_all') => checkVenue({ action, reason: 'x'.repeat(12), confirmOperatorId }, signedInUserId);
  const bad = probe('halt_all');
  const problem = bad.ok ? null : bad;
  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Confirming operator id"
        hint="A different operator than you."
        density="dense"
        error={confirmOperatorId !== '' && problem ? problem.message : undefined}
      >
        <Input value={confirmOperatorId} onValueChange={setConfirm} density="dense" autoComplete="off" spellCheck={false} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <ConfirmAction
          trigger="Halt all markets"
          title="Halt every market on the venue?"
          consequence="Matching stops for all markets at once. This is separate from the trade module switch above."
          confirmLabel="Halt all markets"
          tone="danger"
          disabled={problem !== null}
          disabledReason={problem?.message}
          run={(reason) => tradeOpsAction('kill-switch', { action: 'halt_all', reason, confirmOperatorId })}
        />
        <ConfirmAction
          trigger="Resume all markets"
          title="Resume every market on the venue?"
          consequence="Each market returns to the state its lifecycle allows."
          confirmLabel="Resume all markets"
          disabled={problem !== null}
          disabledReason={problem?.message}
          run={(reason) => tradeOpsAction('kill-switch', { action: 'resume_all', reason, confirmOperatorId })}
        />
      </div>
    </div>
  );
}
