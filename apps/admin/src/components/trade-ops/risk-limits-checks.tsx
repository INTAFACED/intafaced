'use client';

import { useState } from 'react';
import {
  Badge,
  Button,
  Field,
  Input,
  KeyValue,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  type TableColumn,
} from '@intafaced/ui';
import type { ActionApproval } from '@intafaced/contracts';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import type { RiskCurrent, RiskVersionRow } from '@/lib/trade-ops/desk-parse';
import type { MarketRow } from '@/lib/trade-ops/reads';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { checkRiskSet, ENGINE_CHECKS, limitText, type EngineCheck, type OperatorLimitField } from '@/lib/trade-ops/risk-limits-model';
import { ConfirmAction } from './confirm-action';
import { OutcomeNotice } from './outcome-notice';

/**
 * The operator limits svc-trade enforces on the order path, per market: read the current values and every earlier
 * version, then change them with a two-person approval. Reading is audited by the service. A blank limit is unset and
 * does nothing; the desk never fills one in.
 *
 * Changing: (1) propose, which files a request bound to the exact values; (2) a second founder approves it in the
 * Approvals room; (3) apply with the approval id. The service refuses a stale version or an approval for other values.
 */

type Read = { current: RiskCurrent; history: readonly RiskVersionRow[] };
const EMPTY: Record<OperatorLimitField, string> = { collar: '', fatFinger: '', slippageCap: '', throttle: '', circuitBreaker: '' };

export function RiskLimitsChecks({ markets }: { markets: readonly MarketRow[] }) {
  const [marketId, setMarketId] = useState(markets[0]?.id ?? '');
  const [read, setRead] = useState<Outcome<Read> | null>(null);
  const [values, setValues] = useState<Record<OperatorLimitField, string>>(EMPTY);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposed, setProposed] = useState<Outcome<ActionApproval> | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [approvalId, setApprovalId] = useState('');

  const loaded = read?.kind === 'ok' ? read.data : null;
  const symbol = markets.find((m) => m.id === marketId)?.symbol ?? '';
  const check = loaded ? checkRiskSet(loaded.current, values, reason.length >= 12 ? reason : 'x'.repeat(12)) : null;
  const problem = check && !check.ok ? check : null;

  async function load() {
    setBusy(true);
    setProposed(null);
    setHash(null);
    const out = await tradeOpsAction<Read>('risk-limits', { action: 'read', market: marketId });
    setRead(out);
    if (out.kind === 'ok') {
      const c = out.data.current;
      setValues({
        collar: limitText(c.collar),
        fatFinger: limitText(c.fatFinger),
        slippageCap: limitText(c.slippageCap),
        throttle: limitText(c.throttle),
        circuitBreaker: limitText(c.circuitBreaker),
      });
    }
    setBusy(false);
  }

  const body = () => ({ market: marketId, values, reason: reason.trim(), expectedVersion: loaded?.current.version });

  async function propose() {
    setBusy(true);
    setHash(null);
    const h = await tradeOpsAction<{ payloadHash: string }>('risk-limits', { action: 'hash', ...body() });
    if (h.kind === 'ok') setHash(h.data.payloadHash);
    setProposed(h.kind === 'ok' ? await tradeOpsAction<ActionApproval>('risk-limits', { action: 'propose', ...body() }) : h);
    setBusy(false);
  }

  const columns: TableColumn<EngineCheck>[] = [
    { id: 'name', header: 'Check', value: (c) => c.name, width: 170 },
    { id: 'what', header: 'What it does', value: (c) => c.what },
    {
      id: 'current',
      header: 'Current',
      numeric: true,
      width: 130,
      value: (c) => (loaded ? loaded.current[c.field] : null),
      cell: (c) =>
        !loaded ? (
          <span className="text-fg-3">—</span>
        ) : loaded.current[c.field] === null ? (
          <Badge tone="neutral" variant="outline" density="dense">
            Unset
          </Badge>
        ) : (
          <span className="if-num">{loaded.current[c.field]}</span>
        ),
    },
    {
      id: 'next',
      header: 'New value (blank = unset)',
      width: 230,
      value: () => null,
      cell: (c) => (
        <Input
          aria-label={`${c.name}: new value`}
          value={values[c.field]}
          onValueChange={(v) => setValues((prev) => ({ ...prev, [c.field]: v }))}
          density="dense"
          autoComplete="off"
          spellCheck={false}
          disabled={!loaded}
          placeholder={c.unit}
        />
      ),
    },
  ];

  const historyColumns: TableColumn<RiskVersionRow>[] = [
    { id: 'version', header: 'Version', numeric: true, width: 80, value: (h) => h.version },
    { id: 'at', header: 'When (UTC)', width: 190, value: (h) => h.createdAt.replace('T', ' ').slice(0, 19) },
    {
      id: 'limits',
      header: 'Collar / fat-finger / slippage / throttle / breaker',
      value: (h) => [h.collar, h.fatFinger, h.slippageCap, h.throttle, h.circuitBreaker].map((v) => v ?? 'unset').join(' / '),
    },
    { id: 'who', header: 'Operator → approver', value: (h) => `${h.operatorId} → ${h.approverId}` },
    { id: 'reason', header: 'Reason', value: (h) => h.reason },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Market" density="dense">
          <Select
            items={Object.fromEntries(markets.map((m) => [m.id, m.symbol]))}
            value={marketId}
            onValueChange={(v) => setMarketId(String(v))}
          >
            <SelectTrigger size={32}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {markets.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.symbol}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Button size={32} variant="secondary" shape="rounded" loading={busy} onClick={() => void load()}>
          Read limits
        </Button>
        {loaded ? (
          <span className="text-sm text-fg-2">
            Version <span className="if-num">{loaded.current.version}</span>
            {loaded.current.version === '0' ? ' (never set)' : ''}
          </span>
        ) : null}
      </div>
      {read && read.kind !== 'ok' ? <OutcomeNotice outcome={read} /> : null}

      <Table<EngineCheck> label="Operator limits" density="dense" columns={columns} rows={ENGINE_CHECKS} getRowId={(c) => c.id} />

      <div className="flex flex-col gap-3">
        <Field label="Reason (12 to 500 characters, kept in the audit)" density="dense">
          <Input value={reason} onValueChange={setReason} density="dense" autoComplete="off" disabled={!loaded} />
        </Field>
        {loaded && problem && reason.length >= 12 ? <p className="text-sm text-fg-2">{problem.message}</p> : null}
        <div>
          <Button
            size={32}
            variant="primary"
            shape="rounded"
            loading={busy}
            disabled={!loaded || problem !== null || reason.trim().length < 12}
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
              disabled={!loaded}
            />
          </Field>
          <ConfirmAction
            trigger="Apply the approved change"
            title={`Change the operator limits on ${symbol}?`}
            consequence={`The limits on ${symbol} change from version ${loaded?.current.version ?? '—'} as shown above. Orders are checked against the new values at once. The approval is used up.`}
            confirmLabel="Apply change"
            reasonMin={0}
            disabled={!loaded || problem !== null || approvalId.trim() === '' || reason.trim().length < 12}
            disabledReason={problem?.message ?? 'Enter the reason and the approved request id.'}
            run={() => tradeOpsAction('risk-limits', { action: 'apply', ...body(), approvalId: approvalId.trim() })}
            onDone={(o) => {
              if (o.kind === 'ok') void load();
            }}
          />
        </div>
      </div>

      {loaded ? (
        <Table<RiskVersionRow>
          label="Limit history"
          density="dense"
          columns={historyColumns}
          rows={loaded.history}
          getRowId={(h) => h.version}
        />
      ) : null}
    </div>
  );
}
