'use client';
/**
 * The open person: loading, saving, and every safety rule the old workspace had. It is a straight move of that logic into a
 * hook, with the new one-tap actions on top:
 *
 *  - every save sends the revision the form is based on (`lib/crm-base-revision`), so a change by the other founder is refused
 *    instead of overwritten;
 *  - unsaved edits are kept in this tab (`lib/crm-drafts`) and put back after a reload or a sign-in;
 *  - leaving the person with unsaved edits asks first (`lib/crm-discard-confirm`);
 *  - only the latest "open" result reaches the screen (`lib/crm-open-gate`);
 *  - a lost session is one alert with a Sign in link, and the typed edits stay.
 *
 * New: a background refresh that finds the other founder changed this enquiry says so before any save (G5), even while the
 * founder has unsaved edits.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { crmLocalDate } from '@/lib/crm-browser';
import { baseIsStale, expectedRevisionFor, nextBaseRevision, type BaseRevision, type BaseRevisionChange } from '@/lib/crm-base-revision';
import { createDiscardConfirm, keepEditingBeforeSave, type DiscardQuestion } from '@/lib/crm-discard-confirm';
import { createOpenGate, draftOf, followRecord, formAfterDiscard } from '@/lib/crm-open-gate';
import {
  applyDraft,
  browserDraftStorage,
  clearDraft,
  emptyDraftValues,
  keptDraft,
  loadDraft,
  saveDraft,
  type DraftValues,
} from '@/lib/crm-drafts';
import { RESTORED_EDITS_NOTICE, RETENTION_BLOCKED_NOTICE, SAVED_NOTICE } from '@/lib/crm-notices';
import { founderName, type FounderOwner } from '../founder-names';
import { stagesFor } from './format';
import { failureOf, fetchDetail, readJson, type CrmErrorKind, type Detail } from './request';
import type { Disposition } from './policy';

export type RemoteChange = { by: string; /** True when the screen already shows the newer version. */ applied: boolean };
export type Endpoint = 'crm' | 'workflows';
export type SheetHint = 'next' | 'stage' | 'note' | null;

const EMPTY_MESSAGE = { kind: 'information_request', staffText: '', reason: '' };

export function usePerson({
  csrf,
  userId,
  owners,
  onWritten,
  onSelected,
  viewIsPerson,
}: {
  csrf: string;
  userId: string;
  owners: FounderOwner[];
  /** After any confirmed write: reload the lists and totals. */
  onWritten: () => Promise<void> | void;
  /** The open person changed (an id), or was closed (null). The address bar follows. */
  onSelected: (id: string | null) => void;
  /** False in a tool view, where the person is not on screen. */
  viewIsPerson: boolean;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [base, setBase] = useState<BaseRevision | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; kind: CrmErrorKind } | null>(null);
  const [notice, setNotice] = useState('');
  const [leaveBlocked, setLeaveBlocked] = useState(false);
  const [remoteChange, setRemoteChange] = useState<RemoteChange | null>(null);
  const [discardQuestion, setDiscardQuestion] = useState<DiscardQuestion | null>(null);
  const [sheetHint, setSheetHint] = useState<SheetHint>(null);

  // Unsaved edits. The note composer and the next-step sheet have their own fields; the stage and decline sheets share the rest.
  const [note, setNote] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editDue, setEditDue] = useState('');
  const [newStage, setNewStage] = useState('new');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [actionDescription, setActionDescription] = useState('');
  const [actionDue, setActionDue] = useState('');
  const [disposition, setDisposition] = useState<Disposition>('proceeded');
  const [messageValues, setMessageValues] = useState(EMPTY_MESSAGE);
  const [messageDraftDirty, setMessageDraftDirty] = useState(false);
  const [retentionDraftDirty, setRetentionDraftDirty] = useState(false);
  const [retentionWritePending, setRetentionWritePending] = useState(false);
  const [messagesResetVersion, setMessagesResetVersion] = useState(0);
  const [privacyResetVersion, setPrivacyResetVersion] = useState(0);

  const gate = useRef(createOpenGate());
  const detailRef = useRef<Detail | null>(null);
  detailRef.current = detail;
  const inFlight = useRef(0);
  const lastAutoRefresh = useRef(0);
  const loadedAction = useRef({ description: '', due: '' });
  const pending = useRef(new Map<string, { inputKey: string; requestId: string }>());
  const live = useRef({ dirty: false, busy: false, retentionPending: false, detailId: '', viewIsPerson });
  const focusBeforeQuestion = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLElement | null>(null);
  const retentionPendingPrevious = useRef(false);
  const discardConfirm = useRef<ReturnType<typeof createDiscardConfirm> | null>(null);
  if (!discardConfirm.current) discardConfirm.current = createDiscardConfirm(setDiscardQuestion);
  detailRef.current = detail;

  const onRetentionDraftState = useCallback((dirty: boolean, isPending: boolean) => {
    if (retentionPendingPrevious.current && !isPending) {
      setLeaveBlocked(false);
      setError((current) => (current?.message === RETENTION_BLOCKED_NOTICE ? null : current));
    }
    retentionPendingPrevious.current = isPending;
    setRetentionDraftDirty(dirty);
    setRetentionWritePending(isPending);
  }, []);

  function hasDirtyDraft(): boolean {
    if (!detail) return false;
    const due = detail.opportunity.nextAction?.dueAt;
    const originalDue = due ? crmLocalDate(due) : '';
    const record = detail.opportunity.nextAction?.description ?? '';
    return (
      newStage !== detail.opportunity.stage ||
      actionDescription !== record ||
      actionDue !== originalDue ||
      editDescription.trim() !== record ||
      editDue !== originalDue ||
      Boolean(reason.trim() || evidence.trim() || note.trim()) ||
      messageDraftDirty ||
      retentionDraftDirty
    );
  }

  /** The error belongs to the person on screen, except a lost session, which is one page-level alert (the caller shows it). */
  function raise(message: string, kind: CrmErrorKind) {
    setError({ message, kind });
  }

  function askDiscard(prompt: string): Promise<boolean> {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    focusBeforeQuestion.current = active instanceof HTMLElement && active !== document.body ? active : null;
    return discardConfirm.current!.ask(prompt);
  }
  function answerDiscard(discard: boolean, refocus = true) {
    discardConfirm.current!.answer(discard);
    const back = refocus ? focusBeforeQuestion.current : null;
    focusBeforeQuestion.current = null;
    requestAnimationFrame(() => {
      if (back && back.isConnected) back.focus({ preventScroll: true });
    });
  }

  /** Puts every field back to the record on screen now, and bases the form on it. */
  function resetDraft() {
    const latest = detailRef.current;
    if (!latest) return;
    const form = formAfterDiscard(latest, crmLocalDate);
    clearDraft(browserDraftStorage(), latest.opportunity.id);
    if (error?.kind === 'conflict') setError(null);
    setBase(form.base);
    setMessageValues(EMPTY_MESSAGE);
    setMessagesResetVersion((value) => value + 1);
    setNewStage(form.newStage);
    setActionDescription(form.actionDescription);
    setActionDue(form.actionDue);
    setEditDescription(form.editDescription);
    setEditDue(form.editDue);
    setReason('');
    setEvidence('');
    setDisposition('proceeded');
    setNote('');
    setMessageDraftDirty(false);
    setRetentionDraftDirty(false);
    setRemoteChange(null);
  }

  /** Puts only the stage and decline fields back (the sheet was cancelled). */
  function resetStageForm() {
    const latest = detailRef.current;
    if (!latest) return;
    const form = draftOf(latest, crmLocalDate);
    setNewStage(form.newStage);
    setActionDescription(form.actionDescription);
    setActionDue(form.actionDue);
    setReason('');
    setEvidence('');
    setDisposition('proceeded');
  }
  function resetNextStepForm() {
    const latest = detailRef.current;
    if (!latest) return;
    const form = draftOf(latest, crmLocalDate);
    setEditDescription(form.actionDescription);
    setEditDue(form.actionDue);
  }

  function blockLeave() {
    setLeaveBlocked(true);
  }

  /** True when the founder may leave the open person: nothing unsaved, or they chose Discard. */
  async function canLeave(prompt: string): Promise<boolean> {
    if (retentionWritePending) {
      blockLeave();
      return false;
    }
    if (!hasDirtyDraft()) return true;
    if (!(await askDiscard(prompt))) return false;
    resetDraft();
    setPrivacyResetVersion((value) => value + 1);
    return true;
  }

  function whoChanged(result: Detail): string {
    const operators = result.activities.filter((activity) => activity.actor.kind === 'operator');
    const latest = operators.reduce<Detail['activities'][number] | null>(
      (best, activity) => (!best || activity.sequence > best.sequence ? activity : best),
      null,
    );
    return latest && latest.actor.kind === 'operator' ? founderName(owners, latest.actor.userId) : 'Someone';
  }

  /**
   * Opens a person. Only the latest call's result is applied (see createOpenGate). `rebase` forces the form onto the freshly
   * loaded record (a founder-confirmed reload). `savedWithBase` says the write that triggered this read was revision-checked.
   */
  async function open(
    id: string,
    manageBusy = true,
    silent = false,
    rebase = false,
    reveal = true,
    savedWithBase = false,
  ): Promise<boolean> {
    const current = detailRef.current;
    if (current && current.opportunity.id !== id) {
      if (retentionWritePending) {
        blockLeave();
        return false;
      }
      if (hasDirtyDraft()) {
        if (!(await askDiscard('Discard unsaved changes and open another enquiry?'))) return false;
        resetDraft();
        setPrivacyResetVersion((value) => value + 1);
      }
    }
    const call = gate.current.begin();
    if (manageBusy) setBusy(true);
    if (!silent) {
      setLoading(true);
      setError(null);
      setNotice('');
      setLeaveBlocked(false);
    }
    inFlight.current += 1;
    try {
      const result = await fetchDetail(id);
      if (!result) throw new Error('This enquiry could not be found.');
      const decision = gate.current.settle(call, id, silent, reveal);
      if (!decision.apply) return false;
      // The founder started typing while this background read was in flight: keep the revision their draft is based on.
      if (silent && live.current.dirty) return false;
      const { changedRecord } = decision;
      const previousRevision = detailRef.current?.opportunity.id === id ? detailRef.current.opportunity.revision : null;
      setDetail(result);
      if (changedRecord) {
        setRemoteChange(null);
        setSheetHint(null);
        setMessageDraftDirty(false);
        requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
      } else if (silent && previousRevision !== null && result.opportunity.revision !== previousRevision) {
        setRemoteChange({ by: whoChanged(result), applied: true });
      } else if (rebase || savedWithBase) {
        setRemoteChange(null);
      }
      const draft = draftOf(result, crmLocalDate);
      let restoredRevision: number | null = null;
      if (changedRecord || rebase || (silent && !live.current.dirty)) {
        setNewStage(draft.newStage);
        setActionDescription(draft.actionDescription);
        setActionDue(draft.actionDue);
        setEditDescription(draft.actionDescription);
        setEditDue(draft.actionDue);
        setReason('');
        setEvidence('');
        setDisposition('proceeded');
        setNote('');
        if (changedRecord) {
          setMessageValues(EMPTY_MESSAGE);
          onSelected(result.opportunity.id);
          const kept = loadDraft(browserDraftStorage(), result.opportunity.id, userId);
          if (kept) {
            restoredRevision = kept.revision;
            const next = applyDraft(emptyDraftValues(draft), kept.fields, (stage) =>
              stagesFor(result.opportunity.audience).includes(stage),
            );
            setNewStage(next.newStage);
            setActionDescription(next.actionDescription);
            setActionDue(next.actionDue);
            setEditDescription(next.editDescription);
            setEditDue(next.editDue);
            setReason(next.reason);
            setEvidence(next.evidence);
            setNote(next.note);
            setDisposition(next.disposition as Disposition);
            if (next.messageText || next.messageReason) {
              setMessageValues({ kind: next.messageKind, staffText: next.messageText, reason: next.messageReason });
              setMessageDraftDirty(true);
            }
            if (next.note) setSheetHint('note');
            else if (kept.fields.newStage !== undefined || kept.fields.reason !== undefined || kept.fields.evidence !== undefined)
              setSheetHint('stage');
            else if (kept.fields.editDescription !== undefined || kept.fields.editDue !== undefined) setSheetHint('next');
            setNotice(RESTORED_EDITS_NOTICE);
          }
        }
      } else {
        // The same person after a write made here or elsewhere: untouched next-step fields follow the record, typed ones stay.
        const loaded = loadedAction.current;
        setEditDescription((value) => followRecord(value, loaded.description, draft.actionDescription));
        setEditDue((value) => followRecord(value, loaded.due, draft.actionDue));
        setActionDescription((value) => followRecord(value, loaded.description, draft.actionDescription));
        setActionDue((value) => followRecord(value, loaded.due, draft.actionDue));
      }
      loadedAction.current = { description: draft.actionDescription, due: draft.actionDue };
      const loaded = result.opportunity.revision;
      setBase((existing) => {
        const previous = existing && existing.id === id ? existing.revision : loaded;
        const change: BaseRevisionChange = changedRecord
          ? { kind: 'open', loaded, kept: restoredRevision }
          : rebase
            ? { kind: 'rebase', loaded }
            : savedWithBase
              ? { kind: 'saved', loaded }
              : { kind: 'refresh', previous, loaded, formDirty: live.current.dirty };
        return { id, revision: nextBaseRevision(change) };
      });
      return true;
    } catch (failure) {
      if (silent || !gate.current.isCurrent(call)) return false;
      const keep = !manageBusy && gate.current.selected() === id;
      if (!keep) gate.current.clear();
      setDetail((existing) => (keep && existing?.opportunity.id === id ? existing : null));
      const { message, kind } = failureOf(failure, 'Enquiry unavailable.');
      raise(message, kind);
      return false;
    } finally {
      inFlight.current -= 1;
      if (manageBusy) setBusy(false);
      if (!silent) setLoading(false);
    }
  }

  /** Closes the person (Back to the Inbox). False when the founder chose to keep editing. */
  async function close(prompt = 'Discard unsaved edits before returning to the list?'): Promise<boolean> {
    if (!(await canLeave(prompt))) return false;
    gate.current.clear();
    setDetail(null);
    setBase(null);
    setError(null);
    setNotice('');
    setLeaveBlocked(false);
    setRemoteChange(null);
    setSheetHint(null);
    onSelected(null);
    return true;
  }

  /**
   * One revision-checked write. Returns true when the server confirmed it. The same input keeps the same request id on a retry,
   * so a repeated tap can never record twice.
   */
  async function write(
    endpoint: Endpoint,
    action: string,
    input: Record<string, unknown>,
    options: { savedWithBase?: boolean; notice?: string } = {},
  ): Promise<boolean> {
    const current = detailRef.current;
    if (!current) return false;
    // The form stays live behind a discard question. Saving answers it as "Keep editing".
    if (keepEditingBeforeSave(discardConfirm.current!)) focusBeforeQuestion.current = null;
    setBusy(true);
    setError(null);
    setNotice('');
    setLeaveBlocked(false);
    const inputKey = JSON.stringify(input);
    const previous = pending.current.get(action);
    const requestId = previous?.inputKey === inputKey ? previous.requestId : crypto.randomUUID();
    pending.current.set(action, { inputKey, requestId });
    try {
      await readJson(endpoint === 'crm' ? '/api/crm' : '/api/crm/workflows', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intafaced-csrf': csrf },
        body: JSON.stringify({ action, input: { ...input, requestId } }),
      });
      pending.current.delete(action);
      if (action === 'addNote') setNote('');
      if (action === 'changeStage') {
        setReason('');
        setEvidence('');
        setDisposition('proceeded');
      }
      if (action === 'updateNextAction') {
        setEditDescription(String(input.description));
        setEditDue(crmLocalDate(String(input.dueAt)));
      }
      const refreshed = await open(current.opportunity.id, false, false, false, true, options.savedWithBase ?? action !== 'addNote');
      await onWritten();
      setNotice(options.notice ?? (refreshed ? SAVED_NOTICE : 'Your change was saved. Reopen the enquiry to load its latest records.'));
      return true;
    } catch (failure) {
      const { message, kind } = failureOf(failure, 'Could not save.');
      raise(message, kind);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Reloads the open person. A manual run with unsaved edits asks first. A background run never overwrites typed edits. */
  async function refresh(auto = false): Promise<void> {
    const state = live.current;
    if (!state.detailId || !state.viewIsPerson) return;
    if (auto) {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (inFlight.current > 0 || state.busy) return;
      if (Date.now() - lastAutoRefresh.current < 5000) return;
      lastAutoRefresh.current = Date.now();
      if (state.dirty || state.retentionPending) {
        // Typed edits stay untouched, but the founder is told now that the record moved on (G5), not when the save is refused.
        await peekForChange(state.detailId);
        return;
      }
      await open(state.detailId, false, true, false, false);
      return;
    }
    if (await canLeave('Discard unsaved edits and reload this enquiry?')) await open(state.detailId, false, false, true, false);
  }

  async function peekForChange(id: string) {
    try {
      const result = await fetchDetail(id);
      const shown = detailRef.current;
      if (!result || !shown || shown.opportunity.id !== id) return;
      if (result.opportunity.revision > shown.opportunity.revision) setRemoteChange({ by: whoChanged(result), applied: false });
    } catch {
      // A failed look keeps what is on screen; the save still meets the revision check.
    }
  }

  // Keep unsaved edits in this tab while they exist, and drop them as soon as the form matches the record again.
  const draftValues: DraftValues = {
    note,
    reason,
    evidence,
    newOwner: detail?.opportunity.ownerUserId ?? '',
    newStage,
    actionDescription,
    actionDue,
    editDescription,
    editDue,
    disposition,
    messageKind: messageValues.kind,
    messageText: messageValues.staffText,
    messageReason: messageValues.reason,
  };
  const draftSignature = JSON.stringify(draftValues);
  useEffect(() => {
    if (!detail || busy) return;
    const storage = browserDraftStorage();
    const kept = keptDraft(JSON.parse(draftSignature) as DraftValues, draftOf(detail, crmLocalDate));
    const revision = expectedRevisionFor(base, detail.opportunity.id, detail.opportunity.revision);
    if (kept) saveDraft(storage, { enquiryId: detail.opportunity.id, userId, revision, fields: kept });
    else {
      clearDraft(storage, detail.opportunity.id);
      if (revision !== detail.opportunity.revision) {
        setBase({ id: detail.opportunity.id, revision: detail.opportunity.revision });
        if (error?.kind === 'conflict') setError(null);
      }
    }
  }, [detail, busy, draftSignature, userId, base, error]);

  const expectedRevision = detail ? expectedRevisionFor(base, detail.opportunity.id, detail.opportunity.revision) : 0;
  const staleDraft = detail ? baseIsStale(base, detail.opportunity.id, detail.opportunity.revision) : false;

  useEffect(() => {
    live.current = {
      dirty: hasDirtyDraft(),
      busy,
      retentionPending: retentionWritePending,
      detailId: detail?.opportunity.id ?? '',
      viewIsPerson,
    };
  });

  /** The person was erased from outreach (privacy deletion): forget them without reading them again. */
  function forget() {
    const erased = detailRef.current;
    if (erased) clearDraft(browserDraftStorage(), erased.opportunity.id);
    gate.current.clear();
    setDetail(null);
    setBase(null);
    onSelected(null);
  }

  return {
    detail,
    loading,
    busy,
    error,
    setError,
    notice,
    setNotice,
    leaveBlocked,
    remoteChange,
    expectedRevision,
    staleDraft,
    dirty: hasDirtyDraft(),
    sheetHint,
    clearSheetHint: () => setSheetHint(null),
    headingRef,
    fields: {
      note,
      setNote,
      editDescription,
      setEditDescription,
      editDue,
      setEditDue,
      newStage,
      setNewStage,
      reason,
      setReason,
      evidence,
      setEvidence,
      actionDescription,
      setActionDescription,
      actionDue,
      setActionDue,
      disposition,
      setDisposition,
    },
    messageValues,
    setMessageValues,
    setMessageDraftDirty,
    messagesResetVersion,
    privacyResetVersion,
    onRetentionDraftState,
    discardQuestion,
    answerDiscard,
    open,
    close,
    canLeave,
    write,
    refresh,
    resetDraft,
    resetStageForm,
    resetNextStepForm,
    forget,
    retentionWritePending,
  };
}

export type PersonApi = ReturnType<typeof usePerson>;
