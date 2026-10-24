'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { formatWhen } from '@/lib/as-of';
import { lookupQuery, lookupRefusal, type LedgerLookupAnswer, type LedgerLookupQuery, type LedgerTransaction } from '@/lib/ledger/lookup';

type Mode = 'txId' | 'businessKey';

type View =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'answer'; readonly answer: LedgerLookupAnswer; readonly readAt: string }
  | { readonly kind: 'refused'; readonly code: string | null; readonly status: number };

/**
 * Look up one ledger transaction by its id, or trace a business key to the transaction it booked (J-ops-console-03).
 * The read runs as the signed-in founder, and svc-ledger records each lookup under them before it reads. A transaction
 * shows its place in the ledger's log, its reference, request and ledger times and its audit entry, and every posting
 * with where the value came from or went and the account's balance before and after it; the transaction id and the business key each lead to the
 * other lookup. `initial` (from `/ledger?txId=` or `?businessKey=`, the cross-desk search's link back) is looked up once on
 * opening, as a new recorded read.
 */
export function LedgerLookup({ initial = null }: { initial?: LedgerLookupQuery | null }) {
  const [mode, setMode] = useState<Mode>(initial && 'txId' in initial ? 'txId' : 'businessKey');
  const [typed, setTyped] = useState(initial ? ('txId' in initial ? initial.txId : initial.businessKey) : '');
  const [view, setView] = useState<View>({ kind: 'idle' });
  const query = lookupQuery(mode, typed);
  const opened = useRef(false);

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

  useEffect(() => {
    if (opened.current || !initial) return;
    opened.current = true;
    void run('txId' in initial ? 'txId' : 'businessKey', 'txId' in initial ? initial.txId : initial.businessKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on opening
  }, []);

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
    <section id="ledger-lookup" className="adm-control-card" data-testid="ledger-lookup" aria-labelledby="ledger-lookup-heading">
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
          Nothing was booked under the business key <code>{view.answer.businessKey}</code>. No record: the ledger keeps no record of a write
          it refused, so there is nothing more to show for this key.
        </p>
      )}
      {view.kind === 'answer' && view.answer.found && (
        <TransactionView transaction={view.answer.transaction} readAt={view.readAt} onFollow={follow} />
      )}
    </section>
  );
}

/** One booked transaction and its postings. With `onFollow`, the id and the key each run the other lookup; without, they are text. */
export function TransactionView({
  transaction,
  readAt,
  onFollow,
}: {
  transaction: LedgerTransaction;
  readAt: string;
  onFollow?: (mode: Mode, value: string) => void;
}) {
  return (
    <div data-testid="ledger-lookup-transaction">
      <dl>
        <dt>Transaction id</dt>
        <dd>
          {onFollow ? (
            <button type="button" className="adm-link" onClick={() => onFollow('txId', transaction.txId)} data-testid="ledger-lookup-tx-id">
              {transaction.txId}
            </button>
          ) : (
            <code data-testid="ledger-lookup-tx-id">{transaction.txId}</code>
          )}
        </dd>
        <dt>Business key</dt>
        <dd>
          {onFollow ? (
            <button
              type="button"
              className="adm-link"
              onClick={() => onFollow('businessKey', transaction.businessKey)}
              data-testid="ledger-lookup-business-key"
            >
              {transaction.businessKey}
            </button>
          ) : (
            <code data-testid="ledger-lookup-business-key">{transaction.businessKey}</code>
          )}
        </dd>
        <dt>Module</dt>
        <dd>{transaction.module}</dd>
        <dt>Reason</dt>
        <dd>{transaction.reason}</dd>
        <dt>Log sequence</dt>
        <dd data-testid="ledger-lookup-seq">{transaction.booking.seq}</dd>
        <dt>Reference</dt>
        <dd data-testid="ledger-lookup-reference">
          {transaction.booking.reference ? <code>{transaction.booking.reference}</code> : 'None recorded'}
        </dd>
        <dt>Request time</dt>
        <dd data-testid="ledger-lookup-request-time">
          {formatWhen(transaction.postedAt)}{' '}
          <span className="adm-subtle">(the ledger’s clock when it took the request; the hash covers it)</span>
        </dd>
        <dt>Ledger time</dt>
        <dd data-testid="ledger-lookup-ledger-time">
          {transaction.booking.bookedAt ? (
            <>
              {formatWhen(transaction.booking.bookedAt)}{' '}
              <span className="adm-subtle">(the database’s clock when the booking’s database transaction began)</span>
            </>
          ) : (
            'Not recorded: this transaction has no event record'
          )}
        </dd>
        <dt>Audit entry</dt>
        <dd data-testid="ledger-lookup-event">
          {transaction.booking.event ? (
            <>
              <code>{transaction.booking.event.subject}</code> record <code>{transaction.booking.event.id}</code>, written{' '}
              {formatWhen(transaction.booking.event.recordedAt)} in the same commit;{' '}
              {transaction.booking.event.publishedAt
                ? `published ${formatWhen(transaction.booking.event.publishedAt)}`
                : 'not yet published to the event bus'}
            </>
          ) : (
            'None: the ledger holds no event record for this transaction'
          )}
        </dd>
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
              <th>From or to</th>
              <th>Account</th>
              <th>Asset</th>
              <th>Direction</th>
              <th>Amount</th>
              <th>Balance before</th>
              <th>Balance after</th>
            </tr>
          </thead>
          <tbody>
            {transaction.postings.map((posting) => (
              <tr key={posting.entryId} data-side={posting.side}>
                <td>{posting.side === 'source' ? 'Source' : 'Destination'}</td>
                <td>
                  <code>{posting.accountId}</code>
                </td>
                <td>{posting.assetId}</td>
                <td>{posting.direction}</td>
                <td>{posting.amount}</td>
                <td>{posting.balanceBefore}</td>
                <td>{posting.balanceAfter}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="adm-subtle">
        Read at {formatWhen(readAt)} by this browser’s clock. Account ids are the ledger’s own; no customer name is shown.
      </p>
    </div>
  );
}
