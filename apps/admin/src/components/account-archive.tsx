'use client';
import { useCallback, useEffect, useState } from 'react';
import type { AccountArchiveProposals, AccountArchiveResult, AccountArchiveState } from '@intafaced/contracts';
import { ControlDesk } from '@/components/control-desk';
import { ARCHIVE_REASON_CODES, type AccountArchiveReasonCode } from '@/lib/desk/approval-packet';
import { archivedNote } from '@/lib/accounts/archive-copy';

const REASON_LABEL: Record<AccountArchiveReasonCode, string> = {
  dormant: 'Dormant',
  customer_request: 'Customer request',
  duplicate: 'Duplicate record',
  other: 'Other',
};

/**
 * Archive of one closed customer record (J-ops-console-04 #10). A two-founder request through the desk: you propose, a
 * different founder approves on their own console (identity accepts only a founder here), and you run it. Only a closed account can be archived, and an archive
 * cannot be undone: the record is read-only afterwards. Also shows the customers identity proposes for archive under the
 * owner's dormancy period, or that the period is not set.
 */
export function AccountArchive({
  userId,
  founderId,
  onChanged,
  onState,
}: {
  userId: string;
  founderId: string;
  onChanged: () => void;
  /** The archive state as read, null when identity has no such account, undefined while it could not be read. */
  onState?: (state: AccountArchiveState | null | undefined) => void;
}) {
  const [state, setState] = useState<AccountArchiveState | null>(null);
  const [history, setHistory] = useState<AccountArchiveResult[]>([]);
  const [proposals, setProposals] = useState<AccountArchiveProposals | 'unread' | null>(null);
  const [error, setError] = useState('');
  const [reasonCode, setReasonCode] = useState<AccountArchiveReasonCode | ''>('');

  const load = useCallback(async () => {
    setError('');
    const id = encodeURIComponent(userId.toLowerCase());
    // The dormancy list is not about this record, so its failure never hides this record's archive state.
    void fetch('/api/accounts/archive?proposals=true', { cache: 'no-store' })
      .then(async (response) => setProposals(response.ok ? ((await response.json()) as AccountArchiveProposals) : 'unread'))
      .catch(() => setProposals('unread'));
    const [stateResponse, historyResponse] = await Promise.all([
      fetch(`/api/accounts/archive?id=${id}`, { cache: 'no-store' }),
      fetch(`/api/accounts/archive?id=${id}&history=true&limit=50`, { cache: 'no-store' }),
    ]);
    if (!stateResponse.ok || !historyResponse.ok) {
      setState(null);
      onState?.(undefined);
      setError('Identity (svc-identity) did not answer for this record’s archive state. Nothing can be archived until it does.');
      return;
    }
    const current = (await stateResponse.json()) as AccountArchiveState | null;
    setState(current);
    onState?.(current);
    setHistory((await historyResponse.json()) as AccountArchiveResult[]);
  }, [userId, onState]);

  useEffect(() => {
    void load().catch(() => {
      onState?.(undefined);
      setError('Identity (svc-identity) did not answer for this record’s archive state.');
    });
  }, [load, onState]);

  const refresh = () => {
    void load().catch(() => setError('The archive state could not be read again. Inspect the account again.'));
    onChanged();
  };

  return (
    <div className="adm-control-card" data-testid="account-archive">
      <h2>Archive the customer</h2>
      {error && (
        <p className="adm-alert" role="alert">
          {error}
        </p>
      )}
      {!state && !error && <p className="adm-subtle">Reading the record’s archive state…</p>}
      {state && (
        <>
          <p data-testid="account-archive-status">
            <strong>{archivedNote(state) ?? (state.status === 'closed' ? 'Closed, not archived' : 'Open, not archived')}</strong>
            <span className="adm-subtle"> · control version {state.version}</span>
          </p>
          <label className="adm-field">
            Archive reason code
            <select
              value={reasonCode}
              disabled={state.archivedAt !== null}
              onChange={(event) => setReasonCode(event.target.value as AccountArchiveReasonCode | '')}
            >
              <option value="">Choose a reason code</option>
              {ARCHIVE_REASON_CODES.map((code) => (
                <option key={code} value={code}>
                  {REASON_LABEL[code]}
                </option>
              ))}
            </select>
          </label>
          <ControlDesk
            key={`archive:${userId}:${state.version}`}
            endpoint="/api/accounts/archive"
            userId={founderId}
            blockedReason={archivedNote(state)}
            formHold={
              state.status !== 'closed'
                ? 'Identity archives only a closed account (identity.archive_blocked_open_account). Close it first under Close or reopen.'
                : reasonCode === ''
                  ? 'Choose a reason code first.'
                  : null
            }
            action={{
              heading: 'Archive this customer for good',
              submitLabel: 'Ask a second founder to approve the archive',
              needsReason: true,
              reasonLabel: 'Why (kept in the record’s archive history, 12 to 255 characters)',
              danger: true,
              build: (why) => ({
                kind: 'identity.account.archive',
                userId: userId.toLowerCase(),
                reasonCode: reasonCode === '' ? 'other' : reasonCode,
                reason: why,
                version: state.version,
              }),
            }}
            consequence="Two different people must agree: you make the request here, a different founder pastes the packet on their own console and approves it, and then you run it. An archive cannot be undone: the record cannot be frozen, unfrozen or reopened afterwards. Only a founder can approve it."
            blockedButtonLabel="Archive unavailable"
            onChanged={refresh}
          />
          <h3>Dormant customers proposed for archive</h3>
          <div data-testid="account-archive-dormancy">
            {!proposals ? (
              <p className="adm-subtle">Reading identity’s proposals…</p>
            ) : proposals === 'unread' ? (
              <p className="adm-alert" role="alert">
                Identity (svc-identity) did not answer for the dormant customers. Inspect the account again to retry.
              </p>
            ) : proposals.dormancyDays === null ? (
              <p>
                Dormancy period: not set. The owner has not set how long a closed record waits (IDENTITY_DORMANCY_DAYS), so identity
                proposes no customer for archive.
              </p>
            ) : proposals.proposals.length === 0 ? (
              <p>Dormancy period: {proposals.dormancyDays} days. No closed record has gone that long without a change or a sign-in.</p>
            ) : (
              <>
                <p>
                  Dormancy period: {proposals.dormancyDays} days. Identity proposes these closed records; each still needs its own archive
                  with a second founder.
                </p>
                <ul className="adm-plain-list">
                  {proposals.proposals.map((p) => (
                    <li key={p.userId}>
                      {p.userId} <span className="adm-subtle">last activity {new Date(p.lastActivityAt).toLocaleDateString()}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <h3>Archive history</h3>
          {history.length === 0 ? (
            <p>No recorded archive attempts.</p>
          ) : (
            <div className="adm-table-scroll">
              <table className="adm-crm-table" data-testid="account-archive-history">
                <caption className="adm-sr-only">Most recent 50 archive attempts</caption>
                <thead>
                  <tr>
                    <th>Time</th>
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
                      <td>{event.outcome === 'refused' ? `refused (${event.code})` : event.outcome}</td>
                      <td>{REASON_LABEL[event.reasonCode]}</td>
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
