'use client';
import { useEffect, useRef, useState } from 'react';
import type {
  crmErasurePreviewSchema,
  crmErasureStatusSchema,
  crmErasureBeginInputSchema,
  crmErasureAdvanceInputSchema,
} from '@intafaced/contracts';
import { crmJson, crmDate } from '@/lib/crm-browser';
import { founderName, type FounderOwner } from './founder-names';

type Preview = (typeof crmErasurePreviewSchema)['_output'];
type Status = (typeof crmErasureStatusSchema)['_output'];
type Begin = Omit<(typeof crmErasureBeginInputSchema)['_output'], 'requestId'>;
type Advance = Omit<(typeof crmErasureAdvanceInputSchema)['_output'], 'requestId'>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function row(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
/** The server validates shared schemas. These browser-only guards preserve that receipt boundary without importing server modules. */
function parsedStatus(value: unknown): Status {
  if (
    !row(value) ||
    !exact(value, [
      'intentId',
      'canonicalContactId',
      'revision',
      'status',
      'actorKind',
      'requestedBy',
      'requestedAt',
      'completedAt',
      'pendingSubmissionCount',
      'code',
    ]) ||
    !isId(value.intentId) ||
    !isId(value.canonicalContactId) ||
    (value.actorKind !== 'founder' && value.actorKind !== 'system') ||
    (value.actorKind === 'founder' ? !isId(value.requestedBy) : value.requestedBy !== null) ||
    !isCount(value.revision) ||
    value.revision < 1 ||
    !isTime(value.requestedAt) ||
    !isCount(value.pendingSubmissionCount) ||
    (value.code !== null && (typeof value.code !== 'string' || !Object.hasOwn(pendingText, value.code))) ||
    (value.status === 'complete'
      ? !isTime(value.completedAt) || value.pendingSubmissionCount !== 0 || value.code !== null
      : value.status !== 'pending_notify' || value.completedAt !== null)
  )
    throw new Error('The deletion result could not be confirmed. Retry this same request.');
  return value as Status;
}
function parsedPreview(value: unknown): Preview {
  if (
    !row(value) ||
    !exact(value, ['canonicalContactId', 'canonicalRevision', 'contacts', 'submissionIds', 'counts', 'snapshot']) ||
    !isId(value.canonicalContactId) ||
    !isCount(value.canonicalRevision) ||
    value.canonicalRevision < 1 ||
    typeof value.snapshot !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.snapshot) ||
    !Array.isArray(value.contacts) ||
    value.contacts.length < 1 ||
    value.contacts.length > 200 ||
    value.contacts.some(
      (c) => !row(c) || !exact(c, ['contactId', 'revision']) || !isId(c.contactId) || !isCount(c.revision) || c.revision < 1,
    ) ||
    !Array.isArray(value.submissionIds) ||
    value.submissionIds.length > 200 ||
    value.submissionIds.some((v) => !isId(v)) ||
    !row(value.counts) ||
    !exact(value.counts, ['contacts', 'submissions', 'opportunities', 'tasks', 'messages']) ||
    Object.values(value.counts).some((v) => !isCount(v))
  )
    throw new Error('The linked contact records could not be confirmed. Load another preview.');
  return value as Preview;
}
export type PendingPrivacyWrite = { inputKey: string; body: string };
export class PrivacyReviewedStateChanged extends Error {}
/** Unknown responses retain the exact reviewed payload and UUID; there is no automatic retry. */
export async function privacyWrite(
  csrf: string,
  pending: Map<string, PendingPrivacyWrite>,
  action: 'privacyBegin' | 'privacyAdvance',
  input: Begin | Advance,
  canonicalContactId: string,
): Promise<Status> {
  const inputKey = JSON.stringify({ input, canonicalContactId }),
    previous = pending.get(action);
  const body =
    previous?.inputKey === inputKey
      ? previous.body
      : JSON.stringify({
          action,
          ...(action === 'privacyAdvance' ? { canonicalContactId } : {}),
          input: { ...input, requestId: crypto.randomUUID() },
        });
  pending.set(action, { inputKey, body });
  const response = await fetch('/api/crm/privacy', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', 'x-intafaced-csrf': csrf },
    body,
  });
  if (!response.ok) {
    const refusal: unknown = await response.json().catch(() => null);
    if (
      (response.status === 409 || response.status === 412) &&
      refusal !== null &&
      typeof refusal === 'object' &&
      'code' in refusal &&
      refusal.code === 'admin.upstream_refused'
    ) {
      pending.delete(action);
      throw new PrivacyReviewedStateChanged(
        'The reviewed state changed or the action was refused. Review current records before another confirmation.',
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new Error('Your founder session is unavailable. Sign in again before retrying this request.');
    throw new Error('The deletion result is unconfirmed. Keep this enquiry open and retry the same request.');
  }
  const raw: unknown = await response.json();
  const result = parsedStatus(raw);
  if (
    result.canonicalContactId !== canonicalContactId ||
    ('intentId' in input && (result.intentId !== input.intentId || result.revision < input.expectedRevision))
  )
    throw new Error('The deletion result could not be confirmed. Retry this same request.');
  pending.delete(action);
  return result;
}
const pendingText: Record<NonNullable<Status['code']>, string> = {
  'ops.crm.notification_unconfigured': 'The email service is unavailable. Contact records remain while deletion is pending.',
  'ops.crm.notification_erasure_unknown':
    'Deletion of saved email records is unconfirmed. Contact records remain. Retry this step to check the result.',
  'ops.crm.notification_in_flight':
    'An email operation is still in progress. Contact records remain. Check deletion progress before trying this step again.',
};
function statusUrl(intentId: string, canonicalContactId: string) {
  return `/api/crm/privacy?${new URLSearchParams({ view: 'privacyStatus', intentId, canonicalContactId })}`;
}
export function CrmPrivacy({
  csrf,
  canonicalContact,
  owners,
  onComplete,
}: {
  csrf: string;
  canonicalContact: { id: string; name: string; email: string };
  owners: FounderOwner[];
  onComplete: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<Preview | null>(null),
    [intent, setIntent] = useState<Status | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [retention, setRetention] = useState<'loading' | 'disabled' | 'unavailable'>('loading');
  const [needsStatus, setNeedsStatus] = useState(false);
  const pending = useRef(new Map<string, PendingPrivacyWrite>()),
    advance = useRef<Advance | null>(null),
    begin = useRef<Begin | null>(null),
    completeNotified = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void crmJson<unknown>('/api/crm/privacy?view=privacyRetentionStatus', { signal: abort.signal })
      .then((value) => {
        if (mounted.current)
          setRetention(
            row(value) &&
              exact(value, ['status', 'reason']) &&
              value.status === 'disabled' &&
              value.reason === 'published_policy_unconfigured'
              ? 'disabled'
              : 'unavailable',
          );
      })
      .catch(() => {
        if (!abort.signal.aborted && mounted.current) setRetention('unavailable');
      });
    return () => {
      mounted.current = false;
      abort.abort();
    };
  }, []);
  async function received(value: Status) {
    if (!mounted.current) return;
    setIntent(value);
    if (value.status === 'complete' && !completeNotified.current) {
      completeNotified.current = true;
      try {
        await onComplete();
      } catch {
        if (mounted.current) setError('Deletion is complete. Refresh the workspace to remove its earlier view.');
      }
    }
  }
  async function inspect() {
    if (busy) return;
    setBusy(true);
    setError('');
    setConfirmed(false);
    try {
      const result = parsedPreview(
        await crmJson<unknown>(
          `/api/crm/privacy?${new URLSearchParams({ view: 'privacyPreview', canonicalContactId: canonicalContact.id })}`,
        ),
      );
      if (result.canonicalContactId !== canonicalContact.id) throw new Error('The selected contact could not be confirmed.');
      if (mounted.current) {
        setPreview(result);
        begin.current = null;
      }
    } catch (failure) {
      if (mounted.current) {
        setPreview(null);
        setError(failure instanceof Error ? failure.message : 'Preview unavailable.');
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function start() {
    if (busy || !preview || (!confirmed && !pending.current.has('privacyBegin'))) return;
    if (!begin.current)
      begin.current = {
        canonicalContactId: canonicalContact.id,
        expectedCanonicalRevision: preview.canonicalRevision,
        snapshot: preview.snapshot,
        confirmedEntireCluster: true,
        reason: 'confirmed_privacy_request',
      };
    setBusy(true);
    setError('');
    try {
      await received(await privacyWrite(csrf, pending.current, 'privacyBegin', begin.current, canonicalContact.id));
      setConfirmed(false);
    } catch (failure) {
      if (failure instanceof PrivacyReviewedStateChanged) {
        begin.current = null;
        setPreview(null);
        setConfirmed(false);
      }
      if (mounted.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Starting deletion is unconfirmed. Keep this enquiry open and retry the same request.',
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function step() {
    if (busy || needsStatus || !intent || intent.status === 'complete') return;
    if (!advance.current) advance.current = { intentId: intent.intentId, expectedRevision: intent.revision };
    setBusy(true);
    setError('');
    try {
      const value = await privacyWrite(csrf, pending.current, 'privacyAdvance', advance.current, canonicalContact.id);
      advance.current = null;
      await received(value);
    } catch (failure) {
      if (failure instanceof PrivacyReviewedStateChanged) {
        advance.current = null;
        setNeedsStatus(true);
      }
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'This step is unconfirmed. Retry the same request.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function refresh() {
    if (busy || !intent) return;
    setBusy(true);
    setError('');
    try {
      const result = parsedStatus(await crmJson<unknown>(statusUrl(intent.intentId, canonicalContact.id)));
      if (
        result.intentId !== intent.intentId ||
        result.canonicalContactId !== canonicalContact.id ||
        result.actorKind !== intent.actorKind ||
        result.requestedBy !== intent.requestedBy ||
        result.requestedAt !== intent.requestedAt ||
        result.revision < intent.revision
      )
        throw new Error('The current deletion progress could not be confirmed.');
      await received(result);
      setNeedsStatus(false);
      // Preserve an unknown command's original revision/UUID until its exact retry is confirmed.
      if (!pending.current.has('privacyAdvance')) advance.current = null;
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'Deletion progress unavailable.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function checkExisting() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = parsedStatus(
        await crmJson<unknown>(
          `/api/crm/privacy?${new URLSearchParams({ view: 'privacyStatus', canonicalContactId: canonicalContact.id })}`,
        ),
      );
      if (result.canonicalContactId !== canonicalContact.id) throw new Error('The deletion request does not match this primary contact.');
      // A canonical lookup recovers durable state without issuing or changing a command.
      // Keep any unknown mounted command's exact payload and UUID for its original retry.
      await received(result);
      setNeedsStatus(false);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'Deletion progress unavailable.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  let retentionLabel = 'Retention status unavailable. Automatic deletion has not been confirmed.';
  if (retention === 'disabled') retentionLabel = 'Automatic retention disabled · published outreach policy not configured.';
  else if (retention === 'loading') retentionLabel = 'Checking retention status…';
  let startLabel = 'Start contact deletion';
  if (busy) startLabel = 'Confirming…';
  else if (pending.current.has('privacyBegin')) startLabel = 'Retry starting deletion';
  let advanceLabel = 'Continue deletion';
  if (busy) advanceLabel = 'Confirming…';
  else if (pending.current.has('privacyAdvance')) advanceLabel = 'Retry the same deletion step';
  return (
    <section className="adm-enquiry-workflows" aria-label="Contact privacy">
      <h3>Contact privacy</h3>
      <p className="adm-subtle">{retentionLabel}</p>
      <details>
        <summary>Review contact deletion</summary>
        <p>
          Primary contact: <strong>{canonicalContact.name}</strong> · {canonicalContact.email}
        </p>
        <p className="adm-subtle">
          Verify the privacy request before proceeding. Deletion covers this primary contact, every merged contact and all their linked
          enquiry records.
        </p>
        <p className="adm-subtle">
          A saved deletion request does not mean deletion is complete. This removes our saved records; it cannot recall email already
          accepted by an external provider.
        </p>
        {error && (
          <p className="adm-alert" role="alert">
            {error}
            {pending.current.size > 0 ? ' The last result is unconfirmed. Keep this enquiry open and use its retry action.' : ''}
          </p>
        )}
        {!intent && (
          <>
            <p className="adm-subtle">
              Either founder can check this contact's deletion progress after reloading. Checking does not start or continue deletion.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void checkExisting();
              }}
            >
              Check deletion progress
            </button>
            <button
              type="button"
              disabled={busy || pending.current.has('privacyBegin')}
              onClick={() => {
                void inspect();
              }}
            >
              Preview linked records
            </button>
            {preview && (
              <div className="adm-form">
                <dl className="adm-answers">
                  {(
                    [
                      ['Contacts', preview.counts.contacts],
                      ['Original enquiries', preview.counts.submissions],
                      ['Opportunities', preview.counts.opportunities],
                      ['Tasks', preview.counts.tasks],
                      ['Messages', preview.counts.messages],
                    ] as const
                  ).map(([name, count]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd>{count}</dd>
                    </div>
                  ))}
                </dl>
                <div className="adm-callout" data-tone="danger">
                  <strong>Destructive action · all linked contact records</strong>
                  <p>
                    Saved contact details, original answers, notes and linked enquiry records will be removed after deletion of their saved
                    email records is confirmed. This cannot be undone here.
                  </p>
                </div>
                <label className="adm-check">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy || pending.current.has('privacyBegin')}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  I verified this request and confirm deletion of all {preview.counts.contacts} contacts and {preview.counts.submissions}{' '}
                  original enquiries shown above.
                </label>
                <p className="adm-subtle">
                  Starting pauses edits, questionnaire access and new messages for these records. Email already accepted and exports
                  downloaded elsewhere cannot be recalled.
                </p>
                <button
                  type="button"
                  className="adm-btn adm-danger-button"
                  data-tone="danger"
                  disabled={busy || (!confirmed && !pending.current.has('privacyBegin'))}
                  onClick={() => {
                    void start();
                  }}
                >
                  {startLabel}
                </button>
              </div>
            )}
          </>
        )}
        {intent && (
          <>
            <details>
              <summary>Deletion reference</summary>
              <p>
                <code>{intent.intentId}</code>
              </p>
              <p className="adm-subtle">
                Internal reference for this contact. Either founder can select the contact and check deletion progress after signing in.
              </p>
            </details>
            <p className="adm-save-notice" role="status">
              <strong>{intent.status === 'complete' ? 'Linked contact records deleted' : 'Deletion pending'}</strong> · started by{' '}
              {intent.actorKind === 'system'
                ? 'System retention sweep'
                : intent.requestedBy
                  ? founderName(owners, intent.requestedBy)
                  : 'Founder'}{' '}
              on {crmDate(intent.requestedAt)}.
            </p>
            {intent.status === 'pending_notify' ? (
              <>
                <p>Enquiries awaiting email-record deletion: {intent.pendingSubmissionCount}.</p>
                <p className="adm-subtle">
                  {intent.code
                    ? pendingText[intent.code]
                    : 'The deletion request is saved. Contact records remain until every enquiry’s saved email records are confirmed deleted.'}
                </p>
                <p className="adm-subtle">
                  Edits and new messages are paused. Continue deletion processes at most one enquiry per step; checking progress makes no
                  changes. Neither action sends email.
                </p>
                <div className="adm-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void refresh();
                    }}
                  >
                    Check deletion progress
                  </button>
                  <button
                    type="button"
                    className="adm-btn adm-danger-button"
                    data-tone="danger"
                    disabled={busy || needsStatus}
                    onClick={() => {
                      void step();
                    }}
                  >
                    {advanceLabel}
                  </button>
                </div>
              </>
            ) : (
              <p className="adm-subtle">
                Contact deletion completed {intent.completedAt ? crmDate(intent.completedAt) : ''}. Previously accepted email and
                independently downloaded exports remain separate.
              </p>
            )}
          </>
        )}
      </details>
    </section>
  );
}
