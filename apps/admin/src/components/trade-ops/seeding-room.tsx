'use client';

import { useState } from 'react';
import type { ActionApproval } from '@intafaced/contracts';
import { ConfirmAction } from './confirm-action';
import { OutcomeNotice } from './outcome-notice';
import { PageSection } from './kit';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { checkSeedConfig, type MidSource, type SeedConfigDraft, type SeedConfigRow } from '@/lib/trade-ops/seeding-model';

const TABLE = 'w-full border-collapse text-sm [&_td]:py-1 [&_td]:pe-3 [&_th]:py-1 [&_th]:pe-3 [&_th]:text-start [&_td]:text-start';
const v = (s: string | null, unit = '') => (s === null ? 'not set' : `${s}${unit}`);

function Current({ configs }: { configs: readonly SeedConfigRow[] }) {
  if (configs.length === 0) {
    return (
      <p className="text-sm text-fg-2" data-seeding="none">
        No market has an operator configuration. The seed job uses the environment’s values until one is written; with them off, nothing is
        seeded.
      </p>
    );
  }
  return (
    <table className={TABLE} data-seeding="current">
      <thead>
        <tr>
          <th scope="col">Market</th>
          <th scope="col">State</th>
          <th scope="col">Half spread</th>
          <th scope="col">Step</th>
          <th scope="col">Levels</th>
          <th scope="col">Quantity per level</th>
          <th scope="col">Mid</th>
          <th scope="col">Source</th>
          <th scope="col">Version</th>
        </tr>
      </thead>
      <tbody>
        {configs.map((c) => (
          <tr key={c.market} data-config="" data-market={c.symbol} data-approval={c.approvalId} data-enabled={c.enabled}>
            <td>{c.symbol}</td>
            <td data-col="state">{c.enabled ? 'On' : 'Off'}</td>
            <td data-col="half-spread">{v(c.halfSpreadBps, ' bps')}</td>
            <td data-col="step">{v(c.stepBps, ' bps')}</td>
            <td data-col="levels">{v(c.levels)}</td>
            <td data-col="qty">{v(c.qtyPerLevel)}</td>
            <td data-col="mid">
              {c.midSource === null ? 'not set' : c.midSource === 'venue' ? 'Venue feed' : `Configured ${c.configuredMid ?? 'not set'}`}
            </td>
            <td data-col="source">Operator config</td>
            <td data-col="version">
              v{c.version} · approved by {c.approverId} · {c.writtenAt}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Proposed = { approval: ActionApproval; payloadHash: string; expectedVersion: string };

function Field(props: { label: string; value: string; onChange: (v: string) => void; inputMode?: 'numeric' | 'decimal' }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>{props.label}</span>
      <input
        className="adm-input"
        aria-label={props.label}
        inputMode={props.inputMode}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

function Propose({ markets, configs }: { markets: ReadonlyArray<{ id: string; symbol: string }>; configs: readonly SeedConfigRow[] }) {
  const [market, setMarket] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [half, setHalf] = useState('');
  const [step, setStep] = useState('');
  const [levels, setLevels] = useState('');
  const [qty, setQty] = useState('');
  const [midSource, setMidSource] = useState<MidSource | ''>('');
  const [mid, setMid] = useState('');
  const [refusal, setRefusal] = useState<{ code: string; message: string } | null>(null);
  const [proposed, setProposed] = useState<Outcome<Proposed> | null>(null);
  const [approvalId, setApprovalId] = useState('');
  const [busy, setBusy] = useState(false);

  const draft = (): SeedConfigDraft => ({
    enabled,
    halfSpreadBps: half,
    stepBps: step,
    levels,
    qtyPerLevel: qty,
    midSource: midSource === '' ? null : midSource,
    configuredMid: mid,
  });
  const marketId = markets.find((m) => m.symbol === market)?.id ?? '';
  const current = configs.find((c) => c.market === marketId);

  async function propose() {
    setProposed(null);
    if (!marketId) {
      setRefusal({ code: 'trade_ops.seed_market_missing', message: 'Choose a market.' });
      return;
    }
    // Checked here first, with svc-trade's own code: a blank value is refused by name and nothing is filed.
    const check = checkSeedConfig(draft());
    if (!check.ok) {
      setRefusal({ code: check.code, message: check.message });
      return;
    }
    setRefusal(null);
    setBusy(true);
    setProposed(await tradeOpsAction<Proposed>('seeding', { action: 'propose', market: marketId, draft: draft() }));
    setBusy(false);
  }

  return (
    <form
      aria-label="Seeding configuration"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void propose();
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>Market</span>
          <select className="adm-input" aria-label="Market" value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="">Choose…</option>
            {markets.map((m) => (
              <option key={m.id} value={m.symbol}>
                {m.symbol}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" aria-label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Enabled</span>
        </label>
        <Field label="Half spread (bps)" value={half} onChange={setHalf} inputMode="numeric" />
        <Field label="Step (bps)" value={step} onChange={setStep} inputMode="numeric" />
        <Field label="Levels" value={levels} onChange={setLevels} inputMode="numeric" />
        <Field label="Quantity per level" value={qty} onChange={setQty} inputMode="decimal" />
        <label className="flex flex-col gap-1 text-sm">
          <span>Mid source</span>
          <select
            className="adm-input"
            aria-label="Mid source"
            value={midSource}
            onChange={(e) => setMidSource(e.target.value as MidSource | '')}
          >
            <option value="">Not set</option>
            <option value="configured">configured</option>
            <option value="venue">venue</option>
          </select>
        </label>
        <Field label="Configured mid" value={mid} onChange={setMid} inputMode="decimal" />
      </div>
      <p className="text-xs text-fg-2">
        {marketId
          ? `This proposes v${Number(current?.version ?? '0') + 1} for ${market}${current ? `, after v${current.version}` : ', its first operator version'}.`
          : 'Choose a market to see the version this proposes.'}{' '}
        A configured mid is a TEST or owner value the operator types; the venue source reads the outside feed and places nothing while it
        has no price.
      </p>
      <div>
        <button type="submit" className="adm-btn" data-tone="primary" disabled={busy}>
          Propose configuration
        </button>
      </div>
      {refusal ? (
        <div role="alert" className="flex flex-col gap-1 text-sm" data-seeding="refused">
          <span>
            Refused <code className="if-num text-xs">{refusal.code}</code>
          </span>
          <span className="text-fg-2">{refusal.message} Nothing was filed.</span>
        </div>
      ) : null}
      {proposed ? (
        <div className="flex flex-col gap-2" data-seeding="proposed">
          <OutcomeNotice outcome={proposed} doneText="Request filed" />
          {proposed.kind === 'ok' ? (
            <dl data-filed="" className="grid gap-x-4 gap-y-1 text-sm md:grid-cols-[max-content_1fr]">
              <dt className="text-fg-2">Approval id</dt>
              <dd className="if-num" data-field="Approval id">
                {proposed.data.approval.approvalId}
              </dd>
              <dt className="text-fg-2">Payload hash</dt>
              <dd className="if-num" data-field="Payload hash">
                {proposed.data.payloadHash}
              </dd>
              <dt className="text-fg-2">Bound to version</dt>
              <dd className="if-num" data-field="Bound to version">
                v{proposed.data.expectedVersion}
              </dd>
            </dl>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Approved request id" value={approvalId} onChange={setApprovalId} />
        <ConfirmAction
          trigger="Apply approved configuration"
          title={`Write ${market || 'the market'}'s seeding configuration?`}
          consequence={
            enabled
              ? 'The seed job places from this version on its next tick, on the house account, only into an empty book. The approval is used up.'
              : 'The seed job cancels this market’s seed orders on its next tick and places none. The approval is used up.'
          }
          confirmLabel="Write configuration"
          reasonMin={0}
          disabled={approvalId.trim() === '' || !marketId}
          disabledReason="Choose the market and enter the approved request id."
          doneText="Written"
          run={() => tradeOpsAction('seeding', { action: 'apply', market: marketId, draft: draft(), approvalId: approvalId.trim() })}
        />
      </div>
    </form>
  );
}

export function SeedingRoom({
  markets,
  configs,
}: {
  markets: ReadonlyArray<{ id: string; symbol: string }>;
  configs: readonly SeedConfigRow[];
}) {
  return (
    <div className="flex flex-col gap-6" data-room="seeding">
      <PageSection title="Current configuration">
        <Current configs={configs} />
      </PageSection>
      <PageSection title="Propose a version">
        <Propose markets={markets} configs={configs} />
      </PageSection>
    </div>
  );
}
