'use client';

import { useState } from 'react';
import { Button, Field, Input, SegmentedControl } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { OutcomeNotice } from './outcome-notice';

const KINDS = [
  { value: 'fills', label: 'Fills' },
  { value: 'positions', label: 'Positions' },
  { value: 'order_history', label: 'Order history' },
];

/**
 * The full request form for a server-side export of fills, positions or order history over a date range.
 * The back end has no such export (blocker export_missing), so sending this returns the named refusal, never a file.
 */
export function ExportsServerForm() {
  const [dataset, setDataset] = useState('fills');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Outcome<unknown> | null>(null);

  async function send() {
    setBusy(true);
    setResult(await tradeOpsAction('exports', { action: 'server_export', dataset, userId, from, to }));
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl aria-label="Server-side dataset" size={32} value={dataset} onValueChange={setDataset} items={KINDS} />
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Account user id (optional)" density="dense">
          <Input value={userId} onValueChange={setUserId} density="dense" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="From (date)" hint="YYYY-MM-DD" density="dense">
          <Input value={from} onValueChange={setFrom} density="dense" placeholder="2026-10-01" autoComplete="off" />
        </Field>
        <Field label="To (date)" hint="YYYY-MM-DD" density="dense">
          <Input value={to} onValueChange={setTo} density="dense" placeholder="2026-10-17" autoComplete="off" />
        </Field>
      </div>
      <div>
        <Button type="button" variant="secondary" shape="rounded" size={32} loading={busy} onClick={send}>
          Request export
        </Button>
      </div>
      {result ? <OutcomeNotice outcome={result} /> : null}
    </div>
  );
}
