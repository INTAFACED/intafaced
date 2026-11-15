'use client';

import { useId, useRef, useState } from 'react';
import { Badge, Button, Table, type TableColumn } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import {
  AUDIT_TEXT,
  OP_TEXT,
  STATE_TEXT,
  type AuditRow,
  type DeskRun,
  type Halt,
  type HaltDeskRead,
  type HaltOp,
  type HaltRequest,
} from '@/lib/trade-ops/quant-halts';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { OutcomeNotice } from './outcome-notice';

/**
 * The live strategy desk (J-algo-dev-11): every person's live strategy runs with owner, state and version; halt one
 * strategy with a reason; halt every strategy and restore, with a second founder each time. A halt places, cancels and
 * closes nothing: a halted strategy places no new order and starts no new run, while a reduce-only exit still passes.
 */

const utc = (iso: string) => iso.replace('T', ' ').slice(0, 19);
type Notice = { outcome: Outcome<unknown>; doneText: string } | null;

const LIVE: ReadonlySet<string> = new Set(['signing', 'running', 'unknown']);

export function QuantHaltDesk({ initial, userId }: { initial: Outcome<HaltDeskRead>; userId: string }) {
  const [read, setRead] = useState<Outcome<HaltDeskRead>>(initial);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [target, setTarget] = useState<DeskRun | null>(null);
  const [haltReason, setHaltReason] = useState('');
  const [allReason, setAllReason] = useState('');
  const [restore, setRestore] = useState<{ op: HaltOp; halt: Halt | null } | null>(null);
  const [restoreReason, setRestoreReason] = useState('');
  const reads = useRef(0);
  const ids = { haltReason: useId(), allReason: useId(), restoreReason: useId() };
  const desk = read.kind === 'ok' ? read.data : null;

  async function load() {
    const n = ++reads.current;
    const out = await tradeOpsAction<HaltDeskRead>('quant-halts', { action: 'read' });
    if (n === reads.current) setRead(out);
  }

  async function act(key: string, body: Record<string, unknown>, doneText: string, after?: () => void) {
    setBusy(key);
    const outcome = await tradeOpsAction('quant-halts', body);
    setNotice({ outcome, doneText });
    if (outcome.kind === 'ok') after?.();
    await load();
    setBusy(null);
  }

  const runColumns: TableColumn<DeskRun>[] = [
    {
      id: 'strategy',
      header: 'Strategy',
      value: (r) => r.strategyName,
      cell: (r) => (
        <span data-testid="quant-run-strategy" data-strategy={r.strategyId}>
          {r.strategyName} · v{r.strategyVersion}
        </span>
      ),
    },
    {
      id: 'owner',
      header: 'Owner',
      value: (r) => r.userId,
      cell: (r) => (
        <span className="if-num text-xs" data-testid="quant-run-owner" data-user={r.userId} data-wallet={r.owner}>
          {r.userId} · {r.owner}
        </span>
      ),
    },
    {
      id: 'state',
      header: 'State',
      width: 170,
      value: (r) => r.state,
      cell: (r) => (
        <span data-testid="quant-run-state" data-run={r.runId} data-state={r.state} data-halted={r.halt ? 'true' : 'false'}>
          {STATE_TEXT[r.state]}
          {r.halt ? (
            <>
              {' '}
              <Badge tone="warn" density="dense">
                Halted
              </Badge>
            </>
          ) : null}
        </span>
      ),
    },
    {
      id: 'version',
      header: 'Version',
      width: 90,
      value: (r) => String(r.strategyVersion),
      cell: (r) => <span className="if-num">{r.strategyVersion}</span>,
    },
    { id: 'at', header: 'Started (UTC)', width: 170, value: (r) => utc(r.createdAt) },
    {
      id: 'act',
      header: '',
      headerLabel: 'Actions',
      width: 120,
      value: () => null,
      cell: (r) =>
        r.halt ? (
          <Button
            size={28}
            variant="secondary"
            shape="rounded"
            disabled={busy !== null}
            onClick={() => {
              setRestore({ op: 'restore', halt: r.halt });
              setRestoreReason('');
            }}
          >
            Restore
          </Button>
        ) : (
          <Button
            size={28}
            variant="secondary"
            shape="rounded"
            disabled={busy !== null}
            onClick={() => {
              setTarget(r);
              setHaltReason('');
            }}
          >
            Halt
          </Button>
        ),
    },
  ];

  const waitingColumns: TableColumn<HaltRequest>[] = [
    { id: 'op', header: 'Change', width: 190, value: (r) => OP_TEXT[r.op] },
    {
      id: 'target',
      header: 'Strategy',
      value: (r) => r.strategyId ?? '',
      cell: (r) => <span className="if-num text-xs">{r.strategyId ? `${r.strategyId} of ${r.userId}` : 'Every strategy'}</span>,
    },
    { id: 'reason', header: 'Reason', value: (r) => r.reason },
    { id: 'at', header: 'Asked (UTC)', width: 170, value: (r) => utc(r.requestedAt) },
    { id: 'by', header: 'Asked by', value: (r) => r.proposedBy, cell: (r) => <span className="if-num text-xs">{r.proposedBy}</span> },
    {
      id: 'act',
      header: '',
      headerLabel: 'Actions',
      width: 210,
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
            onClick={() => void act(`confirm:${r.id}`, { action: 'confirm', requestId: r.id }, r.op === 'halt_all' ? 'Halted' : 'Restored')}
          >
            Confirm
          </Button>
        ),
    },
  ];

  const auditColumns: TableColumn<AuditRow>[] = [
    { id: 'at', header: 'When (UTC)', width: 170, value: (a) => utc(a.occurredAt) },
    {
      id: 'kind',
      header: 'Action',
      value: (a) => a.kind,
      cell: (a) => (
        <span data-testid="quant-audit-kind" data-kind={a.kind}>
          {AUDIT_TEXT[a.kind] ?? a.kind}
        </span>
      ),
    },
    { id: 'object', header: 'Strategy', value: (a) => a.objectId, cell: (a) => <span className="if-num text-xs">{a.objectId}</span> },
    {
      id: 'operator',
      header: 'Operator',
      value: (a) => a.operatorId,
      cell: (a) => (
        <span className="if-num text-xs" data-testid="quant-audit-operator" data-operator={a.operatorId}>
          {a.operatorId}
        </span>
      ),
    },
    {
      id: 'approver',
      header: 'Second founder',
      value: (a) => a.approverId ?? '',
      cell: (a) => (
        <span className="if-num text-xs" data-testid="quant-audit-approver" data-approver={a.approverId ?? ''}>
          {a.approverId ?? '—'}
        </span>
      ),
    },
    {
      id: 'runs',
      header: 'Live runs',
      width: 90,
      value: (a) => String(a.detail.runs ?? a.detail.liveRuns ?? ''),
      cell: (a) => (
        <span className="if-num" data-testid="quant-audit-runs">
          {String(a.detail.runs ?? a.detail.liveRuns ?? '—')}
        </span>
      ),
    },
    { id: 'reason', header: 'Reason', value: (a) => a.reason ?? '' },
  ];

  const field = 'border border-line bg-transparent px-2 py-1 text-sm';
  const live = desk ? desk.runs.filter((r) => LIVE.has(r.state)) : [];
  return (
    <div className="flex flex-col gap-4" data-room="quant-halts">
      <p className="text-sm text-fg-2">
        Halt one strategy, or every strategy. A halted strategy places no new order and starts no new run; a reduce-only exit still passes,
        and each person&apos;s position stays in their own venue account. Halting every strategy and every restore need a second founder.
      </p>
      {read.kind !== 'ok' ? <OutcomeNotice outcome={read} /> : null}
      {notice ? <OutcomeNotice outcome={notice.outcome} doneText={notice.doneText} /> : null}

      {desk ? (
        <p
          className="text-sm"
          data-testid="quant-halt-counts"
          data-runs={desk.counts.runs}
          data-live={desk.counts.live}
          data-halted={desk.counts.haltedLive}
        >
          {desk.counts.runs} runs, {desk.counts.live} live, {desk.counts.haltedLive} of them halted.
        </p>
      ) : null}

      {target ? (
        <form
          aria-label="Halt one strategy"
          onSubmit={(e) => e.preventDefault()}
          className="flex flex-wrap items-end gap-3"
          data-testid="quant-halt-one"
        >
          <p className="text-sm">
            Halt <strong>{target.strategyName}</strong> of <span className="if-num text-xs">{target.userId}</span>
          </p>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor={ids.haltReason} className="text-fg-2">
              Reason
            </label>
            <input
              id={ids.haltReason}
              className={field}
              value={haltReason}
              onChange={(e) => setHaltReason(e.target.value)}
              autoComplete="off"
            />
          </div>
          <Button
            size={32}
            variant="primary"
            shape="rounded"
            loading={busy === 'halt'}
            disabled={busy !== null}
            onClick={() =>
              void act('halt', { action: 'halt', userId: target.userId, strategyId: target.strategyId, reason: haltReason }, 'Halted', () =>
                setTarget(null),
              )
            }
          >
            Halt this strategy
          </Button>
          <Button size={32} variant="secondary" shape="rounded" disabled={busy !== null} onClick={() => setTarget(null)}>
            Cancel
          </Button>
        </form>
      ) : null}

      <form aria-label="Halt every strategy" onSubmit={(e) => e.preventDefault()} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor={ids.allReason} className="text-fg-2">
            Reason to halt every strategy
          </label>
          <input id={ids.allReason} className={field} value={allReason} onChange={(e) => setAllReason(e.target.value)} autoComplete="off" />
        </div>
        <Button
          size={32}
          variant="primary"
          shape="rounded"
          loading={busy === 'ask:halt_all'}
          disabled={busy !== null}
          onClick={() => void act('ask:halt_all', { action: 'ask', op: 'halt_all', reason: allReason }, 'Sent for a second founder')}
        >
          Ask to halt every strategy
        </Button>
        <Button
          size={32}
          variant="secondary"
          shape="rounded"
          disabled={busy !== null || (desk?.halts.length ?? 0) === 0}
          onClick={() => {
            setRestore({ op: 'restore_all', halt: null });
            setRestoreReason('');
          }}
        >
          Restore every strategy
        </Button>
      </form>

      {restore ? (
        <form
          aria-label="Restore"
          onSubmit={(e) => e.preventDefault()}
          className="flex flex-wrap items-end gap-3"
          data-testid="quant-restore"
        >
          <p className="text-sm">
            {restore.halt ? (
              <>
                Restore <span className="if-num text-xs">{restore.halt.strategyId}</span> of{' '}
                <span className="if-num text-xs">{restore.halt.userId}</span>
              </>
            ) : (
              'Restore every halted strategy'
            )}
          </p>
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor={ids.restoreReason} className="text-fg-2">
              Reason to restore
            </label>
            <input
              id={ids.restoreReason}
              className={field}
              value={restoreReason}
              onChange={(e) => setRestoreReason(e.target.value)}
              autoComplete="off"
            />
          </div>
          <Button
            size={32}
            variant="primary"
            shape="rounded"
            loading={busy === 'ask:restore'}
            disabled={busy !== null}
            onClick={() =>
              void act(
                'ask:restore',
                { action: 'ask', op: restore.op, haltId: restore.halt?.id ?? null, reason: restoreReason },
                'Sent for a second founder',
                () => setRestore(null),
              )
            }
          >
            Ask for a second founder
          </Button>
          <Button
            size={32}
            variant="secondary"
            shape="rounded"
            disabled={busy !== null}
            onClick={() => void act('now:restore', { action: 'now', op: restore.op }, 'Restored')}
          >
            Restore now
          </Button>
          <Button size={32} variant="secondary" shape="rounded" disabled={busy !== null} onClick={() => setRestore(null)}>
            Cancel
          </Button>
        </form>
      ) : null}

      {desk ? (
        <>
          <section aria-label="Live strategy runs">
            <Table<DeskRun>
              label="Live strategy runs"
              density="dense"
              columns={runColumns}
              rows={[...desk.runs]}
              getRowId={(r) => r.runId}
              emptyState={<p className="p-4 text-sm text-fg-2">No live strategy run has been started.</p>}
            />
            {live.length === 0 && desk.runs.length > 0 ? <p className="text-sm text-fg-2">None of these runs is live now.</p> : null}
          </section>
          <section aria-label="Waiting for a second founder">
            <Table<HaltRequest>
              label="Waiting for a second founder"
              density="dense"
              columns={waitingColumns}
              rows={[...desk.waiting]}
              getRowId={(r) => r.id}
              emptyState={<p className="p-4 text-sm text-fg-2">Nothing is waiting for a second founder.</p>}
            />
          </section>
          <section aria-label="Halt audit">
            <Table<AuditRow>
              label="Halt audit"
              density="dense"
              columns={auditColumns}
              rows={[...desk.audit]}
              getRowId={(a) => a.id}
              emptyState={<p className="p-4 text-sm text-fg-2">No halt or restore has been recorded.</p>}
            />
          </section>
        </>
      ) : null}
    </div>
  );
}
