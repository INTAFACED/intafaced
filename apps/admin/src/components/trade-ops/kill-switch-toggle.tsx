'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Field, Input } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import { checkToggle, toggleConsequence } from '@/lib/trade-ops/kill-switch-model';
import { ConfirmAction } from './confirm-action';

/**
 * Stop or resume the trade module. Three extra fields sit beside the confirm dialog because the edge needs them:
 * the confirming operator (a different person than you), and the id of an identity approval with its operation id.
 * The edge records the confirmer from the approval, not from the typed name, so the typed name is only checked
 * for "not you". The dialog asks for the reason and sends once; the page is re-read after a confirmed answer.
 */
export function KillSwitchToggle({ stopped, signedInUserId }: { stopped: boolean; signedInUserId: string }) {
  const router = useRouter();
  const [confirmOperatorId, setConfirm] = useState('');
  const [approvalId, setApproval] = useState('');
  const [operationId, setOperation] = useState('');
  const [touched, setTouched] = useState(false);

  const probe = checkToggle({ disabled: !stopped, reason: 'x'.repeat(12), confirmOperatorId, approvalId, operationId }, signedInUserId);
  const problem = probe.ok ? null : probe;
  const fieldError = (codes: string[]) => (touched && problem && codes.includes(problem.code) ? problem.message : undefined);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-2">
        Two people are needed. Another operator creates the approval in Freezes &amp; approvals; paste its ids here. A typed-in name alone
        is not approval.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Confirming operator id" hint="Not your own id." density="dense" error={fieldError(['missing_operator'])}>
          <Input
            value={confirmOperatorId}
            onValueChange={(v) => {
              setConfirm(v);
              setTouched(true);
            }}
            density="dense"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Approval id" hint="From the identity approval." density="dense" error={fieldError(['action_approval.missing'])}>
          <Input
            value={approvalId}
            onValueChange={(v) => {
              setApproval(v);
              setTouched(true);
            }}
            density="dense"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Operation id" hint="The approval's operation id." density="dense">
          <Input
            value={operationId}
            onValueChange={(v) => {
              setOperation(v);
              setTouched(true);
            }}
            density="dense"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      </div>
      <div>
        <ConfirmAction
          trigger={stopped ? 'Resume trade module' : 'Stop trade module'}
          title={stopped ? 'Resume the trade module?' : 'Stop the trade module?'}
          consequence={toggleConsequence(!stopped)}
          confirmLabel={stopped ? 'Resume trade module' : 'Stop trade module'}
          tone={stopped ? 'default' : 'danger'}
          reasonMin={12}
          disabled={problem !== null}
          disabledReason={problem?.message}
          run={(reason) =>
            tradeOpsAction('kill-switch', { action: 'toggle', disabled: !stopped, reason, confirmOperatorId, approvalId, operationId })
          }
          onDone={(outcome) => {
            if (outcome.kind === 'ok') router.refresh();
          }}
        />
      </div>
    </div>
  );
}
