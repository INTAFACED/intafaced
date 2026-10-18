'use client';

import { useCallback, useRef, useState } from 'react';
import { fetchCompliance, postDisposition, type DisposeReply } from '@/lib/compliance/browser';
import {
  dispositionGate,
  dispositionPhrase,
  type ComplianceRead,
  type ComplianceSection,
  type Disposition,
  type QueueItem,
} from '@/lib/compliance/model';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { actorRef, codeWords } from '@/lib/desk/words';

/**
 * LIVE COMPLIANCE STATE — what svc-edge says right now, with an as-of time.
 *
 * Replaces nothing in the compiled policy matrix below; it sits above it. The matrix is what the build says should
 * happen; this is what the running edge reports. An unreadable section says why and shows no placeholder, and an empty
 * queue is only "empty" because the edge said so.
 */

function Failed({ name, section }: { name: string; section: Extract<ComplianceSection<unknown>, { kind: 'failed' }> }) {
  return (
    <div className="adm-callout" data-tone="danger" role="status">
      <strong>{name} unavailable</strong>
      <p>{section.message}</p>
      {section.code && <p className="dk-muted">Code: {section.code}</p>}
    </div>
  );
}

export interface ComplianceViewProps {
  readonly read: ComplianceRead | null;
  readonly loading: boolean;
  readonly picked: { item: QueueItem; status: Disposition } | null;
  readonly reason: string;
  readonly confirm: string;
  readonly busy: boolean;
  readonly reply: DisposeReply | null;
  readonly onRead: () => void;
  readonly onPick: (p: { item: QueueItem; status: Disposition } | null) => void;
  readonly onReason: (v: string) => void;
  readonly onConfirm: (v: string) => void;
  readonly onSubmit: () => void;
}

export function ComplianceLiveView(p: ComplianceViewProps) {
  const { read, picked } = p;
  const gate = picked
    ? dispositionGate({ status: picked.status, itemId: picked.item.id, reason: p.reason, confirm: p.confirm, busy: p.busy })
    : ({ ok: false, why: '' } as const);
  return (
    <section className="dk" aria-labelledby="cl-title" data-testid="compliance-live">
      <div className="dk-row">
        <h2 id="cl-title">Live compliance state</h2>
        <button type="button" className="adm-btn" onClick={p.onRead} disabled={p.loading}>
          {p.loading ? 'Reading…' : 'Refresh'}
        </button>
        <span className="dk-asof">{read ? `As of ${formatAsOf(read.asOf)} (when this console read svc-edge)` : 'No read yet'}</span>
      </div>
      {!read && <p className="dk-why">svc-edge could not be read. Nothing is shown rather than a guess.</p>}

      {read && read.status.kind === 'failed' && <Failed name="Edge compliance status" section={read.status} />}
      {read && read.status.kind === 'ok' && (
        <div className="dk-grid-2" data-testid="edge-status">
          <div className="dk-badge" data-state={read.status.data.geoBlock.allowed ? 'running' : 'stopped'}>
            <strong>Geo-block verdict: {read.status.data.geoBlock.allowed ? 'allowed' : 'refused'}</strong>
            <span className="dk-muted">
              This is the edge’s verdict for the region it resolved for THIS console’s own request ({read.status.data.region.code}), not for
              any customer region.
            </span>
            <span className="dk-muted">{read.status.data.geoBlock.reason}</span>
            <span className="dk-muted">
              Screening list: {read.status.data.geoBlock.screeningConfigured ? 'configured' : 'not configured'} (
              {read.status.data.geoBlock.screeningDeclaration}); no blocked list is invented.
            </span>
          </div>
          <div className="dk-badge" data-state={read.status.data.region.regionResolved ? 'running' : 'unknown'}>
            <strong>Region resolution: {read.status.data.region.regionResolved ? 'resolved' : 'NOT resolved'}</strong>
            <span className="dk-muted">{read.status.data.region.statusLine}</span>
          </div>
          <div className="dk-badge" data-state={read.status.data.networkSignal.partnerConfigured ? 'running' : 'unknown'}>
            <strong>
              Network (VPN) signal: {read.status.data.networkSignal.partnerConfigured ? 'partner configured' : 'no partner configured'}
            </strong>
            <span className="dk-muted">{read.status.data.networkSignal.statusLine}</span>
            <span className="dk-muted">{read.status.data.networkSignal.summary}</span>
          </div>
          <div className="dk-badge" data-state="unknown">
            <strong>Freeze authority</strong>
            <span className="dk-muted">Sole key: {read.status.data.freezeAuthority.soleKey}</span>
            <span className="dk-muted">{read.status.data.freezeAuthority.note}</span>
          </div>
        </div>
      )}

      {read && read.queue.kind === 'failed' && <Failed name="Compliance queue" section={read.queue} />}
      {read && read.queue.kind === 'ok' && (
        <div className="dk-stack" data-testid="compliance-queue">
          <h3>Compliance queue</h3>
          <p className="dk-muted">{read.queue.data.summary}</p>
          <p className="dk-muted">
            This queue lives in the edge’s memory: it is empty again after an edge restart, and nothing opens a case automatically. A clear
            or reject is one founder’s decision; the edge records its own credential’s user, and this console logs which founder pressed the
            button.
          </p>
          {read.queue.data.items.length > 0 && (
            <div className="dk-table-wrap" role="region" aria-label="Compliance cases" tabIndex={0}>
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Kind</th>
                    <th>Subject</th>
                    <th>Opened</th>
                    <th>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {read.queue.data.items.map((item) => (
                    <tr key={item.id}>
                      <td className="dk-packet">{item.id}</td>
                      <td>{item.kind}</td>
                      <td className="dk-packet">{item.subjectId}</td>
                      <td>{formatWhen(item.openedAt)}</td>
                      <td>
                        <div className="dk-row">
                          <button type="button" className="adm-btn" onClick={() => p.onPick({ item, status: 'cleared' })}>
                            Clear…
                          </button>
                          <button
                            type="button"
                            className="adm-btn"
                            data-tone="danger"
                            onClick={() => p.onPick({ item, status: 'rejected' })}
                          >
                            Reject…
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {picked && (
            <form
              className="dk-stack"
              data-testid="disposition-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (gate.ok) p.onSubmit();
              }}
            >
              <h4>
                {picked.status === 'cleared' ? 'Clear' : 'Reject'} case {picked.item.id}
              </h4>
              <p className="dk-muted">
                {picked.status === 'cleared'
                  ? 'Clearing removes the case from the queue and records an operator clearance. It cannot be undone from here.'
                  : 'Rejecting removes the case from the queue and records an operator rejection with your reason. It cannot be undone from here.'}
              </p>
              <div className="adm-field">
                <label htmlFor="cl-reason">Why (12 to 500 characters)</label>
                <textarea
                  id="cl-reason"
                  className="adm-textarea"
                  rows={2}
                  maxLength={500}
                  value={p.reason}
                  onChange={(e) => p.onReason(e.target.value)}
                />
              </div>
              <div className="adm-field">
                <label htmlFor="cl-confirm">
                  Type <code>{dispositionPhrase(picked.status, picked.item.id)}</code> to confirm
                </label>
                <input
                  id="cl-confirm"
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
                  data-tone={picked.status === 'rejected' ? 'danger' : 'primary'}
                  disabled={!gate.ok}
                >
                  {p.busy ? 'Sending…' : picked.status === 'cleared' ? 'Clear this case' : 'Reject this case'}
                </button>
                <button type="button" className="adm-btn" onClick={() => p.onPick(null)} disabled={p.busy}>
                  Cancel
                </button>
                {!gate.ok && gate.why && <span className="dk-why">{gate.why}</span>}
              </div>
            </form>
          )}
          {p.reply && (
            <div
              className="adm-callout"
              role={p.reply.ok ? 'status' : 'alert'}
              data-testid="disposition-reply"
              data-tone={p.reply.ok ? 'ok' : p.reply.refusal.changed === 'unknown' ? 'warn' : 'danger'}
            >
              {p.reply.ok ? (
                <>
                  <strong>
                    Case {p.reply.itemId} {p.reply.status}
                  </strong>
                  <p>svc-edge confirmed it. The queue above was read again.</p>
                </>
              ) : (
                <>
                  <strong>{p.reply.refusal.title}</strong>
                  <p>{p.reply.refusal.body}</p>
                  <p>{p.reply.refusal.next}</p>
                </>
              )}
            </div>
          )}
          <h3>Recent dispositions</h3>
          {read.queue.data.recentAudit.length === 0 ? (
            <p className="dk-muted">No case has been opened or dispositioned since the edge started.</p>
          ) : (
            <div className="dk-table-wrap" role="region" aria-label="Recent dispositions" tabIndex={0}>
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Case</th>
                    <th>Result</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {read.queue.data.recentAudit.map((a, i) => (
                    <tr key={`${a.at}-${i}`}>
                      <td>{formatWhen(a.at)}</td>
                      <td className="dk-packet">{a.itemId}</td>
                      <td>{a.ok ? (a.status ?? 'recorded') : `refused${a.code ? ` (${codeWords(a.code)})` : ''}`}</td>
                      <td>{actorRef(a.actor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function ComplianceLive({ initial }: { initial: ComplianceRead | null }) {
  const [read, setRead] = useState<ComplianceRead | null>(initial);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<{ item: QueueItem; status: Disposition } | null>(null);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<DisposeReply | null>(null);
  const lock = useRef(false);
  const sequence = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    setLoading(true);
    const next = await fetchCompliance();
    if (mine === sequence.current) {
      setRead(next);
      setLoading(false);
    }
  }, []);

  async function submit() {
    if (lock.current || !picked) return;
    lock.current = true;
    setBusy(true);
    setReply(null);
    try {
      const result = await postDisposition({ itemId: picked.item.id, status: picked.status, reason: reason.trim(), confirm });
      setReply(result);
      if (result.ok) {
        setPicked(null);
        setReason('');
        setConfirm('');
      }
      await reload();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <ComplianceLiveView
      read={read}
      loading={loading}
      picked={picked}
      reason={reason}
      confirm={confirm}
      busy={busy}
      reply={reply}
      onRead={() => void reload()}
      onPick={(v) => {
        setPicked(v);
        setReason('');
        setConfirm('');
        setReply(null);
      }}
      onReason={setReason}
      onConfirm={setConfirm}
      onSubmit={() => void submit()}
    />
  );
}
