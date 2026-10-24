'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { formatWhen } from '@/lib/as-of';
import {
  ADDRESS_PREFIX,
  deskQuery,
  deskSearch,
  localToIso,
  type DeskAccountPage,
  type DeskStats,
  type DeskTransactionPage,
  type LedgerDeskAnswer,
  type LedgerDeskRead,
} from '@/lib/ledger/desk';
import { lookupRefusal } from '@/lib/ledger/lookup';
import { AccountMetadataPanel } from '@/components/ledger-account-metadata';

type Reading<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'answer'; readonly value: T; readonly readAt: string }
  | { readonly kind: 'refused'; readonly code: string | null; readonly status: number };

/** One desk read through `/api/ledger-desk/[read]`, as the signed-in founder. Never throws. */
async function readDesk(read: LedgerDeskRead, query: Record<string, string>): Promise<Reading<LedgerDeskAnswer>> {
  const search = deskSearch(read, query);
  try {
    const res = await fetch(`/api/ledger-desk/${read}${search ? `?${search}` : ''}`, { cache: 'no-store' });
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const named = body && typeof body === 'object' ? (body as { upstream?: unknown; code?: unknown }) : {};
      const code = typeof named.upstream === 'string' ? named.upstream : typeof named.code === 'string' ? named.code : null;
      return { kind: 'refused', code, status: res.status };
    }
    return { kind: 'answer', value: body as LedgerDeskAnswer, readAt: new Date().toISOString() };
  } catch {
    return { kind: 'refused', code: 'admin.upstream_unavailable', status: 503 };
  }
}

function Refused({ code, status, testId }: { code: string | null; status: number; testId: string }) {
  return (
    <p className="adm-alert" role="alert" data-testid={testId}>
      {deskRefusal(code, status)} {code && <span className="adm-subtle">({code})</span>}
    </p>
  );
}

/** What a refused desk read means, in words. The lookups' wording where the codes are theirs. */
export function deskRefusal(code: string | null, status: number): string {
  switch (code) {
    case 'ledger.lookup_unrecorded':
      return 'The ledger could not record this read, so it did not read it. Nothing was shown.';
    case 'ledger.lookup_unavailable':
      return 'The read was recorded, but the ledger could not answer it. Try again.';
    case 'ledger.lookup_input_invalid':
    case 'edge.invalid_ledger_lookup':
    case 'admin.ledger_desk_input':
      return 'The ledger refused these filters: an asset is 1 to 32 characters, a time range runs forward, and an address prefix is an owner type, a colon and the start of the owner id.';
    default:
      return lookupRefusal(code, status);
  }
}

/**
 * The ledger desk's browsing reads (J-ops-console-03 #1, #4, #5, OPS-ledger-desk-01): booked transactions filtered by
 * asset and time with the ledger's own total and a next page, accounts found by address prefix with their volumes and
 * the balance derived from them, and the book's counts. Each read runs as the signed-in founder; svc-ledger records a
 * page of the list or the search under them before it reads. Reads only: nothing here can change a posting.
 */
export function LedgerDesk({ userId }: { userId: string }) {
  return (
    <section className="adm-control-card" data-testid="ledger-desk" aria-labelledby="ledger-desk-heading">
      <h2 id="ledger-desk-heading">Browse the ledger</h2>
      <p className="adm-subtle">
        Reads of the book as it stands. Each page of transactions or accounts is recorded under your name before the ledger reads it.
        Nothing on this desk can change a posting.
      </p>
      <TransactionList />
      <AccountSearch userId={userId} />
      <BookCounts />
    </section>
  );
}

function TransactionList() {
  const [assetId, setAssetId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [view, setView] = useState<Reading<DeskTransactionPage>>({ kind: 'idle' });
  const [pages, setPages] = useState<string[]>([]);
  // The ledger counts on the first page; later pages keep that total.
  const [total, setTotal] = useState<string | null>(null);
  const filters = { assetId: assetId.trim().toUpperCase(), from: localToIso(from), to: localToIso(to) };
  const query = deskQuery('transactions', filters);
  const badTime = (from.trim() !== '' && filters.from === '') || (to.trim() !== '' && filters.to === '');

  const load = async (before: string | null, applied: Record<string, string>) => {
    setView({ kind: 'reading' });
    const outcome = await readDesk('transactions', before ? { ...applied, before } : applied);
    if (outcome.kind === 'answer' && outcome.value.read === 'transactions') {
      if (outcome.value.page.total !== null) setTotal(outcome.value.page.total);
      setView({ kind: 'answer', value: outcome.value.page, readAt: outcome.readAt });
    } else if (outcome.kind === 'refused') {
      setView(outcome);
    } else {
      setView({ kind: 'refused', code: 'admin.upstream_invalid', status: 502 });
    }
  };

  const [applied, setApplied] = useState<Record<string, string>>({});
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!query) return;
    setApplied(query);
    setPages([]);
    setTotal(null);
    void load(null, query);
  };

  return (
    <div className="adm-stack" data-testid="ledger-desk-transactions">
      <h3>Transactions</h3>
      <form onSubmit={submit} className="adm-stack">
        <label className="adm-field">
          Asset
          <input
            value={assetId}
            onChange={(event) => setAssetId(event.target.value)}
            maxLength={32}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="adm-field">
          From (inclusive)
          <input type="datetime-local" step={1} value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="adm-field">
          To (exclusive)
          <input type="datetime-local" step={1} value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        {(badTime || (!query && !badTime)) && (
          <p className="adm-subtle" role="status">
            {badTime ? 'A time is a date and a time.' : 'The range must run forward, and an asset is at most 32 characters.'}
          </p>
        )}
        <button type="submit" disabled={!query || badTime || view.kind === 'reading'}>
          Show transactions
        </button>
      </form>
      {view.kind === 'reading' && <p className="adm-subtle">Reading the ledger…</p>}
      {view.kind === 'refused' && <Refused code={view.code} status={view.status} testId="ledger-desk-transactions-refused" />}
      {view.kind === 'answer' && (
        <>
          <p data-testid="ledger-desk-total">
            <strong>{total ?? '—'}</strong> {total === '1' ? 'transaction matches' : 'transactions match'}, counted by the ledger. Page{' '}
            {pages.length + 1}, newest first.
          </p>
          {view.value.rows.length === 0 ? (
            <p data-testid="ledger-desk-transactions-empty">No booked transaction matches these filters.</p>
          ) : (
            <div className="adm-table-scroll">
              <table className="adm-crm-table" data-testid="ledger-desk-transactions-table">
                <caption className="adm-sr-only">Booked transactions, newest first</caption>
                <thead>
                  <tr>
                    <th>Sequence</th>
                    <th>Booked</th>
                    <th>Business key</th>
                    <th>Module</th>
                    <th>Reason</th>
                    <th>Assets</th>
                    <th>Postings</th>
                  </tr>
                </thead>
                <tbody>
                  {view.value.rows.map((row) => (
                    <tr key={row.txId} data-tx={row.txId}>
                      <td>{row.seq}</td>
                      <td>{formatWhen(row.postedAt)}</td>
                      <td>
                        <Link href={`/ledger?txId=${row.txId}#ledger-lookup`} className="adm-link">
                          {row.businessKey}
                        </Link>
                      </td>
                      <td>{row.module}</td>
                      <td>{row.reason}</td>
                      <td>{row.assets.join(', ')}</td>
                      <td>{row.postings}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="adm-actions">
            {pages.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const previous = pages.slice(0, -1);
                  setPages(previous);
                  void load(previous.at(-1) ?? null, applied);
                }}
              >
                Previous page
              </button>
            )}
            {view.value.nextCursor && (
              <button
                type="button"
                onClick={() => {
                  const cursor = view.value.nextCursor!;
                  setPages([...pages, cursor]);
                  void load(cursor, applied);
                }}
              >
                Next page
              </button>
            )}
          </div>
          <p className="adm-subtle">Read at {formatWhen(view.readAt)} by this browser’s clock. Open a business key to see its postings.</p>
        </>
      )}
    </div>
  );
}

function AccountSearch({ userId }: { userId: string }) {
  const [prefix, setPrefix] = useState('');
  const [labelled, setLabelled] = useState<string | null>(null);
  const [view, setView] = useState<Reading<DeskAccountPage>>({ kind: 'idle' });
  const [pages, setPages] = useState<string[]>([]);
  const [applied, setApplied] = useState('');
  const typed = prefix.trim();
  const valid = ADDRESS_PREFIX.test(typed);

  const load = async (search: string, after: string | null) => {
    setView({ kind: 'reading' });
    const outcome = await readDesk('accounts', after ? { prefix: search, after } : { prefix: search });
    if (outcome.kind === 'answer' && outcome.value.read === 'accounts')
      setView({ kind: 'answer', value: outcome.value.page, readAt: outcome.readAt });
    else if (outcome.kind === 'refused') setView(outcome);
    else setView({ kind: 'refused', code: 'admin.upstream_invalid', status: 502 });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setApplied(typed);
    setPages([]);
    void load(typed, null);
  };

  return (
    <div className="adm-stack" data-testid="ledger-desk-accounts">
      <h3>Accounts by address</h3>
      <p className="adm-subtle">
        An account’s address is its owner type and owner id, for example <code>house:fees:trade</code> or <code>treasury:rail:card</code>.
        Type a whole owner type, a colon and the start of the owner id.
      </p>
      <form onSubmit={submit} className="adm-stack">
        <label className="adm-field">
          Address prefix
          <input value={prefix} onChange={(event) => setPrefix(event.target.value)} maxLength={140} spellCheck={false} autoComplete="off" />
        </label>
        {typed !== '' && !valid && (
          <p className="adm-subtle" role="status">
            Start with user, subaccount, module, house or treasury, then a colon and at least one character.
          </p>
        )}
        <button type="submit" disabled={!valid || view.kind === 'reading'}>
          Search accounts
        </button>
      </form>
      {view.kind === 'reading' && <p className="adm-subtle">Reading the ledger…</p>}
      {view.kind === 'refused' && <Refused code={view.code} status={view.status} testId="ledger-desk-accounts-refused" />}
      {view.kind === 'answer' &&
        (view.value.accounts.length === 0 ? (
          <p data-testid="ledger-desk-accounts-empty">
            No account’s address starts with <code>{applied}</code>.
          </p>
        ) : (
          <>
            <div className="adm-table-scroll">
              <table className="adm-crm-table" data-testid="ledger-desk-accounts-table">
                <caption className="adm-sr-only">Accounts whose address starts with {applied}</caption>
                <thead>
                  <tr>
                    <th>Address</th>
                    <th>Asset</th>
                    <th>Kind</th>
                    <th>Purpose</th>
                    <th>Debits</th>
                    <th>Credits</th>
                    <th>Balance</th>
                    <th>Postings</th>
                    <th>Metadata</th>
                  </tr>
                </thead>
                <tbody>
                  {view.value.accounts.map((row) => (
                    <tr key={row.accountId} data-account={row.accountId}>
                      <td>
                        <code>{row.address}</code>
                      </td>
                      <td>{row.assetId}</td>
                      <td>{row.kind}</td>
                      <td>{row.purpose || '—'}</td>
                      <td>{row.debits}</td>
                      <td>{row.credits}</td>
                      <td>{row.balance}</td>
                      <td>{row.postings}</td>
                      <td>
                        <button type="button" onClick={() => setLabelled(row.accountId)} aria-pressed={labelled === row.accountId}>
                          Metadata
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="adm-actions">
              {pages.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const previous = pages.slice(0, -1);
                    setPages(previous);
                    void load(applied, previous.at(-1) ?? null);
                  }}
                >
                  Previous page
                </button>
              )}
              {view.value.nextCursor && (
                <button
                  type="button"
                  onClick={() => {
                    const cursor = view.value.nextCursor!;
                    setPages([...pages, cursor]);
                    void load(applied, cursor);
                  }}
                >
                  Next page
                </button>
              )}
            </div>
            <p className="adm-subtle">
              Debits raise a balance in this book and credits lower it; the balance is debits minus credits, derived by the ledger from the
              two volumes. Read at {formatWhen(view.readAt)} by this browser’s clock.
            </p>
          </>
        ))}
      {labelled && <AccountMetadataPanel key={labelled} accountId={labelled} userId={userId} onClose={() => setLabelled(null)} />}
    </div>
  );
}

function BookCounts() {
  const [view, setView] = useState<Reading<DeskStats>>({ kind: 'idle' });
  const load = async () => {
    setView({ kind: 'reading' });
    const outcome = await readDesk('stats', {});
    if (outcome.kind === 'answer' && outcome.value.read === 'stats')
      setView({ kind: 'answer', value: outcome.value.stats, readAt: outcome.readAt });
    else if (outcome.kind === 'refused') setView(outcome);
    else setView({ kind: 'refused', code: 'admin.upstream_invalid', status: 502 });
  };
  return (
    <div className="adm-stack" data-testid="ledger-desk-stats">
      <h3>Book counts</h3>
      <button type="button" onClick={() => void load()} disabled={view.kind === 'reading'}>
        {view.kind === 'answer' ? 'Count again' : 'Count the book'}
      </button>
      {view.kind === 'reading' && <p className="adm-subtle">Counting…</p>}
      {view.kind === 'refused' && <Refused code={view.code} status={view.status} testId="ledger-desk-stats-refused" />}
      {view.kind === 'answer' && (
        <>
          <dl data-testid="ledger-desk-stats-counts">
            <dt>Transactions</dt>
            <dd data-testid="ledger-desk-stat-transactions">{view.value.transactions}</dd>
            <dt>Postings</dt>
            <dd data-testid="ledger-desk-stat-postings">{view.value.postings}</dd>
            <dt>Accounts</dt>
            <dd data-testid="ledger-desk-stat-accounts">{view.value.accounts}</dd>
            <dt>Assets with an account</dt>
            <dd data-testid="ledger-desk-stat-assets">{view.value.assets}</dd>
            <dt>Newest transaction</dt>
            <dd>
              {view.value.lastSeq && view.value.lastPostedAt
                ? `sequence ${view.value.lastSeq}, booked ${formatWhen(view.value.lastPostedAt)}`
                : 'None: the book is empty'}
            </dd>
          </dl>
          <p className="adm-subtle">Counted by the ledger at {formatWhen(view.value.asOf)} by its database clock.</p>
        </>
      )}
    </div>
  );
}
