'use client';
import { useCallback, useEffect, useState } from 'react';
import type { AccountClosureResult, AccountClosureState } from '@intafaced/contracts';
import { ControlDesk } from '@/components/control-desk';
import { CLOSE_REASON_CODES, type AccountCloseReasonCode } from '@/lib/desk/approval-packet';

const REASON_LABEL: Record<AccountCloseReasonCode, string> = {
  fraud: 'Fraud',
  negative_balance: 'Negative balance',
  bank_reason: 'Bank reason',
  customer_request: 'Customer request',
  other: 'Other',
};

function statusLine(state: AccountClosureState): string {
  if (state.status !== 'closed') return state.status === 'frozen' ? 'Open (frozen)' : 'Open';
  const why = state.closeReasonCode ? REASON_LABEL[state.closeReasonCode].toLowerCase() : 'the customer’s own closure';
  return state.closedBy === 'customer' ? `Closed by the customer (${why})` : `Closed by staff (${why})`;
}

/**
 * Staff close and reopen of one identity account (J-ops-console-04 #7). Both are two-founder requests through the desk:
 * you propose, a different founder approves on their own console, and you run it. A reopen is possible only for an
 * account the customer closed; any other closed account shows why it stays closed.
 */
export function AccountClosure({
  userId,
  founderId,
  onChanged,
  onState,
}: {
  userId: string;
  founderId: string;
  onChanged: () => void;
  /** The closure state as read, null when identity has no such account, undefined while it could not be read. */
  onState?: (state: AccountClosureState | null | undefined) => void;
}) {
  const [state, setState] = useState<AccountClosureState | null>(null);
  const [history, setHistory] = useState<AccountClosureResult[]>([]);
  const [error, setError] = useState('');
  const [reasonCode, setReasonCode] = useState<AccountCloseReasonCode | ''>('');

  const load = useCallback(async () => {
    setError('');
    const id = encodeURIComponent(userId.toLowerCase());
    const [stateResponse, historyResponse] = await Promise.all([
      fetch(`/api/accounts/closure?id=${id}`, { cache: 'no-store' }),
      fetch(`/api/accounts/closure?id=${id}&history=true&limit=50`, { cache: 'no-store' }),
    ]);
    if (!stateResponse.ok || !historyResponse.ok) {
      setState(null);
      onState?.(undefined);
      setError('Identity (svc-identity) did not answer for this account’s closure state. Nothing can be closed or reopened until it does.');
      return;
    }
    const current = (await stateResponse.json()) as AccountClosureState | null;
    setState(current);
    onState?.(current);
    setHistory((await historyResponse.json()) as AccountClosureResult[]);
  }, [userId, onState]);

  useEffect(() => {
    void load().catch(() => {
      onState?.(undefined);
      setError('Identity (svc-identity) did not answer for this account’s closure state.');
    });
  }, [load, onState]);

  const refresh = () => {
    void load().catch(() => setError('The closure state could not be read again. Inspect the account again.'));
    onChanged();
  };

  return (
    <div className="adm-control-card" data-testid="account-closure">
      <h2>Close or reopen</h2>
      {error && (
        <p className="adm-alert" role="alert">
          {error}
        </p>
      )}
      {!state && !error && <p className="adm-subtle">Reading the account’s closure state…</p>}
      {state && (
        <>
          <p data-testid="account-closure-status">
            <strong>{statusLine(state)}</strong>
            <span className="adm-subtle"> · control version {state.version}</span>
          </p>
          {state.status !== 'closed' ? (
            <>
              <label className="adm-field">
                Reason code
                <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value as AccountCloseReasonCode | '')}>
                  <option value="">Choose a reason code</option>
                  {CLOSE_REASON_CODES.map((code) => (
                    <option key={code} value={code}>
                      {REASON_LABEL[code]}
                    </option>
                  ))}
                </select>
              </label>
              <ControlDesk
                key={`close:${userId}:${state.version}`}
                endpoint="/api/accounts/closure"
                userId={founderId}
                blockedReason={null}
                formHold={reasonCode === '' ? 'Choose a reason code first.' : null}
                action={{
                  heading: 'Close this account',
                  submitLabel: 'Ask a second founder to approve closing the account',
                  needsReason: true,
                  reasonLabel: 'Why (kept in the account’s closure history, 12 to 255 characters)',
                  danger: true,
                  build: (why) => ({
                    kind: 'identity.account.close',
                    userId: userId.toLowerCase(),
                    reasonCode: reasonCode === '' ? 'other' : reasonCode,
                    reason: why,
                    version: state.version,
                  }),
                }}
                consequence="Two different people must agree: you make the request here, a different founder pastes the packet on their own console and approves it, and then you run it. Identity also accepts another operator as the approver, so check who approved before you run it. Identity first asks the bank, trading and P2P services whether anything is still open for this account and refuses while it is. Only an account closed at the customer’s request can be reopened."
                blockedButtonLabel="Close unavailable"
                onChanged={refresh}
              />
            </>
          ) : (
            <ControlDesk
              key={`reopen:${userId}:${state.version}`}
              endpoint="/api/accounts/closure"
              userId={founderId}
              blockedReason={
                state.reopenable
                  ? null
                  : 'Identity reopens only an account the customer closed. This one was closed by staff for another reason, so it stays closed (identity.reopen_not_allowed).'
              }
              action={
                state.reopenable
                  ? {
                      heading: 'Reopen this account',
                      submitLabel: 'Ask a second founder to approve reopening the account',
                      needsReason: true,
                      reasonLabel: 'Why (kept in the account’s closure history, 12 to 255 characters)',
                      build: (why) => ({
                        kind: 'identity.account.reopen',
                        userId: userId.toLowerCase(),
                        reason: why,
                        version: state.version,
                      }),
                    }
                  : null
              }
              consequence="Two different people must agree: you make the request, a different founder approves it on their own console, and you run it (identity also accepts another operator as the approver). The owner signs in again; revoked sessions, API keys and sub-accounts stay revoked."
              blockedButtonLabel="Reopen unavailable"
              onChanged={refresh}
            />
          )}
          <h3>Closure history</h3>
          {history.length === 0 ? (
            <p>No recorded close or reopen attempts.</p>
          ) : (
            <div className="adm-table-scroll">
              <table className="adm-crm-table" data-testid="account-closure-history">
                <caption className="adm-sr-only">Most recent 50 close and reopen attempts</caption>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Outcome</th>
                    <th>Reason code</th>
                    <th>Actor</th>
                    <th>Approved by</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((event) => (
                    <tr key={event.auditId}>
                      <td>{new Date(event.occurredAt).toLocaleString()}</td>
                      <td>{event.action}</td>
                      <td>{event.outcome === 'refused' ? `refused (${event.code})` : event.outcome}</td>
                      <td>{event.reasonCode ? REASON_LABEL[event.reasonCode] : '—'}</td>
                      <td>{event.actorUserId?.slice(0, 8) ?? 'Unauthenticated'}</td>
                      <td>{event.outcome === 'changed' ? event.approverUserId.slice(0, 8) : '—'}</td>
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
