'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { founderName, useFounderOwners } from './founder-names';
import { CrmMetrics, CrmTasks, CrmCampaigns, CrmDuplicates, CrmExports, CrmEnquiryTasks } from './crm-workflows';
import { CrmMessages } from './crm-messages';
import { CrmPrivacy } from './crm-privacy';
import { crmDate, crmLocalDate, crmOverdueCalendarDays, crmRelative, crmTime } from '@/lib/crm-browser';
import { createOpenGate, draftOf, followRecord } from '@/lib/crm-open-gate';
import {
  DEFAULT_CRM_SORT,
  SORT_PRESETS,
  ariaSort,
  formatIndicativeAmount,
  indicativeAmountOf,
  nextSort,
  sortEnquiries,
  sortValue,
  type CrmSort,
  type CrmSortKey,
} from '@/lib/crm-list';
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
import { enquiryIdFromSearch, signInHref } from '@/lib/crm-return';
import type {
  CrmActivity,
  CrmContact,
  CrmOpportunity,
  CrmOpportunityPage,
  CrmOrganisation,
  CrmSubmission,
  CrmTask,
  CrmWorkflowsContract,
} from '@intafaced/contracts';

type Detail = {
  opportunity: CrmOpportunity;
  contact: CrmContact;
  organisation: CrmOrganisation | null;
  submission: CrmSubmission;
  activities: CrmActivity[];
  tasks: CrmTask[];
  deliveries?: Array<{ status: string; errorCode: string | null }>;
  provenance: NonNullable<Awaited<ReturnType<CrmWorkflowsContract['getContactProvenance']>>>;
};
const AUDIENCES = ['investor', 'trader', 'merchant', 'academy', 'partner'] as const;
const DETAIL_TABS = ['overview', 'answers', 'activity', 'messages'] as const;
type DetailTab = (typeof DETAIL_TABS)[number];
const label = (value: string) => value.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
const plural = (count: number, one: string, many: string) => `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`;
/** "Overdue · 2 days", or null when the due time has not passed. Days are local calendar days: yesterday evening is "1 day", not "today". */
export function overdueLabel(dueAt: string, now = Date.now()): string | null {
  if (Date.parse(dueAt) >= now) return null;
  const days = crmOverdueCalendarDays(dueAt, now);
  return days >= 1 ? `Overdue · ${plural(days, 'day', 'days')}` : 'Overdue · today';
}
/** The activity log's own contract kinds in words a founder would use. */
export function activityTitle(
  activity: Pick<CrmActivity, 'kind' | 'note' | 'referenceId'>,
  owners: Array<{ userId: string; displayName: string }>,
): { title: string; note: string | null } {
  switch (activity.kind) {
    case 'assigned': {
      // The service stores the new owner's id in referenceId (svc-ops crm.ts: activity(..., 'assigned', null, ownerUserId)).
      const owner = owners.find((value) => value.userId === activity.referenceId);
      return { title: owner ? `Assigned to ${owner.displayName}` : 'Owner assigned', note: activity.note };
    }
    case 'stage_changed':
      // Older entries keep the reason only, not the stage before and after, so they cannot tell a stage move from a next-action edit.
      return { title: 'Stage or next action updated', note: activity.note };
    case 'next_action_changed': {
      // The service stores the new description in note and the new due time in referenceId (svc-ops crm.ts updateNextAction).
      const due = activity.referenceId && !Number.isNaN(Date.parse(activity.referenceId)) ? crmDate(activity.referenceId) : null;
      return { title: 'Next action changed', note: [activity.note, due ? `due ${due}` : null].filter(Boolean).join(' · ') || null };
    }
    case 'note':
      return { title: 'Note added', note: activity.note };
    case 'questionnaire_submitted':
      return { title: 'Questionnaire submitted', note: activity.note };
    case 'call_invited':
      return { title: 'Call invitation recorded', note: activity.note };
    case 'call_booked':
      return { title: 'Call booked', note: activity.note };
    case 'email_status': {
      const queued = /^Message queued: (.+)$/.exec(activity.note ?? '');
      if (queued?.[1]) return { title: `Message queued: ${label(queued[1])}`, note: null };
      return { title: 'Message update', note: activity.note };
    }
    default:
      return { title: label(String(activity.kind)), note: activity.note };
  }
}
/** "Source: A", "Source: A · latest B", or null when neither is known. */
export function sourceLine(first: string | null | undefined, latest: string | null | undefined): string | null {
  if (first && latest && first !== latest) return `Source: ${first} · latest ${latest}`;
  const known = first ?? latest;
  return known ? `Source: ${known}` : null;
}
const emailStatusText = (status: string) =>
  status === 'verified' ? 'email verified' : status === 'unverified' ? 'email not verified' : `email ${label(status).toLowerCase()}`;
const countryName = (code: string): string => {
  try {
    return new Intl.DisplayNames(['en-GB'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};
function groupedAmount(value: string): string {
  const [whole = '0', fraction] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Enquiry id to the merged-away contact's name, for rows the search reached through a merge. Empty when the page has none. */
export function aliasNamesOf(page: Pick<CrmOpportunityPage, 'aliasMatches'> | null): Map<string, string> {
  return new Map(page?.aliasMatches?.map((match) => [match.opportunityId, match.name]) ?? []);
}
/** "also: <old name>" under a row whose search match came through a merged contact. */
export function AliasNote({ name }: { name: string | undefined }) {
  return name ? <small className="adm-crm-also">also: {name}</small> : null;
}
/** Quick due dates for the next-action editor: days from today, each at 09:00 your local time. */
export const NEXT_ACTION_CHIPS = [
  { label: 'Tomorrow', days: 1 },
  { label: '+3 days', days: 3 },
  { label: 'Next week', days: 7 },
] as const;
/** The date field's value (local "YYYY-MM-DDTHH:mm") for `days` from today at 09:00. Calendar days, so a clock change never shifts it. */
export function quickDue(days: number, now = Date.now()): string {
  const day = new Date(now);
  day.setDate(day.getDate() + days);
  day.setHours(9, 0, 0, 0);
  return crmLocalDate(day.toISOString());
}
/** A warning (never a block) when the chosen due time has already passed, or null. */
export function pastDueWarning(due: string, now = Date.now()): string | null {
  const time = due ? new Date(due).getTime() : Number.NaN;
  if (Number.isNaN(time) || time >= now) return null;
  return 'That time has already passed, so this will show as overdue straight away.';
}
/** Edit what happens next and when, without touching the stage. No reason is asked for. */
export function NextActionEditor({
  description,
  due,
  unchanged,
  busy,
  onDescription,
  onDue,
  onSave,
  now = Date.now(),
}: {
  description: string;
  due: string;
  unchanged: boolean;
  busy: boolean;
  onDescription: (value: string) => void;
  onDue: (value: string) => void;
  onSave: () => void;
  now?: number;
}) {
  const warning = pastDueWarning(due, now);
  return (
    <form
      className="adm-crm-next-edit"
      aria-label="Edit next action"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label>
        What happens next
        <input required maxLength={160} value={description} onChange={(event) => onDescription(event.target.value)} />
      </label>
      <label>
        Due (your local time)
        <input type="datetime-local" required value={due} onChange={(event) => onDue(event.target.value)} />
      </label>
      <div className="adm-crm-next-chips" role="group" aria-label="Quick due dates">
        {NEXT_ACTION_CHIPS.map((chip) => (
          <button key={chip.label} type="button" disabled={busy} onClick={() => onDue(quickDue(chip.days, now))}>
            {chip.label}
          </button>
        ))}
      </div>
      {warning && (
        <p className="adm-crm-next-warn" role="status">
          {warning}
        </p>
      )}
      <button type="submit" disabled={busy || unchanged || !description.trim() || !due}>
        Save next action
      </button>
    </form>
  );
}

function stagesForAudience(audience: string): string[] {
  if (audience === 'investor') return ['new', 'qualified', 'diligence', 'terms', 'closed'];
  if (audience) return ['new', 'qualified', 'invited', 'onboarding', 'closed'];
  return ['new', 'qualified', 'diligence', 'terms', 'invited', 'onboarding', 'closed'];
}

function answerText(key: string, value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value && typeof value === 'object' && 'status' in value) {
    if (value.status === 'stated' && 'amount' in value && 'currency' in value) {
      const period = 'period' in value ? ` / ${String(value.period)}` : '';
      return `${groupedAmount(String(value.amount))} ${String(value.currency)}${period} · indicative`;
    }
    return label(String(value.status));
  }
  if (['investorType', 'participation', 'decisionRole', 'timing', 'experience', 'role'].includes(key)) return label(String(value));
  return String(value);
}

/** session = 401/403 (sign in again); conflict = 409/412 (changed or refused); other = anything else. */
export type CrmErrorKind = 'session' | 'conflict' | 'other';
export class CrmRequestError extends Error {
  constructor(
    message: string,
    readonly kind: CrmErrorKind,
  ) {
    super(message);
  }
}
async function readJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, cache: 'no-store' });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new CrmRequestError('Your founder session is unavailable. Sign in again.', 'session');
    if (response.status === 409 || response.status === 412)
      throw new CrmRequestError('The enquiry changed or this action was refused. Reload it and review before retrying.', 'conflict');
    throw new CrmRequestError('The workspace could not confirm this request. Refresh the enquiry before retrying.', 'other');
  }
  return (await response.json()) as T;
}
const failureOf = (failure: unknown, fallback: string): { message: string; kind: CrmErrorKind } => ({
  message: failure instanceof Error ? failure.message : fallback,
  kind: failure instanceof CrmRequestError ? failure.kind : 'other',
});

/** The enquiry shown is kept in the address, so a reload or a sign-in again comes back to the same one. */
function syncEnquiryUrl(enquiryId: string | null) {
  try {
    if (window.location.pathname === '/crm')
      window.history.replaceState(window.history.state, '', enquiryId ? `/crm?enquiry=${enquiryId}` : '/crm');
  } catch {
    // The address bar is a convenience only.
  }
}
const KEPT_EDITS_NOTICE = 'We kept your unsaved edits.';
const KEPT_EDITS_CHANGED = `${KEPT_EDITS_NOTICE} This enquiry has changed since, so check them before saving.`;

export function CrmWorkspace({ csrf, userId }: { csrf: string; userId?: string }) {
  const [view, setView] = useState('enquiries');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [workflowVersion, setWorkflowVersion] = useState(0);
  const [page, setPage] = useState<CrmOpportunityPage | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [visitedDetailTabs, setVisitedDetailTabs] = useState<Set<DetailTab>>(() => new Set(['overview']));
  const [messageDraftDirty, setMessageDraftDirty] = useState(false);
  const [retentionDraftDirty, setRetentionDraftDirty] = useState(false);
  const [retentionWritePending, setRetentionWritePending] = useState(false);
  const [privacyResetVersion, setPrivacyResetVersion] = useState(0);
  const [mobileDetail, setMobileDetail] = useState(false);
  const detailHeading = useRef<HTMLDivElement>(null);
  const inFlight = useRef(0);
  const lastAutoRefresh = useRef(0);
  const live = useRef({ detailId: '', dirty: false, busy: false, retentionPending: false });
  const refreshRef = useRef<(auto: boolean) => Promise<void>>(async () => undefined);
  const owners = useFounderOwners();
  const [audience, setAudience] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [errorKind, setErrorKind] = useState<CrmErrorKind>('other');
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [ownersWaited, setOwnersWaited] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [note, setNote] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [newStage, setNewStage] = useState('new');
  const [reason, setReason] = useState('');
  const [actionDescription, setActionDescription] = useState('');
  const [actionDue, setActionDue] = useState('');
  // The header's next-action editor has its own fields, so typing there never edits the stage form's follow-up.
  const [editDescription, setEditDescription] = useState('');
  const [editDue, setEditDue] = useState('');
  // What the four next-action fields were last set from the record, so a same-enquiry refresh can tell untouched fields from typed ones.
  const loadedAction = useRef({ description: '', due: '' });
  const [disposition, setDisposition] = useState('proceeded');
  const [evidence, setEvidence] = useState('');
  const [sort, setSort] = useState<CrmSort>(DEFAULT_CRM_SORT);
  // The message form keeps its own fields; it reports them here so they can be kept with the other drafts.
  const [messageValues, setMessageValues] = useState({ kind: 'information_request', staffText: '', reason: '' });
  const [stageFormOpen, setStageFormOpen] = useState(false);
  // Bumped when a discard must empty the message form, which keeps its own fields.
  const [messagesResetVersion, setMessagesResetVersion] = useState(0);
  const pending = useRef(new Map<string, { inputKey: string; requestId: string }>());
  const sequence = useRef(0);
  const openGate = useRef(createOpenGate());
  const listScroll = useRef(0);
  const retentionPendingPrevious = useRef(false);
  const onRetentionDraftState = useCallback((dirty: boolean, pending: boolean) => {
    if (retentionPendingPrevious.current && !pending) setNotice('');
    retentionPendingPrevious.current = pending;
    setRetentionDraftDirty(dirty);
    setRetentionWritePending(pending);
  }, []);
  const filters = new URLSearchParams({
    limit: '50',
    ...(audience ? { audience } : {}),
    ...(stageFilter ? { stage: stageFilter } : {}),
    ...(ownerFilter ? { ownerUserId: ownerFilter } : {}),
    ...(query.trim() ? { query: query.trim() } : {}),
    ...(cursor ? { cursor } : {}),
  }).toString();
  // `silent` is for background refreshes: no spinner, and a failure keeps what is on screen instead of raising an alert.
  const load = useCallback(
    async (silent = false) => {
      const current = ++sequence.current;
      inFlight.current += 1;
      if (!silent) {
        setLoading(true);
        setError('');
      }
      try {
        const result = await readJson<CrmOpportunityPage>(`/api/crm?${filters}`);
        if (current === sequence.current) {
          setPage(result);
          setLastUpdated(new Date().toISOString());
        }
      } catch (failure) {
        if (!silent && current === sequence.current) {
          const { message, kind } = failureOf(failure, 'Workspace unavailable.');
          setError(message);
          setErrorKind(kind);
        }
      } finally {
        inFlight.current -= 1;
        if (!silent && current === sequence.current) setLoading(false);
      }
    },
    [filters],
  );
  useEffect(() => {
    void load();
  }, [load]);
  /**
   * Only the latest call's result is applied (see createOpenGate). `rebase` forces the form fields to the freshly loaded
   * record; it is for a founder-confirmed reload, where the unsaved edits were just discarded.
   */
  async function open(id: string, manageBusy = true, silent = false, rebase = false, reveal = true) {
    const gate = openGate.current;
    if (id !== gate.selected() && typeof window !== 'undefined') listScroll.current = window.scrollY;
    if (detail && detail.opportunity.id !== id) {
      if (retentionWritePending) {
        setNotice('A retention review result is unconfirmed. Retry that same request before leaving this enquiry.');
        return false;
      }
      if (hasDirtyDraft()) {
        if (!window.confirm('Discard unsaved changes and open another enquiry?')) return false;
        resetDraft();
        setPrivacyResetVersion((value) => value + 1);
      }
    }
    const call = gate.begin();
    if (manageBusy) setBusy(true);
    if (!silent) {
      setError('');
      setNotice('');
    }
    inFlight.current += 1;
    try {
      const result = await readJson<Detail | null>(`/api/crm?opportunityId=${encodeURIComponent(id)}`);
      if (!result) throw new Error('This enquiry could not be found.');
      const decision = gate.settle(call, id, silent, reveal);
      if (!decision.apply) return false;
      // The founder started typing while this background read was in flight: keep the revision their draft is based on, so
      // the next save still meets the conflict check instead of silently overwriting the newer record.
      if (silent && live.current.dirty) return false;
      const { changedRecord } = decision;
      setDetail(result);
      if (decision.showMobileDetail) setMobileDetail(true);
      if (changedRecord) {
        setDetailTab('overview');
        setVisitedDetailTabs(new Set(['overview']));
        setMessageDraftDirty(false);
        requestAnimationFrame(() => {
          // Phone: the list is hidden, so start at the top where "Back" is. Narrow desktop: the detail sits below the list, so let
          // focus scroll to it. Wide desktop: the detail is sticky beside the list, so never move the page.
          const phone = window.matchMedia('(max-width: 600px)').matches;
          const stacked = window.matchMedia('(max-width: 1000px)').matches;
          if (phone) window.scrollTo(0, 0);
          detailHeading.current?.focus({ preventScroll: phone || !stacked });
        });
      }
      const draft = draftOf(result, crmLocalDate);
      // A refresh of the same record with nothing typed also re-bases the form, so a change made elsewhere does not read as an unsaved edit.
      if (changedRecord || rebase || (silent && !live.current.dirty)) {
        setNewOwner(draft.newOwner);
        setNewStage(draft.newStage);
        setActionDescription(draft.actionDescription);
        setActionDue(draft.actionDue);
        setEditDescription(draft.actionDescription);
        setEditDue(draft.actionDue);
        setReason('');
        setEvidence('');
        setNote('');
        if (changedRecord) {
          setMessageValues({ kind: 'information_request', staffText: '', reason: '' });
          syncEnquiryUrl(result.opportunity.id);
          // Edits kept in this tab (the session ended, or the page was reloaded) go back over the freshly loaded record.
          const kept = loadDraft(browserDraftStorage(), result.opportunity.id, userId);
          if (kept) {
            // The contracts package is imported for types only here (its main entry pulls in server code), so the stage list is local.
            const next = applyDraft(emptyDraftValues(draft), kept.fields, (stage) =>
              stagesForAudience(result.opportunity.audience).includes(stage),
            );
            setNewOwner(next.newOwner);
            setNewStage(next.newStage);
            setActionDescription(next.actionDescription);
            setActionDue(next.actionDue);
            setEditDescription(next.editDescription);
            setEditDue(next.editDue);
            setReason(next.reason);
            setEvidence(next.evidence);
            setNote(next.note);
            setDisposition(next.disposition);
            const hasMessage = Boolean(next.messageText || next.messageReason);
            if (hasMessage) {
              setMessageValues({ kind: next.messageKind, staffText: next.messageText, reason: next.messageReason });
              setMessageDraftDirty(true);
              setVisitedDetailTabs(new Set(['overview', 'messages']));
            }
            // Open the tab that holds the edits: a note lives under History, a message under Messages.
            if (next.note) {
              setDetailTab('activity');
              setVisitedDetailTabs((visited) => new Set([...visited, 'activity']));
            } else if (hasMessage) setDetailTab('messages');
            if (
              kept.fields.newStage !== undefined ||
              kept.fields.reason !== undefined ||
              kept.fields.evidence !== undefined ||
              kept.fields.actionDescription !== undefined ||
              kept.fields.actionDue !== undefined ||
              kept.fields.newOwner !== undefined
            )
              setStageFormOpen(true);
            setNotice(kept.revision === result.opportunity.revision ? KEPT_EDITS_NOTICE : KEPT_EDITS_CHANGED);
          }
        }
      } else {
        // Same enquiry after a write made here or elsewhere: untouched next-action fields follow the record, typed ones stay.
        // Updater form, so the comparison sees what is in the field now, not what it held when this call started.
        const loaded = loadedAction.current;
        setEditDescription((value) => followRecord(value, loaded.description, draft.actionDescription));
        setEditDue((value) => followRecord(value, loaded.due, draft.actionDue));
        setActionDescription((value) => followRecord(value, loaded.description, draft.actionDescription));
        setActionDue((value) => followRecord(value, loaded.due, draft.actionDue));
      }
      loadedAction.current = { description: draft.actionDescription, due: draft.actionDue };
      return true;
    } catch (failure) {
      // A newer open owns the screen now; this older call's failure must not clear or alert over it.
      if (silent || !gate.isCurrent(call)) return false;
      // Keep the last loaded record when a confirmed write's refresh fails.
      const keep = !manageBusy && gate.selected() === id;
      if (!keep) gate.clear();
      setDetail((current) => (keep && current?.opportunity.id === id ? current : null));
      const { message, kind } = failureOf(failure, 'Enquiry unavailable.');
      setError(message);
      setErrorKind(kind);
      return false;
    } finally {
      inFlight.current -= 1;
      if (manageBusy) setBusy(false);
    }
  }
  function hasDirtyDraft() {
    if (!detail) return false;
    const due = detail.opportunity.nextAction?.dueAt;
    const originalDue = due ? crmLocalDate(due) : '';
    return (
      newOwner !== detail.opportunity.ownerUserId ||
      newStage !== detail.opportunity.stage ||
      actionDescription !== (detail.opportunity.nextAction?.description ?? '') ||
      actionDue !== originalDue ||
      editDescription.trim() !== (detail.opportunity.nextAction?.description ?? '') ||
      editDue !== originalDue ||
      Boolean(reason.trim() || evidence.trim() || note.trim()) ||
      messageDraftDirty ||
      retentionDraftDirty
    );
  }
  function resetDraft() {
    if (!detail) return;
    clearDraft(browserDraftStorage(), detail.opportunity.id);
    setMessageValues({ kind: 'information_request', staffText: '', reason: '' });
    setMessagesResetVersion((value) => value + 1);
    setNewOwner(detail.opportunity.ownerUserId);
    setNewStage(detail.opportunity.stage);
    setActionDescription(detail.opportunity.nextAction?.description ?? '');
    const due = detail.opportunity.nextAction?.dueAt;
    setActionDue(due ? crmLocalDate(due) : '');
    setEditDescription(detail.opportunity.nextAction?.description ?? '');
    setEditDue(due ? crmLocalDate(due) : '');
    setReason('');
    setEvidence('');
    setNote('');
    setMessageDraftDirty(false);
    setRetentionDraftDirty(false);
  }
  function canLeaveCurrentDetail(prompt: string): boolean {
    if (retentionWritePending) {
      setNotice('A retention review result is unconfirmed. Retry that same request before leaving this enquiry.');
      return false;
    }
    if (!hasDirtyDraft()) return true;
    if (!window.confirm(prompt)) return false;
    resetDraft();
    setPrivacyResetVersion((value) => value + 1);
    return true;
  }
  function selectTab(tab: DetailTab) {
    setDetailTab(tab);
    setVisitedDetailTabs((visited) => new Set([...visited, tab]));
  }
  function navigateView(next: string) {
    if (next === view) return;
    if (!canLeaveCurrentDetail('Discard unsaved edits before leaving this CRM view?')) return;
    setView(next);
  }
  /** Follow-ups, optionally narrowed to overdue ones (the totals strip's overdue count). */
  function openTasks(overdue: boolean) {
    if (view !== 'tasks' && !canLeaveCurrentDetail('Discard unsaved edits before leaving this CRM view?')) return;
    setOverdueOnly(overdue);
    setView('tasks');
  }
  async function mutate(action: string, input: Record<string, unknown>) {
    if (!detail) return;
    setBusy(true);
    setError('');
    setNotice('');
    const inputKey = JSON.stringify(input);
    const previous = pending.current.get(action);
    const requestId = previous?.inputKey === inputKey ? previous.requestId : crypto.randomUUID();
    pending.current.set(action, { inputKey, requestId });
    try {
      await readJson('/api/crm', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intafaced-csrf': csrf },
        body: JSON.stringify({ action, input: { ...input, requestId } }),
      });
      pending.current.delete(action);
      if (action === 'addNote') setNote('');
      if (action === 'changeStage') {
        setReason('');
        setEvidence('');
      }
      if (action === 'updateNextAction') {
        // The editor's own fields now hold the saved (trimmed) values. The stage form's follow-up is left alone: an unsaved
        // draft there is kept, and an untouched one follows the record when the refresh below re-bases it.
        setEditDescription(String(input.description));
        setEditDue(crmLocalDate(String(input.dueAt)));
      }
      const refreshed = await open(detail.opportunity.id, false);
      await load();
      setWorkflowVersion((value) => value + 1);
      setNotice(refreshed ? 'Saved to the enquiry history.' : 'Your change was saved. Reopen the enquiry to load its latest records.');
    } catch (failure) {
      const { message, kind } = failureOf(failure, 'Could not save.');
      setError(message);
      setErrorKind(kind);
    } finally {
      setBusy(false);
    }
  }
  /**
   * Refresh = list + the open enquiry + the totals. A background run (focus, tab visible, every 60 s) never overlaps another load
   * and never replaces the open enquiry while there are unsaved edits, because saving uses the revision it was opened at.
   * A manual run with unsaved edits asks first; if the founder declines, only the list and totals reload.
   */
  async function refresh(auto = false) {
    const state = live.current;
    if (auto) {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (inFlight.current > 0 || state.busy) return;
      if (Date.now() - lastAutoRefresh.current < 5000) return;
      lastAutoRefresh.current = Date.now();
    }
    const jobs: Array<Promise<unknown>> = [load(auto)];
    if (state.detailId && !(auto && (state.dirty || state.retentionPending))) {
      const reloadDetail = auto || canLeaveCurrentDetail('Discard unsaved edits and reload this enquiry?');
      // After a confirmed discard the form is re-based onto the newest revision, so the next save carries that revision knowingly.
      if (reloadDetail) jobs.push(open(state.detailId, false, auto, !auto, false));
    }
    await Promise.all(jobs);
    setWorkflowVersion((value) => value + 1);
  }
  // Keep unsaved edits in this tab while they exist, and drop them as soon as the form matches the record again (after a save
  // or a discard). Writes wait while a save is in flight, so a half-finished save never leaves its own values behind.
  const draftValues: DraftValues = {
    note,
    reason,
    evidence,
    newOwner,
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
    if (kept) saveDraft(storage, { enquiryId: detail.opportunity.id, userId, revision: detail.opportunity.revision, fields: kept });
    else clearDraft(storage, detail.opportunity.id);
  }, [detail, busy, draftSignature, userId]);
  // Coming back from sign-in (or a reload) lands on /crm?enquiry=<id>: open that enquiry.
  useEffect(() => {
    const id = enquiryIdFromSearch(window.location.search);
    if (id) void open(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    live.current = {
      detailId: detail?.opportunity.id ?? '',
      dirty: hasDirtyDraft(),
      busy,
      retentionPending: retentionWritePending,
    };
    refreshRef.current = refresh;
  });
  useEffect(() => {
    const run = () => void refreshRef.current(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    const timer = window.setInterval(run, 60_000);
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setOwnersWaited(true), 5000);
    return () => window.clearTimeout(timer);
  }, []);
  const items = page?.items ?? [];
  const contacts = new Map(page?.contacts.map((contact) => [contact.id, contact]) ?? []);
  // Sorting only re-orders the page already loaded; the server keeps returning newest first.
  const sortedItems = sortEnquiries(items, contacts, sort);
  const paginated = Boolean(page?.nextCursor) || history.length > 0;
  const sortHeader = (key: CrmSortKey, text: string, className?: string) => (
    <th scope="col" aria-sort={ariaSort(sort, key)} className={className}>
      <button type="button" className="adm-sort-button" onClick={() => setSort(nextSort(sort, key))}>
        {text}
        <span aria-hidden="true" className="adm-sort-mark">
          {sort.key === key ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  );
  const submissions = new Map(page?.submissions.map((submission) => [submission.submissionId, submission]) ?? []);
  // Present only when the search matched a merged-away contact instead of the one shown on the row.
  const aliasNames = aliasNamesOf(page);
  const stages = stagesForAudience(audience);
  const resetPage = () => {
    setCursor(null);
    setHistory([]);
  };
  const now = Date.now();
  let pageSummary = 'Workspace unavailable';
  if (loading) pageSummary = 'Loading…';
  else if (page) {
    const overdue = items.filter((item) => item.nextAction && Date.parse(item.nextAction.dueAt) < now).length;
    pageSummary = `${items.length} shown · ${overdue} overdue`;
  }
  const ownersMissing = owners.length !== 2;
  // The organisation record may not exist yet; the form's own organisation and country fields still do.
  const organisationName = detail ? (detail.organisation?.name ?? detail.submission.contact.organisationName ?? null) : null;
  const countries = detail
    ? (detail.submission.contact.country ? [detail.submission.contact.country] : (detail.organisation?.countries ?? [])).map(countryName)
    : [];
  const source = detail
    ? sourceLine(detail.provenance.firstKnownSource?.campaign?.name, detail.provenance.latestKnownSource?.campaign?.name)
    : null;
  const activeFilters = [audience, stageFilter, ownerFilter].filter(Boolean).length;
  return (
    <section className={`adm-workspace${mobileDetail && view === 'enquiries' ? ' is-mobile-detail' : ''}`}>
      {view === 'enquiries' && (
        <a
          className="adm-skip-link"
          href="#crm-enquiries"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById('crm-enquiries')?.focus();
          }}
        >
          Skip to enquiries
        </a>
      )}
      <div className="adm-crm-topbar">
        <div className="adm-workspace-heading">
          <div>
            <h1>
              {view === 'tasks'
                ? 'Follow-ups'
                : view === 'campaigns'
                  ? 'Sources and campaigns'
                  : view === 'duplicates'
                    ? 'Duplicates'
                    : view === 'exports'
                      ? 'Exports'
                      : 'Enquiries'}
            </h1>
          </div>
          <div className="adm-crm-refresh">
            {lastUpdated && <span className="adm-subtle">Updated {crmTime(lastUpdated)}</span>}
            <button
              type="button"
              onClick={() => {
                void refresh();
              }}
              disabled={loading}
            >
              Refresh
            </button>
          </div>
        </div>
        <CrmMetrics
          version={workflowVersion}
          filters={{
            ...(audience ? { audience } : {}),
            ...(stageFilter ? { stage: stageFilter } : {}),
            ...(ownerFilter ? { ownerUserId: ownerFilter } : {}),
          }}
          onTasks={() => openTasks(false)}
          onOverdue={() => openTasks(true)}
        />
        <nav className="adm-crm-tabs" aria-label="CRM workflows">
          <button type="button" aria-current={view === 'enquiries' ? 'page' : undefined} onClick={() => navigateView('enquiries')}>
            Enquiries
          </button>
          <button type="button" aria-current={view === 'tasks' ? 'page' : undefined} onClick={() => openTasks(false)}>
            Follow-ups
          </button>
          <details className="adm-crm-tools-menu">
            <summary>Tools</summary>
            <div>
              {(
                [
                  ['campaigns', 'Sources and campaigns'],
                  ['duplicates', 'Duplicates'],
                  ['exports', 'Exports'],
                ] as const
              ).map(([key, name]) => (
                <button key={key} type="button" aria-current={view === key ? 'page' : undefined} onClick={() => navigateView(key)}>
                  {name}
                </button>
              ))}
            </div>
          </details>
        </nav>
      </div>
      {(view === 'enquiries' || view === 'exports') && (
        <form
          className={`adm-filters${filtersOpen ? ' is-open' : ''}`}
          onSubmit={(event) => {
            event.preventDefault();
            resetPage();
            void load();
          }}
        >
          <button type="button" className="adm-filters-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>
            {activeFilters ? `Filters (${activeFilters})` : 'Filters'}
          </button>
          <label className="adm-filter-field">
            Audience
            <select
              aria-label="Audience"
              value={audience}
              onChange={(event) => {
                setAudience(event.target.value);
                setStageFilter('');
                resetPage();
              }}
            >
              <option value="">All audiences</option>
              {AUDIENCES.map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="adm-filter-field">
            Stage
            <select
              aria-label="Stage"
              value={stageFilter}
              onChange={(event) => {
                setStageFilter(event.target.value);
                resetPage();
              }}
            >
              <option value="">All stages</option>
              {stages.map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="adm-filter-field">
            Owner
            <select
              aria-label="Owner"
              value={ownerFilter}
              onChange={(event) => {
                setOwnerFilter(event.target.value);
                resetPage();
              }}
            >
              <option value="">Both founders</option>
              {owners.map((value) => (
                <option key={value.userId} value={value.userId}>
                  {value.displayName}
                </option>
              ))}
            </select>
          </label>
          {view === 'enquiries' && (
            <label className="adm-filter-search">
              Search
              <input
                aria-label="Search"
                type="search"
                placeholder="Name or email"
                maxLength={160}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  resetPage();
                }}
              />
            </label>
          )}
        </form>
      )}
      {error && (
        <p className="adm-alert" role="alert">
          {error} {errorKind === 'session' && <a href={signInHref(detail?.opportunity.id)}>Sign in</a>}
          {errorKind === 'conflict' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (detail) void refresh();
                else void load();
              }}
            >
              Reload this enquiry
            </button>
          )}
        </p>
      )}
      {ownersWaited && owners.length === 0 && (
        <p className="adm-subtle" role="status">
          Founder names did not load, so the Owner filter is empty and owners cannot be changed. Reload the page to try again.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {view === 'tasks' && (
        <CrmTasks
          key={String(overdueOnly)}
          initialOverdue={overdueOnly}
          version={workflowVersion}
          filtersActive={activeFilters > 0}
          owners={owners}
          onOpen={(id) => {
            void open(id).then((opened) => {
              if (opened) setView('enquiries');
            });
          }}
        />
      )}
      {view === 'campaigns' && <CrmCampaigns csrf={csrf} owners={owners} />}
      {view === 'duplicates' && (
        <CrmDuplicates
          csrf={csrf}
          owners={owners}
          onChanged={async () => {
            await load();
            if (detail) await open(detail.opportunity.id, false);
            setWorkflowVersion((value) => value + 1);
          }}
        />
      )}
      {view === 'exports' && (
        <CrmExports
          csrf={csrf}
          owners={owners}
          filters={{
            ...(audience ? { audience } : {}),
            ...(stageFilter ? { stage: stageFilter } : {}),
            ...(ownerFilter ? { ownerUserId: ownerFilter } : {}),
          }}
        />
      )}
      {view === 'enquiries' && (
        <>
          <div className={`adm-workspace-grid${mobileDetail ? ' is-mobile-detail' : ''}`}>
            <div id="crm-enquiries" tabIndex={-1}>
              <p className="adm-subtle adm-crm-page-summary">{pageSummary}</p>
              {paginated && (
                <p className="adm-subtle adm-crm-sort-note">
                  Sorting applies to the enquiries loaded on this page only. Use Next and Previous to see the others.
                </p>
              )}
              <label className="adm-crm-sort-phone">
                Sort by
                <select
                  aria-label="Sort by"
                  value={sortValue(sort)}
                  onChange={(event) =>
                    setSort(SORT_PRESETS.find((preset) => preset.value === event.target.value)?.sort ?? DEFAULT_CRM_SORT)
                  }
                >
                  {SORT_PRESETS.map((preset) => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="adm-table-scroll">
                <table className="adm-crm-table">
                  <caption className="adm-sr-only">Rows matching your filters</caption>
                  <thead>
                    <tr>
                      {sortHeader('name', 'Name', 'adm-col-name')}
                      <th scope="col" className="adm-col-audience">
                        Audience
                      </th>
                      {sortHeader('amount', 'Amount', 'adm-col-amount')}
                      <th scope="col" className="adm-col-stage">
                        Stage
                      </th>
                      {sortHeader('due', 'Next action', 'adm-col-next')}
                      <th scope="col" className="adm-col-owner">
                        Owner
                      </th>
                      {sortHeader('received', 'Received', 'adm-col-received')}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedItems.map((item) => {
                      const contact = contacts.get(item.contactId);
                      const submission = submissions.get(item.submissionId);
                      const overdue = item.nextAction ? overdueLabel(item.nextAction.dueAt, now) : null;
                      const selected = detail?.opportunity.id === item.id;
                      return (
                        <tr key={item.id} className={selected ? 'is-selected' : undefined} data-overdue={overdue ? 'true' : undefined}>
                          <td data-label="Name" className="adm-col-name">
                            <button
                              className="adm-text-button"
                              data-enquiry-id={item.id}
                              disabled={busy}
                              aria-current={selected ? 'true' : undefined}
                              title={contact?.email}
                              onClick={() => {
                                void open(item.id);
                              }}
                            >
                              {contact?.name ?? 'Open enquiry'}
                            </button>
                            <small className="adm-crm-sub">
                              {submission?.organisationName ?? contact?.email}
                              <AliasNote name={aliasNames.get(item.id)} />
                            </small>
                          </td>
                          <td data-label="Audience" className="adm-col-audience">
                            {label(item.audience)}
                            {submission && !submission.completedAt && (
                              <small title="Partly answered: questionnaires not finished">Partial</small>
                            )}
                          </td>
                          <td data-label="Amount" className="adm-col-amount" title="Indicative only, not a commitment">
                            {formatIndicativeAmount(indicativeAmountOf(item))}
                          </td>
                          <td data-label="Stage" className="adm-col-stage">
                            <span className="adm-crm-stage" data-stage={item.stage}>
                              {label(item.stage)}
                            </span>
                          </td>
                          <td data-label="Next action" className="adm-col-next">
                            {item.nextAction ? (
                              <>
                                <span className="adm-crm-next-text" title={item.nextAction.description}>
                                  {item.nextAction.description}
                                </span>
                                <small title={crmDate(item.nextAction.dueAt)}>
                                  {crmRelative(item.nextAction.dueAt, now)}
                                  {overdue && <span className="adm-overdue-badge">{overdue}</span>}
                                </small>
                              </>
                            ) : (
                              label(item.closedDisposition ?? 'Closed')
                            )}
                          </td>
                          <td data-label="Owner" className="adm-col-owner" title={item.ownerUserId}>
                            {founderName(owners, item.ownerUserId)}
                          </td>
                          <td data-label="Received" className="adm-col-received" title={crmDate(item.createdAt)}>
                            {crmRelative(item.createdAt, now)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!loading && page && items.length === 0 && <p className="adm-empty">Nothing matches these filters.</p>}
              <div className="adm-pagination">
                <button
                  disabled={loading || history.length === 0}
                  onClick={() => {
                    setCursor(history.at(-1) ?? null);
                    setHistory((values) => values.slice(0, -1));
                  }}
                >
                  Previous
                </button>
                <button
                  disabled={loading || !page?.nextCursor}
                  onClick={() => {
                    setHistory((values) => [...values, cursor]);
                    setCursor(page?.nextCursor ?? null);
                  }}
                >
                  Next
                </button>
              </div>
            </div>
            <aside className={`adm-detail${mobileDetail ? ' is-mobile-open' : ''}`} aria-label="Enquiry details">
              {!detail ? (
                <p>Pick a row to see its answers and follow-up.</p>
              ) : (
                <>
                  <button
                    className="adm-crm-back"
                    type="button"
                    onClick={() => {
                      if (!canLeaveCurrentDetail('Discard unsaved edits before returning to the enquiry list?')) return;
                      setMobileDetail(false);
                      syncEnquiryUrl(null);
                      requestAnimationFrame(() => {
                        window.scrollTo(0, listScroll.current);
                        const selected = [...document.querySelectorAll<HTMLButtonElement>('[data-enquiry-id]')].find(
                          (button) => button.dataset.enquiryId === detail.opportunity.id,
                        );
                        selected?.focus({ preventScroll: true });
                      });
                    }}
                  >
                    ← Back to the list
                  </button>
                  <div className="adm-crm-detail-heading" ref={detailHeading} tabIndex={-1} role="region" aria-label="Selected enquiry">
                    <div>
                      <p className="adm-eyebrow">
                        {label(detail.opportunity.audience)} · {label(detail.opportunity.stage)}
                      </p>
                      <h2>{detail.contact.name}</h2>
                      <a href={`mailto:${detail.contact.email}`}>{detail.contact.email}</a>
                    </div>
                    <span className="adm-status-pill">{founderName(owners, detail.opportunity.ownerUserId)}</span>
                  </div>
                  <p className="adm-subtle">
                    Received {crmDate(detail.submission.capturedAt)} · {emailStatusText(detail.contact.emailEvidence.status)}
                  </p>
                  <p className="adm-subtle">
                    {detail.submission.completedAt
                      ? `Questionnaires finished ${crmDate(detail.submission.completedAt)}`
                      : 'Partly answered: questionnaires not finished'}
                  </p>
                  <section className="adm-crm-next-action" aria-label="Current next action">
                    <small>Next action</small>
                    {detail.opportunity.nextAction ? (
                      <>
                        <strong>{detail.opportunity.nextAction.description}</strong>
                        <span>
                          {crmDate(detail.opportunity.nextAction.dueAt)} · {crmRelative(detail.opportunity.nextAction.dueAt, now)}
                        </span>
                        {overdueLabel(detail.opportunity.nextAction.dueAt, now) && (
                          <span className="adm-overdue-badge">{overdueLabel(detail.opportunity.nextAction.dueAt, now)}</span>
                        )}
                      </>
                    ) : (
                      <strong>{label(detail.opportunity.closedDisposition ?? 'Closed')}</strong>
                    )}
                    {detail.opportunity.nextAction && (
                      <NextActionEditor
                        description={editDescription}
                        due={editDue}
                        unchanged={
                          editDescription.trim() === detail.opportunity.nextAction.description &&
                          editDue === crmLocalDate(detail.opportunity.nextAction.dueAt)
                        }
                        busy={busy}
                        onDescription={setEditDescription}
                        onDue={setEditDue}
                        onSave={() => {
                          const dueAt = new Date(editDue);
                          if (Number.isNaN(dueAt.getTime())) return;
                          void mutate('updateNextAction', {
                            opportunityId: detail.opportunity.id,
                            expectedRevision: detail.opportunity.revision,
                            description: editDescription.trim(),
                            dueAt: dueAt.toISOString(),
                          });
                        }}
                      />
                    )}
                  </section>
                  <div className="adm-crm-detail-tabs" role="tablist" aria-label="Enquiry detail">
                    {DETAIL_TABS.map((tab, index) => (
                      <button
                        key={tab}
                        type="button"
                        id={`crm-${tab}-tab`}
                        aria-controls={`crm-${tab}-panel`}
                        aria-selected={detailTab === tab}
                        role="tab"
                        tabIndex={detailTab === tab ? 0 : -1}
                        onClick={() => selectTab(tab)}
                        onKeyDown={(event) => {
                          // Roving tabindex: arrows move between tabs and select, Home/End jump to the ends.
                          const step =
                            event.key === 'ArrowRight'
                              ? 1
                              : event.key === 'ArrowLeft'
                                ? -1
                                : event.key === 'Home'
                                  ? 'first'
                                  : event.key === 'End'
                                    ? 'last'
                                    : 0;
                          if (step === 0) return;
                          event.preventDefault();
                          const target =
                            step === 'first'
                              ? 0
                              : step === 'last'
                                ? DETAIL_TABS.length - 1
                                : (index + step + DETAIL_TABS.length) % DETAIL_TABS.length;
                          const next = DETAIL_TABS[target]!;
                          selectTab(next);
                          document.getElementById(`crm-${next}-tab`)?.focus();
                        }}
                      >
                        {label(tab)}
                      </button>
                    ))}
                  </div>
                  {hasDirtyDraft() && (
                    <p className="adm-save-notice" role="status">
                      Unsaved edits are retained while you review this enquiry.
                    </p>
                  )}
                  {visitedDetailTabs.has('overview') && (
                    <section role="tabpanel" id="crm-overview-panel" aria-labelledby="crm-overview-tab" hidden={detailTab !== 'overview'}>
                      <p>
                        <strong>Organisation:</strong> {organisationName ?? <span className="adm-subtle">not given</span>}
                      </p>
                      <p>
                        <strong>Country:</strong> {countries.length ? countries.join(', ') : <span className="adm-subtle">not given</span>}
                      </p>
                      {source && <p className="adm-subtle">{source}</p>}
                      <details className="adm-original-contact">
                        <summary>Original contact and consent</summary>
                        <strong>{detail.submission.contact.name}</strong>
                        <p>{detail.submission.contact.email}</p>
                        <p className="adm-subtle">
                          Interested in: {detail.submission.contact.interests.map(label).join(', ')} · news emails:{' '}
                          {detail.submission.contact.marketingOptIn ? 'agreed' : 'not agreed'}
                        </p>
                        {detail.provenance.originalContact.id !== detail.provenance.canonicalContact.id && (
                          <p className="adm-subtle">
                            This enquiry is linked to {detail.provenance.canonicalContact.name} (the main contact). The original contact
                            details and answers are kept.
                          </p>
                        )}
                        <p className="adm-subtle">We have not confirmed who owns this email address.</p>
                      </details>
                      <details
                        className="adm-crm-edit"
                        open={stageFormOpen}
                        onToggle={(event) => setStageFormOpen(event.currentTarget.open)}
                      >
                        <summary>Assign owner and set next action</summary>
                        <form
                          className="adm-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void mutate('assign', {
                              opportunityId: detail.opportunity.id,
                              expectedRevision: detail.opportunity.revision,
                              ownerUserId: newOwner,
                            });
                          }}
                        >
                          <h3>Follow-up owner</h3>
                          <label>
                            Founder
                            <select aria-label="Founder" value={newOwner} onChange={(event) => setNewOwner(event.target.value)}>
                              {owners.map((value) => (
                                <option key={value.userId} value={value.userId}>
                                  {value.displayName}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button type="submit" disabled={busy || ownersMissing || newOwner === detail.opportunity.ownerUserId}>
                            Assign owner
                          </button>
                          {ownersMissing && (
                            <p className="adm-subtle" role="status">
                              Assign is off because the founder names did not load ({owners.length} of 2). Reload the page to try again.
                            </p>
                          )}
                        </form>
                        <form
                          className="adm-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void mutate('changeStage', {
                              opportunityId: detail.opportunity.id,
                              expectedRevision: detail.opportunity.revision,
                              stage: newStage,
                              reason,
                              nextAction:
                                newStage === 'closed' ? null : { description: actionDescription, dueAt: new Date(actionDue).toISOString() },
                              closedDisposition: newStage === 'closed' ? disposition : null,
                              closingEvidenceRef: newStage === 'closed' ? evidence : null,
                            });
                          }}
                        >
                          <h3>Stage and next action</h3>
                          <label>
                            Stage
                            <select aria-label="Stage" value={newStage} onChange={(event) => setNewStage(event.target.value)}>
                              {(detail.opportunity.audience === 'investor'
                                ? ['new', 'qualified', 'diligence', 'terms', 'closed']
                                : ['new', 'qualified', 'invited', 'onboarding', 'closed']
                              ).map((value) => (
                                <option key={value} value={value}>
                                  {label(value)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Reason
                            <input
                              aria-label="Reason"
                              required
                              maxLength={500}
                              value={reason}
                              onChange={(event) => setReason(event.target.value)}
                            />
                          </label>
                          {newStage === 'closed' ? (
                            <>
                              <label>
                                Outcome
                                <select aria-label="Outcome" value={disposition} onChange={(event) => setDisposition(event.target.value)}>
                                  {['proceeded', 'declined', 'withdrawn', 'waitlisted', 'duplicate'].map((value) => (
                                    <option key={value} value={value}>
                                      {label(value)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                Decision evidence
                                <input
                                  aria-label="Decision evidence"
                                  required
                                  maxLength={256}
                                  value={evidence}
                                  onChange={(event) => setEvidence(event.target.value)}
                                />
                              </label>
                              <p className="adm-subtle">Closing this enquiry records a decision. Contributions remain indicative.</p>
                            </>
                          ) : (
                            <>
                              <label>
                                Next action
                                <input
                                  aria-label="Next action"
                                  required
                                  maxLength={160}
                                  value={actionDescription}
                                  onChange={(event) => setActionDescription(event.target.value)}
                                />
                              </label>
                              <label>
                                Due at (your local time)
                                <input
                                  aria-label="Due at (your local time)"
                                  type="datetime-local"
                                  required
                                  value={actionDue}
                                  onChange={(event) => setActionDue(event.target.value)}
                                />
                              </label>
                            </>
                          )}
                          <button type="submit" disabled={busy}>
                            Save stage and follow-up
                          </button>
                        </form>
                      </details>
                      <details>
                        <summary>Privacy and contact controls</summary>
                        <CrmPrivacy
                          key={`privacy:${detail.provenance.canonicalContact.id}:${privacyResetVersion}`}
                          csrf={csrf}
                          canonicalContact={detail.provenance.canonicalContact}
                          canonicalRevision={detail.provenance.canonicalRevision}
                          owners={owners}
                          onDraftState={onRetentionDraftState}
                          onComplete={async () => {
                            const erasedContactId = detail.provenance.canonicalContact.id;
                            clearDraft(browserDraftStorage(), detail.opportunity.id);
                            if (openGate.current.selected() === detail.opportunity.id) openGate.current.clear();
                            setDetail((current) => (current?.provenance.canonicalContact.id === erasedContactId ? null : current));
                            setNotice('Linked contact records deleted from outreach.');
                            await load();
                            setWorkflowVersion((value) => value + 1);
                          }}
                        />
                      </details>
                    </section>
                  )}
                  {visitedDetailTabs.has('answers') && (
                    <section role="tabpanel" id="crm-answers-panel" aria-labelledby="crm-answers-tab" hidden={detailTab !== 'answers'}>
                      <h3>Original answers</h3>
                      <p>
                        {detail.submission.completedAt ? `Finished ${crmDate(detail.submission.completedAt)}. ` : 'Partly answered: '}
                        {detail.submission.questionnaires.length} of{' '}
                        {plural(detail.submission.contact.interests.length, 'questionnaire', 'questionnaires')} finished.
                      </p>
                      <details className="adm-original-contact">
                        <summary>Original contact and consent</summary>
                        <strong>{detail.submission.contact.name}</strong>
                        <p>{detail.submission.contact.email}</p>
                        <p className="adm-subtle">
                          Interested in: {detail.submission.contact.interests.map(label).join(', ')} · news emails:{' '}
                          {detail.submission.contact.marketingOptIn ? 'agreed' : 'not agreed'}
                        </p>
                      </details>
                      {detail.submission.questionnaires.map((questionnaire) => (
                        <section key={questionnaire.audience}>
                          <h4>{label(questionnaire.audience)}</h4>
                          <dl className="adm-answers">
                            {Object.entries(questionnaire.answers).map(([key, value]) => (
                              <div key={key}>
                                <dt>{label(key.replace(/([A-Z])/g, ' $1'))}</dt>
                                <dd>{answerText(key, value)}</dd>
                              </div>
                            ))}
                          </dl>
                        </section>
                      ))}
                    </section>
                  )}
                  {visitedDetailTabs.has('activity') && (
                    <section role="tabpanel" id="crm-activity-panel" aria-labelledby="crm-activity-tab" hidden={detailTab !== 'activity'}>
                      <h3>History</h3>
                      <ol className="adm-history">
                        {detail.activities.map((activity) => {
                          const entry = activityTitle(activity, owners);
                          return (
                            <li key={activity.id}>
                              <strong>{entry.title}</strong>
                              <small>
                                {crmDate(activity.occurredAt)} ·{' '}
                                {activity.actor.kind === 'operator'
                                  ? founderName(owners, activity.actor.userId)
                                  : activity.actor.kind === 'system'
                                    ? 'System'
                                    : 'Enquirer'}
                              </small>
                              {entry.note && <p>{entry.note}</p>}
                            </li>
                          );
                        })}
                      </ol>
                      <form
                        className="adm-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void mutate('addNote', { opportunityId: detail.opportunity.id, note });
                        }}
                      >
                        <h3>Add a staff note</h3>
                        <label>
                          Note
                          <textarea
                            aria-label="Note"
                            required
                            maxLength={2000}
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                          />
                        </label>
                        <button type="submit" disabled={busy || !note.trim()}>
                          Add note
                        </button>
                      </form>
                      <CrmEnquiryTasks
                        key={`tasks:${detail.opportunity.id}`}
                        csrf={csrf}
                        opportunity={detail.opportunity}
                        owners={owners}
                        onSaved={async () => {
                          const refreshed = await open(detail.opportunity.id, false);
                          await load();
                          setWorkflowVersion((value) => value + 1);
                          return refreshed;
                        }}
                      />
                    </section>
                  )}
                  {visitedDetailTabs.has('messages') && (
                    <section role="tabpanel" id="crm-messages-panel" aria-labelledby="crm-messages-tab" hidden={detailTab !== 'messages'}>
                      <CrmMessages
                        key={`messages:${detail.opportunity.id}:${messagesResetVersion}`}
                        csrf={csrf}
                        opportunity={detail.opportunity}
                        originalRecipient={detail.submission.contact}
                        owners={owners}
                        onDraftChange={setMessageDraftDirty}
                        initialDraft={messageValues}
                        onDraftValues={setMessageValues}
                        onSaved={async () => {
                          const refreshed = await open(detail.opportunity.id, false);
                          await load();
                          setWorkflowVersion((value) => value + 1);
                          return refreshed;
                        }}
                      />
                      {detail.deliveries && (
                        <section className="adm-original-contact">
                          <h3>Enquiry acknowledgement</h3>
                          {detail.deliveries.map((delivery, index) => (
                            <p key={index}>
                              {label(delivery.status)}
                              {delivery.errorCode ? ` · ${label(delivery.errorCode.replace(/^ops\.crm\./, ''))}` : ''}
                            </p>
                          ))}
                        </section>
                      )}
                    </section>
                  )}
                </>
              )}
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
