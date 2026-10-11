'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CrmOpportunity, crmMessagePageSchema, crmQueueMessageReceiptSchema, crmMessageSchema } from '@intafaced/contracts';
import { crmJson, crmWrite, workflowUrl, crmDate as date, crmLabel as label, type PendingCrmWrite } from '@/lib/crm-browser';
import { founderName, type FounderOwner } from './founder-names';
type Page = (typeof crmMessagePageSchema)['_output'];
type Receipt = (typeof crmQueueMessageReceiptSchema)['_output'];
type Message = (typeof crmMessageSchema)['_output'];
const statusText: Record<Message['status'], string> = {
  pending: 'Queued · awaiting dispatch',
  unconfigured: 'Saved in queue · delivery not configured',
  accepted: 'Gateway accepted · arrival unconfirmed',
  failed: 'Dispatch failed',
  unresolved: 'Acceptance unknown · no automatic resend',
};
export function CrmMessages({
  csrf,
  opportunity,
  originalRecipient,
  owners,
  onSaved,
  onDraftChange,
}: {
  csrf: string;
  opportunity: CrmOpportunity;
  originalRecipient: { name: string; email: string };
  owners: FounderOwner[];
  onSaved: () => Promise<boolean>;
  onDraftChange: (dirty: boolean) => void;
}) {
  const [page, setPage] = useState<Page | null>(null),
    [cursor, setCursor] = useState<string>(),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [kind, setKind] = useState('information_request'),
    [staffText, setStaffText] = useState(''),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const pending = useRef(new Map<string, PendingCrmWrite>()),
    generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const value = await crmJson<Page>(workflowUrl('listMessages', { opportunityId: opportunity.id, limit: 20, cursor }));
      if (current === generation.current) setPage(value);
      return true;
    } catch (failure) {
      if (current === generation.current) setError(failure instanceof Error ? failure.message : 'Message outcomes unavailable.');
      return false;
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [opportunity.id, cursor]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  async function queue() {
    setBusy(true);
    setError('');
    setNotice('');
    let saved: Receipt | null = null;
    try {
      saved = await crmWrite<Receipt>(csrf, pending.current, 'queueMessage', {
        opportunityId: opportunity.id,
        expectedRevision: opportunity.revision,
        kind,
        staffText,
        reason,
      });
      setStaffText('');
      setReason('');
      setConfirmed(false);
      onDraftChange(false);
      const recordFresh = await onSaved(),
        messagesFresh = await refresh();
      setNotice(
        `Queue-time receipt: ${statusText[saved.message.status]}. This is a durable queue receipt.${recordFresh && messagesFresh ? '' : ' Refresh to load the latest records.'}`,
      );
    } catch (failure) {
      if (saved) setNotice(`Queue-time receipt: ${statusText[saved.message.status]}. Refresh to load the latest records.`);
      else setError(failure instanceof Error ? failure.message : 'Could not confirm the queue request.');
    } finally {
      setBusy(false);
    }
  }
  const inviteAllowed = opportunity.audience === 'investor' && ['qualified', 'diligence', 'terms'].includes(opportunity.stage);
  return (
    <section className="adm-enquiry-messages">
      <h3>Enquiry messages</h3>
      <p className="adm-subtle">
        Messages go to the original submission address: {originalRecipient.name} · {originalRecipient.email}. A canonical contact merge does
        not replace this recipient.
      </p>
      {error && (
        <p className="adm-alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="adm-save-notice" role="status">
          {notice}
        </p>
      )}
      <ul className="adm-history">
        {page?.items.map((message) => (
          <li key={message.id}>
            <strong>{label(message.kind)}</strong>
            <small>{statusText[message.status]}</small>
            <small>
              {founderName(owners, message.actorUserId)} · queued {date(message.createdAt)}
            </small>
            {message.notification?.code && <p className="adm-subtle">{label(message.notification.code.replace('guest.', ''))}</p>}
            {message.notification?.acceptedAt && (
              <p className="adm-subtle">
                Gateway accepted {date(message.notification.acceptedAt)}. This does not confirm that the recipient received or read it.
              </p>
            )}
          </li>
        ))}
      </ul>
      {!loading && page?.items.length === 0 && <p className="adm-subtle">No staff messages on the last loaded page.</p>}
      <div className="adm-pagination">
        <button
          type="button"
          disabled={loading || busy}
          onClick={() => {
            setError('');
            void refresh();
          }}
        >
          Refresh message outcomes
        </button>
        {page?.nextCursor && (
          <button type="button" disabled={loading || busy} onClick={() => setCursor(page.nextCursor ?? undefined)}>
            Next message page
          </button>
        )}
        {cursor && (
          <button type="button" disabled={loading || busy} onClick={() => setCursor(undefined)}>
            First message page
          </button>
        )}
      </div>
      <details>
        <summary>Queue an enquiry message</summary>
        <form
          className="adm-form"
          onSubmit={(event) => {
            event.preventDefault();
            void queue();
          }}
        >
          <label>
            Message purpose
            <select aria-label="Message purpose" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="information_request">Request information</option>
              <option value="follow_up">Follow up</option>
              <option value="call_invitation" disabled={!inviteAllowed}>
                Invite to a call
              </option>
            </select>
          </label>
          {!inviteAllowed && (
            <p className="adm-subtle">Call invitations become available after an investor enquiry is reviewed and qualified.</p>
          )}
          <label>
            Message text
            <textarea
              aria-label="Message text"
              required
              maxLength={2000}
              value={staffText}
              onChange={(event) => {
                setStaffText(event.target.value);
                onDraftChange(Boolean(event.target.value || reason || confirmed));
              }}
            />
          </label>
          <label>
            Message reason
            <input
              aria-label="Message reason"
              required
              maxLength={500}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                onDraftChange(Boolean(staffText || event.target.value || confirmed));
              }}
            />
          </label>
          <label className="adm-check">
            <input
              required
              type="checkbox"
              checked={confirmed}
              onChange={(event) => {
                setConfirmed(event.target.checked);
                onDraftChange(Boolean(staffText || reason || event.target.checked));
              }}
            />
            Queue this transactional message for the original enquiry address shown above.
          </label>
          <p className="adm-subtle">
            Saved in queue and gateway accepted are different outcomes. Unknown acceptance remains for staff review; there is no automatic
            resend button.
          </p>
          <button
            type="submit"
            disabled={busy || !confirmed || opportunity.stage === 'closed' || (kind === 'call_invitation' && !inviteAllowed)}
          >
            Queue message
          </button>
        </form>
      </details>
    </section>
  );
}
