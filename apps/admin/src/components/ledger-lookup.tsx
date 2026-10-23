'use client';

import { useState, type FormEvent } from 'react';
import { formatWhen } from '@/lib/as-of';
import { lookupQuery, lookupRefusal, type LedgerLookupAnswer, type LedgerTransaction } from '@/lib/ledger/lookup';

type Mode = 'txId' | 'businessKey';

type View =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'answer'; readonly answer: LedgerLookupAnswer; readonly readAt: string }
  | { readonly kind: 'refused'; readonly code: string | null; readonly status: number };

/**
 * Look up one ledger transaction by its id, or trace a business key to the transaction it booked (J-ops-console-03).
 * The read runs as the signed-in founder, and svc-ledger records each lookup under them before it reads. A transaction
 * shows every posting with the account's balance after it; the transaction id and the business key each lead to the
 * other lookup.
 */
export function LedgerLookup() {
  const [mode, setMode] = useState<Mode>('businessKey');
  const [typed, setTyped] = useState('');
  const [view, setView] = useState<View>({ kind: 'idle' });
  const query = lookupQuery(mode, typed);

  const run = async (nextMode: Mode, value: string) => {
    const next = lookupQuery(nextMode, value);
    if (!next) return;
    setView({ kind: 'reading' });
    const param = 'txId' in next ? `txId=${encodeURIComponent(next.txId)}` : `businessKey=${encodeURIComponent(next.businessKey)}`;
    try {
      const res = await fetch(`/api/ledger-lookup?${param}`, { cache: 'no-store' });
      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const code = body && typeof body === 'object' ? (body as { upstream?: unknown; code?: unknown }) : {};
        const named = typeof code.upstream === 'string' ? code.upstream : typeof code.code === 'string' ? code.code : null;
        setView({ kind: 'refused', code: named, status: res.status });
        return;
      }
      setView({ kind: 'answer', answer: body as LedgerLookupAnswer, readAt: new Date().toISOString() });
    } catch {
      setView({ kind: 'refused', code: 'admin.upstream_unavailable', status: 503 });
    }
  };

  const follow = (nextMode: Mode, value: string) => {
    setMode(nextMode);
    setTyped(value);
    void run(nextMode, value);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(mode, typed);
  };

  return (
    <section className="adm-control-card" data-testid="ledger-lookup" aria-labelledby="ledger-lookup-heading">
      <h2 id="ledger-lookup-heading">Look up a transaction</h2>
      <p className="adm-subtle">
        Find one booked transaction by its id, or trace a business key (for example a deposit’s key) to the transaction it booked. Each
        lookup is recorded under your name before the ledger reads it.
      </p>
      <form onSubmit={submit} className="adm-stack">
        <label className="adm-field">
          Look up by
          <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
            <option value="businessKey">Business key</option>
            <option value="txId">Transaction id</option>
          </select>
        </label>
        <label className="adm-field">
          {mode === 'txId' ? 'Transaction id' : 'Business key'}
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            maxLength={mode === 'txId' ? 36 : 512}
          />
        </label>
        {typed.trim() !== '' && !query && (
          <p className="adm-subtle" role="status">
            {mode === 'txId' ? 'A transaction id is a UUID.' : 'A business key is 1 to 512 characters.'}
          </p>
        )}
        <button type="submit" disabled={!query || view.kind === 'reading'}>
          Look up
        </button>
      </form>
      {view.kind === 'reading' && <p className="adm-subtle">Reading the ledger…</p>}
      {view.kind === 'refused' && (
        <p className="adm-alert" role="alert" data-testid="ledger-lookup-refused">
          {lookupRefusal(view.code, view.status)} {view.code && <span className="adm-subtle">({view.code})</span>}
        </p>
      )}
      {view.kind === 'answer' && !view.answer.found && (
        <p data-testid="ledger-lookup-not-found">
          Nothing was booked under the business key <code>{view.answer.businessKey}</code>.
        </p>
      )}
      {view.kind === 'answer' && view.answer.found && (
        <TransactionView transaction={view.answer.transaction} readAt={view.readAt} onFollow={follow} />
      )}
    </section>
  );
}

function TransactionView({
  transaction,
  readAt,
  onFollow,
}: {
  transaction: LedgerTransaction;
  readAt: string;
  onFollow: (mode: Mode, value: string) => void;
}) {
  return (
    <div data-testid="ledger-lookup-transaction">
      <dl>
        <dt>Transaction id</dt>
        <dd>
          <button type="button" className="adm-link" onClick={() => onFollow('txId', transaction.txId)} data-testid="ledger-lookup-tx-id">
            {transaction.txId}
          </button>
        </dd>
        <dt>Business key</dt>
        <dd>
          <button
            type="button"
            className="adm-link"
            onClick={() => onFollow('businessKey', transaction.businessKey)}
            data-testid="ledger-lookup-business-key"
          >
            {transaction.businessKey}
          </button>
        </dd>
        <dt>Module</dt>
        <dd>{transaction.module}</dd>
        <dt>Reason</dt>
        <dd>{transaction.reason}</dd>
        <dt>Booked</dt>
        <dd>{formatWhen(transaction.postedAt)}</dd>
        <dt>Hash</dt>
        <dd>
          <code>{transaction.hash}</code>
        </dd>
        <dt>Previous hash</dt>
        <dd>{transaction.previousHash ? <code>{transaction.previousHash}</code> : 'None: the first transaction in the chain'}</dd>
      </dl>
      <div className="adm-table-scroll">
        <table className="adm-crm-table" data-testid="ledger-lookup-postings">
          <caption className="adm-sr-only">Postings of this transaction</caption>
          <thead>
            <tr>
              <th>Account</th>
              <th>Asset</th>
              <th>Direction</th>
              <th>Amount</th>
              <th>Balance after</th>
            </tr>
          </thead>
          <tbody>
            {transaction.postings.map((posting) => (
              <tr key={posting.entryId}>
                <td>
                  <code>{posting.accountId}</code>
                </td>
                <td>{posting.assetId}</td>
                <td>{posting.direction}</td>
                <td>{posting.amount}</td>
                <td>{posting.balanceAfter}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="adm-subtle">
        As svc-ledger answered at {formatWhen(readAt)}. Account ids are the ledger’s own; no customer name is shown.
      </p>
    </div>
  );
}
