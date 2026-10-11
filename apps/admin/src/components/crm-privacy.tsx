'use client';
import { useEffect, useRef, useState } from 'react';
import type {
  crmErasurePreviewSchema,
  crmErasureStatusSchema,
  crmErasureBeginInputSchema,
  crmErasureAdvanceInputSchema,
  crmRetentionStatusSchema,
  crmRetentionReviewInputSchema,
  crmRetentionReviewSchema,
} from '@intafaced/contracts';
import { crmJson, crmDate } from '@/lib/crm-browser';
import { founderName, type FounderOwner } from './founder-names';

type Preview = (typeof crmErasurePreviewSchema)['_output'];
type Status = (typeof crmErasureStatusSchema)['_output'];
type Begin = Omit<(typeof crmErasureBeginInputSchema)['_output'], 'requestId'>;
type Advance = Omit<(typeof crmErasureAdvanceInputSchema)['_output'], 'requestId'>;
type RetentionStatus = (typeof crmRetentionStatusSchema)['_output'];
type RetentionReview = (typeof crmRetentionReviewSchema)['_output'];
type RetentionReviewDraft = Omit<(typeof crmRetentionReviewInputSchema)['_output'], 'requestId'>;
export type PendingRetentionReview = { inputKey: string; body: string };
export class RetentionReviewRefused extends Error {}
export function RetentionPolicySummary({ status }: { status: RetentionStatus | 'loading' | 'unavailable' }) {
  let summary = 'Retention status unavailable. Automatic deletion has not been confirmed.';
  if (status === 'loading') summary = 'Checking retention status…';
  else if (status !== 'unavailable')
    summary =
      status.status === 'disabled'
        ? 'Automatic retention disabled · published outreach policy not configured.'
        : `Retention policy configured · six calendar months · automatic deletion ${status.automationEnabled ? 'enabled' : 'paused'}.`;
  return (
    <>
      <p className="adm-subtle">{summary}</p>
      {status !== 'loading' && status !== 'unavailable' && status.status === 'configured' && (
        <p className="adm-subtle">
          Published policy: six calendar months of inactivity · active review window up to 30 days · UTC. Automatic sweep:{' '}
          {status.automationEnabled ? 'enabled' : 'paused'} · last sweep {status.lastSweepAt ? crmDate(status.lastSweepAt) : 'not recorded'}
          .
        </p>
      )}
      {status !== 'loading' && status !== 'unavailable' && status.status === 'disabled' && (
        <p className="adm-subtle">No published retention policy is configured. Automatic retention is unavailable.</p>
      )}
    </>
  );
}
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
function parsedRetentionStatus(value: unknown): RetentionStatus | null {
  if (!row(value)) return null;
  if (value.status === 'disabled')
    return exact(value, ['status', 'reason']) && value.reason === 'published_policy_unconfigured' ? (value as RetentionStatus) : null;
  if (
    value.status !== 'configured' ||
    !exact(value, ['status', 'inactivityCalendarMonths', 'clockTimeZone', 'activeReviewMaxDays', 'automationEnabled', 'lastSweepAt']) ||
    value.inactivityCalendarMonths !== 6 ||
    value.clockTimeZone !== 'UTC' ||
    value.activeReviewMaxDays !== 30 ||
    typeof value.automationEnabled !== 'boolean' ||
    (value.lastSweepAt !== null && !isTime(value.lastSweepAt))
  )
    return null;
  return value as RetentionStatus;
}
function parsedRetentionReview(value: unknown): RetentionReview {
  if (
    !row(value) ||
    !exact(value, [
      'reviewId',
      'canonicalContactId',
      'revision',
      'state',
      'reviewedBy',
      'reviewedAt',
      'expiresAt',
      'evidenceRef',
      'reason',
    ]) ||
    !isId(value.reviewId) ||
    !isId(value.canonicalContactId) ||
    !isCount(value.revision) ||
    value.revision < 1 ||
    (value.state !== 'active' && value.state !== 'inactive') ||
    !isId(value.reviewedBy) ||
    !isTime(value.reviewedAt) ||
    (value.expiresAt !== null && !isTime(value.expiresAt)) ||
    typeof value.evidenceRef !== 'string' ||
    !value.evidenceRef.trim() ||
    value.evidenceRef.length > 256 ||
    typeof value.reason !== 'string' ||
    !value.reason.trim() ||
    value.reason.length > 2000 ||
    (value.state === 'inactive' ? value.expiresAt !== null : !validReviewExpiry(value.reviewedAt, value.expiresAt))
  )
    throw new Error('The retention review could not be confirmed. Retry the same request.');
  return value as RetentionReview;
}
function validReviewExpiry(reviewedAt: unknown, expiresAt: unknown): boolean {
  if (typeof reviewedAt !== 'string' || typeof expiresAt !== 'string') return false;
  const start = Date.parse(reviewedAt),
    end = Date.parse(expiresAt);
  return Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 30 * 24 * 60 * 60 * 1000;
}
function validRetentionDraft(value: unknown): value is RetentionReviewDraft {
  return (
    row(value) &&
    exact(value, ['canonicalContactId', 'expectedCanonicalRevision', 'expectedReviewRevision', 'state', 'evidenceRef', 'reason']) &&
    isId(value.canonicalContactId) &&
    isCount(value.expectedCanonicalRevision) &&
    value.expectedCanonicalRevision > 0 &&
    isCount(value.expectedReviewRevision) &&
    (value.state === 'active' || value.state === 'inactive') &&
    typeof value.evidenceRef === 'string' &&
    value.evidenceRef === value.evidenceRef.trim() &&
    value.evidenceRef.length > 0 &&
    value.evidenceRef.length <= 256 &&
    typeof value.reason === 'string' &&
    value.reason === value.reason.trim() &&
    value.reason.length > 0 &&
    value.reason.length <= 2000
  );
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
/** Unknown results retain one exact body and UUID; the operator retries explicitly. */
export async function retentionReviewWrite(
  csrf: string,
  pending: { current: PendingRetentionReview | null },
  draft: RetentionReviewDraft,
  canonicalContactId: string,
): Promise<RetentionReview> {
  if (!validRetentionDraft(draft)) throw new Error('Add a short evidence reference and reason before saving.');
  const inputKey = JSON.stringify(draft),
    previous = pending.current;
  if (previous && previous.inputKey !== inputKey)
    throw new Error('The previous review is unconfirmed. Retry its exact request before changing these entries.');
  const body =
    previous?.inputKey === inputKey
      ? previous.body
      : JSON.stringify({ action: 'privacyRetentionReview', input: { ...draft, requestId: crypto.randomUUID() } });
  pending.current = { inputKey, body };
  const response = await fetch('/api/crm/privacy', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', 'x-intafaced-csrf': csrf },
    body,
  });
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if ((response.status === 409 || response.status === 412) && row(raw) && raw.code === 'admin.upstream_refused') {
      pending.current = null;
      throw new RetentionReviewRefused('The contact or review changed. Refresh its current review before recording another one.');
    }
    if (response.status === 401 || response.status === 403)
      throw new Error('Your founder session is unavailable. Sign in again before retrying this review.');
    throw new Error('The review result is unconfirmed. Retry this same request.');
  }
  const result = parsedRetentionReview(raw);
  if (
    result.canonicalContactId !== canonicalContactId ||
    result.revision !== draft.expectedReviewRevision + 1 ||
    result.state !== draft.state ||
    result.evidenceRef !== draft.evidenceRef ||
    result.reason !== draft.reason
  )
    throw new Error('The saved review could not be confirmed. Retry the same request.');
  pending.current = null;
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
  canonicalRevision,
  owners,
  onDraftState,
  onComplete,
}: {
  csrf: string;
  canonicalContact: { id: string; name: string; email: string };
  canonicalRevision: number;
  owners: FounderOwner[];
  onDraftState: (dirty: boolean, pending: boolean) => void;
  onComplete: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<Preview | null>(null),
    [intent, setIntent] = useState<Status | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [retention, setRetention] = useState<RetentionStatus | 'loading' | 'unavailable'>('loading');
  const [retentionReview, setRetentionReview] = useState<RetentionReview | null>(null);
  const [reviewDraftBaseline, setReviewDraftBaseline] = useState<{
    state: 'active' | 'inactive';
    evidenceRef: string;
    reason: string;
  }>({ state: 'active', evidenceRef: '', reason: '' });
  const [retentionLoaded, setRetentionLoaded] = useState(false);
  const [reviewState, setReviewState] = useState<'active' | 'inactive'>('active');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [reviewReason, setReviewReason] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const reviewPending = useRef<{ inputKey: string; body: string } | null>(null);
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
        if (mounted.current) {
          setRetention(parsedRetentionStatus(value) ?? 'unavailable');
        }
      })
      .catch(() => {
        if (!abort.signal.aborted && mounted.current) setRetention('unavailable');
      });
    return () => {
      mounted.current = false;
      abort.abort();
    };
  }, []);
  useEffect(() => {
    const baseline = reviewDraftBaseline;
    const dirty =
      retentionLoaded &&
      (reviewState !== baseline.state || evidenceRef.trim() !== baseline.evidenceRef || reviewReason.trim() !== baseline.reason);
    onDraftState(dirty, reviewPending.current !== null);
  }, [onDraftState, retentionLoaded, reviewDraftBaseline, reviewState, evidenceRef, reviewReason, reviewBusy, reviewError]);
  useEffect(() => () => onDraftState(false, false), [onDraftState]);
  async function loadRetentionReview() {
    setReviewBusy(true);
    setReviewError('');
    try {
      const [status, review] = await Promise.all([
        crmJson<unknown>('/api/crm/privacy?view=privacyRetentionStatus'),
        crmJson<unknown>(
          `/api/crm/privacy?${new URLSearchParams({ view: 'privacyRetentionReviewStatus', canonicalContactId: canonicalContact.id })}`,
        ),
      ]);
      const parsedStatus = parsedRetentionStatus(status),
        parsedReview = review === null ? null : parsedRetentionReview(review);
      if (!parsedStatus || (parsedReview && parsedReview.canonicalContactId !== canonicalContact.id))
        throw new Error('The retention status could not be confirmed for this contact.');
      setRetention(parsedStatus);
      setRetentionReview(parsedReview);
      setRetentionLoaded(true);
      if (parsedReview) {
        setReviewState(parsedReview.state);
        setEvidenceRef(parsedReview.evidenceRef);
        setReviewReason(parsedReview.reason);
        setReviewDraftBaseline({ state: parsedReview.state, evidenceRef: parsedReview.evidenceRef, reason: parsedReview.reason });
      } else {
        const emptyDraft = { state: 'active' as const, evidenceRef: '', reason: '' };
        setReviewState(emptyDraft.state);
        setEvidenceRef(emptyDraft.evidenceRef);
        setReviewReason(emptyDraft.reason);
        setReviewDraftBaseline(emptyDraft);
      }
    } catch (failure) {
      setReviewError(failure instanceof Error ? failure.message : 'Retention review unavailable.');
    } finally {
      setReviewBusy(false);
    }
  }
  async function saveRetentionReview() {
    if (reviewBusy) return;
    const fields = {
      canonicalContactId: canonicalContact.id,
      expectedCanonicalRevision: canonicalRevision,
      expectedReviewRevision: retentionReview?.revision ?? 0,
      state: reviewState,
      evidenceRef: evidenceRef.trim(),
      reason: reviewReason.trim(),
    };
    if (!validRetentionDraft(fields)) {
      setReviewError('Add a short evidence reference and reason before saving.');
      return;
    }
    setReviewBusy(true);
    setReviewError('');
    try {
      const receipt = await retentionReviewWrite(csrf, reviewPending, fields, canonicalContact.id);
      setRetentionReview(receipt);
      const nextDraft = { state: 'active' as const, evidenceRef: '', reason: '' };
      setReviewState(nextDraft.state);
      setEvidenceRef(nextDraft.evidenceRef);
      setReviewReason(nextDraft.reason);
      setReviewDraftBaseline(nextDraft);
    } catch (failure) {
      setReviewError(failure instanceof Error ? failure.message : 'The saved review is unconfirmed. Retry the same request.');
    } finally {
      setReviewBusy(false);
    }
  }
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
    if (busy || reviewPending.current || !preview || (!confirmed && !pending.current.has('privacyBegin'))) return;
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
    if (busy || reviewPending.current || needsStatus || !intent || intent.status === 'complete') return;
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
  let startLabel = 'Start contact deletion';
  if (busy) startLabel = 'Confirming…';
  else if (pending.current.has('privacyBegin')) startLabel = 'Retry starting deletion';
  let advanceLabel = 'Continue deletion';
  if (busy) advanceLabel = 'Confirming…';
  else if (pending.current.has('privacyAdvance')) advanceLabel = 'Retry the same deletion step';
  return (
    <section className="adm-enquiry-workflows" aria-label="Contact privacy">
      <h3>Contact privacy</h3>
      <details>
        <summary>Retention and contact review</summary>
        <RetentionPolicySummary status={retention} />
        <p className="adm-subtle">
          This is the last recorded discussion review. Retention eligibility is rechecked under the current policy; this record alone does
          not guarantee an exemption.
        </p>
        {!retentionLoaded ? (
          <button type="button" disabled={reviewBusy} onClick={() => void loadRetentionReview()}>
            {reviewBusy ? 'Loading…' : 'Load contact review'}
          </button>
        ) : (
          <div className="adm-form">
            <button type="button" disabled={reviewBusy || Boolean(reviewPending.current)} onClick={() => void loadRetentionReview()}>
              Refresh current review
            </button>
            {retentionReview && (
              <p className="adm-save-notice" role="status">
                Last review marked <strong>{retentionReview.state}</strong> by {founderName(owners, retentionReview.reviewedBy)} on{' '}
                {crmDate(retentionReview.reviewedAt)}.
                {retentionReview.state === 'active' ? ` Recorded review expiry: ${crmDate(retentionReview.expiresAt!)}` : ''}
              </p>
            )}
            {!retentionReview && <p className="adm-subtle">No contact discussion review has been recorded.</p>}
            <label>
              Discussion review state
              <select
                disabled={reviewBusy || Boolean(reviewPending.current)}
                value={reviewState}
                onChange={(event) => setReviewState(event.target.value as 'active' | 'inactive')}
              >
                <option value="active">Active discussion</option>
                <option value="inactive">Inactive discussion</option>
              </select>
            </label>
            <label>
              Evidence reference
              <input
                disabled={reviewBusy || Boolean(reviewPending.current)}
                value={evidenceRef}
                maxLength={256}
                onChange={(event) => setEvidenceRef(event.target.value)}
              />
            </label>
            <label>
              Review reason
              <textarea
                disabled={reviewBusy || Boolean(reviewPending.current)}
                value={reviewReason}
                maxLength={2000}
                onChange={(event) => setReviewReason(event.target.value)}
                rows={3}
              />
            </label>
            <p className="adm-subtle">Active reviews are bounded by the policy window. No expiry is entered or extended by the browser.</p>
            {reviewError && (
              <p className="adm-alert" role="alert">
                {reviewError}
              </p>
            )}
            <button type="button" disabled={reviewBusy} onClick={() => void saveRetentionReview()}>
              {reviewBusy ? 'Saving…' : reviewPending.current ? 'Retry same review' : retentionReview ? 'Record a new discussion review' : 'Record discussion review'}
            </button>
          </div>
        )}
      </details>
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
                  disabled={busy || Boolean(reviewPending.current) || (!confirmed && !pending.current.has('privacyBegin'))}
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
                    disabled={busy || Boolean(reviewPending.current) || needsStatus}
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
