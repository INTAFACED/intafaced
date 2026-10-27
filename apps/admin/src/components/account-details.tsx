'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  CUSTOMER_DETAIL_KEYS,
  type CustomerDetailKey,
  type CustomerDetailReview,
  type CustomerDetailsResult,
  type CustomerDetailsState,
} from '@intafaced/contracts/account-controls';
import { founderMutationHeaders } from '@/lib/founder-browser';
import { DETAIL_LABEL, historyOutcome, isProtectedDetail } from '@/lib/accounts/details';

/**
 * A customer's personal details (J-ops-console-04 #9). One founder changes contact, address, occupation, income and
 * business details at once, with a reason. A change of name, date of birth or tax number opens a compliance review: the
 * record keeps the old value, and the other founder passes or rejects it here. Identity keeps the details encrypted, and
 * the history names fields, never values.
 */
export function AccountDetails({
  userId,
  founderId,
  readOnly = null,
}: {
  userId: string;
  founderId: string;
  /** Why nothing may change (an archived record), or null. */
  readOnly?: string | null;
}) {
  const [state, setState] = useState<CustomerDetailsState | null | undefined>(undefined);
  /** null when the history could not be read: no edit is offered then, since its request key names the newest entry. */
  const [history, setHistory] = useState<CustomerDetailsResult[] | null>(null);
  const [error, setError] = useState('');
  const [field, setField] = useState<CustomerDetailKey | ''>('');
  const [value, setValue] = useState('');
  const [clear, setClear] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<{ ok: boolean; text: string } | null>(null);
  const id = userId.toLowerCase();

  const load = useCallback(async () => {
    setError('');
    const q = encodeURIComponent(id);
    const [stateResponse, historyResponse] = await Promise.all([
      fetch(`/api/accounts/details?id=${q}`, { cache: 'no-store' }),
      fetch(`/api/accounts/details?id=${q}&view=history&limit=50`, { cache: 'no-store' }),
    ]);
    if (!stateResponse.ok) {
      const body = (await stateResponse.json().catch(() => null)) as { upstream?: string } | null;
      setState(undefined);
      setError(
        body?.upstream === 'identity.details_unconfigured'
          ? 'Identity keeps customer details encrypted under the KYC document key (IDENTITY_KYC_DOC_KEY), which is not set, so no detail can be read or changed (identity.details_unconfigured).'
          : body?.upstream === 'identity.details_unreadable'
            ? 'Identity holds details for this customer that its KYC document key does not open (a changed IDENTITY_KYC_DOC_KEY or a damaged record), so nothing is shown and nothing can be changed (identity.details_unreadable).'
            : 'Identity (svc-identity) did not answer for this customer’s details. Nothing can be changed until it does.',
      );
      return;
    }
    setState((await stateResponse.json()) as CustomerDetailsState | null);
    setHistory(historyResponse.ok ? ((await historyResponse.json()) as CustomerDetailsResult[]) : null);
  }, [id]);

  useEffect(() => {
    void load().catch(() => setError('Identity (svc-identity) did not answer for this customer’s details.'));
  }, [load]);

  async function post(path: string, body: unknown) {
    setBusy(true);
    setReply(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await founderMutationHeaders()) },
        body: JSON.stringify(body),
      });
      const answer = (await res.json().catch(() => null)) as { ok: boolean; text: string } | null;
      setReply(answer ?? { ok: false, text: 'The console could not read the answer. Read the account again before asking again.' });
      if (answer?.ok) {
        setValue('');
        setClear(false);
        setReason('');
        setNote('');
      }
    } catch {
      setReply({
        ok: false,
        text: 'The answer was lost. The record and its history below are read again and show whether identity made the change.',
      });
    } finally {
      setBusy(false);
      void load().catch(() => setError('The details could not be read again. Inspect the account again.'));
    }
  }

  const review: CustomerDetailReview | null = state?.openReview ?? null;
  const guarded = field !== '' && isProtectedDetail(field);
  const editWhy =
    readOnly ??
    (history === null
      ? 'The details history could not be read, so no change is offered. Read the account again.'
      : field === ''
        ? 'Choose the detail to change.'
        : guarded && review
          ? 'A compliance review of this customer’s protected details is already open; it is decided first (identity.details_review_open).'
          : !clear && value.trim() === ''
            ? 'Give the new value, or tick “Take it off the record”.'
            : reason.trim().length < 12
              ? 'Write the reason first (at least 12 characters).'
              : null);
  const decideWhy =
    readOnly ??
    (review && review.requestedBy === founderId.toLowerCase()
      ? 'You asked for this change, so the other founder decides it (identity.details_review_self_forbidden).'
      : note.trim().length < 12
        ? 'Write the decision note first (at least 12 characters).'
        : null);

  return (
    <div className="adm-control-card" data-testid="account-details">
      <h2>Customer details</h2>
      {error && (
        <p className="adm-alert" role="alert">
          {error}
        </p>
      )}
      {state === undefined && !error && <p className="adm-subtle">Reading the customer’s details…</p>}
      {state === null && <p>Identity has no customer with this id (target.not_found).</p>}
      {state && (
        <>
          <p className="adm-subtle" data-testid="account-details-version">
            Record version {state.version}. Name, date of birth and tax number change only after a compliance review a second founder
            passes.
          </p>
          <table className="adm-crm-table" data-testid="account-details-table">
            <caption className="adm-sr-only">The customer’s details on record</caption>
            <tbody>
              {CUSTOMER_DETAIL_KEYS.map((key) => (
                <tr key={key} data-detail={key}>
                  <th scope="row">{DETAIL_LABEL[key]}</th>
                  <td>{state.details[key] ?? <span className="adm-subtle">Not on record</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Compliance review</h3>
          {!review ? (
            <p data-testid="account-details-review">No compliance review is open.</p>
          ) : (
            <div data-testid="account-details-review">
              <p>
                <strong>Open:</strong> asked by {review.requestedBy.slice(0, 8)} on {new Date(review.requestedAt).toLocaleString()} because
                “{review.reason}”. The record keeps the old value until a second founder passes it.
              </p>
              <ul className="adm-plain-list">
                {review.fields.map((key) => (
                  <li key={key}>
                    {DETAIL_LABEL[key]}: {state.details[key] ?? 'not on record'} →{' '}
                    <strong>{review.proposed[key] ?? 'taken off the record'}</strong>
                  </li>
                ))}
              </ul>
              {review.documentIds.length > 0 && (
                <p className="adm-subtle">Evidence: {review.documentIds.length} document(s) in identity’s store.</p>
              )}
              <label className="adm-field">
                Decision note (kept with the review, 12 to 255 characters)
                <input value={note} disabled={readOnly !== null} maxLength={255} onChange={(e) => setNote(e.target.value)} />
              </label>
              {decideWhy && (
                <p className="adm-subtle" data-testid="account-details-decide-why">
                  {decideWhy}
                </p>
              )}
              <div className="adm-actions">
                <button
                  type="button"
                  className="adm-button"
                  disabled={busy || decideWhy !== null}
                  onClick={() =>
                    void post('/api/accounts/details/decide', { userId: id, reviewId: review.reviewId, decision: 'pass', note })
                  }
                >
                  Pass the review
                </button>
                <button
                  type="button"
                  className="adm-button"
                  disabled={busy || decideWhy !== null}
                  onClick={() =>
                    void post('/api/accounts/details/decide', { userId: id, reviewId: review.reviewId, decision: 'reject', note })
                  }
                >
                  Reject the review
                </button>
              </div>
            </div>
          )}

          <h3>Change a detail</h3>
          <form
            className="adm-stack"
            data-testid="account-details-edit"
            onSubmit={(event) => {
              event.preventDefault();
              if (editWhy || field === '' || history === null) return;
              void post('/api/accounts/details', {
                userId: id,
                field,
                value: clear ? null : value.trim(),
                reason: reason.trim(),
                basis: { version: state.version, after: history[0]?.auditId ?? null },
              });
            }}
          >
            <label className="adm-field">
              Detail to change
              <select value={field} disabled={readOnly !== null} onChange={(e) => setField(e.target.value as CustomerDetailKey | '')}>
                <option value="">Choose a detail</option>
                {CUSTOMER_DETAIL_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {DETAIL_LABEL[key]}
                    {isProtectedDetail(key) ? ' (compliance review)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="adm-field">
              New value
              <input value={value} disabled={readOnly !== null || clear} maxLength={500} onChange={(e) => setValue(e.target.value)} />
            </label>
            <label className="adm-check">
              <input type="checkbox" checked={clear} disabled={readOnly !== null} onChange={(e) => setClear(e.target.checked)} />
              Take it off the record
            </label>
            <label className="adm-field">
              Why (kept in the details history, 12 to 255 characters)
              <textarea value={reason} disabled={readOnly !== null} maxLength={255} onChange={(e) => setReason(e.target.value)} />
            </label>
            {editWhy && (
              <p className="adm-subtle" data-testid="account-details-edit-why">
                {editWhy}
              </p>
            )}
            <button type="submit" className="adm-button" disabled={busy || editWhy !== null}>
              {guarded ? 'Ask for a compliance review' : 'Save the change'}
            </button>
          </form>
          {reply && (
            <p role={reply.ok ? 'status' : 'alert'} className={reply.ok ? '' : 'adm-alert'} data-testid="account-details-reply">
              {reply.text}
            </p>
          )}

          <h3>Details history</h3>
          {history === null ? (
            <p className="adm-alert" role="alert" data-testid="account-details-history-error">
              Identity (svc-identity) did not return the details history, so it is not known whether this record was edited.
            </p>
          ) : history.length === 0 ? (
            <p>No recorded edits.</p>
          ) : (
            <div className="adm-table-scroll">
              <table className="adm-crm-table" data-testid="account-details-history">
                <caption className="adm-sr-only">Most recent 50 edits and decisions, without values</caption>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Outcome</th>
                    <th>Details</th>
                    <th>By</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((event) => (
                    <tr key={event.auditId}>
                      <td>{new Date(event.occurredAt).toLocaleString()}</td>
                      <td>{historyOutcome(event)}</td>
                      <td>{event.fields.map((key) => DETAIL_LABEL[key]).join(', ') || '—'}</td>
                      <td>{event.actorUserId?.slice(0, 8) ?? 'Unauthenticated'}</td>
                      <td>{event.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
