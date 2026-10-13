import { isEnquiryId, isUuid } from './crm-return';

/**
 * Unsaved edits on the open enquiry, kept in this browser tab's sessionStorage so an expired founder session does not lose
 * them. Only the founder's own typed text and choices are stored (never a token, cookie or CSRF value). The store is per tab,
 * is removed on sign-out and after a save, and is dropped after 12 hours.
 */
export const DRAFT_KEY_PREFIX = 'intafaced.crm.draft.v1:';
export const RESUME_KEY = 'intafaced.crm.resume.v1';
export const DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Every field a founder can have half-typed on the open enquiry. */
export type DraftValues = {
  note: string;
  reason: string;
  evidence: string;
  newOwner: string;
  newStage: string;
  actionDescription: string;
  actionDue: string;
  editDescription: string;
  editDue: string;
  disposition: string;
  messageKind: string;
  messageText: string;
  messageReason: string;
};
/** What the saved record says, so only real edits are kept. */
export type DraftBaseline = Pick<DraftValues, 'newOwner' | 'newStage' | 'actionDescription' | 'actionDue'>;

const DISPOSITIONS = ['proceeded', 'declined', 'withdrawn', 'waitlisted', 'duplicate'];
const MESSAGE_KINDS = ['information_request', 'follow_up', 'call_invitation'];
const STAGES = ['new', 'qualified', 'diligence', 'terms', 'invited', 'onboarding', 'closed'];
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/** Same limits as the form fields, so a stored draft can never hold more than the form would accept. */
const LIMITS: Record<keyof DraftValues, number> = {
  note: 2000,
  reason: 500,
  evidence: 256,
  newOwner: 36,
  newStage: 16,
  actionDescription: 160,
  actionDue: 16,
  editDescription: 160,
  editDue: 16,
  disposition: 16,
  messageKind: 24,
  messageText: 2000,
  messageReason: 500,
};
const KEYS = Object.keys(LIMITS) as Array<keyof DraftValues>;

export const emptyDraftValues = (baseline: DraftBaseline): DraftValues => ({
  note: '',
  reason: '',
  evidence: '',
  newOwner: baseline.newOwner,
  newStage: baseline.newStage,
  actionDescription: baseline.actionDescription,
  actionDue: baseline.actionDue,
  editDescription: baseline.actionDescription,
  editDue: baseline.actionDue,
  disposition: 'proceeded',
  messageKind: 'information_request',
  messageText: '',
  messageReason: '',
});

/** Only the fields that differ from the saved record or the empty form, or null when nothing is worth keeping. */
export function keptDraft(values: DraftValues, baseline: DraftBaseline): Partial<DraftValues> | null {
  const kept: Partial<DraftValues> = {};
  for (const key of ['note', 'reason', 'evidence', 'messageText', 'messageReason'] as const)
    if (values[key].trim()) kept[key] = values[key];
  if (kept.messageText || kept.messageReason) kept.messageKind = values.messageKind;
  if (values.newOwner && values.newOwner !== baseline.newOwner) kept.newOwner = values.newOwner;
  if (values.newStage !== baseline.newStage) {
    kept.newStage = values.newStage;
    if (values.newStage === 'closed' && values.disposition !== 'proceeded') kept.disposition = values.disposition;
  }
  if (values.actionDescription.trim() !== baseline.actionDescription) kept.actionDescription = values.actionDescription;
  if (values.actionDue !== baseline.actionDue) kept.actionDue = values.actionDue;
  if (values.editDescription.trim() !== baseline.actionDescription) kept.editDescription = values.editDescription;
  if (values.editDue !== baseline.actionDue) kept.editDue = values.editDue;
  return Object.keys(kept).length ? kept : null;
}

/** Puts kept edits back over a freshly loaded record. A stage that does not suit this enquiry's audience is ignored. */
export function applyDraft(base: DraftValues, kept: Partial<DraftValues>, stageFits: (stage: string) => boolean): DraftValues {
  const next = { ...base, ...kept };
  if (kept.newStage !== undefined && !stageFits(kept.newStage)) {
    next.newStage = base.newStage;
    next.disposition = base.disposition;
  }
  return next;
}

/** Whatever came out of storage, reduced to known fields of the right shape and size. Anything else is dropped. */
export function sanitiseDraft(raw: unknown): Partial<DraftValues> {
  const clean: Partial<DraftValues> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clean;
  const row = raw as Record<string, unknown>;
  for (const key of KEYS) {
    const value = row[key];
    if (typeof value !== 'string' || value.length > LIMITS[key]) continue;
    if (key === 'newOwner' && !isUuid(value)) continue;
    if (key === 'newStage' && !STAGES.includes(value)) continue;
    if (key === 'disposition' && !DISPOSITIONS.includes(value)) continue;
    if (key === 'messageKind' && !MESSAGE_KINDS.includes(value)) continue;
    if ((key === 'actionDue' || key === 'editDue') && value !== '' && !LOCAL_DATE.test(value)) continue;
    clean[key] = value;
  }
  return clean;
}

export type StoredDraft = { enquiryId: string; revision: number; fields: Partial<DraftValues> };
type Envelope = { v: 1; enquiryId: string; userId: string | null; revision: number; savedAt: number; fields: Partial<DraftValues> };
/** The few Storage methods used, so tests can pass a plain stand-in. */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

const keyFor = (enquiryId: string) => `${DRAFT_KEY_PREFIX}${enquiryId}`;

/** This tab's sessionStorage, or null where the browser refuses it (private window, blocked site data). */
export function browserDraftStorage(): DraftStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveDraft(
  storage: DraftStorage | null,
  input: { enquiryId: string; userId: string; revision: number; fields: Partial<DraftValues> },
  now = Date.now(),
): void {
  // A draft with no founder on it could never be loaded again (loadDraft requires a match), so it is not kept at all.
  if (!storage || !isEnquiryId(input.enquiryId) || !input.userId) return;
  const envelope: Envelope = {
    v: 1,
    enquiryId: input.enquiryId,
    userId: input.userId,
    revision: input.revision,
    savedAt: now,
    fields: sanitiseDraft(input.fields),
  };
  try {
    storage.setItem(keyFor(input.enquiryId), JSON.stringify(envelope));
    storage.setItem(RESUME_KEY, JSON.stringify({ enquiryId: input.enquiryId, userId: input.userId }));
  } catch {
    // Storage full or blocked: the page works as before, it just cannot keep the draft.
  }
}

export function clearDraft(storage: DraftStorage | null, enquiryId: string): void {
  if (!storage) return;
  try {
    storage.removeItem(keyFor(enquiryId));
    if (readPointer(storage)?.enquiryId === enquiryId) storage.removeItem(RESUME_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/** Sign-out: every kept draft and the "return here" pointer go. */
export function clearAllDrafts(storage: DraftStorage | null): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(DRAFT_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
    storage.removeItem(RESUME_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/**
 * The kept draft for this enquiry, or null. A draft saved by another founder, older than 12 hours, malformed or empty
 * is not returned and is removed.
 */
export function loadDraft(
  storage: DraftStorage | null,
  enquiryId: string,
  userId: string | null | undefined,
  now = Date.now(),
): StoredDraft | null {
  if (!storage || !isEnquiryId(enquiryId)) return null;
  try {
    const text = storage.getItem(keyFor(enquiryId));
    if (text === null) return null;
    const value = JSON.parse(text) as Partial<Envelope> | null;
    const fresh =
      value !== null &&
      typeof value === 'object' &&
      value.v === 1 &&
      value.enquiryId === enquiryId &&
      typeof value.savedAt === 'number' &&
      now - value.savedAt <= DRAFT_MAX_AGE_MS &&
      value.savedAt - now < 60_000 &&
      typeof value.revision === 'number' &&
      // Fails closed: with no signed-in founder, or no founder on the draft, nothing is restored.
      Boolean(userId) &&
      value.userId === userId;
    const fields = fresh ? sanitiseDraft(value.fields) : {};
    if (!fresh || !Object.keys(fields).length) {
      clearDraft(storage, enquiryId);
      return null;
    }
    return { enquiryId, revision: value.revision as number, fields };
  } catch {
    clearDraft(storage, enquiryId);
    return null;
  }
}

type Pointer = { enquiryId: string; userId: string };
function readPointer(storage: DraftStorage): Pointer | null {
  const text = storage.getItem(RESUME_KEY);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<Pointer> | null;
    if (value && typeof value === 'object' && isEnquiryId(value.enquiryId) && typeof value.userId === 'string' && value.userId)
      return { enquiryId: value.enquiryId, userId: value.userId };
  } catch {
    // An old or damaged pointer is ignored.
  }
  return null;
}

/**
 * The enquiry this tab last kept a draft for, so sign-in can send the founder back to it. Only the founder who kept it is
 * sent there: with no known founder, or another one, the pointer is ignored.
 */
export function keptEnquiryId(storage: DraftStorage | null, userId: string | null | undefined): string | null {
  if (!storage || !userId) return null;
  try {
    const pointer = readPointer(storage);
    return pointer && pointer.userId === userId ? pointer.enquiryId : null;
  } catch {
    return null;
  }
}
