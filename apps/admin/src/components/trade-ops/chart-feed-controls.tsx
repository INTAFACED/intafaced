'use client';

import { useState } from 'react';
import type { ActionApproval } from '@intafaced/contracts';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import {
  ACTION_LABEL,
  CHART_FEED_ACTION_KINDS,
  FALLBACK_NOT_CONNECTED,
  FALLBACK_NOT_SET,
  PRIMARY_SOURCE,
  STATE_EFFECT,
  STATE_LABEL,
  changeText,
  reasonReady,
  sourceLabel,
  type ChartFeedActionKind,
  type ChartFeedControlsView,
  type ChartFeedPrepared,
} from '@/lib/trade-ops/chart-feed-model';
import { utcSecond } from '@/lib/trade-ops/feeds-model';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { ConfirmAction } from './confirm-action';
import { OutcomeNotice } from './outcome-notice';

/**
 * Feed source and symbol control (C-ops-03 (b), J-charts-desk-19 #2 #3): each market's chart feed source and state, a
 * change filed for a second operator, applied with the approval id, and the journal of every applied change. svc-trade
 * decides each change; the page shows what it answered and what each state really does.
 */

type Filed = { approval: ActionApproval; prepared: ChartFeedPrepared };

const READ_ONLY = 'Read only: changing a chart feed needs admin:write.';

function Journal({ view }: { view: ChartFeedControlsView }) {
  if (view.journal.length === 0) return <p className="text-sm text-fg-2">No chart feed change has been applied.</p>;
  return (
    <table className="w-full text-sm" aria-label="Chart control journal">
      <thead>
        <tr className="text-left text-fg-3">
          {['Time', 'Market', 'Action', 'Change', 'Reason', 'Proposed by', 'Approved by', 'Applied by', 'Approval'].map((h) => (
            <th key={h} scope="col" className="py-1 pr-4">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {view.journal.map((r) => (
          <tr key={r.id} data-approval={r.approvalId} data-symbol={r.symbol} data-action={r.action} className="border-t border-line">
            <td className="py-1 pr-4 tabular-nums" data-field="at" data-at={r.at}>
              {utcSecond(r.at)}
            </td>
            <td className="py-1 pr-4">{r.symbol}</td>
            <td className="py-1 pr-4">{ACTION_LABEL[r.action]}</td>
            <td className="py-1 pr-4" data-field="change">
              {changeText(r)}
            </td>
            <td className="py-1 pr-4" data-field="reason">
              {r.reason}
            </td>
            <td className="py-1 pr-4 if-num text-xs" data-field="proposer">
              {r.proposerId}
            </td>
            <td className="py-1 pr-4 if-num text-xs" data-field="approver">
              {r.approverId}
            </td>
            <td className="py-1 pr-4 if-num text-xs" data-field="executor">
              {r.executorId}
            </td>
            <td className="py-1 pr-4 if-num text-xs">{r.approvalId}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Markets({ view }: { view: ChartFeedControlsView }) {
  return (
    <table className="w-full text-sm" aria-label="Chart feed per market">
      <thead>
        <tr className="text-left text-fg-3">
          {['Market', 'Source', 'Chart state', 'What it does', 'Version', 'Last change'].map((h) => (
            <th key={h} scope="col" className="py-1 pr-4">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {view.markets.map((m) => (
          <tr
            key={m.symbol}
            data-symbol={m.symbol}
            data-source={m.source}
            data-state={m.state}
            data-version={m.version}
            className="border-t border-line"
          >
            <th scope="row" className="py-1 pr-4 text-left font-medium">
              {m.symbol}
              {m.test ? <span className="ml-2 text-xs text-fg-3">TEST</span> : null}
            </th>
            <td className="py-1 pr-4" data-field="source">
              {sourceLabel(m.source)}
            </td>
            <td className="py-1 pr-4" data-field="state">
              {STATE_LABEL[m.state]}
            </td>
            <td className="py-1 pr-4 text-fg-2">{STATE_EFFECT[m.state]}</td>
            <td className="py-1 pr-4 tabular-nums">{m.version}</td>
            <td className="py-1 pr-4 tabular-nums">{m.updatedAt ? utcSecond(m.updatedAt) : 'Never changed'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ChartFeedControls({ initial }: { initial: ChartFeedControlsView }) {
  const [view, setView] = useState(initial);
  const [symbol, setSymbol] = useState(initial.markets[0]?.symbol ?? '');
  const [kind, setKind] = useState<ChartFeedActionKind>('switch_source');
  const sources = [PRIMARY_SOURCE, ...(view.fallbackSources ?? [])];
  const [to, setTo] = useState(view.fallbackSources?.[0] ?? PRIMARY_SOURCE);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [filed, setFiled] = useState<Outcome<Filed> | null>(null);
  const [approvalId, setApprovalId] = useState('');

  const market = view.markets.find((m) => m.symbol === symbol) ?? null;
  const readOnly = !view.canWrite;
  const body = () => ({
    symbol,
    kind,
    ...(kind === 'switch_source' ? { to } : {}),
    expectedVersion: market?.version ?? '0',
    reason: reason.trim(),
  });
  const blocked = readOnly || market === null || !reasonReady(reason);

  async function reread() {
    const r = await tradeOpsAction<ChartFeedControlsView>('chart-feeds', { action: 'read' });
    if (r.kind === 'ok') setView(r.data);
  }

  async function propose() {
    setBusy(true);
    setFiled(await tradeOpsAction<Filed>('chart-feeds', { action: 'propose', ...body() }));
    setBusy(false);
  }

  if (view.markets.length === 0)
    return <p className="text-sm text-fg-2">No spot markets are listed, so there is no chart feed to control.</p>;

  return (
    <div className="flex flex-col gap-4" data-room="chart-feed-controls">
      <p className="text-sm text-fg-2" data-testid="fallback-sources" data-sources={view.fallbackSources?.join(',') ?? ''}>
        {view.fallbackSources === null
          ? FALLBACK_NOT_SET
          : `The owner's fallback sources: ${view.fallbackSources.join(', ')}. ${FALLBACK_NOT_CONNECTED}`}
      </p>
      <Markets view={view} />

      <form
        aria-label="Change a chart feed"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void propose();
        }}
      >
        {readOnly ? <p className="text-sm text-fg-2">{READ_ONLY}</p> : null}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>Market</span>
            <select
              className="adm-input"
              aria-label="Market"
              value={symbol}
              onChange={(e) => {
                setSymbol(e.target.value);
                setFiled(null);
              }}
            >
              {view.markets.map((m) => (
                <option key={m.symbol} value={m.symbol}>
                  {m.symbol}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Change</span>
            <select
              className="adm-input"
              aria-label="Change"
              value={kind}
              disabled={readOnly}
              onChange={(e) => {
                if ((CHART_FEED_ACTION_KINDS as readonly string[]).includes(e.target.value)) setKind(e.target.value as ChartFeedActionKind);
                setFiled(null);
              }}
            >
              {CHART_FEED_ACTION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {ACTION_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          {kind === 'switch_source' ? (
            <label className="flex flex-col gap-1 text-sm">
              <span>New source</span>
              <select className="adm-input" aria-label="New source" value={to} disabled={readOnly} onChange={(e) => setTo(e.target.value)}>
                {sources.map((s) => (
                  <option key={s} value={s}>
                    {sourceLabel(s)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <span className="text-sm text-fg-2">
            Now: {market ? `${sourceLabel(market.source)}, ${STATE_LABEL[market.state]} (version ${market.version})` : '—'}
          </span>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span>Reason (12 to 500 characters, kept in the journal and the audit)</span>
          <input
            className="adm-input"
            aria-label="Reason"
            value={reason}
            disabled={readOnly}
            autoComplete="off"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div>
          <button type="submit" className="adm-btn" data-tone="primary" disabled={busy || blocked} title={readOnly ? READ_ONLY : undefined}>
            Ask a second operator to approve
          </button>
        </div>
        {filed ? (
          <div className="flex flex-col gap-2" data-chart-feed="filed">
            <OutcomeNotice outcome={filed} doneText="Request filed: a second operator approves it in Freezes & approvals" />
            {filed.kind === 'ok' ? (
              <dl data-filed="" className="grid gap-x-4 gap-y-1 text-sm md:grid-cols-[max-content_1fr]">
                <dt className="text-fg-2">Approval id</dt>
                <dd className="if-num" data-field="Approval id">
                  {filed.data.approval.approvalId}
                </dd>
                <dt className="text-fg-2">Payload hash</dt>
                <dd className="if-num" data-field="Payload hash">
                  {filed.data.prepared.payloadHash}
                </dd>
                <dt className="text-fg-2">Bound to version</dt>
                <dd className="if-num" data-field="Bound to version">
                  {filed.data.prepared.expectedVersion}
                </dd>
                <dt className="text-fg-2">Change</dt>
                <dd data-field="Change">
                  {changeText({
                    fromSource: filed.data.prepared.from.source,
                    fromState: filed.data.prepared.from.state,
                    toSource: filed.data.prepared.to.source,
                    toState: filed.data.prepared.to.state,
                  })}
                </dd>
              </dl>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>Approved request id</span>
            <input
              className="adm-input"
              aria-label="Approved request id"
              value={approvalId}
              disabled={readOnly}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setApprovalId(e.target.value)}
            />
          </label>
          <ConfirmAction
            trigger="Apply the approved change"
            title={`Change the chart feed of ${symbol}?`}
            consequence={`${ACTION_LABEL[kind]}${kind === 'switch_source' ? ` to ${sourceLabel(to)}` : ''}. The change, its journal row and its audit row are written together, or nothing is. The approval is used up.`}
            confirmLabel="Apply change"
            reasonMin={0}
            disabled={blocked || approvalId.trim() === ''}
            disabledReason={readOnly ? READ_ONLY : 'Enter the same change and reason, and the approved request id.'}
            doneText="Applied"
            run={() => tradeOpsAction('chart-feeds', { action: 'apply', ...body(), approvalId: approvalId.trim() })}
            onDone={(o) => {
              if (o.kind === 'ok') void reread();
            }}
          />
        </div>
      </form>

      <section aria-labelledby="chart-control-journal" className="flex flex-col gap-2">
        <h3 id="chart-control-journal" className="text-sm font-medium">
          Chart control journal
        </h3>
        <Journal view={view} />
      </section>
    </div>
  );
}
