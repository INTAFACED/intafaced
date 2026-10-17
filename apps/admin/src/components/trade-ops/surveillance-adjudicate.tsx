'use client';

import { useEffect, useState } from 'react';
import { Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import { DECISIONS, LAW, checkAdjudication, type Decision } from '@/lib/trade-ops/surveillance-model';
import { ConfirmAction } from './confirm-action';

/**
 * A human decision on one case. There is no sanction or fine field on purpose, and nothing here decides for the
 * operator. Today the console answers with the typed blocker surveillance_not_routed; no decision is recorded.
 */
export function SurveillanceAdjudicate({ caseId: selectedId }: { caseId: string }) {
  const [caseId, setCaseId] = useState(selectedId);
  const [decision, setDecision] = useState<Decision | ''>('');
  const [rationale, setRationale] = useState('');
  useEffect(() => setCaseId(selectedId), [selectedId]);
  const check = checkAdjudication({ caseId, decision, rationale });
  const problem = check.ok ? null : check;
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      <p className="text-sm text-fg-2">{LAW}</p>
      <Field label="Case id" density="dense">
        <Input value={caseId} onValueChange={setCaseId} density="dense" autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Decision" density="dense">
        <Select
          items={Object.fromEntries(DECISIONS.map((d) => [d.value, d.label]))}
          value={decision || null}
          onValueChange={(v) => setDecision(DECISIONS.find((d) => d.value === v)?.value ?? '')}
        >
          <SelectTrigger size={32}>
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
          <SelectContent>
            {DECISIONS.map((d) => (
              <SelectItem key={d.value} value={d.value}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Rationale" hint="At least 12 characters; kept with the decision." density="dense">
        <Input value={rationale} onValueChange={setRationale} density="dense" />
      </Field>
      <div>
        <ConfirmAction
          trigger="Record decision"
          title="Record this decision?"
          consequence="You are recording your own decision on this case. Nothing is decided automatically and no sanction or fine is set by this desk."
          confirmLabel="Record decision"
          reasonMin={0}
          disabled={problem !== null}
          disabledReason={problem?.message}
          run={() => tradeOpsAction('surveillance', { action: 'adjudicate', caseId, decision, rationale })}
        />
      </div>
    </div>
  );
}
