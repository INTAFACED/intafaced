'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { KycReviewList } from '@intafaced/contracts/identity-kyc-cases';
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { KycReviewRefusal } from '@/lib/kyc-review/model';
import './desk.css';

type Answer<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly refusal: KycReviewRefusal };

const UNKNOWN: KycReviewRefusal = {
  code: null,
  title: 'The outcome is not known',
  body: 'The console could not tell whether that went through. Reload the queue to see where the case stands.',
};

async function readAnswer<T>(res: Response): Promise<Answer<T>> {
  const body = (await res.json().catch(() => null)) as Answer<T> | null;
  if (body && body.ok === true && 'data' in body) return body;
  if (body && body.ok === false && body.refusal && typeof body.refusal.title === 'string') return body;
  return { ok: false, refusal: UNKNOWN };
}

/** One page of the queue, through the console's own route. */
export async function fetchQueue(cursor: string | null): Promise<Answer<KycReviewList>> {
  try {
    const res = await fetch(`/api/identity-ops/kyc${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return await readAnswer<KycReviewList>(res);
  } catch {
    return { ok: false, refusal: UNKNOWN };
  }
}

/** A claim, release or note, as the signed-in person. */
export async function postReviewStep<T>(step: Record<string, unknown>): Promise<Answer<T>> {
  try {
    const res = await fetch('/api/identity-ops/kyc', {
      method: 'POST',
      headers: await founderMutationHeaders(),
      body: JSON.stringify(step),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return await readAnswer<T>(res);
  } catch {
    return { ok: false, refusal: UNKNOWN };
  }
}

export function RefusalLine({ refusal, testId = 'kyc-review-refusal' }: { refusal: KycReviewRefusal; testId?: string }) {
  return (
    <article className="adm-callout" data-tone="danger" role="alert" data-testid={testId} data-code={refusal.code ?? ''}>
      <strong>{refusal.title}</strong>
      <p>{refusal.body}</p>
      {refusal.code ? <p className="dk-muted">Code: {refusal.code}</p> : null}
    </article>
  );
}

function who(assignedTo: string | null, me: string): string {
  if (assignedTo === null) return 'Nobody';
  return assignedTo === me ? 'You' : 'Another reviewer';
}

/**
 * The verification review queue (I-kyc-compliance-02, J-identity-20 #1): open cases oldest first, one page of the owner's
 * page size at a time, read from identity with the time it was read. A reviewer claims a case before working it; a case
 * someone else claimed first refuses in words (`kyc.case_assigned`) and nothing changes.
 */
export function KycReviewQueue({ me }: { me: string }) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [page, setPage] = useState<Answer<KycReviewList> | null>(null);
  const [readAt, setReadAt] = useState<string | null>(null);
  const [rowReply, setRowReply] = useState<Record<string, KycReviewRefusal | 'claimed' | 'released'>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const cursor = cursors[cursors.length - 1] ?? null;

  async function load(at: string | null) {
    setPage(null);
    const next = await fetchQueue(at);
    setPage(next);
    setReadAt(new Date().toISOString());
  }

  useEffect(() => {
    void load(cursor);
  }, [cursor]);

  async function assign(caseId: string, action: 'claim' | 'release') {
    setBusy(caseId);
    const reply = await postReviewStep<{ assignedTo: string | null }>({ op: 'assign', caseId, action });
    setRowReply((r) => ({ ...r, [caseId]: reply.ok ? (action === 'claim' ? 'claimed' : 'released') : reply.refusal }));
    setBusy(null);
    const fresh = await fetchQueue(cursor);
    setPage(fresh);
    setReadAt(new Date().toISOString());
  }

  return (
    <section className="dk-stack" data-testid="kyc-review-queue">
      <header className="dk-stack">
        <h1>Verification queue</h1>
        <p className="dk-muted">
          Open verification cases, oldest first, read from identity as you. Claim a case before you work it: a case has one reviewer at a
          time. Decisions are made on the case.
        </p>
      </header>
      <form className="dk-row" action="/identity-ops/kyc/business" method="get" data-testid="kyb-open">
        <label className="dk-stack">
          <span>Business application: merchant id</span>
          <input name="merchantId" aria-label="Merchant id" pattern="[0-9a-fA-F-]{36}" required />
        </label>
        <button type="submit" className="adm-btn">
          Open business application
        </button>
      </form>
      {page === null ? (
        <p data-testid="kyc-queue-loading">Reading the queue from identity…</p>
      ) : !page.ok ? (
        <RefusalLine refusal={page.refusal} testId="kyc-queue-refusal" />
      ) : (
        <>
          <p className="dk-muted" data-testid="kyc-queue-meta" data-page-size={page.data.pageSize} data-page={cursors.length}>
            Page {cursors.length}, up to {page.data.pageSize} cases a page (the owner&apos;s page size). Read at{' '}
            <time dateTime={readAt ?? ''}>{readAt}</time>.
          </p>
          {page.data.cases.length === 0 ? (
            <p data-testid="kyc-queue-empty">No open verification cases on this page.</p>
          ) : (
            <table className="adm-table" data-testid="kyc-queue-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Level</th>
                  <th>Country</th>
                  <th>Submitted</th>
                  <th>Reviewer</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {page.data.cases.map((c) => {
                  const reply = rowReply[c.caseId];
                  return (
                    <tr key={c.caseId} data-testid="kyc-queue-row" data-case={c.caseId} data-assignee={who(c.assignedTo, me)}>
                      <td>
                        <Link href={`/identity-ops/kyc/${encodeURIComponent(c.caseId)}`}>
                          <code>{c.caseId.slice(0, 8)}</code>
                        </Link>
                      </td>
                      <td>{c.tier}</td>
                      <td>{c.jurisdiction}</td>
                      <td>
                        <time dateTime={c.submittedAt}>{c.submittedAt}</time>
                      </td>
                      <td data-testid="kyc-queue-assignee">{who(c.assignedTo, me)}</td>
                      <td className="dk-stack">
                        {c.assignedTo === me ? (
                          <button
                            type="button"
                            className="adm-btn"
                            disabled={busy === c.caseId}
                            onClick={() => void assign(c.caseId, 'release')}
                          >
                            Release
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="adm-btn"
                            disabled={busy === c.caseId}
                            onClick={() => void assign(c.caseId, 'claim')}
                          >
                            Claim
                          </button>
                        )}
                        {reply === 'claimed' ? <p data-testid="kyc-queue-claimed">You claimed this case.</p> : null}
                        {reply === 'released' ? <p data-testid="kyc-queue-released">You released this case.</p> : null}
                        {reply && typeof reply === 'object' ? <RefusalLine refusal={reply} /> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <nav className="dk-row" aria-label="Queue pages">
            <button type="button" className="adm-btn" disabled={cursors.length === 1} onClick={() => setCursors([null])}>
              First page
            </button>
            <button
              type="button"
              className="adm-btn"
              disabled={page.data.nextCursor === null}
              onClick={() => setCursors((c) => [...c, page.data.nextCursor])}
            >
              Next page
            </button>
            {page.data.nextCursor === null ? <span data-testid="kyc-queue-last">This is the last page.</span> : null}
          </nav>
        </>
      )}
    </section>
  );
}
