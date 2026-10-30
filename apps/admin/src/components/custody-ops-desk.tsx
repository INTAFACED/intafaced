'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Chip } from '@/components/chip';
import { fetchCustodyOps, fetchTask, postDecision, type DecisionReply } from '@/lib/custody-ops/browser';
import {
  EVENT_LABEL,
  KIND_LABEL,
  SCOPE_LABEL,
  STATUS_LABEL,
  decisionGate,
  decisionPhrase,
  payloadRows,
  timeLeft,
  type CustodyApprover,
  type CustodyTask,
  type CustodyTaskDetail,
  type Decision,
} from '@/lib/custody-ops/model';
import { OPEN_ITEM_KIND_LABEL, openItemWhy, shownLine, sumLine, type OpenItems } from '@/lib/custody-ops/open-items';
import { PENDING_WINDOW, RECENT_WINDOW, type CustodyOpsRead } from '@/lib/custody-ops/server-types';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import type { Part } from '@/lib/desk/part';
import { shortId } from '@/lib/desk/desk-model';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import './desk.css';
import './custody-ops.css';

/**
 * CUSTODY APPROVALS: the tasks waiting for this approver, recent tasks, the registered approvers, and one task to read and decide.
 *
 * Built to be used on a phone: one column, large buttons, nothing that needs a hover. An approver reads the whole payload and
 * its fingerprint, then types APPROVE or REJECT plus the first eight characters of that fingerprint. svc-pay checks the approver
 * is registered and is not the person who started the task, and binds the decision to the fingerprint. The desk shows what
 * svc-pay answered and then reads again; it never advances a state itself. A task that cannot run yet (no executor is wired) is
 * not startable at all, so nothing here is ever waiting on something that cannot happen.
 */

function PartFailed({ name, part }: { name: string; part: Extract<Part<unknown>, { kind: 'failed' }> }) {
  return (
    <div className="adm-callout" data-tone="danger" role="status">
      <strong>{name} unavailable</strong>
      <p>{part.message}</p>
      {part.code && <p className="dk-muted">Code: {part.code}</p>}
    </div>
  );
}

const statusTone = (task: CustodyTask) =>
  task.status === 'executed' ? 'live' : task.status === 'pending' || task.status === 'approved' ? 'info' : 'danger';

function TaskCard({ task, now, picked, onPick }: { task: CustodyTask; now: Date; picked: boolean; onPick: (task: CustodyTask) => void }) {
  const left = task.status === 'pending' ? timeLeft(task.expiresAt, now) : null;
  return (
    <li className="co-card" aria-current={picked}>
      <div className="co-row">
        <strong>{task.title}</strong>
        <Chip tone={statusTone(task)}>{STATUS_LABEL[task.status]}</Chip>
      </div>
      <p className="dk-muted">
        {KIND_LABEL[task.kind]}
        {task.scope ? ` · ${SCOPE_LABEL[task.scope] ?? task.scope}` : ''} · started by {shortId(task.initiator)}
      </p>
      <p>
        {task.approvalCount} of {task.requiredApprovals} approvals{left ? ` · ${left}` : ''}
        {task.approvedByMe ? ' · you approved' : ''}
      </p>
      <div className="co-actions">
        <button type="button" className="adm-btn" aria-pressed={picked} onClick={() => onPick(task)}>
          {picked ? 'Open' : 'Review'}
        </button>
      </div>
    </li>
  );
}

function TaskList({
  part,
  empty,
  now,
  pickedId,
  onPick,
}: {
  part: Part<readonly CustodyTask[]>;
  empty: string;
  now: Date;
  pickedId: string | null;
  onPick: (task: CustodyTask) => void;
}) {
  if (part.kind === 'failed') return <PartFailed name="Tasks" part={part} />;
  if (part.data.length === 0) return <p className="dk-muted">{empty}</p>;
  return (
    <ul className="co-list">
      {part.data.map((task) => (
        <TaskCard key={task.id} task={task} now={now} picked={pickedId === task.id} onPick={onPick} />
      ))}
    </ul>
  );
}

function Approvers({ part }: { part: Part<readonly CustodyApprover[]> }) {
  if (part.kind === 'failed') return <PartFailed name="Approvers" part={part} />;
  if (part.data.length === 0)
    return <p className="dk-muted">No approver is registered, so no task can be decided. A founder registers approvers.</p>;
  return (
    <ul className="co-list">
      {part.data.map((a) => (
        <li className="co-card" key={a.userId}>
          <div className="co-row">
            <strong>{a.label}</strong>
            <Chip tone={a.active ? 'live' : 'dark'}>{a.active ? 'Active' : 'Revoked'}</Chip>
          </div>
          <p className="dk-muted">
            {a.role === 'keyless' ? 'Key-less approver: decides tasks and holds no signing key' : 'Founder'} · {shortId(a.userId)} · set{' '}
            {formatWhen(a.setAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Open custody items: why custody and the ledger differ right now. Read-only; resolving one is done where its deposit is handled. */
export function OpenItemsList({ part }: { part: Part<OpenItems> }) {
  if (part.kind === 'failed') return <PartFailed name="Open custody items" part={part} />;
  const { items, sums } = part.data;
  if (part.data.total === 0)
    return (
      <p className="dk-muted" data-testid="co-open-none">
        No open custody item: no deposit is held uncredited, and no credit was taken back uncovered.
      </p>
    );
  return (
    <>
      <ul className="co-list" aria-label="Open items by network and asset">
        {sums.map((s) => (
          <li
            className="co-card"
            key={`${s.networkId}:${s.assetId}`}
            data-testid="co-open-sum"
            data-network-id={s.networkId}
            data-asset-id={s.assetId}
            data-net={s.net}
          >
            {sumLine(s)}
          </li>
        ))}
      </ul>
      <ul className="co-list" aria-label="Open items">
        {items.map((i) => (
          <li className="co-card" key={i.depositId}>
            <div className="co-row">
              <strong>
                {i.signedAmount} {i.assetId} on {i.networkId}
              </strong>
              <Chip tone={i.kind === 'held' ? 'dark' : 'warn'}>{OPEN_ITEM_KIND_LABEL[i.kind]}</Chip>
            </div>
            <p className="dk-muted">
              {openItemWhy(i)} · user {shortId(i.userId)} · tx {shortId(i.txHash)}#{i.outputIndex} · seen {formatWhen(i.detectedAt)}
            </p>
          </li>
        ))}
      </ul>
      <p className="dk-muted" data-testid="co-open-total" data-total={part.data.total}>
        {shownLine(part.data)}
      </p>
    </>
  );
}

export interface TaskPanelProps {
  readonly task: CustodyTaskDetail;
  readonly userId: string;
  readonly now: Date;
  readonly busy: Decision | null;
  readonly reply: DecisionReply | null;
  readonly onDecide: (decision: Decision, confirm: string) => void;
  readonly onClose: () => void;
}

export function TaskPanel({ task, userId, now, busy, reply, onDecide, onClose }: TaskPanelProps) {
  const [typed, setTyped] = useState('');
  const [decision, setDecision] = useState<Decision | null>(null);
  const gates = (['approve', 'reject', 'cancel'] as const).map((d) => [d, decisionGate(d, task, userId, now)] as const);
  const left = task.status === 'pending' ? timeLeft(task.expiresAt, now) : null;
  const phrase = decision ? decisionPhrase(decision, task) : '';
  return (
    <section className="co-card" aria-label="Task">
      <div className="co-row">
        <h2>{task.title}</h2>
        <button type="button" className="adm-btn" onClick={onClose}>
          Close
        </button>
      </div>
      <p>
        <Chip tone={statusTone(task)}>{STATUS_LABEL[task.status]}</Chip> {task.approvalCount} of {task.requiredApprovals} approvals
        {left ? ` · ${left}` : ''}
      </p>
      <dl className="co-facts">
        <dt>Kind</dt>
        <dd>
          {KIND_LABEL[task.kind]}
          {task.scope ? ` · ${SCOPE_LABEL[task.scope] ?? task.scope}` : ''}
        </dd>
        <dt>Started by</dt>
        <dd>{shortId(task.initiator)}</dd>
        <dt>Deadline</dt>
        <dd>{formatWhen(task.expiresAt)}</dd>
        {task.failureCode && (
          <>
            <dt>Could not run</dt>
            <dd>{task.failureCode}</dd>
          </>
        )}
        {payloadRows(task.payload).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="dk-muted">Fingerprint you are deciding on. Approvals and rejections apply to exactly this.</p>
      <p className="co-hash">{task.payloadHash}</p>

      <div className="co-actions">
        {gates.map(([d, gate]) => (
          <button
            key={d}
            type="button"
            className="adm-btn"
            disabled={!gate.ok || busy !== null}
            aria-pressed={decision === d}
            onClick={() => {
              setDecision(d);
              setTyped('');
            }}
          >
            {d === 'approve' ? 'Approve' : d === 'reject' ? 'Reject' : 'Cancel task'}
          </button>
        ))}
      </div>
      {gates.every(([, g]) => !g.ok) && <p className="dk-muted">{gates[0]![1].ok ? '' : (gates[0]![1] as { why: string }).why}</p>}
      {decision && (
        <form
          className="co-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (typed === phrase && busy === null) onDecide(decision, typed);
          }}
        >
          <div className="adm-field">
            <label htmlFor="co-confirm">
              Type {phrase} to {decision === 'cancel' ? 'cancel this task' : decision}
            </label>
            <input
              id="co-confirm"
              className="adm-input"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          <div className="co-actions">
            <button type="submit" className="adm-btn" disabled={typed !== phrase || busy !== null}>
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      )}
      {reply && !reply.ok && <Refusal refusal={reply.refusal} />}
      {reply?.ok && (
        <p role="status">
          {reply.action === 'approve' ? 'Approved' : reply.action === 'reject' ? 'Rejected' : 'Cancelled'}. The task now reads:{' '}
          {STATUS_LABEL[reply.task.status]}.
        </p>
      )}

      <h3>Timeline</h3>
      {task.timeline.length === 0 ? (
        <p className="dk-muted">Nothing has happened on this task yet.</p>
      ) : (
        <ol className="co-list">
          {task.timeline.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="co-row">
              <span>
                {EVENT_LABEL[entry.kind] ?? entry.kind} · {entry.actor === 'system' ? 'the system' : shortId(entry.actor)}
              </span>
              <span className="dk-muted">{formatWhen(entry.at)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Refusal({ refusal }: { refusal: RefusalView }) {
  return (
    <div className="adm-callout" data-tone={refusal.changed === 'unknown' ? 'warn' : 'danger'} role="alert">
      <strong>{refusal.title}</strong>
      <p>{refusal.body}</p>
      <p>{refusal.next}</p>
      {refusal.code && <p className="dk-muted">Code: {refusal.code}</p>}
    </div>
  );
}

export interface CustodyOpsViewProps {
  readonly read: CustodyOpsRead;
  readonly userId: string;
  readonly now: Date;
  readonly pickedId: string | null;
  readonly onPick: (task: CustodyTask) => void;
  readonly onRefresh: () => void;
  readonly detail: React.ReactNode;
}

export function CustodyOpsView({ read, userId: _userId, now, pickedId, onPick, onRefresh, detail }: CustodyOpsViewProps) {
  return (
    <div className="co-page">
      <header className="co-row">
        <div>
          <h1>Custody approvals</h1>
          <p className="dk-muted">Read {formatAsOf(read.asOf)}. Sensitive custody actions wait here for registered approvers.</p>
        </div>
        <button type="button" className="adm-btn" onClick={onRefresh}>
          Refresh
        </button>
      </header>
      {detail}
      <div className="co-grid">
        <section aria-label="Waiting on you">
          <h2>Waiting on you</h2>
          <TaskList part={read.pending} empty="Nothing is waiting on you." now={now} pickedId={pickedId} onPick={onPick} />
          <p className="dk-muted">Up to {PENDING_WINDOW} shown.</p>
        </section>
        <section aria-label="Recent tasks">
          <h2>Recent tasks</h2>
          <TaskList part={read.recent} empty="No task has been started." now={now} pickedId={pickedId} onPick={onPick} />
          <p className="dk-muted">Latest {RECENT_WINDOW} shown.</p>
        </section>
      </div>
      <section aria-label="Approvers">
        <h2>Registered approvers</h2>
        <Approvers part={read.approvers} />
      </section>
      <section aria-label="Open custody items">
        <h2>Open custody items</h2>
        <OpenItemsList part={read.openItems} />
      </section>
    </div>
  );
}

export function CustodyOpsDesk({ initial, userId }: { initial: CustodyOpsRead; userId: string }) {
  const [read, setRead] = useState(initial);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [task, setTask] = useState<CustodyTaskDetail | null>(null);
  const [problem, setProblem] = useState<RefusalView | null>(null);
  const [busy, setBusy] = useState<Decision | null>(null);
  const [reply, setReply] = useState<DecisionReply | null>(null);
  const [stale, setStale] = useState(false);
  const alive = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    return () => controller.abort();
  }, []);

  const reload = useCallback(async () => {
    const next = await fetchCustodyOps(alive.current?.signal);
    if (alive.current?.signal.aborted) return false;
    if (next) setRead(next);
    return next !== null;
  }, []);
  const open = useCallback(async (id: string) => {
    setPickedId(id);
    setReply(null);
    setProblem(null);
    const answer = await fetchTask(id, alive.current?.signal);
    if (alive.current?.signal.aborted) return;
    if (answer.ok) setTask(answer.task);
    else {
      setTask(null);
      setProblem(answer.refusal);
    }
  }, []);

  async function decide(decision: Decision, confirm: string) {
    if (!task || busy) return;
    setBusy(decision);
    const answer = await postDecision({
      action: decision,
      taskId: task.id,
      payloadHash: decision === 'cancel' ? null : task.payloadHash,
      confirm,
    });
    if (alive.current?.signal.aborted) return;
    setBusy(null);
    setReply(answer);
    // Always read the state again, whatever the answer: a refused or unknown decision may still have changed the task.
    const fresh = await fetchTask(task.id, alive.current?.signal);
    if (alive.current?.signal.aborted) return;
    if (fresh.ok) setTask(fresh.task);
    const listed = await reload();
    setStale(!fresh.ok || !listed);
  }

  const now = new Date();
  return (
    <CustodyOpsView
      read={read}
      userId={userId}
      now={now}
      pickedId={pickedId}
      onPick={(t) => void open(t.id)}
      onRefresh={() => void reload().then((listed) => setStale(!listed))}
      detail={
        <>
          {problem && <Refusal refusal={problem} />}
          {stale && (
            <div className="adm-callout" data-tone="warn" role="alert">
              Could not re-read the latest state. What you see may be out of date; refresh before you decide.
            </div>
          )}
          {task && (
            <TaskPanel
              key={`${task.id}:${task.status}:${task.approvalCount}`}
              task={task}
              userId={userId}
              now={now}
              busy={busy}
              reply={reply}
              onDecide={(d, c) => void decide(d, c)}
              onClose={() => {
                setTask(null);
                setPickedId(null);
                setReply(null);
              }}
            />
          )}
        </>
      }
    />
  );
}
