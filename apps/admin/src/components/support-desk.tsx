'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Chip } from '@/components/chip';
import { shortId } from '@/lib/desk/desk-model';
import type { Part } from '@/lib/desk/part';
import { fetchQueue, fetchTicket, fetchTicketExtras, postClaim, postClaimNext, type ClaimReply } from '@/lib/support/browser';
import { claimGate, DESK_COMMENTS_READ, formatAge, queueMetrics, type ClaimGate } from '@/lib/support/model';
import type { QueueRead, SupportQueueView, SupportTicketView, TicketDetail, TicketExtrasView } from '@/lib/support/types';
import { Failed } from './support-action-parts';
import { SupportBulkBar } from './support-bulk-bar';
import { TicketActions } from './support-ticket-actions';
import { CustomerCard } from './support-customer-card';
import { TicketOwner } from './support-ticket-owner';
import { RatingsSummary } from './support-ratings-summary';
import { TicketExtras } from './support-ticket-extras';
import { TicketFiles } from './support-ticket-files';
import { TicketLifecycle } from './support-ticket-lifecycle';
import { TicketMerge } from './support-ticket-merge';
import { TicketProperties } from './support-ticket-properties';
import { QueueFilters } from './support-queue-filters';
import { EMPTY_QUERY } from '@/lib/support/queue-query';
import { historyRows, type HistoryRow } from '@/lib/support/history';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';

/**
 * SUPPORT DESK — list, then ticket, then claim, reply, set status, escalate; with the ticket's case file and rating, and the help articles.
 *
 * Counts and ages are of the tickets svc-support returned for this page, and the desk says how many that is. The
 * score orders the queue; svc-support marks it "not a promise", and so does this page. A claim assigns the ticket to
 * the founder who pressed it; there is no release from here, so it takes a second click.
 */

export function QueueMetricsView({ read }: { read: QueueRead }) {
  const m = queueMetrics(read);
  return (
    <div className="dk-stack" data-testid="queue-metrics">
      <div className="dk-row">
        <Chip tone="info">{m.shown} shown</Chip>
        {Object.entries(m.byStatus).map(([k, v]) => (
          <Chip key={k} tone={k === 'open' ? 'warn' : 'neutral'}>
            {v} {k}
          </Chip>
        ))}
        <span className="dk-muted">Oldest: {m.oldestAgeMs === null ? 'none' : formatAge(m.oldestAgeMs)}</span>
      </div>
      <div className="dk-row">
        {Object.entries(m.byCategory).map(([k, v]) => (
          <span key={k} className="dk-muted">
            {k}: {v}
          </span>
        ))}
      </div>
      <p className="dk-muted">
        {m.pageFull
          ? `This is the first ${read.limit} tickets the queue returned, and the page is full: there may be more. These are not totals.`
          : `The queue returned ${m.shown} ticket${m.shown === 1 ? '' : 's'} and nothing more. The score only orders the list; it is not a response-time promise.`}
      </p>
    </div>
  );
}

export interface DeskViewProps {
  readonly queue: SupportQueueView | null;
  readonly ticket: SupportTicketView | null;
  readonly ticketId: string | null;
  readonly userId: string;
  readonly loadingQueue: boolean;
  readonly loadingTicket: boolean;
  readonly arming: boolean;
  readonly busy: boolean;
  readonly reply: ClaimReply | null;
  readonly extras: TicketExtrasView | null;
  readonly loadingExtras: boolean;
  /** A reply, status change or escalation was sent (whatever the answer): read the ticket and its extras again. */
  readonly onActionDone: () => void;
  readonly children?: ReactNode;
  /** The filter, search and saved views over the queue. Absent when the page offers none. */
  readonly filters?: ReactNode;
  readonly onRefresh: () => void;
  readonly onOpen: (id: string) => void;
  readonly onClose: () => void;
  readonly onArm: (v: boolean) => void;
  readonly onClaim: () => void;
  /** Claim whichever request the queue ranks first, and open it at its own address. */
  readonly onClaimNext: () => void;
  readonly claimingNext: boolean;
  /** svc-support's answer to the last "claim the next request"; null before one. */
  readonly nextReply: ClaimReply | null;
  /** The ticked requests for a bulk change. Absent when the page offers no bulk bar. */
  readonly bulk?: {
    readonly selected: ReadonlySet<string>;
    readonly onToggle: (id: string) => void;
    readonly onToggleAll: (ids: readonly string[], on: boolean) => void;
    readonly bar: ReactNode;
  };
}

function TicketPanel(p: DeskViewProps) {
  if (!p.ticketId) return null;
  const view = p.ticket;
  return (
    <section className="dk-stack" aria-label="Ticket" data-testid="ticket-detail">
      <div className="dk-row">
        <h3>Ticket {shortId(p.ticketId)}</h3>
        <button type="button" className="adm-btn" onClick={p.onClose}>
          Back to the queue
        </button>
        <span className="dk-asof">{view ? `As of ${formatAsOf(view.asOf)}` : 'Reading…'}</span>
      </div>
      {p.loadingTicket && !view && <p className="dk-muted">Reading the ticket…</p>}
      {view && view.detail.kind === 'failed' && <Failed name="Ticket" part={view.detail} />}
      {view && view.detail.kind === 'ok' && <TicketBody detail={view.detail.data} {...p} />}
    </section>
  );
}

function TicketBody({ detail, ...p }: { detail: TicketDetail } & DeskViewProps) {
  const t = detail.ticket;
  const gate: ClaimGate = claimGate(t, p.userId, p.busy);
  const mine = t.assigneeId !== null && t.assigneeId.toLowerCase() === p.userId.toLowerCase();
  return (
    <>
      <dl className="dk-kv">
        <dt>Subject</dt>
        <dd>{t.subject}</dd>
        <dt>Category</dt>
        <dd>{t.category}</dd>
        <dt>Status</dt>
        <dd>{t.status}</dd>
        <dt>Customer account id</dt>
        <dd>
          <span className="dk-packet" title={t.userId}>
            {shortId(t.userId)}
          </span>{' '}
          <span className="dk-muted" data-testid="customer-no-handle">
            No handle: svc-identity has no operator read that names an account from its id (back-end need 47).
          </span>
        </dd>
        <dt>Owner</dt>
        <dd>{t.assigneeId === null ? 'Nobody yet' : mine ? 'You' : shortId(t.assigneeId)}</dd>
        <dt>Opened</dt>
        <dd>{formatWhen(t.createdAt)}</dd>
        <dt>Last updated</dt>
        <dd>{formatWhen(t.updatedAt)}</dd>
      </dl>
      <div className="adm-callout">
        <strong>What the customer wrote</strong>
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t.body}</p>
      </div>

      <div className="dk-stack" data-testid="claim-box">
        {p.arming ? (
          <div className="adm-callout" data-tone="warn">
            <strong>Claim this ticket?</strong>
            <p>It becomes yours until you unclaim it or a lead gives it to someone else.</p>
            <div className="dk-row">
              <button type="button" className="adm-btn" data-tone="primary" onClick={p.onClaim} disabled={!gate.ok}>
                {p.busy ? 'Claiming…' : 'Yes, claim it'}
              </button>
              <button type="button" className="adm-btn" onClick={() => p.onArm(false)} disabled={p.busy}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="dk-row">
            <button type="button" className="adm-btn" data-tone="primary" disabled={!gate.ok} onClick={() => p.onArm(true)}>
              Claim this ticket
            </button>
            {!gate.ok && <span className="dk-why">{gate.why}</span>}
          </div>
        )}
        {p.reply && (
          <div
            className="adm-callout"
            role={p.reply.ok ? 'status' : 'alert'}
            data-testid="claim-reply"
            data-code={p.reply.ok ? undefined : (p.reply.refusal.code ?? undefined)}
            data-tone={p.reply.ok ? 'ok' : p.reply.refusal.changed === 'unknown' ? 'warn' : 'danger'}
          >
            {p.reply.ok ? (
              <>
                <strong>
                  {p.reply.assigneeId !== null && p.reply.assigneeId.toLowerCase() === p.userId.toLowerCase()
                    ? 'Claimed. svc-support says the ticket is now owned by you'
                    : `svc-support says the ticket is now owned by ${p.reply.assigneeId ? shortId(p.reply.assigneeId) : 'nobody'}`}
                </strong>
                <p>The ticket above was read again.</p>
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
      </div>

      <TicketOwner key={`owner:${t.id}`} ticket={t} events={detail.events} userId={p.userId} onDone={p.onActionDone} />
      <CustomerCard key={`customer:${t.id}`} ticketId={t.id} />

      <h4>Conversation</h4>
      {detail.comments.kind === 'failed' ? (
        <Failed name="Comments" part={detail.comments} />
      ) : detail.comments.data.length === 0 ? (
        <p className="dk-muted">No comments yet.</p>
      ) : (
        <ol className="dk-stack" aria-label="Comments">
          {detail.comments.data.map((c) => (
            <li key={c.id} className="adm-callout" data-visibility={c.visibility}>
              <strong>
                {c.visibility === 'internal' ? 'Internal note' : c.authorRole === 'operator' ? 'Staff' : 'Customer'} ·{' '}
                {formatWhen(c.createdAt)}
              </strong>
              {c.visibility === 'internal' && (
                <span className="adm-chip" data-tone="warn">
                  Staff only · the customer does not see this
                </span>
              )}
              <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{c.body}</p>
            </li>
          ))}
        </ol>
      )}

      <h4>What happened to this ticket</h4>
      {detail.events.kind === 'failed' && <Failed name="History" part={detail.events} />}
      {detail.propertyChanges.kind === 'failed' && <Failed name="Priority, type and label changes" part={detail.propertyChanges} />}
      <TicketHistory
        rows={historyRows(
          detail.events.kind === 'ok' ? detail.events.data : [],
          detail.propertyChanges.kind === 'ok' ? detail.propertyChanges.data : [],
        )}
        anyFailed={detail.events.kind === 'failed' || detail.propertyChanges.kind === 'failed'}
      />

      <TicketExtras extras={p.extras} loading={p.loadingExtras} />
      <TicketFiles key={`files:${t.id}`} ticketId={t.id} />
      <TicketLifecycle key={`lifecycle:${t.id}`} ticket={t} />
      <TicketProperties key={`properties:${t.id}`} ticket={t} onDone={p.onActionDone} />
      <TicketMerge key={`merge:${t.id}`} ticket={t} onDone={p.onActionDone} />
      <TicketActions
        key={`actions:${t.id}`}
        ticket={t}
        events={detail.events}
        userId={p.userId}
        notesRead={detail.comments.kind === 'ok' ? detail.comments.data.filter((c) => c.visibility === 'internal').length : null}
        notesCapped={detail.comments.kind === 'ok' && detail.comments.data.length >= DESK_COMMENTS_READ}
        onDone={p.onActionDone}
      />
    </>
  );
}

function TicketHistory({ rows, anyFailed }: { rows: readonly HistoryRow[]; anyFailed: boolean }) {
  // "No events recorded" only when every part was read; a failed part already says so above.
  if (rows.length === 0) return anyFailed ? null : <p className="dk-muted">No events recorded.</p>;
  return (
    <div className="dk-table-wrap" role="region" aria-label="Ticket history" tabIndex={0}>
      <table className="adm-table">
        <thead>
          <tr>
            <th>#</th>
            <th>When</th>
            <th>What</th>
            <th>By</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.sequence ?? '—'}</td>
              <td>{formatWhen(r.at)}</td>
              <td>{r.what}</td>
              <td>
                {r.actorRole} {shortId(r.actorId)}
              </td>
              <td>{r.note ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SupportDeskView(p: DeskViewProps) {
  const q = p.queue;
  return (
    <div className="dk" data-testid="support-desk">
      <div className="adm-pagehead">
        <div>
          <h1>Support queue</h1>
          <p>Open and waiting tickets, highest score first. Open one to read it, claim it, reply, change its status or escalate it.</p>
        </div>
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={p.onRefresh} disabled={p.loadingQueue}>
          {p.loadingQueue ? 'Reading…' : 'Refresh'}
        </button>
        <button type="button" className="adm-btn" data-tone="primary" onClick={p.onClaimNext} disabled={p.claimingNext}>
          {p.claimingNext ? 'Claiming…' : 'Claim the next request'}
        </button>
        <span className="dk-asof">{q ? `As of ${formatAsOf(q.asOf)} (when this console read svc-support)` : 'No read yet'}</span>
      </div>
      {p.nextReply && !p.nextReply.ok && (
        <div
          className="adm-callout"
          role="alert"
          data-testid="claim-next-reply"
          data-code={p.nextReply.refusal.code ?? undefined}
          data-tone={p.nextReply.refusal.changed === 'unknown' ? 'warn' : 'danger'}
        >
          <strong>{p.nextReply.refusal.title}</strong>
          <p>{p.nextReply.refusal.body}</p>
          <p>{p.nextReply.refusal.next}</p>
        </div>
      )}
      {q && p.filters}
      {!q && <p className="dk-why">svc-support could not be read. Nothing is shown rather than a guess.</p>}
      {q && q.queue.kind === 'failed' && <Failed name="Support queue" part={q.queue} />}
      {q && q.queue.kind === 'ok' && (
        <>
          <QueueMetricsView read={q.queue.data} />
          {q.queue.data.entries.length === 0 ? (
            <p className="dk-muted" data-testid="queue-empty">
              svc-support says the queue is empty: no open or waiting tickets.
            </p>
          ) : (
            <div className="dk-table-wrap" role="region" aria-label="Support queue" tabIndex={0}>
              <table className="adm-table">
                <thead>
                  <tr>
                    {p.bulk && (
                      <th>
                        <input
                          type="checkbox"
                          aria-label="Tick every request shown"
                          checked={q.queue.data.entries.every((e) => p.bulk!.selected.has(e.ticketId))}
                          onChange={(e) =>
                            p.bulk!.onToggleAll(q.queue.kind === 'ok' ? q.queue.data.entries.map((x) => x.ticketId) : [], e.target.checked)
                          }
                        />
                      </th>
                    )}
                    <th>Subject</th>
                    <th>Category</th>
                    <th>Status</th>
                    <th>Score</th>
                    <th>Waiting</th>
                    <th>Open</th>
                  </tr>
                </thead>
                <tbody>
                  {q.queue.data.entries.map((e) => (
                    <tr key={e.ticketId} data-selected={p.ticketId === e.ticketId}>
                      {p.bulk && (
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Tick ${e.subject}`}
                            checked={p.bulk.selected.has(e.ticketId)}
                            onChange={() => p.bulk!.onToggle(e.ticketId)}
                          />
                        </td>
                      )}
                      <td>{e.subject}</td>
                      <td>{e.category}</td>
                      <td>{e.status}</td>
                      <td>{e.score}</td>
                      <td>{formatAge(e.ageMs)}</td>
                      <td>
                        <button
                          type="button"
                          className="adm-btn"
                          aria-pressed={p.ticketId === e.ticketId}
                          onClick={() => p.onOpen(e.ticketId)}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {p.bulk && q && q.queue.kind === 'ok' && q.queue.data.entries.length > 0 && p.bulk.bar}
      <RatingsSummary />
      <TicketPanel {...p} />
      {p.children}
    </div>
  );
}

/** The request id an address names (`/support/<id>`), or null for the desk itself. */
export function addressTicketId(pathname: string): string | null {
  const match = /\/support\/([0-9a-fA-F-]{36})$/.exec(pathname);
  return match ? match[1]! : null;
}

/** The desk's address with one request open, or with none: `/support/<id>` beside `/support`, keeping the queue's query. */
function deskAddress(ticketId: string | null): string {
  const base = window.location.pathname.replace(/\/support(\/[^/]*)?$/, '/support');
  return `${base}${ticketId ? `/${ticketId}` : ''}${window.location.search}`;
}

export function SupportDesk({
  initial,
  userId,
  openTicketId,
  children,
}: {
  initial: SupportQueueView | null;
  userId: string;
  /** The request named by the address, opened on arrival. */
  openTicketId?: string;
  children?: ReactNode;
}) {
  const [queue, setQueue] = useState<SupportQueueView | null>(initial);
  const [ticket, setTicket] = useState<SupportTicketView | null>(null);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [loadingTicket, setLoadingTicket] = useState(false);
  const [extras, setExtras] = useState<TicketExtrasView | null>(null);
  const [loadingExtras, setLoadingExtras] = useState(false);
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ClaimReply | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [claimingNext, setClaimingNext] = useState(false);
  const [nextReply, setNextReply] = useState<ClaimReply | null>(null);
  const lock = useRef(false);
  const queueSeq = useRef(0);
  const ticketSeq = useRef(0);
  const extrasSeq = useRef(0);

  const reloadQueue = useCallback(async () => {
    const mine = ++queueSeq.current;
    setLoadingQueue(true);
    const next = await fetchQueue(initial?.query ?? EMPTY_QUERY);
    if (mine === queueSeq.current) {
      setQueue(next);
      setLoadingQueue(false);
      // A request that left the queue (changed, closed, taken) is no longer ticked.
      if (next && next.queue.kind === 'ok') {
        const here = new Set(next.queue.data.entries.map((e) => e.ticketId));
        setTicked((t) => new Set([...t].filter((id) => here.has(id))));
      }
    }
  }, [initial?.query]);

  const loadOne = useCallback(async (id: string) => {
    const mine = ++ticketSeq.current;
    setLoadingTicket(true);
    const next = await fetchTicket(id);
    if (mine === ticketSeq.current) {
      setTicket(next);
      setLoadingTicket(false);
    }
  }, []);

  const loadExtras = useCallback(async (id: string) => {
    const mine = ++extrasSeq.current;
    setLoadingExtras(true);
    const next = await fetchTicketExtras(id);
    if (mine === extrasSeq.current) {
      setExtras(next);
      setLoadingExtras(false);
    }
  }, []);

  const open = useCallback(
    (id: string) => {
      setTicketId(id);
      setTicket(null);
      setExtras(null);
      setReply(null);
      setArming(false);
      void loadOne(id);
      void loadExtras(id);
    },
    [loadOne, loadExtras],
  );

  const close = useCallback(() => {
    ticketSeq.current += 1;
    extrasSeq.current += 1;
    setTicketId(null);
    setTicket(null);
    setExtras(null);
    setReply(null);
    setArming(false);
  }, []);

  useEffect(() => {
    if (openTicketId) open(openTicketId);
  }, [openTicketId, open]);

  // Back and Forward move between requests: the open request is always the one the address names.
  useEffect(() => {
    const follow = () => {
      const id = addressTicketId(window.location.pathname);
      if (id) open(id);
      else close();
    };
    window.addEventListener('popstate', follow);
    return () => window.removeEventListener('popstate', follow);
  }, [open, close]);

  async function claimNext() {
    if (lock.current) return;
    lock.current = true;
    setClaimingNext(true);
    setNextReply(null);
    try {
      const result = await postClaimNext();
      setNextReply(result);
      if (result.ok) {
        window.history.pushState(null, '', deskAddress(result.ticketId));
        open(result.ticketId);
      }
      await reloadQueue();
    } finally {
      lock.current = false;
      setClaimingNext(false);
    }
  }

  async function claim() {
    if (lock.current || !ticketId) return;
    lock.current = true;
    setBusy(true);
    setReply(null);
    try {
      const result = await postClaim(ticketId);
      setReply(result);
      setArming(false);
      await Promise.all([loadOne(ticketId), reloadQueue()]);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <SupportDeskView
      queue={queue}
      ticket={ticket}
      ticketId={ticketId}
      userId={userId}
      loadingQueue={loadingQueue}
      loadingTicket={loadingTicket}
      arming={arming}
      busy={busy}
      reply={reply}
      onRefresh={() => void reloadQueue()}
      onOpen={(id) => {
        window.history.pushState(null, '', deskAddress(id));
        open(id);
      }}
      onClose={() => {
        window.history.pushState(null, '', deskAddress(null));
        close();
      }}
      onArm={setArming}
      onClaim={() => void claim()}
      onClaimNext={() => void claimNext()}
      claimingNext={claimingNext}
      nextReply={nextReply}
      bulk={{
        selected: ticked,
        onToggle: (id) =>
          setTicked((t) => {
            const next = new Set(t);
            if (!next.delete(id)) next.add(id);
            return next;
          }),
        onToggleAll: (ids, on) => setTicked(on ? new Set(ids) : new Set()),
        bar: <SupportBulkBar selected={[...ticked]} onClear={() => setTicked(new Set())} onDone={() => void reloadQueue()} />,
      }}
      filters={queue ? <QueueFilters query={queue.query ?? EMPTY_QUERY} view={queue.view ?? null} refused={queue.refused ?? null} /> : null}
      extras={extras}
      loadingExtras={loadingExtras}
      onActionDone={() => {
        if (ticketId) void Promise.all([loadOne(ticketId), loadExtras(ticketId), reloadQueue()]);
      }}
    >
      {children}
    </SupportDeskView>
  );
}
