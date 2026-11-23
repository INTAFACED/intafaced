'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import './desk.css';
import type { QuantModerationEntry } from '@intafaced/contracts';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchLibraryDesk, postLibraryAction } from '@/lib/quant-library-ops/browser';
import { ACTION_WORDS, STATE_WORDS, type LibraryDeskReply, type LibraryDeskView } from '@/lib/quant-library-ops/model';

/**
 * STRATEGY LIBRARY DESK (AL-library-03, J-algo-dev-10), on the market desk.
 *
 * Every published strategy listing, oldest first, with the facts its publish check relied on and never its source. An
 * operator hides one with a reason (it leaves the library, the record stays), unhides it, or removes it for good; each
 * action is an audit row naming who and why. A dispute is opened with its support ticket reference and resolved with a
 * reason. svc-quant decides every action and refuses a blank reason by name.
 */
export function QuantLibraryDesk({ initial }: { initial: LibraryDeskView | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<LibraryDeskReply | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  // The page being read: null is the first; each later page starts after the last listing of the one before.
  const [cursor, setCursor] = useState<string | null>(null);
  const field = (key: string) => fields[key] ?? '';
  const setField = (key: string, value: string) => setFields((f) => ({ ...f, [key]: value }));

  const reload = useCallback(
    async (at: string | null = cursor) => {
      const next = await fetchLibraryDesk(at);
      if (next) {
        setView(next);
        setCursor(at);
      }
    },
    [cursor],
  );

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setReply(await postLibraryAction(body));
    setBusy(false);
    // Whatever the answer, the desk shows what svc-quant holds now.
    await reload();
  };

  const queue = view?.queue;
  return (
    <div className="dk" data-testid="quant-library-desk">
      <div className="adm-pagehead">
        <div>
          <h1>Market desk: strategy library</h1>
          <p>
            <Link href="/more-ops">Back to more modules</Link>
          </p>
        </div>
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={() => void reload()}>
          Refresh
        </button>
        <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      </div>
      <Outcome reply={reply} />
      {!view && <p className="dk-why">The console could not reach its own server for this desk. Nothing is shown rather than a guess.</p>}
      {queue?.kind === 'failed' && (
        <div className="adm-callout" data-tone="danger" role="status" data-testid="library-queue-failed" data-code={queue.code ?? ''}>
          <strong>Could not read the review queue</strong>
          <p>{queue.message}</p>
          {queue.code && <p className="dk-muted">Code: {queue.code}</p>}
        </div>
      )}
      {queue?.kind === 'ok' && (
        <section className="dk-stack" aria-labelledby="h-library-queue">
          <h2 id="h-library-queue">Review queue</h2>
          <p className="dk-muted">
            Oldest first, {queue.data.pageSize} to a page (the owner&rsquo;s page size). A listing&rsquo;s source is never shown here.
          </p>
          {queue.data.entries.length === 0 ? (
            <p className="dk-muted" data-testid="library-queue-empty">
              No strategy has been published yet.
            </p>
          ) : (
            <ol className="dk-stack" data-testid="library-queue">
              {queue.data.entries.map((e) => (
                <Entry key={e.listingId} entry={e} busy={busy} field={field} setField={setField} send={send} />
              ))}
            </ol>
          )}
          <div className="dk-row">
            {cursor !== null && (
              <button type="button" className="adm-btn" onClick={() => void reload(null)}>
                First page
              </button>
            )}
            {queue.data.nextCursor && (
              <button type="button" className="adm-btn" onClick={() => void reload(queue.data.nextCursor)}>
                Next page
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function Entry({
  entry: e,
  busy,
  field,
  setField,
  send,
}: {
  entry: QuantModerationEntry;
  busy: boolean;
  field: (key: string) => string;
  setField: (key: string, value: string) => void;
  send: (body: Record<string, unknown>) => Promise<void>;
}) {
  const reasonKey = `reason:${e.listingId}`;
  const ticketKey = `ticket:${e.listingId}`;
  const disputeKey = `dispute:${e.listingId}`;
  const act = (op: 'hide' | 'unhide' | 'remove') => send({ op, listingId: e.listingId, reason: field(reasonKey), seq: e.audit.length });
  return (
    <li className="dk-stack" data-listing={e.listingId} data-state={e.state} data-testid="library-entry">
      <p>
        <strong>{e.title}</strong> — <span data-testid="library-entry-state">{STATE_WORDS[e.state]}</span>
      </p>
      <dl className="dk-row" data-testid="library-entry-facts">
        <div>
          <dt>Listed</dt>
          <dd>{formatWhen(e.listedAt)}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>
            <code>{e.ownerId}</code>
          </dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>
            {e.strategyVersion}
            {e.facts.stale ? ' (a newer version exists)' : ''}
          </dd>
        </div>
        <div>
          <dt>Visibility</dt>
          <dd>{e.visibility}</dd>
        </div>
        <div>
          <dt>Licence</dt>
          <dd>{e.licence}</dd>
        </div>
        <div>
          <dt>Backtest checked</dt>
          <dd>
            <code>{e.facts.runId}</code>
          </dd>
        </div>
        <div>
          <dt>Realism checklist</dt>
          <dd>{e.facts.checklistVersion}</dd>
        </div>
        <div>
          <dt>Tags</dt>
          <dd>{e.tags.join(', ') || 'none'}</dd>
        </div>
      </dl>
      <p className="dk-muted">{e.description}</p>
      {e.state !== 'removed' && (
        <div className="dk-row">
          <div className="adm-field">
            <label htmlFor={reasonKey}>Reason</label>
            <input id={reasonKey} value={field(reasonKey)} maxLength={500} onChange={(ev) => setField(reasonKey, ev.target.value)} />
          </div>
          {e.state === 'listed' && (
            <button type="button" className="adm-btn" disabled={busy} onClick={() => void act('hide')}>
              Hide
            </button>
          )}
          {e.state === 'hidden' && (
            <button type="button" className="adm-btn" disabled={busy} onClick={() => void act('unhide')}>
              Unhide
            </button>
          )}
          <button type="button" className="adm-btn" disabled={busy} onClick={() => void act('remove')}>
            Remove
          </button>
        </div>
      )}
      <h3>Audit</h3>
      {e.audit.length === 0 ? (
        <p className="dk-muted">No moderation action yet.</p>
      ) : (
        <ul data-testid="library-entry-audit">
          {e.audit.map((a) => (
            <li key={a.seq} data-action={a.action} data-actor={a.actor}>
              {formatWhen(a.at)}: {ACTION_WORDS[a.action]}, by <code>{a.actor}</code>. Reason: {a.reason}
            </li>
          ))}
        </ul>
      )}
      <h3>Disputes</h3>
      {e.disputes.length === 0 ? (
        <p className="dk-muted">No dispute.</p>
      ) : (
        <ul className="dk-stack" data-testid="library-entry-disputes">
          {e.disputes.map((d) => {
            const resolveKey = `resolve:${d.disputeId}`;
            return (
              <li key={d.disputeId} className="dk-stack" data-dispute={d.disputeId} data-state={d.state}>
                <p>
                  Ticket <strong>{d.ticketRef}</strong>, opened {formatWhen(d.openedAt)} by <code>{d.openedBy}</code>: {d.reason}.{' '}
                  <span data-testid="dispute-state">{d.state === 'resolved' ? 'Resolved' : 'Open'}</span>
                </p>
                {d.resolution ? (
                  <p>
                    Resolved {formatWhen(d.resolution.at)} by <code>{d.resolution.actor}</code>. Reason: {d.resolution.reason}
                  </p>
                ) : (
                  <div className="dk-row">
                    <div className="adm-field">
                      <label htmlFor={resolveKey}>Resolution reason</label>
                      <input
                        id={resolveKey}
                        value={field(resolveKey)}
                        maxLength={500}
                        onChange={(ev) => setField(resolveKey, ev.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      className="adm-btn"
                      disabled={busy}
                      onClick={() => void send({ op: 'dispute-resolve', disputeId: d.disputeId, reason: field(resolveKey) })}
                    >
                      Resolve dispute
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor={ticketKey}>Support ticket reference</label>
          <input id={ticketKey} value={field(ticketKey)} maxLength={120} onChange={(ev) => setField(ticketKey, ev.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor={disputeKey}>Dispute reason</label>
          <input id={disputeKey} value={field(disputeKey)} maxLength={500} onChange={(ev) => setField(disputeKey, ev.target.value)} />
        </div>
        <button
          type="button"
          className="adm-btn"
          disabled={busy}
          onClick={() =>
            void send({
              op: 'dispute-open',
              listingId: e.listingId,
              reason: field(disputeKey),
              ticketRef: field(ticketKey),
              seq: e.disputes.length,
            })
          }
        >
          Open dispute
        </button>
      </div>
    </li>
  );
}

function Outcome({ reply }: { reply: LibraryDeskReply | null }) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="library-desk-outcome">
        <strong>Done: {reply.what}</strong>
      </div>
    );
  return (
    <div
      className="adm-callout"
      role="alert"
      data-tone={reply.changed === 'unknown' ? 'warn' : 'danger'}
      data-testid="library-desk-outcome"
      data-code={reply.code ?? ''}
    >
      <strong>{reply.title}</strong>
      <p>{reply.body}</p>
      <p className="dk-muted">{reply.next}</p>
      {reply.code && <p className="dk-muted">Code: {reply.code}</p>}
    </div>
  );
}
