'use client';

import { useCallback, useRef, useState } from 'react';
import { Chip } from '@/components/chip';
import type { Part } from '@/lib/desk/part';
import { fetchNotify } from '@/lib/notify/browser';
import { channelStats, failureRows, spanOf, type DeliveriesRead, type NotifyView } from '@/lib/notify/model';
import { shortId } from '@/lib/desk/desk-model';
import './desk.css';

/**
 * NOTIFY DELIVERY HEALTH — read-only.
 *
 * Per-channel outcomes over the most recently updated delivery rows svc-notify returned, with the span they cover and
 * whether the page was full. "Accepted" means the transport took it; svc-notify records no "delivered", so neither does
 * this page. A channel with no rows is "no recent deliveries", never "healthy". Nothing here resends or mutes anything.
 */

function Failed({ name, part }: { name: string; part: Extract<Part<unknown>, { kind: 'failed' }> }) {
  return (
    <div className="adm-callout" data-tone="danger" role="status" data-testid="notify-failed">
      <strong>{name} unavailable</strong>
      <p>{part.message}</p>
      {part.code && <p className="dk-muted">Code: {part.code}</p>}
    </div>
  );
}

export function ChannelTable({ read }: { read: DeliveriesRead }) {
  const stats = channelStats(read.rows);
  const span = spanOf(read);
  return (
    <div className="dk-stack" data-testid="channel-stats">
      {span ? (
        <p className="dk-muted">
          Covers the {read.rows.length} most recently updated deliveries, from {span.from} to {span.to}.{' '}
          {span.pageFull
            ? `The page is full (${read.limit}), so older deliveries exist that are not counted. These are not all-time figures.`
            : 'svc-notify returned nothing older.'}
        </p>
      ) : (
        <p className="dk-muted" data-testid="notify-empty">
          svc-notify returned no deliveries. That means none are recorded, not that anything is healthy.
        </p>
      )}
      {stats.length > 0 && (
        <div className="dk-table-wrap" role="region" aria-label="Delivery outcomes by channel" tabIndex={0}>
          <table className="adm-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Rows</th>
                <th>Accepted</th>
                <th>Pending</th>
                <th>Refused</th>
                <th>Failed</th>
                <th>Abandoned</th>
                <th>Accepted of settled</th>
                <th>Oldest pending</th>
                <th>Most common refusal</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.channel} data-testid={`channel-${s.channel}`}>
                  <th scope="row">{s.channel}</th>
                  <td>{s.total}</td>
                  <td>{s.counts.accepted}</td>
                  <td>{s.counts.pending}</td>
                  <td>{s.counts.refused}</td>
                  <td>{s.counts.failed}</td>
                  <td>{s.counts.abandoned}</td>
                  <td>
                    {s.acceptedPercent === null ? 'nothing settled yet' : `${s.acceptedPercent}% (${s.counts.accepted} of ${s.settled})`}
                  </td>
                  <td>{s.oldestPendingCreatedAt ?? '—'}</td>
                  <td>{s.topRefusalCodes.length === 0 ? '—' : s.topRefusalCodes.map((c) => `${c.code} ×${c.count}`).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="dk-muted">
        Accepted means the inbox was written or a gateway took the message. svc-notify has no “delivered” fact, so this page does not claim
        one.
      </p>
    </div>
  );
}

export function FailureList({ read }: { read: DeliveriesRead }) {
  const rows = failureRows(read.rows);
  if (rows.length === 0) return <p className="dk-muted">No refused, failed or abandoned deliveries in these rows.</p>;
  return (
    <div className="dk-table-wrap" role="region" aria-label="Failed deliveries" tabIndex={0}>
      <table className="adm-table">
        <thead>
          <tr>
            <th>Updated</th>
            <th>Channel</th>
            <th>Status</th>
            <th>Code</th>
            <th>Attempts</th>
            <th>Last attempt</th>
            <th>Notification</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.updatedAt}</td>
              <td>{r.channel}</td>
              <td>
                <Chip tone={r.status === 'refused' ? 'warn' : 'danger'}>{r.status}</Chip>
              </td>
              <td className="dk-packet">{r.refusalCode ?? '—'}</td>
              <td>{r.attempts}</td>
              <td>{r.attemptedAt ?? 'never attempted'}</td>
              <td className="dk-packet">{shortId(r.notificationId)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface NotifyViewProps {
  readonly view: NotifyView | null;
  readonly loading: boolean;
  readonly onRefresh: () => void;
}

export function NotifyDeskView({ view, loading, onRefresh }: NotifyViewProps) {
  return (
    <div className="dk" data-testid="notify-desk">
      <div className="adm-pagehead">
        <div>
          <h1>Notify delivery health</h1>
          <p>What happened to the notifications svc-notify tried to send, by channel. Read-only.</p>
        </div>
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={onRefresh} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
        <span className="dk-asof">{view ? `As of ${view.asOf} (when this console read svc-notify)` : 'No read yet'}</span>
      </div>
      {!view && <p className="dk-why">svc-notify could not be read. Nothing is shown rather than a guess.</p>}
      {view && view.health.kind === 'ok' && (
        <div className="dk-badge" data-state={view.health.data.fanoutEnabled ? 'running' : 'stopped'} data-testid="notify-health">
          <strong>Out-of-app fan-out is {view.health.data.fanoutEnabled ? 'on' : 'OFF'}</strong>
          <span className="dk-muted">
            {view.health.data.fanoutEnabled
              ? 'svc-notify will send email, SMS and push when a channel is configured.'
              : 'svc-notify is not sending anything out of the app. In-app inbox writes are separate.'}
          </span>
        </div>
      )}
      {view && view.health.kind === 'failed' && <Failed name="svc-notify health" part={view.health} />}
      {view && view.deliveries.kind === 'failed' && <Failed name="Delivery outcomes" part={view.deliveries} />}
      {view && view.deliveries.kind === 'ok' && (
        <>
          <h2>By channel</h2>
          <ChannelTable read={view.deliveries.data} />
          <h2>Failures</h2>
          <FailureList read={view.deliveries.data} />
        </>
      )}
    </div>
  );
}

export function NotifyDesk({ initial }: { initial: NotifyView | null }) {
  const [view, setView] = useState<NotifyView | null>(initial);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    setLoading(true);
    const next = await fetchNotify();
    if (mine === sequence.current) {
      setView(next);
      setLoading(false);
    }
  }, []);
  return <NotifyDeskView view={view} loading={loading} onRefresh={() => void reload()} />;
}
