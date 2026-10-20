'use client';

import { useRef, useState } from 'react';
import { fetchCustomerBalances, fetchCustomerEntries } from '@/lib/ops-desk/browser';
import { displayCell } from '@/lib/ops-desk/model';
import { ownServerFailureText, type OwnFetch } from '@/lib/ops-desk/own-server';
import type { Cell, ReadOutcome, Row } from '@/lib/ops-desk/types';
import { formatAsOf } from '@/lib/as-of';
import './desk.css';

/**
 * One customer's balances and the entries behind them (PF-balances-01), for the finance-treasury desk. Read when asked, never with
 * the page: svc-bank writes a log line with the operator and the customer before it reads any figure. Every figure is svc-bank's own
 * string, printed as given. A refusal is shown in the service's words with its code, and nothing is shown in place of a figure that
 * could not be read.
 */

const CUSTOMER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function OutcomeProblem({ outcome, what }: { outcome: ReadOutcome; what: string }) {
  const { part } = outcome;
  if (part.kind !== 'failed') return null;
  return (
    <div
      className="adm-callout"
      data-tone={part.forbidden || part.notBuilt ? 'warn' : 'danger'}
      role="status"
      data-testid="customer-failed"
    >
      <strong>Could not load {what}</strong>
      <p className="dk-muted">As of {formatAsOf(outcome.asOf)}.</p>
      <p>{part.message}</p>
      {part.code && <p className="dk-muted">Code: {part.code}</p>}
      <p className="dk-muted">Nothing is shown here rather than a guess.</p>
    </div>
  );
}

function Problem({ result }: { result: Extract<OwnFetch, { ok: false }> }) {
  return (
    <p className="dk-why" role="alert" data-testid="customer-unreached">
      {ownServerFailureText(result, 'customer')}
    </p>
  );
}

function CellTable({ rows, head, action }: { rows: readonly Row[]; head: readonly Cell[]; action?: (row: Row) => React.ReactNode }) {
  return (
    <div className="dk-table-wrap" role="region" aria-label="Customer figures" tabIndex={0}>
      <table className="adm-table">
        <thead>
          <tr>
            {head.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
            {action && (
              <th>
                <span className="adm-sr-only">Entries</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {row.cells
                .filter((c) => !c.detail)
                .map((c) => (
                  <td key={c.key} className={c.key === 'txId' ? 'dk-packet' : undefined}>
                    {displayCell(c)}
                  </td>
                ))}
              {action && <td>{action(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Entries =
  | { readonly state: 'loading' }
  | { readonly state: 'unreached'; readonly result: Extract<OwnFetch, { ok: false }> }
  | { readonly state: 'failed'; readonly outcome: ReadOutcome }
  | {
      readonly state: 'ok';
      readonly asOf: string;
      readonly rows: readonly Row[];
      readonly cursor: string | null;
      readonly check: readonly Cell[];
      readonly more: { readonly busy: boolean; readonly problem: string | null };
    };

export function EntriesPanel({ userId, assetId }: { userId: string; assetId: string }) {
  const [state, setState] = useState<Entries | null>(null);
  const busy = useRef(false);
  async function load(cursor: string | null) {
    if (busy.current) return;
    busy.current = true;
    const prior = state?.state === 'ok' && cursor !== null ? state : null;
    if (prior) setState({ ...prior, more: { busy: true, problem: null } });
    else setState({ state: 'loading' });
    try {
      const got = await fetchCustomerEntries(userId, assetId, cursor);
      const problem = (message: string) => prior && setState({ ...prior, more: { busy: false, problem: message } });
      if (!got.ok) return prior ? problem(ownServerFailureText(got, 'customer')) : setState({ state: 'unreached', result: got });
      const { entries, check } = got;
      if (entries.part.kind === 'failed') return prior ? problem(entries.part.message) : setState({ state: 'failed', outcome: entries });
      if (check.part.kind === 'failed') return prior ? problem(check.part.message) : setState({ state: 'failed', outcome: check });
      if (entries.part.data.shape !== 'list' || check.part.data.shape !== 'record') {
        return prior ? problem('The page came back in a shape this console does not understand.') : null;
      }
      const fresh = entries.part.data.rows.map((r) => ({ ...r, id: `${cursor ?? 'first'}:${r.id}` }));
      setState({
        state: 'ok',
        asOf: entries.asOf,
        rows: [...(prior?.rows ?? []), ...fresh],
        cursor: entries.part.data.nextCursor ?? null,
        check: check.part.data.cells,
        more: { busy: false, problem: null },
      });
    } finally {
      busy.current = false;
    }
  }
  return (
    <div className="dk-stack" data-testid={`customer-entries-${assetId}`}>
      <div className="dk-row">
        <button type="button" className="adm-btn" disabled={state?.state === 'loading'} onClick={() => void load(null)}>
          {state === null ? `Show the ${assetId} entries` : state.state === 'loading' ? 'Reading…' : `Read the ${assetId} entries again`}
        </button>
        <span className="dk-muted">svc-bank logs your account and this customer each time it hands out figures.</span>
      </div>
      {state?.state === 'unreached' && <Problem result={state.result} />}
      {state?.state === 'failed' && <OutcomeProblem outcome={state.outcome} what="the customer’s entries" />}
      {state?.state === 'ok' && (
        <div className="dk-stack">
          <p className="dk-asof">As of {formatAsOf(state.asOf)} (when this console read svc-bank)</p>
          <dl className="dk-kv" data-testid="customer-entries-check">
            {state.check.map((c) => (
              <div key={c.key} className="dk-kv-row">
                <dt>{c.label}</dt>
                <dd>{displayCell(c)}</dd>
              </div>
            ))}
          </dl>
          {state.rows.length === 0 ? (
            <p className="dk-muted" data-testid="customer-entries-empty">
              The ledger holds no entry behind this coin for this customer.
            </p>
          ) : (
            <CellTable rows={state.rows} head={state.rows[0]!.cells.filter((c) => !c.detail)} />
          )}
          {state.cursor !== null && (
            <div className="dk-row">
              <button
                type="button"
                className="adm-btn"
                disabled={state.more.busy}
                onClick={() => void load(state.cursor)}
                data-testid="customer-entries-next"
              >
                {state.more.busy ? 'Reading…' : 'Older entries'}
              </button>
              <span className="dk-muted">svc-bank says older entries exist. Each page is read on request.</span>
            </div>
          )}
          {state.more.problem && (
            <p className="dk-why" role="alert" data-testid="customer-entries-problem">
              {state.more.problem}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Look up one customer by account id: their balance per coin, then the entries behind any coin. */
export function CustomerBalances() {
  const [typed, setTyped] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [result, setResult] = useState<OwnFetch | 'loading' | null>(null);
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const busy = useRef(false);
  const id = typed.trim();
  const valid = CUSTOMER_ID.test(id);
  async function find() {
    if (!valid || busy.current) return;
    busy.current = true;
    setAsked(id);
    setOpenAsset(null);
    setResult('loading');
    try {
      setResult(await fetchCustomerBalances(id));
    } finally {
      busy.current = false;
    }
  }
  const outcome = result !== null && result !== 'loading' && result.ok ? result.outcome : null;
  return (
    <form
      className="dk-stack"
      data-testid="customer-balances"
      onSubmit={(e) => {
        e.preventDefault();
        void find();
      }}
    >
      <h3>Look up one customer’s balances</h3>
      <p className="dk-muted">
        Paste the customer’s account id, as support has it. This reads the ledger and changes nothing. svc-bank writes a log line with your
        account and the customer’s before it reads a figure, and refuses to read when it cannot.
      </p>
      <div className="adm-field">
        <label htmlFor="customer-balances-id">Customer account id</label>
        <input
          id="customer-balances-id"
          className="adm-input"
          value={typed}
          maxLength={36}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setTyped(e.target.value);
            setAsked(null);
            setResult(null);
          }}
        />
      </div>
      <div className="dk-row">
        <button type="submit" className="adm-btn" disabled={!valid || result === 'loading'}>
          {result === 'loading' ? 'Reading…' : 'Find this customer'}
        </button>
        {!valid && <span className="dk-why">Enter an account id first (the 36-character id, with dashes).</span>}
      </div>
      {result !== null && result !== 'loading' && !result.ok && <Problem result={result} />}
      {outcome?.part.kind === 'failed' && <OutcomeProblem outcome={outcome} what="the customer’s balances" />}
      {outcome?.part.kind === 'ok' && outcome.part.data.shape === 'list' && asked !== null && (
        <div className="dk-stack" data-testid="customer-balances-result">
          <p className="dk-asof">As of {formatAsOf(outcome.asOf)} (when this console read svc-bank)</p>
          {outcome.part.data.rows.length === 0 ? (
            <p className="dk-muted" data-testid="customer-balances-empty">
              The ledger holds no balance for this customer. That means no coin has ever been posted to them, not that the id is right.
            </p>
          ) : (
            <CellTable
              rows={outcome.part.data.rows}
              head={outcome.part.data.rows[0]!.cells}
              action={(row) => (
                <button
                  type="button"
                  className="adm-btn"
                  aria-expanded={openAsset === row.id}
                  onClick={() => setOpenAsset(openAsset === row.id ? null : row.id)}
                >
                  {openAsset === row.id ? 'Close' : 'Entries'}
                </button>
              )}
            />
          )}
          {openAsset !== null && <EntriesPanel key={`${asked}:${openAsset}`} userId={asked} assetId={openAsset} />}
        </div>
      )}
    </form>
  );
}
