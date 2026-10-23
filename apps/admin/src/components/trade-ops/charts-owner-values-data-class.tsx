'use client';

import { useState } from 'react';
import { Button, Field, Input, KeyValue, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@intafaced/ui';
import type { ActionApproval } from '@intafaced/contracts';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import {
  CHART_DATA_CLASSES,
  DATA_CLASS_LABEL,
  READ_ONLY_TEXT,
  dataClassText,
  reasonReady,
  type ChartDataClass,
  type ChartDataClassRow,
  type ChartOwnerValuesView,
} from '@/lib/trade-ops/charts-owner-values-model';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { ConfirmAction } from './confirm-action';
import { OutcomeNotice } from './outcome-notice';

/**
 * The data class of one market: real time, delayed or end of day. A change needs a second founder: file the request,
 * a different founder approves it in the Approvals room, then apply it with the approval id. The page shows the payload
 * hash the approver confirms; the service refuses an approval bound to other values, and a stale version.
 */

const NOT_SET = 'not_set';
type Choice = typeof NOT_SET | ChartDataClass;
const CHOICES: readonly Choice[] = [NOT_SET, ...CHART_DATA_CLASSES];
const CHOICE_LABEL: Readonly<Record<Choice, string>> = { not_set: 'Not set', ...DATA_CLASS_LABEL };

export function ChartDataClassPanel({ view, onChanged }: { view: ChartOwnerValuesView; onChanged: (next: ChartOwnerValuesView) => void }) {
  const rows = view.dataClasses;
  const [symbol, setSymbol] = useState(rows[0]?.symbol ?? '');
  const [choice, setChoice] = useState<Choice>(NOT_SET);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposed, setProposed] = useState<Outcome<ActionApproval> | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [approvalId, setApprovalId] = useState('');

  const row: ChartDataClassRow | null = rows.find((r) => r.symbol === symbol) ?? null;
  const expectedVersion = row?.version ?? '0';
  const dataClass: ChartDataClass | null = choice === NOT_SET ? null : choice;
  const readOnly = !view.canWrite;
  const writeBlocked = readOnly || row === null || !reasonReady(reason);
  const body = () => ({ symbol, dataClass, expectedVersion, reason: reason.trim() });

  if (rows.length === 0) {
    return <p className="text-sm text-fg-2">No markets are listed, so there is no data class to set.</p>;
  }

  async function propose() {
    setBusy(true);
    setHash(null);
    const h = await tradeOpsAction<{ payloadHash: string }>('charts-settings', { action: 'hash', ...body() });
    if (h.kind === 'ok') setHash(h.data.payloadHash);
    setProposed(h.kind === 'ok' ? await tradeOpsAction<ActionApproval>('charts-settings', { action: 'propose', ...body() }) : h);
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-4">
      {readOnly ? <p className="text-sm text-fg-2">{READ_ONLY_TEXT}</p> : null}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Market" density="dense">
          <Select
            items={Object.fromEntries(rows.map((r) => [r.symbol, r.symbol]))}
            value={symbol}
            onValueChange={(v) => {
              setSymbol(String(v));
              setProposed(null);
              setHash(null);
            }}
          >
            <SelectTrigger size={32}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {rows.map((r) => (
                <SelectItem key={r.symbol} value={r.symbol}>
                  {r.symbol}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <span className="text-sm text-fg-2">
          Now: <span className="text-fg">{dataClassText(row?.dataClass ?? null)}</span>
          {row?.version ? <span className="if-num"> (version {row.version})</span> : null}
        </span>
        <Field label="New data class" density="dense">
          <Select
            items={Object.fromEntries(CHOICES.map((c) => [c, CHOICE_LABEL[c]]))}
            value={choice}
            onValueChange={(v) => {
              if (CHOICES.includes(v as Choice)) setChoice(v as Choice);
            }}
            disabled={readOnly}
          >
            <SelectTrigger size={32}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHOICES.map((c) => (
                <SelectItem key={c} value={c}>
                  {CHOICE_LABEL[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field label="Reason (12 to 500 characters, kept in the audit)" density="dense">
        <Input value={reason} onValueChange={setReason} density="dense" autoComplete="off" disabled={readOnly} />
      </Field>
      <div>
        <Button
          size={32}
          variant="primary"
          shape="rounded"
          loading={busy}
          disabled={writeBlocked}
          title={readOnly ? READ_ONLY_TEXT : undefined}
          onClick={() => void propose()}
        >
          Ask a second founder to approve
        </Button>
      </div>
      {proposed ? <OutcomeNotice outcome={proposed} doneText="Request filed" /> : null}
      {proposed?.kind === 'ok' ? (
        <KeyValue
          density="dense"
          items={[
            { label: 'Approval id (apply with this once approved)', value: proposed.data.approvalId, mono: true },
            { label: 'Payload hash (the approver confirms this)', value: hash, mono: true },
            { label: 'Bound to version', value: proposed.data.expectedVersion },
          ]}
        />
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Approved request id" density="dense">
          <Input
            value={approvalId}
            onValueChange={setApprovalId}
            density="dense"
            autoComplete="off"
            spellCheck={false}
            disabled={readOnly}
          />
        </Field>
        <ConfirmAction
          trigger="Apply the approved change"
          title={`Change the data class of ${symbol}?`}
          consequence={`The data class of ${symbol} changes from ${dataClassText(row?.dataClass ?? null)} to ${CHOICE_LABEL[choice]}. The approval is used up.`}
          confirmLabel="Apply change"
          reasonMin={0}
          disabled={writeBlocked || approvalId.trim() === ''}
          disabledReason={readOnly ? READ_ONLY_TEXT : 'Enter the reason and the approved request id.'}
          run={() => tradeOpsAction('charts-settings', { action: 'apply', ...body(), approvalId: approvalId.trim() })}
          onDone={(o) => {
            if (o.kind === 'ok') onChanged(o.data as ChartOwnerValuesView);
          }}
        />
      </div>
    </div>
  );
}
