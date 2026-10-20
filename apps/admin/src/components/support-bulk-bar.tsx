'use client';

import { useEffect, useRef, useState } from 'react';
import { shortId } from '@/lib/desk/desk-model';
import { fetchStaff } from '@/lib/support/browser';
import {
  bulkChangeOf,
  bulkCodeWords,
  bulkGate,
  bulkTally,
  emptyBulkForm,
  type BulkForm,
  type BulkKind,
  type BulkPolicyView,
  type BulkRow,
} from '@/lib/support/bulk';
import { fetchBulkPolicy, postBulk, type BulkReply } from '@/lib/support/bulk-browser';
import { PRIORITIES, STATUS_CHOICES, REASON_MAX, type Priority } from '@/lib/support/model';
import type { StaffMemberView } from '@/lib/support/staff';
import type { TicketStatus } from '@/lib/support/types';
import { ConfirmStep } from './support-action-parts';

/**
 * BULK CHANGE — one change to every ticked request in the queue.
 *
 * The bar sends one batch under one key: an assignee, a status or a priority, with an optional reason that is kept in the
 * log. svc-support answers each request on its own (changed, already there, or refused with a reason), and this shows that
 * list as it came back. The batch size is the owner's setting; while it is blank the bar says so and sends nothing.
 * Sending takes a second click, and the same key is kept until an answer is known so a retry cannot change anything twice.
 */

const KIND_LABEL: Record<BulkKind, string> = { status: 'Status', priority: 'Priority', assign: 'Assignee' };

export interface BulkBarViewProps {
  readonly selected: readonly string[];
  /** The batch size, `null` while the owner has not set it, or absent when it could not be read. */
  readonly policy: BulkPolicyView | null;
  readonly policyFailed: string | null;
  readonly roster: readonly StaffMemberView[] | null;
  readonly form: BulkForm;
  readonly armed: boolean;
  readonly busy: boolean;
  readonly reply: BulkReply | null;
  readonly onField: (patch: Partial<BulkForm>) => void;
  readonly onArm: (on: boolean) => void;
  readonly onSend: () => void;
  readonly onClear: () => void;
}

function consequenceOf(form: BulkForm, count: number): string {
  const change = bulkChangeOf(form);
  const what =
    change?.kind === 'status'
      ? `set the status to ${change.status}`
      : change?.kind === 'priority'
        ? change.priority === null
          ? 'clear the priority'
          : `set the priority to ${change.priority}`
        : change?.kind === 'assign'
          ? `assign them to ${shortId(change.assigneeId)}`
          : 'make the change';
  return `This will ${what} on ${count} request${count === 1 ? '' : 's'}. svc-support answers each one on its own: one that cannot take the change is refused and the rest still change. Nothing is undone by cancelling after this.`;
}

function ResultList({ rows }: { rows: readonly BulkRow[] }) {
  const t = bulkTally(rows);
  return (
    <div className="dk-table-wrap" role="region" aria-label="Bulk change results" tabIndex={0} data-testid="bulk-results">
      <p className="dk-muted">
        {t.changed} changed, {t.unchanged} already there, {t.refused} refused.
      </p>
      <table className="adm-table">
        <thead>
          <tr>
            <th>Request</th>
            <th>Answer</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.ticketId} data-testid={`bulk-row-${r.ticketId}`}>
              <td className="dk-packet">{shortId(r.ticketId)}</td>
              <td>{r.outcome === 'changed' ? 'Changed' : r.outcome === 'unchanged' ? 'Already there' : 'Refused'}</td>
              <td>{bulkCodeWords(r.code)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SupportBulkBarView(p: BulkBarViewProps) {
  const gate = bulkGate({ selected: p.selected.length, policy: p.policy }, p.form, p.busy);
  const cap = p.policy?.cap ?? null;
  return (
    <section className="dk-stack" aria-label="Change several requests" data-testid="bulk-bar">
      <h2>Change several requests</h2>
      {p.policyFailed !== null ? (
        <p className="dk-why" data-testid="bulk-policy-failed">
          {p.policyFailed}
        </p>
      ) : p.policy && cap === null ? (
        <p className="dk-why" data-testid="bulk-cap-unset">
          The owner has not set how many requests can change at once (support.bulk_cap), so svc-support refuses bulk changes. Nothing is
          sent from here until it is set.
        </p>
      ) : (
        <p className="dk-muted" data-testid="bulk-cap">
          {cap === null ? 'Reading the batch size…' : `The owner allows up to ${cap} requests at a time.`}
        </p>
      )}
      <p data-testid="bulk-count">
        {p.selected.length} request{p.selected.length === 1 ? '' : 's'} ticked.{' '}
        {p.selected.length > 0 && (
          <button type="button" className="adm-btn" onClick={p.onClear} disabled={p.busy}>
            Untick all
          </button>
        )}
      </p>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="sd-bulk-kind">Change</label>
          <select
            id="sd-bulk-kind"
            className="adm-input"
            value={p.form.kind}
            disabled={p.busy || p.armed}
            onChange={(e) => p.onField({ kind: e.target.value as BulkKind })}
          >
            {(Object.keys(KIND_LABEL) as BulkKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        {p.form.kind === 'status' && (
          <div className="adm-field">
            <label htmlFor="sd-bulk-status">New status</label>
            <select
              id="sd-bulk-status"
              className="adm-input"
              value={p.form.status}
              disabled={p.busy || p.armed}
              onChange={(e) => p.onField({ status: e.target.value as TicketStatus | '' })}
            >
              <option value="">Choose…</option>
              {STATUS_CHOICES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}
        {p.form.kind === 'priority' && (
          <div className="adm-field">
            <label htmlFor="sd-bulk-priority">New priority</label>
            <select
              id="sd-bulk-priority"
              className="adm-input"
              value={p.form.priority}
              disabled={p.busy || p.armed}
              onChange={(e) => p.onField({ priority: e.target.value as Priority | 'none' | '' })}
            >
              <option value="">Choose…</option>
              {PRIORITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              <option value="none">Clear the priority</option>
            </select>
          </div>
        )}
        {p.form.kind === 'assign' && (
          <div className="adm-field">
            <label htmlFor="sd-bulk-assignee">Assign to</label>
            <select
              id="sd-bulk-assignee"
              className="adm-input"
              value={p.form.assigneeId}
              disabled={p.busy || p.armed || p.roster === null}
              onChange={(e) => p.onField({ assigneeId: e.target.value })}
            >
              <option value="">{p.roster === null ? 'Staff list not read' : 'Choose…'}</option>
              {(p.roster ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {shortId(m.userId)} ({m.role})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="adm-field">
        <label htmlFor="sd-bulk-reason">Reason (optional, kept in the log)</label>
        <input
          id="sd-bulk-reason"
          className="adm-input"
          type="text"
          maxLength={REASON_MAX}
          value={p.form.reason}
          disabled={p.busy || p.armed}
          onChange={(e) => p.onField({ reason: e.target.value })}
        />
      </div>
      {p.armed ? (
        <ConfirmStep
          title="Send this change?"
          consequence={consequenceOf(p.form, p.selected.length)}
          confirmLabel="Yes, change them"
          busy={p.busy}
          onConfirm={p.onSend}
          onCancel={() => p.onArm(false)}
        />
      ) : (
        <div className="dk-row">
          <button type="button" className="adm-btn" data-tone="primary" disabled={!gate.ok} onClick={() => p.onArm(true)}>
            Change {p.selected.length} request{p.selected.length === 1 ? '' : 's'}
          </button>
          {!gate.ok && <span className="dk-why">{gate.why}</span>}
        </div>
      )}
      {p.reply && !p.reply.ok && (
        <div
          className="adm-callout"
          role="alert"
          data-tone={p.reply.refusal.changed === 'unknown' ? 'warn' : 'danger'}
          data-testid="bulk-refusal"
        >
          <strong>{p.reply.refusal.title}</strong>
          <p>{p.reply.refusal.body}</p>
          <p>{p.reply.refusal.next}</p>
        </div>
      )}
      {p.reply && p.reply.ok && (
        <>
          <div className="adm-callout" role="status" data-tone="ok" data-testid="bulk-done">
            <strong>Done</strong>
            <p>{p.reply.summary}</p>
          </div>
          <ResultList rows={p.reply.rows} />
        </>
      )}
    </section>
  );
}

/** The bar wired to svc-support. It reads the batch size and the staff list once, the first time something is ticked. */
export function SupportBulkBar({ selected, onDone, onClear }: { selected: readonly string[]; onDone: () => void; onClear: () => void }) {
  const [policy, setPolicy] = useState<BulkPolicyView | null>(null);
  const [policyFailed, setPolicyFailed] = useState<string | null>(null);
  const [roster, setRoster] = useState<readonly StaffMemberView[] | null>(null);
  const [form, setForm] = useState<BulkForm>(emptyBulkForm);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<BulkReply | null>(null);
  const loaded = useRef(false);
  const lock = useRef(false);
  const batchKey = useRef('');

  const first = selected.length > 0;
  useEffect(() => {
    if (!first || loaded.current) return;
    loaded.current = true;
    const ac = new AbortController();
    void (async () => {
      const [pol, staff] = await Promise.all([fetchBulkPolicy(ac.signal), fetchStaff(ac.signal)]);
      if (ac.signal.aborted) return;
      if (!pol || pol.policy.kind === 'failed') {
        setPolicyFailed(
          pol?.policy.kind === 'failed'
            ? `The batch size could not be read: ${pol.policy.message}`
            : 'The batch size could not be read from svc-support, so nothing is sent.',
        );
      } else {
        setPolicy(pol.policy.data);
      }
      if (staff && staff.roster.kind === 'ok') setRoster(staff.roster.data);
    })();
    return () => ac.abort();
  }, [first]);

  function arm(on: boolean) {
    if (on) batchKey.current = `batch:${crypto.randomUUID()}`;
    setArmed(on);
  }

  async function send() {
    const change = bulkChangeOf(form);
    if (lock.current || !change) return;
    lock.current = true;
    setBusy(true);
    setReply(null);
    try {
      const result = await postBulk({
        batchKey: batchKey.current,
        ticketIds: selected,
        change,
        ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
      });
      setReply(result);
      // A known answer ends this batch: the next one is a new key. A refusal that changed nothing keeps it for the retry.
      if (result.ok || result.refusal.changed === 'no') setArmed(false);
      if (result.ok) {
        setForm(emptyBulkForm);
        onClear();
        onDone();
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <SupportBulkBarView
      selected={selected}
      policy={policy}
      policyFailed={policyFailed}
      roster={roster}
      form={form}
      armed={armed}
      busy={busy}
      reply={reply}
      onField={(patch) => setForm((f) => ({ ...f, ...patch }))}
      onArm={arm}
      onSend={() => void send()}
      onClear={onClear}
    />
  );
}
