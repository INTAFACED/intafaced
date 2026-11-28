'use client';

import { useRef, useState } from 'react';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchChartsLookup } from '@/lib/support/browser';
import { alertsWords, conditionWords, historyWords, layoutsWords, type PartWords } from '@/lib/support/charts-lookup';
import type { SupportChartsLookupView } from '@/lib/support/types';

type State =
  { readonly kind: 'idle' } | { readonly kind: 'loading' } | { readonly kind: 'done'; readonly view: SupportChartsLookupView | null };

function Words({ words, testId }: { words: PartWords; testId: string }) {
  return (
    <p
      className={words.state === 'read' ? undefined : 'dk-muted'}
      data-testid={testId}
      data-state={words.state}
      data-code={words.code ?? undefined}
    >
      {words.text}
    </p>
  );
}

/**
 * CHARTS: ALERTS AND LAYOUTS (J-charts-desk-19 #1). The ticket owner's price alerts with their firing history and saved
 * desk layouts, read through svc-support on the agent's click. Read-only: nothing here changes an alert or a layout.
 * svc-support takes the customer from the request and writes one row in its history (agent, customer, time) before it
 * reads; that row is shown with the result, and a lookup whose row did not land is refused and shows nothing.
 */
export function ChartsLookupPanel({ ticketId }: { ticketId: string }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const seq = useRef(0);

  const look = async () => {
    const mine = ++seq.current;
    setState({ kind: 'loading' });
    const view = await fetchChartsLookup(ticketId);
    if (mine === seq.current) setState({ kind: 'done', view });
  };

  return (
    <section className="dk-stack" aria-label="Charts: alerts and layouts" data-testid="charts-lookup">
      <div className="dk-row">
        <h4>Charts: alerts and layouts</h4>
        <button type="button" className="adm-btn" onClick={() => void look()} disabled={state.kind === 'loading'}>
          {state.kind === 'loading' ? 'Reading…' : state.kind === 'idle' ? 'Look up alerts and layouts' : 'Look up again'}
        </button>
        {state.kind === 'done' && state.view && <span className="dk-asof">As of {formatAsOf(state.view.asOf)}</span>}
      </div>
      {state.kind === 'idle' && (
        <p className="dk-muted">Read-only. Looking up records your name, this customer and the time in the request history.</p>
      )}
      {state.kind === 'loading' && (
        <p className="dk-muted" role="status">
          Reading the customer’s alerts and layouts…
        </p>
      )}
      {state.kind === 'done' && <ChartsLookupResult view={state.view} />}
    </section>
  );
}

export function ChartsLookupResult({ view }: { view: SupportChartsLookupView | null }) {
  if (!view) {
    return (
      <div className="adm-callout" role="alert" data-testid="charts-lookup-error">
        <strong>The lookup did not come back</strong>
        <p>The console could not reach svc-support. Nothing was shown; try again.</p>
      </div>
    );
  }
  if (view.lookup.kind === 'failed') {
    return (
      <div className="adm-callout" role="alert" data-testid="charts-lookup-refused" data-code={view.lookup.code ?? undefined}>
        <strong>The lookup was refused</strong>
        <p>{view.lookup.message}</p>
        {view.lookup.code && <p className="dk-muted">Code: {view.lookup.code}</p>}
      </div>
    );
  }
  const l = view.lookup.data;
  return (
    <div className="dk-stack" data-testid="charts-lookup-result">
      <dl className="dk-kv" data-testid="charts-lookup-audit" aria-label="Lookup recorded">
        <dt>Recorded as</dt>
        <dd>History row #{String(l.audit.sequence)}</dd>
        <dt>Agent</dt>
        <dd data-testid="charts-audit-agent">{l.audit.agentId}</dd>
        <dt>Customer</dt>
        <dd data-testid="charts-audit-customer">{l.audit.customerId}</dd>
        <dt>Time</dt>
        <dd data-testid="charts-audit-time" data-at={l.audit.at}>
          {formatWhen(l.audit.at)}
        </dd>
      </dl>

      <h5>Price alerts</h5>
      <Words words={alertsWords(l)} testId="charts-alerts-state" />
      {l.alerts.status === 'read' && l.alerts.items.length > 0 && (
        <div className="dk-table-wrap" role="region" aria-label="Price alerts" tabIndex={0}>
          <table className="adm-table" aria-label="Price alerts">
            <thead>
              <tr>
                <th>Alert</th>
                <th>Market</th>
                <th>When</th>
                <th>Price</th>
                <th>Status</th>
                <th>Created</th>
                <th>Last fired</th>
              </tr>
            </thead>
            <tbody>
              {l.alerts.items.map((a) => (
                <tr key={a.id} data-testid="charts-alert-row" data-alert-id={a.id}>
                  <td>{a.name ?? a.id.slice(0, 8)}</td>
                  <td>{a.marketId}</td>
                  <td>{conditionWords(a.condition, a.targetPrice)}</td>
                  <td>{a.source}</td>
                  <td>{a.status}</td>
                  <td>{formatWhen(a.createdAt)}</td>
                  <td>{(a.lastFiredAt ?? a.firedAt) ? formatWhen(a.lastFiredAt ?? a.firedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h5>Alert history</h5>
      <Words words={historyWords(l)} testId="charts-history-state" />
      {l.alerts.status === 'read' && l.alerts.history.status === 'read' && l.alerts.history.items.length > 0 && (
        <div className="dk-table-wrap" role="region" aria-label="Alert history" tabIndex={0}>
          <table className="adm-table" aria-label="Alert history">
            <thead>
              <tr>
                <th>Fired</th>
                <th>Alert</th>
                <th>Market</th>
                <th>Asked for</th>
                <th>Mark</th>
              </tr>
            </thead>
            <tbody>
              {l.alerts.history.items.map((t) => (
                <tr key={`${t.alertId}:${String(t.seq)}`} data-testid="charts-history-row" data-alert-id={t.alertId}>
                  <td>{formatWhen(t.firedAt)}</td>
                  <td>
                    {t.alertId.slice(0, 8)} #{String(t.seq)}
                  </td>
                  <td>{t.marketId}</td>
                  <td>{conditionWords(t.condition, t.targetPrice)}</td>
                  <td>{t.markPrice}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h5>Saved layouts</h5>
      <Words words={layoutsWords(l)} testId="charts-layouts-state" />
      {l.layouts.status === 'read' && l.layouts.items.length > 0 && (
        <div className="dk-table-wrap" role="region" aria-label="Saved layouts" tabIndex={0}>
          <table className="adm-table" aria-label="Saved layouts">
            <thead>
              <tr>
                <th>Name</th>
                <th>Market</th>
                <th>Interval</th>
                <th>Widgets</th>
                <th>Saved</th>
                <th>In use</th>
              </tr>
            </thead>
            <tbody>
              {l.layouts.items.map((x) => (
                <tr key={x.id} data-testid="charts-layout-row" data-layout-id={x.id}>
                  <td>{x.name}</td>
                  <td>{x.symbol}</td>
                  <td>{x.interval}</td>
                  <td>
                    {x.desk.v === 1
                      ? `${x.desk.preset}: ${x.desk.order.join(', ')}`
                      : `${x.desk.panels.length} panels: ${x.desk.panels.map((panel) => panel.type).join(', ')}`}
                  </td>
                  <td>{formatWhen(x.savedAt)}</td>
                  <td>{l.layouts.status === 'read' && l.layouts.active === x.id ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
