'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchSubscriberDesk, postSubscriberChange } from '@/lib/notify/subscribers-browser';
import {
  IMPORT_MAX,
  SUBSCRIBER_STATES,
  addressesIn,
  importPreview,
  safeguardValue,
  type Channels,
  type DeliveryRow,
  type ImportResult,
  type Safeguards,
  type SubscriberDeskReply,
  type SubscriberDeskView,
  type SubscriberRow,
  type SubscriberState,
} from '@/lib/notify/subscribers-model';

/**
 * SUBSCRIBER DESK (SP-status-04).
 *
 * Who gets status updates and in which state, how each channel leaves this deployment, the delivery rows of one
 * published notice (one per subscriber and channel: a second fan-out reuses them), the subscribe safeguards, and imports.
 * A channel with no sender is named by its code; its rows wait pending and nothing pretends they were sent.
 */

type Submit = (body: Record<string, unknown>) => void;

const STATE_WORDS: Record<SubscriberState, string> = { unconfirmed: 'Unconfirmed', active: 'Active', unsubscribed: 'Unsubscribed' };
const DELIVERY_WORDS: Record<DeliveryRow['status'], string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  failed: 'Failed',
  refused: 'Refused',
};

function Outcome({ reply }: { reply: SubscriberDeskReply | null }) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="subscriber-desk-outcome">
        <strong>Done: {reply.what}</strong>
        {reply.imported && <ImportSummary result={reply.imported} />}
      </div>
    );
  return (
    <div
      className="adm-callout"
      role="alert"
      data-tone={reply.changed === 'unknown' ? 'warn' : 'danger'}
      data-testid="subscriber-desk-outcome"
      data-code={reply.code ?? ''}
    >
      <strong>{reply.title}</strong>
      <p>{reply.body}</p>
      <p className="dk-muted">{reply.next}</p>
      {reply.code && <p className="dk-muted">Code: {reply.code}</p>}
    </div>
  );
}

function ImportSummary({ result }: { result: ImportResult }) {
  return (
    <p data-testid="subscriber-import-result">
      {result.received} received, {result.distinct} distinct addresses: {result.added} added, {result.alreadyKnown} already known
      {result.limited > 0 ? `, ${result.limited} over the hourly limit (stored, no confirmation sent yet)` : ''}.
      {result.invalid.length > 0 ? ` Not addresses: ${result.invalid.join(', ')}.` : ''} Each added address gets its own confirmation and
      receives nothing else until it is opened.
    </p>
  );
}

function Failed({ title, message }: { title: string; message: string }) {
  return (
    <div className="adm-callout" data-tone="danger" role="status">
      <strong>{title}</strong>
      <p>{message}</p>
    </div>
  );
}

function ChannelsPanel({ channels }: { channels: Channels }) {
  const email =
    channels.email.sender === 'local-outbox'
      ? 'Sends through the LOCAL TEST outbox: each message is a line in a file on this machine, and nothing leaves it.'
      : channels.email.sender === 'gateway'
        ? 'Sends through the email gateway the owner configured.'
        : `No sender is connected (${channels.email.notConnected ?? 'vendor.email'}). Email rows wait pending until one is.`;
  return (
    <section className="dk-stack" aria-labelledby="subscriber-channels" data-testid="subscriber-channels">
      <h2 id="subscriber-channels">Channels</h2>
      <dl className="dk-kv">
        <dt>Email</dt>
        <dd data-testid="subscriber-channel-email">{email}</dd>
        <dt>SMS</dt>
        <dd data-testid="subscriber-channel-sms">
          Switched off in this build: no SMS sender ({channels.sms}). The subscribe form does not offer it.
        </dd>
        <dt>Push</dt>
        <dd data-testid="subscriber-channel-push">
          Switched off in this build: no push sender ({channels.push}). The subscribe form does not offer it.
        </dd>
        <dt>Webhook</dt>
        <dd>The subscriber&apos;s own public https address, checked again before every send.</dd>
      </dl>
    </section>
  );
}

function SafeguardsPanel({ safeguards, busy, onSubmit }: { safeguards: Safeguards; busy: boolean; onSubmit: Submit }) {
  const [bits, setBits] = useState(safeguards.challengeBits === null ? '' : String(safeguards.challengeBits));
  const [rate, setRate] = useState(safeguards.subscribeRatePerHour === null ? '' : String(safeguards.subscribeRatePerHour));
  const [reason, setReason] = useState('');
  const [why, setWhy] = useState<string | null>(null);
  const save = () => {
    const b = safeguardValue(bits, 1, 32);
    const r = safeguardValue(rate, 1, 1000);
    if (!b.ok) return setWhy('The challenge strength is a whole number of bits from 1 to 32, or blank.');
    if (!r.ok) return setWhy('The rate limit is a whole number of requests from 1 to 1000 an hour, or blank.');
    if (reason.trim() === '') return setWhy('Say why: the change is logged with its reason.');
    setWhy(null);
    onSubmit({
      op: 'safeguards',
      challengeBits: b.value,
      subscribeRatePerHour: r.value,
      expectedRevision: safeguards.revision,
      reason: reason.trim(),
    });
  };
  return (
    <section className="dk-stack" aria-labelledby="subscriber-safeguards" data-testid="subscriber-safeguards">
      <h2 id="subscriber-safeguards">Safeguards</h2>
      <p className="dk-muted">
        Owner values, blank until a founder sets them. While either is blank, subscribing on /status and imports refuse (
        <code>status.challenge_unset</code>, <code>status.rate_limit_unset</code>).
      </p>
      <p data-testid="subscriber-safeguards-now">
        Proof of work: {safeguards.challengeBits === null ? 'blank' : `${safeguards.challengeBits} bits`}. Subscribe requests per address:{' '}
        {safeguards.subscribeRatePerHour === null ? 'blank' : `${safeguards.subscribeRatePerHour} an hour`}.
      </p>
      <div className="adm-field">
        <label htmlFor="safeguard-bits">Proof of work strength (bits)</label>
        <input
          id="safeguard-bits"
          className="adm-input"
          inputMode="numeric"
          value={bits}
          onChange={(e) => setBits(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="safeguard-rate">Subscribe requests per address per hour</label>
        <input
          id="safeguard-rate"
          className="adm-input"
          inputMode="numeric"
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="safeguard-reason">Reason</label>
        <input
          id="safeguard-reason"
          className="adm-input"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
        />
      </div>
      {why && (
        <p className="dk-why" role="alert">
          {why}
        </p>
      )}
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={save} disabled={busy}>
          Save safeguards
        </button>
      </div>
    </section>
  );
}

function DeliveriesPanel({
  view,
  busy,
  onPick,
  onSubmit,
}: {
  view: SubscriberDeskView;
  busy: boolean;
  onPick: (noticeId: string | null) => void;
  onSubmit: Submit;
}) {
  if (view.notices.kind === 'failed') return <Failed title="Published notices could not be read" message={view.notices.message} />;
  const notices = view.notices.data;
  return (
    <section className="dk-stack" aria-labelledby="subscriber-deliveries" data-testid="subscriber-deliveries">
      <h2 id="subscriber-deliveries">Deliveries of a notice</h2>
      <div className="adm-field">
        <label htmlFor="delivery-notice">Published notice</label>
        <select
          id="delivery-notice"
          className="adm-select"
          value={view.noticeId ?? ''}
          onChange={(e) => onPick(e.target.value || null)}
          disabled={busy}
        >
          <option value="">{notices.length === 0 ? 'Nothing is published' : 'Choose a notice'}</option>
          {notices.map((n) => (
            <option key={n.id} value={n.id}>
              {n.title} ({n.kind}, {formatWhen(n.publishedAt)})
            </option>
          ))}
        </select>
      </div>
      {view.noticeId && view.deliveries?.kind === 'failed' && (
        <Failed title="Delivery rows could not be read" message={view.deliveries.message} />
      )}
      {view.noticeId && view.deliveries?.kind === 'ok' && (
        <>
          {view.deliveries.data.more && (
            <p className="dk-why" data-testid="subscriber-deliveries-more">
              Only the first {view.deliveries.data.rows.length} rows are shown: this notice has more. The counts per subscriber below
              include every row.
            </p>
          )}
          {view.deliveries.data.rows.length === 0 ? (
            <p className="dk-muted" data-testid="subscriber-deliveries-none">
              No delivery rows: no active subscriber chose what this notice names.
            </p>
          ) : (
            <div className="dk-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th scope="col">Subscriber</th>
                    <th scope="col">Channel</th>
                    <th scope="col">Status</th>
                    <th scope="col">Why</th>
                    <th scope="col">Attempts</th>
                  </tr>
                </thead>
                <tbody>
                  {view.deliveries.data.rows.map((d) => (
                    <tr key={d.key} data-testid="subscriber-delivery" data-email={d.email} data-channel={d.channel} data-status={d.status}>
                      <td>{d.email}</td>
                      <td>{d.channel === 'email' ? 'Email' : 'Webhook'}</td>
                      <td>{DELIVERY_WORDS[d.status]}</td>
                      <td>{d.refusalCode ? <code>{d.refusalCode}</code> : '—'}</td>
                      <td>{d.attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="dk-row">
            <button type="button" className="adm-btn" onClick={() => onSubmit({ op: 'resend', noticeId: view.noticeId })} disabled={busy}>
              Send again
            </button>
            <span className="dk-muted">
              Tries this notice&apos;s pending and failed rows once more. Accepted rows are left, no row is doubled, and no one who
              subscribed since is sent it.
            </span>
          </div>
        </>
      )}
    </section>
  );
}

function SubscribersPanel({
  view,
  busy,
  onState,
}: {
  view: SubscriberDeskView;
  busy: boolean;
  onState: (state: SubscriberState | null) => void;
}) {
  return (
    <section className="dk-stack" aria-labelledby="subscriber-list" data-testid="subscriber-list">
      <h2 id="subscriber-list">Subscribers</h2>
      <div className="adm-field">
        <label htmlFor="subscriber-state">State</label>
        <select
          id="subscriber-state"
          className="adm-select"
          value={view.state ?? ''}
          onChange={(e) => onState((e.target.value || null) as SubscriberState | null)}
          disabled={busy}
        >
          <option value="">All</option>
          {SUBSCRIBER_STATES.map((s) => (
            <option key={s} value={s}>
              {STATE_WORDS[s]}
            </option>
          ))}
        </select>
      </div>
      {view.subscribers.kind === 'failed' ? (
        <Failed title="Subscribers could not be read" message={view.subscribers.message} />
      ) : view.subscribers.data.length === 0 ? (
        <p className="dk-muted" data-testid="subscriber-list-none">
          No subscribers{view.state ? ` in this state` : ''}.
        </p>
      ) : (
        <div className="dk-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">State</th>
                <th scope="col">From</th>
                <th scope="col">Components</th>
                <th scope="col">Deliveries</th>
              </tr>
            </thead>
            <tbody>
              {view.subscribers.data.map((s: SubscriberRow) => (
                <tr key={s.id} data-testid="subscriber-row" data-email={s.email} data-state={s.state}>
                  <td>{s.email}</td>
                  <td>{STATE_WORDS[s.state]}</td>
                  <td>{s.source ? `Import: ${s.source}` : 'The /status form'}</td>
                  <td>{s.componentIds === null ? 'All' : s.componentIds.join(', ')}</td>
                  <td>
                    {s.deliveries.accepted} accepted, {s.deliveries.pending} pending, {s.deliveries.failed} failed, {s.deliveries.refused}{' '}
                    refused
                    {s.webhook ? ' · has a webhook' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ImportPanel({ busy, onSubmit }: { busy: boolean; onSubmit: Submit }) {
  const [source, setSource] = useState('');
  const [text, setText] = useState('');
  const preview = importPreview(text);
  return (
    <section className="dk-stack" aria-labelledby="subscriber-import" data-testid="subscriber-import">
      <h2 id="subscriber-import">Import addresses</h2>
      <p className="dk-muted">
        Each new address starts unconfirmed and gets its own confirmation link; nothing else reaches it until it is opened. An address
        already known is left as it is.
      </p>
      <div className="adm-field">
        <label htmlFor="import-source">Source (lowercase letters, digits, dashes)</label>
        <input
          id="import-source"
          className="adm-input"
          maxLength={40}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="import-addresses">Addresses (one per line, or separated by commas)</label>
        <textarea
          id="import-addresses"
          className="adm-textarea"
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />
      </div>
      <p className="dk-muted" data-testid="subscriber-import-preview">
        {preview.lines} {preview.lines === 1 ? 'line' : 'lines'}, {preview.distinct} distinct. At most {IMPORT_MAX} in one import.
      </p>
      <div className="dk-row">
        <button
          type="button"
          className="adm-btn"
          onClick={() => onSubmit({ op: 'import', source: source.trim(), emails: addressesIn(text) })}
          disabled={busy || preview.lines === 0}
        >
          Import
        </button>
      </div>
    </section>
  );
}

export function NotifySubscribersDesk({ initial }: { initial: SubscriberDeskView }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<SubscriberDeskReply | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Empties the import form after an import landed; any other change, or a refusal, keeps what the founder wrote there.
  const [imports, setImports] = useState(0);

  const reread = useCallback(async (state: SubscriberState | null, noticeId: string | null) => {
    const next = await fetchSubscriberDesk(state, noticeId);
    setLoadFailed(next === null);
    if (next) setView(next);
    return next !== null;
  }, []);

  const select = useCallback(
    async (state: SubscriberState | null, noticeId: string | null) => {
      setBusy(true);
      setReply(null);
      await reread(state, noticeId);
      setBusy(false);
    },
    [reread],
  );

  const submit = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setReply(null);
      const result = await postSubscriberChange(body);
      setReply(result);
      if (result.ok && body.op === 'import') setImports((n) => n + 1);
      await reread(view.state, view.noticeId);
      setBusy(false);
    },
    [reread, view.state, view.noticeId],
  );
  const onSubmit: Submit = (b) => void submit(b);

  return (
    <div className="dk-stack" data-testid="subscriber-desk">
      <header className="adm-pagehead">
        <h1>Status subscribers</h1>
        <p className="dk-muted">
          Who gets status updates, and what reached them. <Link href="/notify/incidents">Incident desk</Link> ·{' '}
          <Link href="/notify/status">Status page desk</Link>
        </p>
        <div className="dk-row">
          <button type="button" className="adm-btn" onClick={() => void select(view.state, view.noticeId)} disabled={busy}>
            {busy ? 'Reading…' : 'Read again'}
          </button>
          <span className="dk-asof">As of {formatAsOf(view.asOf)}</span>
        </div>
        {loadFailed && <p className="dk-why">The console could not read the desk again. What is shown is the last read.</p>}
      </header>
      <Outcome reply={reply} />
      {view.channels.kind === 'ok' ? (
        <ChannelsPanel channels={view.channels.data} />
      ) : (
        <Failed title="Channels could not be read" message={view.channels.message} />
      )}
      <DeliveriesPanel view={view} busy={busy} onPick={(id) => void select(view.state, id)} onSubmit={onSubmit} />
      <SubscribersPanel view={view} busy={busy} onState={(s) => void select(s, view.noticeId)} />
      {view.safeguards.kind === 'ok' ? (
        // A new revision (saved here or by another founder) starts the form from what svc-notify holds now.
        <SafeguardsPanel key={view.safeguards.data.revision} safeguards={view.safeguards.data} busy={busy} onSubmit={onSubmit} />
      ) : (
        <Failed title="Safeguards could not be read" message={view.safeguards.message} />
      )}
      <ImportPanel key={imports} busy={busy} onSubmit={onSubmit} />
    </div>
  );
}
