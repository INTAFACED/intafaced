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
import { formatPercent } from '@intafaced/i18n';
import type { PriceBandChangeRow, PriceBandView, RiskRead, RiskVersionRow } from '@/lib/trade-ops/desk-parse';
import type { MarketRow } from '@/lib/trade-ops/reads';
import type { Outcome } from '@/lib/trade-ops/outcome';
import {
  appliesTo,
  checkRiskSet,
  ENGINE_CHECKS,
  limitText,
  valuesFor,
  type EngineCheck,
  type OperatorLimitField,
} from '@/lib/trade-ops/risk-limits-model';
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

const EMPTY = Object.fromEntries(ENGINE_CHECKS.map((c) => [c.field, ''])) as Record<OperatorLimitField, string>;

export function RiskLimitsChecks({ markets }: { markets: readonly MarketRow[] }) {
  const [marketId, setMarketId] = useState(markets[0]?.id ?? '');
  const [read, setRead] = useState<Outcome<RiskRead> | null>(null);
  const [values, setValues] = useState<Record<OperatorLimitField, string>>(EMPTY);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposed, setProposed] = useState<Outcome<ActionApproval> | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [approvalId, setApprovalId] = useState('');

  const loaded = read?.kind === 'ok' ? read.data : null;
  const symbol = markets.find((m) => m.id === marketId)?.symbol ?? '';
  // The kind of the market whose limits were read, so the form never offers or sends a check that does not apply there.
  const kind = loaded ? markets.find((m) => m.id === loaded.current.marketId)?.kind : undefined;
  const sent = valuesFor(values, kind);
  const check = loaded ? checkRiskSet(loaded.current, sent, reason.length >= 12 ? reason : 'x'.repeat(12)) : null;
  const problem = check && !check.ok ? check : null;

  async function load() {
    setBusy(true);
    setProposed(null);
    setHash(null);
    // The band is read only for a futures market: nothing else has one.
    const futures = markets.find((m) => m.id === marketId)?.kind === 'futures';
    const out = await tradeOpsAction<RiskRead>('risk-limits', { action: 'read', market: marketId, band: futures });
    setRead(out);
    if (out.kind === 'ok') {
      const c = out.data.current;
      setValues(Object.fromEntries(ENGINE_CHECKS.map((k) => [k.field, limitText(c[k.field])])) as Record<OperatorLimitField, string>);
    }
    setBusy(false);
  }

  /** A new market drops the read, so nothing read for one market is shown, sent or applied for another. */
  function chooseMarket(id: string) {
    setMarketId(id);
    setRead(null);
    setValues(EMPTY);
    setProposed(null);
    setHash(null);
  }

  const body = () => ({ market: marketId, values: sent, reason: reason.trim(), expectedVersion: loaded?.current.version });

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
        ) : !appliesTo(c, kind) ? (
          <Badge tone="neutral" variant="outline" density="dense">
            Futures only
          </Badge>
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
      cell: (c) =>
        loaded && !appliesTo(c, kind) ? (
          <span className="text-sm text-fg-2">Not used on {kind} markets</span>
        ) : (
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
    { id: 'at', header: 'When (UTC)', width: 190, value: (h) => utc(h.createdAt) },
    {
      id: 'limits',
      header: 'Collar / fat-finger / slippage / throttle / breaker / open interest / share / range widest, trigger, cadence',
      value: (h) => ENGINE_CHECKS.map((c) => h[c.field] ?? 'unset').join(' / '),
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
            onValueChange={(v) => chooseMarket(String(v))}
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

      {loaded && kind === 'futures' ? (
        <PriceBandPanel band={loaded.band} refusal={loaded.bandRefusal} limitsVersion={loaded.current.version} />
      ) : null}

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

const REASON_TEXT: Record<PriceBandChangeRow['reason'], string> = {
  within_trigger: 'Within the trigger: the usual band',
  widened: 'Widened by the premium',
  capped: 'Held at the widest',
  inputs_missing: 'Mark or book unreadable: the usual band',
};

/** A fraction as a percentage, to four places. */
const pct = (fraction: string | null) => (fraction === null ? '—' : formatPercent(fraction, 'en', { maxFractionDigits: 4 }));

const utc = (iso: string) => iso.replace('T', ' ').slice(0, 19);

/**
 * The futures market's band as svc-trade's job last worked it out, and each change. Read only: the range is set with
 * the limits above. New orders are held to this band only while it is fresh and was worked for the limits in force;
 * otherwise, and while the range is blank, to the usual one.
 */
function PriceBandPanel({ band, refusal, limitsVersion }: { band: PriceBandView | null; refusal: string | null; limitsVersion: string }) {
  const now = band?.current ?? null;
  const columns: TableColumn<PriceBandChangeRow & { readonly n: number }>[] = [
    { id: 'at', header: 'When (UTC)', width: 190, value: (c) => utc(c.changedAt) },
    { id: 'band', header: 'Band', numeric: true, width: 110, value: (c) => pct(c.band) },
    {
      id: 'was',
      header: 'Was',
      numeric: true,
      width: 110,
      value: (c) => (c.previousBand === null ? 'first working' : pct(c.previousBand)),
    },
    { id: 'usual', header: 'Usual band', numeric: true, width: 110, value: (c) => pct(c.staticBand) },
    { id: 'premium', header: 'Premium', numeric: true, width: 110, value: (c) => pct(c.premium) },
    { id: 'why', header: 'Why', value: (c) => REASON_TEXT[c.reason] },
    { id: 'version', header: 'Limits version', numeric: true, width: 120, value: (c) => c.riskVersion },
  ];
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-fg-1">Price band, as last worked out</h3>
      <p className="text-sm text-fg-2">
        New orders are held to this band only while it was worked for the limits in force and within the last two cadences (or two runs of
        the futures jobs, when those are slower); otherwise, and while the price range is blank, to the usual band. Compare the last
        worked-out time with now.
      </p>
      {refusal !== null ? (
        <p className="text-sm text-fg-2">The band could not be read: {refusal}</p>
      ) : now === null ? (
        <p className="text-sm text-fg-2">
          This market has not been worked out: new orders are held to the usual band. The futures jobs work it out once the price range is
          set.
        </p>
      ) : (
        <KeyValue
          density="dense"
          items={[
            ...(now.riskVersion !== limitsVersion
              ? [
                  {
                    label: 'In force',
                    value: `No: worked for limits version ${now.riskVersion}, now ${limitsVersion}. The usual band applies until it is worked again.`,
                  },
                ]
              : []),
            { label: 'Band (each side of the mark)', value: pct(now.band) },
            { label: 'Usual band', value: pct(now.staticBand) },
            { label: 'Premium of the book over the mark', value: pct(now.premium) },
            { label: 'Mark', value: now.mark ?? '—' },
            { label: 'Middle of the futures book', value: now.bookMid ?? '—' },
            { label: 'Why', value: REASON_TEXT[now.reason] },
            { label: 'Worked for limits version', value: now.riskVersion },
            { label: 'Last worked out (UTC)', value: utc(now.checkedAt) },
            { label: 'Last changed (UTC)', value: utc(now.changedAt) },
          ]}
        />
      )}
      {band ? (
        <Table<PriceBandChangeRow & { readonly n: number }>
          label="Band changes"
          density="dense"
          columns={columns}
          rows={band.changes.map((c, n) => ({ ...c, n }))}
          getRowId={(c) => String(c.n)}
        />
      ) : null}
    </div>
  );
}
