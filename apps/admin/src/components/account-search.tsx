'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { CellValueView } from '@/components/ops-desk';
import { searchTerm } from '@/lib/account-search/search';
import type { ReadOutcome, ReadSpec, Row } from '@/lib/ops-desk/types';
import './desk.css';

type Answer = { readonly spec: ReadSpec; readonly outcome: ReadOutcome };
type Shown = { readonly spec: ReadSpec; readonly rows: readonly Row[]; readonly cursor: string | null; readonly asOf: string };

async function fetchSearch(q: string, cursor: string | null): Promise<Answer | { readonly problem: string }> {
  const params = new URLSearchParams({ q, ...(cursor === null ? {} : { cursor }) });
  try {
    const response = await fetch(`/api/accounts/search?${params}`, { cache: 'no-store' });
    const body = (await response.json().catch(() => null)) as (Answer & { message?: string }) | null;
    if (!response.ok || !body?.outcome)
      return { problem: body?.message ?? `This console could not run the search (HTTP ${response.status}).` };
    return body;
  } catch {
    return { problem: 'This console did not answer. Nothing was searched; try again.' };
  }
}

/**
 * Find customers by the start of their handle or their whole email (identity's operator search). Results page with identity's
 * own marker, so a long result is never cut; each row opens that customer's record.
 */
export function AccountSearch() {
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [problem, setProblem] = useState<{ title: string; message: string; code: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  async function run(q: string, cursor: string | null) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const answer = await fetchSearch(q, cursor);
      if ('problem' in answer) return setProblem({ title: 'Search not run', message: answer.problem, code: null });
      const { part } = answer.outcome;
      if (part.kind === 'failed')
        return setProblem({ title: `Could not load ${answer.spec.plainName}`, message: part.message, code: part.code });
      if (part.data.shape !== 'list')
        return setProblem({
          title: 'Search not readable',
          message: 'Identity answered in a shape this console does not understand.',
          code: null,
        });
      const page = part.data;
      setShown((now) => ({
        spec: answer.spec,
        rows: cursor === null || !now ? page.rows : [...now.rows, ...page.rows.filter((r) => !now.rows.some((s) => s.id === r.id))],
        cursor: page.nextCursor ?? null,
        asOf: answer.outcome.asOf,
      }));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="adm-callout dk-stack" data-tone="info" aria-labelledby="h-account-search" data-testid="account-search">
      <strong id="h-account-search">Find a customer</strong>
      <form
        className="dk-row"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = searchTerm(query);
          if ('error' in parsed) return setProblem({ title: 'Search not run', message: parsed.error, code: null });
          setTerm(query.trim());
          setShown(null);
          void run(query.trim(), null);
        }}
      >
        <label>
          Handle or email
          <input name="account-search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <button type="submit" className="adm-btn" data-tone="primary" disabled={busy}>
          Search
        </button>
      </form>
      <p className="dk-muted">The start of a handle (three characters or more), or a whole email address. Identity logs every search.</p>
      {problem && (
        <div className="adm-callout" data-tone="warn" role="status" data-testid="account-search-problem">
          <strong>{problem.title}</strong>
          <p>{problem.message}</p>
          {problem.code && <p className="dk-muted">Code: {problem.code}</p>}
        </div>
      )}
      {shown && (
        <div className="dk-stack" data-testid="account-search-results">
          <h3>{shown.spec.title}</h3>
          <p className="dk-muted">{shown.spec.note}</p>
          {shown.rows.length === 0 ? (
            <p data-testid="account-search-empty">{shown.spec.emptyText}</p>
          ) : (
            <div className="dk-table-wrap">
              <table className="dk-table">
                <thead>
                  <tr>
                    <th scope="col">Matched on</th>
                    {shown.spec.columns
                      .filter((c) => !c.detail)
                      .map((c) => (
                        <th key={c.key} scope="col">
                          {c.label}
                        </th>
                      ))}
                    <th scope="col">Record</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.rows.map((row) => (
                    <tr key={row.id} data-testid="account-search-row">
                      <td>{shown.spec.input && 'email' in shown.spec.input ? 'Email' : 'Handle start'}</td>
                      {row.cells
                        .filter((c) => !c.detail)
                        .map((c) => (
                          <td key={c.key}>
                            <CellValueView cell={c} />
                          </td>
                        ))}
                      <td>
                        <Link href={`/accounts/${row.id}`}>Open record</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="dk-muted" data-testid="account-search-count">
            {shown.rows.length} shown{shown.cursor ? ', more match' : ', that is every match'}.
          </p>
          {shown.cursor && term && (
            <button type="button" className="adm-btn" disabled={busy} onClick={() => void run(term, shown.cursor)}>
              Next page
            </button>
          )}
        </div>
      )}
    </section>
  );
}
