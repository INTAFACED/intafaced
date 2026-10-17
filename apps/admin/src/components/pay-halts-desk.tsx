'use client';

import { useCallback, useRef, useState } from 'react';
import type { PayHaltEvent, PayHaltPendingClear, PayHaltScope, PayHaltState, PayHaltTarget } from '@intafaced/contracts';
import { Chip } from '@/components/chip';
import {
  HALT_SCOPES,
  TARGET_LEVELS,
  canConfirmClear,
  describeTarget,
  explainOutcome,
  haltPhrase,
  setGate,
  stateFor,
  targetFrom,
  targetKey,
  versionFor,
  type Gate,
  type TargetLevel,
} from '@/lib/pay-halts/model';
import { fetchPayHalts, newRequestId, postHalt, type HaltReply, type HaltRequest } from '@/lib/pay-halts/browser';
import type { Part, PayHaltsRead } from '@/lib/pay-halts/types';
import { shortId } from '@/lib/desk/desk-model';
import './desk.css';

/**
 * PAYMENTS HALTS — stop an operation, or resume it with a second founder.
 *
 * Halting is one founder and immediate: it is the fast stop. Clearing a halt takes two DIFFERENT founders: the first
 * records a proposal (the halt stays on), a different founder confirms it from the pending list below. svc-pay
 * enforces both; this desk shows what svc-pay answered and then reads the halts again, never advancing a state itself.
 */

const SCOPE_LABEL: Record<PayHaltScope, string> = {
  intake: 'Taking payments',
  conversion: 'Converting currency',
  payout: 'Paying out',
  settlement: 'Settling to merchants',
};

function PartFailed({ name, part }: { name: string; part: Extract<Part<unknown>, { kind: 'failed' }> }) {
  return (
    <div className="adm-callout" data-tone="danger" role="status">
      <strong>{name} unavailable</strong>
      <p>{part.message}</p>
      {part.code && <p className="dk-muted">Code: {part.code}</p>}
    </div>
  );
}

export function HaltStatesTable({ states }: { states: readonly PayHaltState[] }) {
  return (
    <div className="dk-table-wrap" role="region" aria-label="Current halts" tabIndex={0}>
      <table className="adm-table">
        <thead>
          <tr>
            <th>Operation</th>
            <th>Covers</th>
            <th>State</th>
            <th>Why</th>
            <th>Set by</th>
            <th>Since</th>
            <th>Version</th>
          </tr>
        </thead>
        <tbody>
          {states.map((s) => (
            <tr key={targetKey(s.scope, s.target)} data-killed={s.halted}>
              <td>{SCOPE_LABEL[s.scope]}</td>
              <td>{describeTarget(s.target)}</td>
              <td>{s.halted ? <Chip tone="danger">HALTED</Chip> : <Chip tone="live">Running</Chip>}</td>
              <td>{s.reason ?? '—'}</td>
              <td>{s.source === 'auto_trip' ? 'Automatic trip' : s.actorUserId ? shortId(s.actorUserId) : '—'}</td>
              <td>{s.changedAt ?? 'never changed'}</td>
              <td>{s.version}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PendingClearsTable({
  proposals,
  userId,
  onPick,
  picked,
}: {
  proposals: readonly PayHaltPendingClear[];
  userId: string;
  onPick: (p: PayHaltPendingClear) => void;
  picked: string | null;
}) {
  if (proposals.length === 0) return <p className="dk-muted">No clear is waiting for a second founder.</p>;
  return (
    <div className="dk-table-wrap" role="region" aria-label="Clears waiting for a second founder" tabIndex={0}>
      <table className="adm-table">
        <thead>
          <tr>
            <th>Operation</th>
            <th>Covers</th>
            <th>Reason given</th>
            <th>Proposed by</th>
            <th>Proposed at</th>
            <th>Your part</th>
          </tr>
        </thead>
        <tbody>
          {proposals.map((p) => {
            const mine = !canConfirmClear(p.requestedByUserId, userId);
            return (
              <tr key={p.requestId} data-testid="pending-clear">
                <td>{SCOPE_LABEL[p.scope]}</td>
                <td>{describeTarget(p.target)}</td>
                <td>{p.reason}</td>
                <td>
                  {shortId(p.requestedByUserId)}
                  {mine ? ' (you)' : ''}
                </td>
                <td>{p.requestedAt}</td>
                <td>
                  {mine ? (
                    <span className="dk-muted">A different founder has to confirm</span>
                  ) : (
                    <button type="button" className="adm-btn" aria-pressed={picked === p.requestId} onClick={() => onPick(p)}>
                      Review and confirm
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function HaltHistoryTable({ events }: { events: readonly PayHaltEvent[] }) {
  if (events.length === 0) return <p className="dk-muted">No halt has ever been set or cleared.</p>;
  return (
    <div className="dk-table-wrap" role="region" aria-label="Halt history" tabIndex={0}>
      <table className="adm-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Operation</th>
            <th>Covers</th>
            <th>Change</th>
            <th>Why</th>
            <th>By</th>
            <th>Second founder</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e, i) => (
            <tr key={`${e.changedAt}-${i}`}>
              <td>{e.changedAt ?? '—'}</td>
              <td>{SCOPE_LABEL[e.scope]}</td>
              <td>{describeTarget(e.target)}</td>
              <td>{e.halted ? 'Halted' : 'Cleared'}</td>
              <td>{e.reason ?? '—'}</td>
              <td>{e.source === 'auto_trip' ? 'Automatic trip' : shortId(e.actorUserId)}</td>
              <td>{e.confirmedByUserId ? shortId(e.confirmedByUserId) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HaltReplyView({ reply }: { reply: HaltReply }) {
  if (!reply.ok) {
    return (
      <div
        className="adm-callout"
        role="alert"
        data-testid="halt-reply"
        data-tone={reply.refusal.changed === 'unknown' ? 'warn' : 'danger'}
      >
        <strong>{reply.refusal.title}</strong>
        <p>{reply.refusal.body}</p>
        <p>{reply.refusal.next}</p>
        <p className="dk-muted">{reply.refusal.changed === 'unknown' ? 'Outcome not known.' : 'Nothing was changed.'}</p>
      </div>
    );
  }
  const text = explainOutcome(reply.outcome, reply.state.halted);
  return (
    <div className="adm-callout" role="status" data-testid="halt-reply" data-tone={text.applied ? 'ok' : 'warn'}>
      <strong>{text.title}</strong>
      <p>{text.body}</p>
      <p className="dk-muted">
        svc-pay says {SCOPE_LABEL[reply.state.scope as PayHaltScope] ?? reply.state.scope} for {describeTarget(reply.state.target)} is now{' '}
        {reply.state.halted ? 'halted' : 'running'} (version {reply.state.version}).
      </p>
    </div>
  );
}

export interface PayHaltsViewProps {
  readonly read: PayHaltsRead | null;
  readonly userId: string;
  readonly loading: boolean;
  readonly scope: PayHaltScope;
  readonly level: TargetLevel;
  readonly targetId: string;
  readonly reason: string;
  readonly confirm: string;
  readonly busy: boolean;
  readonly reply: HaltReply | null;
  readonly picked: PayHaltPendingClear | null;
  readonly onRead: () => void;
  readonly onScope: (v: PayHaltScope) => void;
  readonly onLevel: (v: TargetLevel) => void;
  readonly onTargetId: (v: string) => void;
  readonly onReason: (v: string) => void;
  readonly onConfirm: (v: string) => void;
  readonly onSubmit: () => void;
  readonly onPick: (p: PayHaltPendingClear | null) => void;
}

export function PayHaltsDeskView(p: PayHaltsViewProps) {
  const { read } = p;
  const states = read && read.status.kind === 'ok' ? read.status.data.states : null;
  const readable = read && read.status.kind === 'ok' ? read.status.data.readable : false;
  const target: PayHaltTarget | null = targetFrom(p.level, p.targetId);
  const current = states && target ? stateFor(states, p.scope, target) : null;
  const halted = current?.halted ?? false;
  const wantHalt = !halted;
  const gate: Gate = !states
    ? { ok: false, why: 'The current halts could not be read, so nothing can be changed. Read them again first.' }
    : !readable
      ? { ok: false, why: 'svc-pay reports the halt store unreadable. Treat every operation as halted until it is readable.' }
      : setGate({ scope: p.scope, target, halted: wantHalt, reason: p.reason, confirm: p.confirm, busy: p.busy });
  const phrase = haltPhrase(p.scope, wantHalt);
  const confirming = p.picked;
  return (
    <section className="dk" aria-labelledby="ph-title" data-testid="pay-halts-desk">
      <div className="dk-row">
        <h2 id="ph-title">Payments halts</h2>
        <button type="button" className="adm-btn" onClick={p.onRead} disabled={p.loading}>
          {p.loading ? 'Reading…' : 'Refresh'}
        </button>
        <span className="dk-asof">{read ? `As of ${read.asOf} (when this console read svc-pay)` : 'No read yet'}</span>
      </div>
      <p className="dk-muted">
        Stopping an operation is one founder and immediate. Resuming one takes two different founders: the first records it and the halt
        stays on until a different founder confirms.
      </p>

      {!read && <p className="dk-why">The halts could not be read from svc-pay. Nothing is shown rather than a guess.</p>}
      {read && read.status.kind === 'failed' && <PartFailed name="Current halts" part={read.status} />}
      {read && read.status.kind === 'ok' && (
        <>
          {!read.status.data.readable && (
            <div className="adm-callout" data-tone="danger" role="alert">
              <strong>svc-pay cannot read its halt store</strong>
              While it cannot, every operation counts as halted. Nothing below is a clean bill of health.
            </div>
          )}
          <HaltStatesTable states={read.status.data.states} />
          <p className="dk-muted">
            {read.status.data.autoTrip.enabled
              ? `Automatic trip is on: an operation pauses itself after ${read.status.data.autoTrip.consecutiveFailures} failures in a row.`
              : 'Automatic trip is off: nothing pauses by itself. A venue or rail can keep failing until a founder halts it.'}
          </p>
        </>
      )}

      <form
        className="dk-stack"
        data-testid="halt-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (gate.ok && !confirming) p.onSubmit();
        }}
      >
        <h3>{wantHalt ? 'Halt an operation' : 'Ask to clear a halt'}</h3>
        <div className="dk-grid-2">
          <div className="adm-field">
            <label htmlFor="ph-scope">Operation</label>
            <select id="ph-scope" className="adm-select" value={p.scope} onChange={(e) => p.onScope(e.target.value as PayHaltScope)}>
              {HALT_SCOPES.map((s) => (
                <option key={s} value={s}>
                  {SCOPE_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="adm-field">
            <label htmlFor="ph-level">Covers</label>
            <select id="ph-level" className="adm-select" value={p.level} onChange={(e) => p.onLevel(e.target.value as TargetLevel)}>
              {TARGET_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l === 'global'
                    ? 'Everyone (global)'
                    : l === 'merchant'
                      ? 'One merchant'
                      : l === 'user'
                        ? 'One user’s withdrawal exit'
                        : 'One rail'}
                </option>
              ))}
            </select>
          </div>
          {p.level !== 'global' && (
            <div className="adm-field">
              <label htmlFor="ph-target">{p.level === 'rail' ? 'Rail id' : 'Id (UUID)'}</label>
              <input
                id="ph-target"
                className="adm-input"
                value={p.targetId}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => p.onTargetId(e.target.value)}
              />
            </div>
          )}
        </div>
        {target && states && (
          <p className="dk-muted" data-testid="halt-current">
            Right now: {SCOPE_LABEL[p.scope]} for {describeTarget(target)} is {halted ? 'HALTED' : 'running'} (version{' '}
            {versionFor(states, p.scope, target)}).
          </p>
        )}
        <div className="adm-field">
          <label htmlFor="ph-reason">Why (recorded with the change, 12 to 500 characters)</label>
          <textarea
            id="ph-reason"
            className="adm-textarea"
            rows={3}
            maxLength={500}
            value={p.reason}
            onChange={(e) => p.onReason(e.target.value)}
          />
        </div>
        <div className="adm-field">
          <label htmlFor="ph-confirm">
            Type <code>{phrase}</code> to confirm
          </label>
          <input
            id="ph-confirm"
            className="adm-input"
            value={p.confirm}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => p.onConfirm(e.target.value)}
          />
        </div>
        <div className="dk-row">
          <button type="submit" className="adm-btn" data-tone={wantHalt ? 'danger' : 'primary'} disabled={!gate.ok || confirming !== null}>
            {p.busy ? 'Sending…' : wantHalt ? 'Halt now' : 'Ask for a second founder to confirm the clear'}
          </button>
          {!gate.ok && <span className="dk-why">{gate.why}</span>}
        </div>
      </form>

      {read && read.pending.kind === 'failed' && <PartFailed name="Pending clears" part={read.pending} />}
      {read && read.pending.kind === 'ok' && (
        <div className="dk-stack">
          <h3>Clears waiting for a second founder</h3>
          <PendingClearsTable
            proposals={read.pending.data.proposals}
            userId={p.userId}
            onPick={p.onPick}
            picked={confirming?.requestId ?? null}
          />
        </div>
      )}
      {confirming && (
        <form
          className="dk-stack"
          data-testid="confirm-clear-form"
          onSubmit={(e) => {
            e.preventDefault();
            p.onSubmit();
          }}
        >
          <h3>
            Confirm clearing: {SCOPE_LABEL[confirming.scope]} for {describeTarget(confirming.target)}
          </h3>
          <p className="dk-muted">
            Proposed by {shortId(confirming.requestedByUserId)} with the reason: {confirming.reason}. Confirming lifts the halt: this
            operation runs again for everyone it covers.
          </p>
          <div className="adm-field">
            <label htmlFor="ph-reason2">Your reason (12 to 500 characters)</label>
            <textarea
              id="ph-reason2"
              className="adm-textarea"
              rows={2}
              maxLength={500}
              value={p.reason}
              onChange={(e) => p.onReason(e.target.value)}
            />
          </div>
          <div className="adm-field">
            <label htmlFor="ph-confirm2">
              Type <code>{haltPhrase(confirming.scope, false)}</code> to confirm
            </label>
            <input
              id="ph-confirm2"
              className="adm-input"
              value={p.confirm}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => p.onConfirm(e.target.value)}
            />
          </div>
          <div className="dk-row">
            <button
              type="submit"
              className="adm-btn"
              data-tone="primary"
              disabled={
                !setGate({
                  scope: confirming.scope,
                  target: confirming.target,
                  halted: false,
                  reason: p.reason,
                  confirm: p.confirm,
                  busy: p.busy,
                }).ok
              }
            >
              {p.busy ? 'Sending…' : 'Confirm the clear'}
            </button>
            <button type="button" className="adm-btn" onClick={() => p.onPick(null)} disabled={p.busy}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {p.reply && <HaltReplyView reply={p.reply} />}

      {read && read.history.kind === 'failed' && <PartFailed name="History" part={read.history} />}
      {read && read.history.kind === 'ok' && (
        <div className="dk-stack">
          <h3>Recent changes</h3>
          <HaltHistoryTable events={read.history.data} />
        </div>
      )}
    </section>
  );
}

export function PayHaltsDesk({ initial, userId }: { initial: PayHaltsRead | null; userId: string }) {
  const [read, setRead] = useState<PayHaltsRead | null>(initial);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<PayHaltScope>('intake');
  const [level, setLevel] = useState<TargetLevel>('global');
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<HaltReply | null>(null);
  const [picked, setPicked] = useState<PayHaltPendingClear | null>(null);
  const [requestId, setRequestId] = useState(newRequestId);
  const lock = useRef(false);
  const sequence = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    setLoading(true);
    const next = await fetchPayHalts();
    if (mine === sequence.current) {
      setRead(next);
      setLoading(false);
    }
  }, []);

  async function submit() {
    if (lock.current) return;
    const states = read && read.status.kind === 'ok' ? read.status.data.states : null;
    let request: HaltRequest | null = null;
    if (picked) {
      request = {
        action: 'confirm_clear',
        requestId: picked.requestId,
        scope: picked.scope,
        target: picked.target,
        reason: reason.trim(),
        expectedVersion: picked.expectedVersion,
        confirm,
      };
    } else {
      const target = targetFrom(level, targetId);
      if (!states || !target) return;
      const halted = stateFor(states, scope, target)?.halted ?? false;
      request = {
        action: halted ? 'clear' : 'halt',
        requestId,
        scope,
        target,
        reason: reason.trim(),
        expectedVersion: versionFor(states, scope, target),
        confirm,
      };
    }
    lock.current = true;
    setBusy(true);
    setReply(null);
    try {
      const result = await postHalt(request);
      setReply(result);
      // A definite answer ends this attempt. An unknown one keeps the request id, so repeating it is the same request.
      if (result.ok || result.refusal.changed === 'no') {
        setRequestId(newRequestId());
        if (result.ok) {
          setReason('');
          setConfirm('');
          setPicked(null);
        }
      }
      await reload();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <PayHaltsDeskView
      read={read}
      userId={userId}
      loading={loading}
      scope={scope}
      level={level}
      targetId={targetId}
      reason={reason}
      confirm={confirm}
      busy={busy}
      reply={reply}
      picked={picked}
      onRead={() => void reload()}
      onScope={setScope}
      onLevel={(v) => {
        setLevel(v);
        setTargetId('');
      }}
      onTargetId={setTargetId}
      onReason={setReason}
      onConfirm={setConfirm}
      onSubmit={() => void submit()}
      onPick={(p) => {
        setPicked(p);
        setReason(p ? p.reason : '');
        setConfirm('');
        setReply(null);
      }}
    />
  );
}
