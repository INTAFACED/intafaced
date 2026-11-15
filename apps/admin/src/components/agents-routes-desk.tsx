'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAsOf } from '@/lib/as-of';
import { founderMutationHeaders } from '@/lib/founder-browser';
import { rateOf, routeSay } from '@/lib/agents-routes/model';

/**
 * The model routing table (J-agents-20; AG-usage-02, RC-agents-05), as svc-agents serves it: each task with its
 * provider and model alias, which come from configuration and nowhere else, its output ceiling and its rates per
 * million tokens, or "not set". A founder asks for a change of a route's ceiling or rates; it stays pending until a
 * second founder confirms it, and then the table changes once with an audit row naming both. svc-agents holds those
 * rules, not this page. A rate change takes effect from the next usage window, which the row says.
 */

interface Change {
  readonly id: string;
  readonly task: string;
  readonly maxOutputTokens: number;
  readonly inputPerMillion: string | null;
  readonly outputPerMillion: string | null;
  readonly status: 'pending' | 'applied' | 'withdrawn';
  readonly proposedBy: string;
  readonly confirmedBy: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

interface Route {
  readonly task: string;
  readonly capability: string;
  readonly providerId: string;
  readonly model: string;
  readonly providerSource: 'configuration';
  readonly maxOutputTokens: number;
  readonly inputPerMillion: string | null;
  readonly outputPerMillion: string | null;
  readonly nextRate: { inputPerMillion: string | null; outputPerMillion: string | null; from: string } | null;
  readonly assetId: string;
  /** The adapter the route's provider id is wired to in this deployment: what new runs use. */
  readonly engine: 'sandbox' | 'live' | 'unknown';
  readonly pending: Change | null;
  readonly lastChange: Change | null;
}

interface Snapshot {
  readonly maxOutputTokens: number;
  readonly inputPerMillion: string | null;
  readonly outputPerMillion: string | null;
}

interface AuditRow {
  readonly id: string;
  readonly at: string;
  readonly task: string;
  readonly action: 'propose' | 'withdraw' | 'confirm';
  readonly operatorId: string;
  readonly proposedBy: string;
  readonly before: Snapshot;
  readonly after: Snapshot;
}

interface Desk {
  readonly routes: readonly Route[];
  readonly audit: readonly AuditRow[];
  readonly handles: Readonly<Record<string, string>>;
  readonly handlesUnread: boolean;
  readonly me: string;
  readonly asOf: string;
}

const NOT_SET = 'not set';
const ENGINE_WORD: Record<Route['engine'], string> = {
  sandbox: 'Stand-in engine (sandbox)',
  live: 'Live model adapter',
  unknown: 'Not wired',
};
const ACTION_WORD: Record<AuditRow['action'], string> = { propose: 'Asked for', withdraw: 'Withdrew', confirm: 'Confirmed' };
const rateText = (value: string | null) => value ?? NOT_SET;
const snapText = (s: Snapshot) =>
  `ceiling ${s.maxOutputTokens}, input ${rateText(s.inputPerMillion)}, output ${rateText(s.outputPerMillion)}`;

async function post(body: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return { ok: false, message: `${(error as Error).message} Nothing was sent.` };
  }
  try {
    const res = await fetch('/api/agents-routes', { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store' });
    const data: unknown = await res.json().catch(() => null);
    if (res.ok) return { ok: true, data };
    const code = data && typeof data === 'object' && 'code' in data && typeof data.code === 'string' ? data.code : `http_${res.status}`;
    return { ok: false, message: routeSay(code) };
  } catch {
    return { ok: false, message: 'The answer was lost. Reload to see what is stored; nothing is repeated automatically.' };
  }
}

function ChangeSheet({ route, onDone, onCancel }: { route: Route; onDone: (message: string | null) => void; onCancel: () => void }) {
  const [ceiling, setCeiling] = useState(String(route.maxOutputTokens));
  const [input, setInput] = useState(route.inputPerMillion ?? '');
  const [output, setOutput] = useState(route.outputPerMillion ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One request id per sheet: a retried press of the same change lands on the same row.
  const requestId = useRef(`agents-routes:${route.task}:${crypto.randomUUID()}`);
  const titleId = `route-sheet-${route.task.replace(/[^A-Za-z0-9]/g, '-')}`;

  async function submit() {
    const max = Number(ceiling);
    const i = rateOf(input);
    const o = rateOf(output);
    if (!Number.isInteger(max) || max < 1 || i === undefined || o === undefined || (i === null) !== (o === null)) {
      setProblem(routeSay('agents.route_change_invalid'));
      return;
    }
    setBusy(true);
    setProblem(null);
    const answer = await post({
      action: 'propose',
      task: route.task,
      maxOutputTokens: max,
      inputPerMillion: i,
      outputPerMillion: o,
      requestId: requestId.current,
    });
    setBusy(false);
    if (!answer.ok) return setProblem(answer.message);
    onDone(null);
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="adm-callout dk-stack">
      <h4 id={titleId}>Change {route.task}</h4>
      <p className="dk-muted">
        Provider {route.providerId} and model {route.model} come from configuration and are not changed here. A second founder must confirm
        this change before the table moves. A new rate takes effect from the next usage window. Leave both rates blank for &ldquo;not
        set&rdquo;, which refuses every metered run.
      </p>
      <label className="dk-stack">
        Output ceiling (tokens)
        <input type="text" inputMode="numeric" value={ceiling} onChange={(e) => setCeiling(e.target.value)} />
      </label>
      <label className="dk-stack">
        Input per million ({route.assetId})
        <input type="text" inputMode="decimal" value={input} onChange={(e) => setInput(e.target.value)} />
      </label>
      <label className="dk-stack">
        Output per million ({route.assetId})
        <input type="text" inputMode="decimal" value={output} onChange={(e) => setOutput(e.target.value)} />
      </label>
      <div className="dk-row">
        <button type="button" className="adm-btn" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Sending…' : 'Ask a second founder'}
        </button>
        <button type="button" className="adm-btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {problem && (
        <p className="dk-why" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

export function AgentsRoutesDesk() {
  const [desk, setDesk] = useState<Desk | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [actionProblem, setActionProblem] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const mine = ++sequence.current;
    const answer = await post({ action: 'desk' });
    if (mine !== sequence.current) return;
    if (!answer.ok) return setProblem(answer.message);
    setProblem(null);
    setDesk({ ...(answer.data as Omit<Desk, 'asOf'>), asOf: new Date().toISOString() });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const who = (id: string | null | undefined) => (id ? (desk?.handles[id.toLowerCase()] ?? id) : NOT_SET);

  async function decide(action: 'withdraw' | 'confirm', changeId: string) {
    setBusy(true);
    setActionProblem(null);
    const answer = await post({ action, changeId });
    setBusy(false);
    if (!answer.ok) setActionProblem(answer.message);
    await load();
  }

  return (
    <>
      <section className="dk-stack" data-testid="read-agents.routes" aria-label="Task routes and prices">
        <div>
          <h3>Task routes and prices</h3>
          <p className="dk-muted">
            Each task the gateway serves: its provider and model alias, from configuration; its output ceiling; and its metered price per
            million tokens. A change takes two founders.
          </p>
          <p className="dk-asof">{desk ? `As of ${formatAsOf(desk.asOf)} (when this console read agents)` : 'Not read yet'}</p>
        </div>
        {problem && (
          <div className="adm-callout" data-tone="warn" role="status" data-testid="read-failed">
            <strong>Could not load the routing table</strong>
            <p>{problem}</p>
            <p className="dk-muted">Nothing is shown here rather than a guess.</p>
          </div>
        )}
        {desk?.handlesUnread && <p className="dk-why">Identity did not name the founders, so their account ids are shown.</p>}
        {actionProblem && (
          <p className="dk-why" role="alert" data-testid="route-problem">
            {actionProblem}
          </p>
        )}
        {desk && desk.routes.length === 0 && <p className="dk-muted">svc-agents serves no task routes.</p>}
        {desk && desk.routes.length > 0 && (
          <div className="dk-table-wrap" role="region" aria-label="Task routes" tabIndex={0}>
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Capability</th>
                  <th>Output ceiling (tokens)</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Set in</th>
                  <th>Engine for new runs</th>
                  <th>Input per million</th>
                  <th>Output per million</th>
                  <th>Billed in</th>
                  <th>Last change</th>
                  <th>
                    <span className="adm-sr-only">Change</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {desk.routes.map((route) => {
                  const pending = route.pending;
                  const last = route.lastChange;
                  const mineToWithdraw = pending !== null && pending.proposedBy.toLowerCase() === desk.me;
                  return (
                    <tr key={route.task}>
                      <td>{route.task}</td>
                      <td>{route.capability}</td>
                      <td>{route.maxOutputTokens}</td>
                      <td data-testid="route-provider">{route.providerId}</td>
                      <td data-testid="route-model">{route.model}</td>
                      <td data-testid="route-provider-source">From configuration</td>
                      <td data-testid="route-engine">{ENGINE_WORD[route.engine]}</td>
                      <td>{rateText(route.inputPerMillion)}</td>
                      <td>
                        {rateText(route.outputPerMillion)}
                        {route.nextRate && (
                          <span className="dk-muted" data-testid="route-next-rate">
                            {' '}
                            From {formatAsOf(route.nextRate.from)}: input {rateText(route.nextRate.inputPerMillion)}, output{' '}
                            {rateText(route.nextRate.outputPerMillion)}
                          </span>
                        )}
                      </td>
                      <td>{route.assetId}</td>
                      <td data-testid="route-audit">
                        {last
                          ? `Changed by ${who(last.proposedBy)}, confirmed by ${who(last.confirmedBy)}${last.decidedAt ? `, ${formatAsOf(last.decidedAt)}` : ''}`
                          : 'No founder change yet'}
                      </td>
                      <td>
                        {pending ? (
                          <div className="dk-stack">
                            <span data-testid="route-pending">
                              Pending a second founder: {snapText(pending)}, asked by {who(pending.proposedBy)}
                            </span>
                            {mineToWithdraw ? (
                              <button type="button" className="adm-btn" disabled={busy} onClick={() => void decide('withdraw', pending.id)}>
                                Withdraw change
                              </button>
                            ) : (
                              <button type="button" className="adm-btn" disabled={busy} onClick={() => void decide('confirm', pending.id)}>
                                Confirm change
                              </button>
                            )}
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="adm-btn"
                            disabled={busy || sheet !== null}
                            onClick={() => {
                              setActionProblem(null);
                              setSheet(route.task);
                            }}
                          >
                            Change route
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {desk &&
          sheet !== null &&
          (() => {
            const route = desk.routes.find((r) => r.task === sheet);
            return route ? (
              <ChangeSheet
                key={route.task}
                route={route}
                onCancel={() => setSheet(null)}
                onDone={() => {
                  setSheet(null);
                  void load();
                }}
              />
            ) : null;
          })()}
      </section>
      {desk && (
        <section className="dk-stack" data-testid="agents-routes-audit" aria-label="Routing table audit">
          <h3>Routing table audit</h3>
          {desk.audit.length === 0 ? (
            <p className="dk-muted">No founder has asked for a route change yet.</p>
          ) : (
            <ol className="dk-stack">
              {desk.audit.map((row) => (
                <li key={row.id}>
                  {formatAsOf(row.at)}: {ACTION_WORD[row.action]} {row.task} by {who(row.operatorId)}
                  {row.action === 'confirm' ? `, asked by ${who(row.proposedBy)}` : ''}. Before: {snapText(row.before)}. After:{' '}
                  {snapText(row.after)}.
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </>
  );
}
