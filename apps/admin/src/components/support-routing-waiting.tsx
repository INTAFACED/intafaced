'use client';

import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchRoutingWaiting } from '@/lib/support/browser';
import type { SupportRoutingWaitingView } from '@/lib/support/types';
import { Failed } from './support-action-parts';

/**
 * WAITING FOR AN AGENT — requests in a routed group that svc-support could not give to anyone.
 *
 * Each one carries svc-support's own code, `support.no_agent_available`: nobody in the group was online with a capacity set,
 * room under it and the skill the request needs. The list is exactly svc-support's answer for the signed-in person; a refusal
 * is shown as that part's refusal, never as "none waiting".
 */

export interface RoutingWaitingViewProps {
  readonly view: SupportRoutingWaitingView | null;
  readonly loading: boolean;
  readonly onRefresh: () => void;
}

export function RoutingWaitingView({ view, loading, onRefresh }: RoutingWaitingViewProps) {
  return (
    <section className="dk-stack" aria-label="Waiting for an agent" data-testid="routing-waiting">
      <h3>Waiting for an agent</h3>
      {!view ? (
        <p className="dk-muted">{loading ? 'Reading…' : 'svc-support could not be read. Nothing is shown rather than a guess.'}</p>
      ) : view.waiting.kind === 'failed' ? (
        <Failed name="Waiting for an agent" part={view.waiting} />
      ) : view.waiting.data.length === 0 ? (
        <p className="dk-muted" data-testid="routing-waiting-none">
          svc-support has no routed request waiting for an agent.
        </p>
      ) : (
        <div className="dk-table-wrap" role="region" aria-label="Requests waiting for an agent" tabIndex={0}>
          <table className="adm-table">
            <thead>
              <tr>
                <th>Request</th>
                <th>Why</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {view.waiting.data.map((w) => (
                <tr key={w.ticketId} data-testid={`routing-waiting-${w.ticketId}`}>
                  <td className="dk-packet">
                    <Link href={`/support/${w.ticketId}`}>{w.ticketId}</Link>
                  </td>
                  <td>
                    No agent available <code className="dk-packet">{w.code}</code>
                  </td>
                  <td>{w.since ? formatWhen(w.since) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={onRefresh} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh waiting'}
        </button>
        {view && <span className="dk-asof">As of {formatAsOf(view.asOf)}</span>}
      </div>
    </section>
  );
}

export function RoutingWaiting({ initial }: { initial: SupportRoutingWaitingView | null }) {
  const [view, setView] = useState<SupportRoutingWaitingView | null>(initial);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    const next = await fetchRoutingWaiting();
    if (mine === seq.current) {
      setView(next);
      setLoading(false);
    }
  }, []);
  return <RoutingWaitingView view={view} loading={loading} onRefresh={() => void load()} />;
}
