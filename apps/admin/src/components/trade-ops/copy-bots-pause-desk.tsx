'use client';

import { useId, useRef, useState } from 'react';
import { Badge, Button, Table, type TableColumn } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import {
  BOT_TYPES,
  OP_TEXT,
  SCOPE_KIND_TEXT,
  scopeText,
  type ActivePause,
  type PauseDeskRead,
  type PauseOp,
  type PauseRequest,
  type PauseScopeKind,
} from '@/lib/trade-ops/copy-bots-pauses';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { OutcomeNotice } from './outcome-notice';

/**
 * The copy and bots kill switch (CB-ops-03): pause copy mirrors and bots by lead, by bot type or by symbol, and resume
 * them, two founders every time. A pause stops new copies and new bots in its scope (a halted symbol also stops running
 * bots' orders on it); it places, cancels and closes nothing, so open positions keep running.
 */

const utc = (iso: string) => iso.replace('T', ' ').slice(0, 19);
type Notice = { outcome: Outcome<unknown>; doneText: string } | null;

export function CopyBotsPauseDesk({ initial, userId }: { initial: Outcome<PauseDeskRead>; userId: string }) {
  const [read, setRead] = useState<Outcome<PauseDeskRead>>(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [op, setOp] = useState<PauseOp>('pause');
  const [kind, setKind] = useState<PauseScopeKind>('lead');
  const [lead, setLead] = useState('');
  const [botType, setBotType] = useState<string>(BOT_TYPES[0].value);
  const [symbol, setSymbol] = useState('');
  const reads = useRef(0);
  const ids = { scope: useId(), lead: useId(), bot: useId(), symbol: useId() };
  const desk = read.kind === 'ok' ? read.data : null;

  async function load() {
    const n = ++reads.current;
    const out = await tradeOpsAction<PauseDeskRead>('copy-bots-pauses', { action: 'read' });
    if (n === reads.current) setRead(out);
  }

  async function act(key: string, body: Record<string, unknown>, doneText: string) {
    setBusy(key);
    const outcome = await tradeOpsAction('copy-bots-pauses', body);
    setNotice({ outcome, doneText });
    await load();
    setBusy(null);
  }

  const value = kind === 'lead' ? lead : kind === 'bot_type' ? botType : symbol;
  const scope = { kind, value };

  /** Resume a paused scope: the form is set to it, ready to ask a second founder. */
  function chooseResume(p: ActivePause) {
    setOp('resume');
    setKind(p.scope.kind);
    if (p.scope.kind === 'lead') setLead(p.scope.value);
    if (p.scope.kind === 'bot_type') setBotType(p.scope.value);
    if (p.scope.kind === 'symbol') setSymbol(p.scope.value);
  }

  const pausedColumns: TableColumn<ActivePause>[] = [
    { id: 'scope', header: 'Scope', width: 120, value: (p) => SCOPE_KIND_TEXT[p.scope.kind] },
    {
      id: 'value',
      header: 'Paused',
      value: (p) => p.scope.value,
      cell: (p) => <span className="if-num text-xs">{scopeText(p.scope)}</span>,
    },
    { id: 'at', header: 'Since (UTC)', width: 170, value: (p) => utc(p.pausedAt) },
    { id: 'by', header: 'Asked by', value: (p) => p.pausedBy, cell: (p) => <span className="if-num text-xs">{p.pausedBy}</span> },
    {
      id: 'approver',
      header: 'Confirmed by',
      value: (p) => p.pauseApprover,
      cell: (p) => <span className="if-num text-xs">{p.pauseApprover}</span>,
    },
    {
      id: 'act',
      header: '',
      headerLabel: 'Actions',
      width: 110,
      value: () => null,
      cell: (p) => (
        <Button size={28} variant="secondary" shape="rounded" disabled={busy !== null} onClick={() => chooseResume(p)}>
          Resume
        </Button>
      ),
    },
  ];

  const waitingColumns: TableColumn<PauseRequest>[] = [
    { id: 'op', header: 'Change', width: 100, value: (r) => OP_TEXT[r.op] },
    {
      id: 'scope',
      header: 'Scope',
      value: (r) => scopeText(r.scope),
      cell: (r) => <span className="if-num text-xs">{scopeText(r.scope)}</span>,
    },
    { id: 'at', header: 'Asked (UTC)', width: 170, value: (r) => utc(r.requestedAt) },
    { id: 'by', header: 'Asked by', value: (r) => r.proposedBy, cell: (r) => <span className="if-num text-xs">{r.proposedBy}</span> },
    {
      id: 'act',
      header: '',
      headerLabel: 'Actions',
      width: 200,
      value: () => null,
      cell: (r) =>
        r.proposedBy.toLowerCase() === userId.toLowerCase() ? (
          <Badge tone="warn" variant="outline" density="dense">
            Waiting for a second founder
          </Badge>
        ) : (
          <Button
            size={28}
            variant="primary"
            shape="rounded"
            loading={busy === `confirm:${r.id}`}
            disabled={busy !== null}
            onClick={() => void act(`confirm:${r.id}`, { action: 'confirm', requestId: r.id }, r.op === 'pause' ? 'Paused' : 'Resumed')}
          >
            Confirm
          </Button>
        ),
    },
  ];

  const field = 'border border-line bg-transparent px-2 py-1 text-sm';
  return (
    <div className="flex flex-col gap-4" data-room="copy-bots-pauses">
      <p className="text-sm text-fg-2">
        Pause copying by lead, new bots by type, or copying and bots on a symbol. Open positions keep running: a pause places, cancels and
        closes nothing. Every pause and every resume needs a second founder.
      </p>
      {read.kind !== 'ok' ? <OutcomeNotice outcome={read} /> : null}
      {notice ? <OutcomeNotice outcome={notice.outcome} doneText={notice.doneText} /> : null}

      {/* Each label holds only its own words, beside its field: a label around a select would carry every option's text. */}
      <form aria-label="Pause or resume" onSubmit={(e) => e.preventDefault()} className="flex flex-wrap items-end gap-3">
        <span className="flex flex-col gap-1 text-sm">
          <span className="text-fg-2">Change</span>
          <Badge tone={op === 'pause' ? 'warn' : 'lime'} density="dense">
            {OP_TEXT[op]}
          </Badge>
        </span>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor={ids.scope} className="text-fg-2">
            Scope
          </label>
          <select id={ids.scope} className={field} value={kind} onChange={(e) => setKind(e.target.value as PauseScopeKind)}>
            <option value="lead">Lead</option>
            <option value="bot_type">Bot type</option>
            <option value="symbol">Symbol</option>
          </select>
        </div>
        {kind === 'lead' ? (
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor={ids.lead} className="text-fg-2">
              Lead
            </label>
            <input id={ids.lead} className={field} value={lead} onChange={(e) => setLead(e.target.value)} autoComplete="off" />
          </div>
        ) : null}
        {kind === 'bot_type' ? (
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor={ids.bot} className="text-fg-2">
              Bot type
            </label>
            <select id={ids.bot} className={field} value={botType} onChange={(e) => setBotType(e.target.value)}>
              {BOT_TYPES.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {kind === 'symbol' ? (
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor={ids.symbol} className="text-fg-2">
              Symbol
            </label>
            <input id={ids.symbol} className={field} value={symbol} onChange={(e) => setSymbol(e.target.value)} autoComplete="off" />
          </div>
        ) : null}
        <Button
          size={32}
          variant="primary"
          shape="rounded"
          loading={busy === 'ask'}
          disabled={busy !== null}
          onClick={() => void act('ask', { action: 'ask', op, scope }, 'Sent for a second founder')}
        >
          Ask for a second founder
        </Button>
        <Button
          size={32}
          variant="secondary"
          shape="rounded"
          disabled={busy !== null}
          onClick={() => void act('now', { action: 'now', op, scope }, op === 'pause' ? 'Paused' : 'Resumed')}
        >
          {op === 'pause' ? 'Pause now' : 'Resume now'}
        </Button>
        {op === 'resume' ? (
          <Button size={32} variant="secondary" shape="rounded" disabled={busy !== null} onClick={() => setOp('pause')}>
            Back to pausing
          </Button>
        ) : null}
      </form>

      {desk ? (
        <>
          <section aria-label="Waiting for a second founder">
            <Table<PauseRequest>
              label="Waiting for a second founder"
              density="dense"
              columns={waitingColumns}
              rows={[...desk.waiting]}
              getRowId={(r) => r.id}
              emptyState={<p className="p-4 text-sm text-fg-2">Nothing is waiting for a second founder.</p>}
            />
          </section>
          <section aria-label="Paused scopes">
            <Table<ActivePause>
              label="Paused scopes"
              density="dense"
              columns={pausedColumns}
              rows={[...desk.paused]}
              getRowId={(p) => p.id}
              emptyState={<p className="p-4 text-sm text-fg-2">Nothing is paused: copy and bots run everywhere.</p>}
            />
          </section>
        </>
      ) : null}
    </div>
  );
}
