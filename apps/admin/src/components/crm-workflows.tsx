'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CrmWorkflowsContract,
  CrmOpportunity,
  CrmOpportunityPage,
  CrmContact,
  CrmOrganisation,
  CrmSubmission,
} from '@intafaced/contracts';
import {
  crmJson,
  crmWrite,
  workflowUrl,
  crmLabel as label,
  crmDate as date,
  crmLocalDate,
  AT_FETCH_TIME,
  resolveFetchTime,
  readFailureKeepsValue,
  type PendingCrmWrite,
} from '@/lib/crm-browser';
import { describeDue } from '@/lib/crm-due';
import { submitProps } from '@/lib/crm-form-state';
import { pagerVisible } from '@/lib/crm-view';
import { Callout, CrmIcon } from './crm-callout';
import { founderName, type FounderOwner } from './founder-names';
import './crm-workflows.css';
type Result<K extends keyof CrmWorkflowsContract> = Awaited<ReturnType<CrmWorkflowsContract[K]>>;
function sourceLabel(source: { campaignId: string | null; sourceKey: string | null }): string {
  if (source.campaignId) return 'Known campaign';
  if (source.sourceKey) return 'Unrecognised link code';
  return 'Source unknown';
}
const KIND_LABELS: Record<string, string> = {
  next_action: 'Next action',
  follow_up: 'Follow-up',
  call_invitation: 'Call invitation',
  information_request: 'Information request',
};
/** Plain label for a task or message kind: "call_invitation" becomes "Call invitation". */
export const kindLabel = (kind: string) => KIND_LABELS[kind] ?? label(kind);
const pluralise = (count: number, one: string, many: string) => `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`;
/** "13 Oct 2026" from the shared en-GB formatter, without the time. */
const dayOnly = (value: string) => date(value).split(',')[0] ?? date(value);
function groupedAmount(value: string): string {
  const [whole = '0', fraction] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Everything a founder needs to recognise an enquiry at a glance. */
export type EnquiryBrief = {
  id: string;
  contactId: string;
  contactName: string;
  email: string;
  organisation: string | null;
  audience: string;
  stage: string;
  ownerUserId: string;
  receivedAt: string;
  amount: string | null;
};
function amountOf(opportunity: CrmOpportunity): string | null {
  if (opportunity.audience !== 'investor' || opportunity.indicativeContribution.status !== 'stated') return null;
  return `${groupedAmount(opportunity.indicativeContribution.amount)} ${opportunity.indicativeContribution.currency}`;
}
export function briefsFromList(page: Pick<CrmOpportunityPage, 'items' | 'contacts' | 'submissions'>): EnquiryBrief[] {
  return page.items.flatMap((opportunity) => {
    const contact = page.contacts.find((item) => item.id === opportunity.contactId);
    if (!contact) return [];
    const submission = page.submissions.find((item) => item.submissionId === opportunity.submissionId);
    return [
      {
        id: opportunity.id,
        contactId: contact.id,
        contactName: contact.name,
        email: contact.email,
        organisation: submission?.organisationName ?? null,
        audience: opportunity.audience,
        stage: opportunity.stage,
        ownerUserId: opportunity.ownerUserId,
        receivedAt: opportunity.createdAt,
        amount: amountOf(opportunity),
      },
    ];
  });
}
type EnquiryDetail = { opportunity: CrmOpportunity; contact: CrmContact; organisation: CrmOrganisation | null; submission: CrmSubmission };
export function briefFromDetail({ opportunity, contact, organisation, submission }: EnquiryDetail): EnquiryBrief {
  return {
    id: opportunity.id,
    contactId: contact.id,
    contactName: contact.name,
    email: contact.email,
    organisation: organisation?.name ?? submission.contact.organisationName ?? null,
    audience: opportunity.audience,
    stage: opportunity.stage,
    ownerUserId: opportunity.ownerUserId,
    receivedAt: opportunity.createdAt,
    amount: amountOf(opportunity),
  };
}
/**
 * The tasks and duplicates responses carry ids only, so names, organisations, audiences and stages come from the
 * enquiry list (newest 200). An id outside that window is fetched from its own enquiry record instead.
 */
function useEnquiryIndex() {
  const [rows, setRows] = useState<EnquiryBrief[]>([]),
    [loaded, setLoaded] = useState(false),
    [truncated, setTruncated] = useState(false);
  useEffect(() => {
    let live = true;
    crmJson<CrmOpportunityPage>('/api/crm?limit=200')
      .then((page) => {
        if (!live) return;
        setRows(briefsFromList(page));
        setTruncated(page.nextCursor !== null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, []);
  return { rows, loaded, truncated };
}
function useTaskBriefs(opportunityIds: string[]) {
  const index = useEnquiryIndex();
  const [extra, setExtra] = useState<Record<string, EnquiryBrief | null>>({});
  const wanted = opportunityIds.filter((id) => !index.rows.some((row) => row.id === id) && !(id in extra));
  const key = wanted.join(',');
  useEffect(() => {
    if (!index.loaded || !key) return;
    let live = true;
    for (const id of key.split(','))
      crmJson<EnquiryDetail | null>(`/api/crm?opportunityId=${encodeURIComponent(id)}`)
        .then((detail) => live && setExtra((current) => ({ ...current, [id]: detail ? briefFromDetail(detail) : null })))
        .catch(() => live && setExtra((current) => ({ ...current, [id]: null })));
    return () => {
      live = false;
    };
  }, [index.loaded, key]);
  return {
    find: (id: string): EnquiryBrief | null | undefined => index.rows.find((row) => row.id === id) ?? (id in extra ? extra[id] : undefined),
    loading: !index.loaded || wanted.length > 0,
  };
}

type TaskItem = Result<'listTasks'>['items'][number];
/** Overdue pending tasks first, then the rest by due date, soonest first. Finished tasks go last. */
export function sortTasks<T extends { task: { status: string; dueAt: string } }>(items: T[], now = Date.now()): T[] {
  const rank = (item: T) => (item.task.status !== 'pending' ? 2 : Date.parse(item.task.dueAt) < now ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || Date.parse(a.task.dueAt) - Date.parse(b.task.dueAt));
}
/**
 * "2 days overdue", "Overdue today" or "Due in 3 days"; null for tasks that are no longer pending. The words come from
 * lib/crm-due, the same wording the enquiry list and the open enquiry use.
 */
export function dueText(task: { status: string; dueAt: string }, now = Date.now()): { text: string; overdue: boolean } | null {
  if (task.status !== 'pending') return null;
  const due = describeDue(task.dueAt, now);
  return due.overdue ? { text: due.overdue, overdue: true } : { text: due.when, overdue: false };
}
/** Inline hint under a date field; a past date is still allowed. */
export function PastDateWarning({ value, now = Date.now() }: { value: string; now?: number }) {
  if (!value || Number.isNaN(Date.parse(value)) || Date.parse(value) >= now) return null;
  return (
    <small className="crm-wf-warn" role="status">
      That date is in the past
    </small>
  );
}
/**
 * Close Tools and Reports on Escape or an outside click, so an opened menu never lingers over the page. The workspace calls it
 * once, so it works in every view (the Reports menu is only on some of them, Tools is on all).
 */
export function useDismissableMenus() {
  useEffect(() => {
    const open = () =>
      Array.from(document.querySelectorAll<HTMLDetailsElement>('details.adm-crm-report-details[open], details.adm-crm-tools-menu[open]'));
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      for (const menu of open()) {
        menu.open = false;
        menu.querySelector<HTMLElement>('summary')?.focus();
      }
    };
    // mousedown closes on an outside press; click also closes after choosing an item inside, once that item has acted.
    const onPointer = (event: MouseEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      for (const menu of open()) {
        const inside = target !== null && menu.contains(target);
        const choseItem = event.type === 'click' && inside && target instanceof Element && target.closest('button') !== null;
        if (!inside || choseItem) menu.open = false;
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('click', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('click', onPointer);
    };
  }, []);
}
/**
 * `version` refetches when it changes. The previous value stays on screen until the new one arrives. If a refetch of the same
 * request fails, the value also stays and `staleError` carries the reason quietly (no alert, nothing wiped); a first load, or a
 * request whose inputs changed, still fails loudly through `error`. An input equal to `AT_FETCH_TIME` is replaced by the current
 * time on every fetch, so "overdue" is measured when the data is read, not when the view opened.
 */
function useRead<K extends keyof CrmWorkflowsContract>(view: K, input: Record<string, unknown>, version = 0) {
  const [value, setValue] = useState<Result<K> | null>(null),
    [error, setError] = useState(''),
    [staleError, setStaleError] = useState(''),
    [loading, setLoading] = useState(true);
  const url = workflowUrl(view, input),
    generation = useRef(0),
    shown = useRef<string | null>(null),
    inputRef = useRef(input);
  inputRef.current = input;
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const data = await crmJson<Result<K>>(workflowUrl(view, resolveFetchTime(inputRef.current)));
      if (current === generation.current) {
        shown.current = url;
        setValue(data);
        setStaleError('');
      }
      return true;
    } catch (failure) {
      if (current === generation.current) {
        const message = failure instanceof Error ? failure.message : 'Records unavailable.';
        if (readFailureKeepsValue(shown.current, url)) setStaleError(message);
        else {
          shown.current = null;
          setError(message);
          setStaleError('');
          setValue(null);
        }
      }
      return false;
    } finally {
      if (current === generation.current) setLoading(false);
    }
    // `input` is read through a ref and is covered by `url`; `view` is part of it too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh, version]);
  return { value, error, staleError, loading, refresh };
}
/** Shown beside figures that stayed on screen after a failed reload. */
export function StaleNote({ error }: { error: string }) {
  if (!error) return null;
  return (
    <small className="adm-subtle" role="status" title={error}>
      Couldn&apos;t refresh just now. Showing the last figures we have.
    </small>
  );
}
function Message({ error, notice, stale }: { error?: string; notice?: string; stale?: string }) {
  return (
    <>
      <StaleNote error={stale ?? ''} />
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
      {notice && (
        <Callout role="status" icon="check">
          {notice}
        </Callout>
      )}
    </>
  );
}
/** First and next page. Nothing is shown while the list fits on one page. */
function Pager({
  next,
  current,
  loading,
  setCursor,
}: {
  next?: string | null;
  /** The cursor of the page on screen; undefined on the first page. */
  current?: string;
  loading: boolean;
  setCursor: (value: string | undefined) => void;
}) {
  if (!pagerVisible(Boolean(next), current !== undefined)) return null;
  return (
    <div className="adm-pagination">
      <button type="button" disabled={loading} onClick={() => setCursor(undefined)}>
        First page
      </button>
      <button type="button" disabled={loading || !next} onClick={() => setCursor(next ?? undefined)}>
        Next page
      </button>
    </div>
  );
}
export function CrmMetrics({
  filters,
  onTasks,
  onOverdue,
  onIncomplete,
  onInvitations,
  version = 0,
}: {
  filters: Record<string, unknown>;
  onTasks: () => void;
  /** Change this number to refetch the totals in place (no remount, no "Loading totals…" flash). */
  version?: number;
  /** Open Follow-ups already filtered to overdue (see CrmTasks `initialOverdue`). Falls back to `onTasks`. */
  onOverdue?: () => void;
  /** Show only enquiries whose questions are unfinished. The count stays plain text until this is provided. */
  onIncomplete?: () => void;
  /** Show enquiries with a recorded call invitation. The count stays plain text until this is provided. */
  onInvitations?: () => void;
}) {
  const { value, error, staleError, loading } = useRead('metrics', filters, version);
  const firstLoad = loading && !value;
  let observation = firstLoad ? 'Loading totals…' : 'Reporting unavailable';
  if (value) observation = `updated ${date(value.observedAt)}`;
  const count = (n: number | undefined) => n?.toLocaleString('en-GB') ?? '—';
  const overdueGo = onOverdue ?? onTasks;
  return (
    <section className="adm-crm-overview" aria-label="Enquiry totals">
      <div className="adm-crm-summary-strip" aria-live="polite">
        <strong>
          {firstLoad
            ? 'Loading totals…'
            : `${value?.totals.opportunities.toLocaleString('en-GB') ?? '—'} ${value?.totals.opportunities === 1 ? 'enquiry' : 'enquiries'}`}
        </strong>
        {onIncomplete ? (
          <button type="button" className="crm-wf-count" onClick={onIncomplete}>
            {count(value?.totals.incompleteSubmissions)} incomplete
          </button>
        ) : (
          <span>{count(value?.totals.incompleteSubmissions)} incomplete</span>
        )}
        <button type="button" className={`crm-wf-count${value?.totals.overdueTasks ? ' is-warn' : ''}`} onClick={overdueGo}>
          {count(value?.totals.overdueTasks)} overdue
        </button>
        {onInvitations ? (
          <button type="button" className="crm-wf-count" onClick={onInvitations}>
            {count(value?.totals.manualCallInvitations)} invitations
          </button>
        ) : (
          <span>{count(value?.totals.manualCallInvitations)} invitations</span>
        )}
        <StaleNote error={staleError} />
      </div>
      <Message error={error} />
      <details className="adm-crm-report-details">
        <summary aria-label="Open reports and totals">Reports</summary>
        <div className="adm-crm-report-popover">
          <h2>Reports</h2>
          <p className="adm-subtle">Totals {observation}.</p>
          <p className="adm-subtle">
            The Audience, Stage and Owner filters change these totals. Searching by name only changes the list. Indicative amounts are what
            people said they might invest, not money received.
          </p>
          {value && (
            <>
              <div className="adm-metric-grid">
                {[
                  ['Enquiries', value.totals.opportunities, 'All enquiries'],
                  ['Incomplete', value.totals.incompleteSubmissions, 'Contact saved, questions unfinished'],
                  ['Overdue', value.totals.overdueTasks, 'Follow-ups past their due time. Open the queue.'],
                  ['Call invitations', value.totals.manualCallInvitations, 'Recorded by hand'],
                ].map(([name, n, help]) => {
                  const inner = (
                    <>
                      <span>{name}</span>
                      <strong>{typeof n === 'number' ? n.toLocaleString('en-GB') : '—'}</strong>
                      <small>{help}</small>
                    </>
                  );
                  // The Overdue figure is itself the way to the queue, so there is no separate button for it.
                  return name === 'Overdue' ? (
                    <button type="button" className="adm-metric adm-metric--link" key={String(name)} onClick={overdueGo}>
                      {inner}
                    </button>
                  ) : (
                    <div className="adm-metric" key={String(name)}>
                      {inner}
                    </div>
                  );
                })}
              </div>
              <p className="adm-subtle">
                {pluralise(value.totals.submissions, 'submission', 'submissions')} ·{' '}
                {pluralise(value.totals.canonicalContacts, 'contact', 'contacts')} after merging duplicates ·{' '}
                {pluralise(value.totals.manualCallBookings, 'call booking', 'call bookings')} recorded by hand
              </p>
              <div className="adm-report-breakdown">
                {value.byStage.map((item) => (
                  <span key={`${item.audience}:${item.stage}`}>
                    {label(item.audience)} / {label(item.stage)} <strong>{item.count}</strong>
                  </span>
                ))}
              </div>
              <details className="adm-audit">
                <summary>Enquiries by source</summary>
                <ul className="adm-history">
                  {value.bySource.map((source, index) => (
                    <li key={index}>
                      <strong>
                        {sourceLabel(source)} · {source.count}
                      </strong>
                      {source.sourceKey && <code className="adm-source-key">{source.sourceKey}</code>}
                      <small>This shows which link was used, not who used it.</small>
                    </li>
                  ))}
                </ul>
                {value.sourceGroupsTruncated && <p className="adm-subtle">Showing the first 200 sources; there are more.</p>}
              </details>
            </>
          )}
          <Callout className="adm-provider-status">
            Deck tracking: not connected. Our Papermark plan does not let us import deck views, so we cannot see who opened the deck. A
            source link shows which link was used, not who used it.
          </Callout>
        </div>
      </details>
    </section>
  );
}
export function TaskRow({
  item,
  brief,
  loading,
  owners,
  onOpen,
  now = Date.now(),
}: {
  item: TaskItem;
  brief: EnquiryBrief | null | undefined;
  loading: boolean;
  owners: FounderOwner[];
  onOpen: (id: string) => void;
  now?: number;
}) {
  const { task, kind } = item,
    due = dueText(task, now);
  return (
    <li>
      <button type="button" className="crm-wf-task" onClick={() => onOpen(task.opportunityId)}>
        <span className="crm-wf-task-who">
          <strong>{brief ? brief.contactName : loading && brief === undefined ? 'Loading name…' : 'Contact details unavailable'}</strong>{' '}
          {brief && <small>{[brief.organisation, label(brief.audience)].filter(Boolean).join(' · ')}</small>}
        </span>
        <span className="crm-wf-task-what">{task.description}</span>
        <span className="crm-wf-task-meta">
          {kindLabel(kind)} · {founderName(owners, task.ownerUserId)} · due {date(task.dueAt)}
        </span>
        <span className="crm-wf-task-due">
          {due ? (
            <span className={`crm-wf-due${due.overdue ? ' is-overdue' : ''}`}>{due.text}</span>
          ) : (
            <span className="adm-status-pill">{label(task.status)}</span>
          )}
        </span>
      </button>
    </li>
  );
}
export function CrmTasks({
  owners,
  onOpen,
  initialOverdue = false,
  version = 0,
  filtersActive = false,
}: {
  owners: FounderOwner[];
  onOpen: (id: string) => void;
  /** Start with "Overdue only" ticked. Key this component on the value so changing it re-applies. */
  initialOverdue?: boolean;
  /** Change this number to refetch the list in place (the workspace bumps it on every refresh and save). */
  version?: number;
  /** The totals strip has Audience, Stage or Owner filters on, so its overdue count can be smaller than this list. */
  filtersActive?: boolean;
}) {
  const [owner, setOwner] = useState(''),
    [status, setStatus] = useState('pending'),
    [overdue, setOverdue] = useState(initialOverdue),
    [cursor, setCursor] = useState<string>();
  // "Overdue" is measured at the moment of each fetch, so a task that falls due while this view stays open appears on the next refresh.
  const { value, error, staleError, loading } = useRead(
    'listTasks',
    {
      limit: 50,
      cursor,
      ownerUserId: owner || undefined,
      status: status || undefined,
      dueBefore: overdue ? AT_FETCH_TIME : undefined,
    },
    version,
  );
  const briefs = useTaskBriefs(value?.items.map((item) => item.task.opportunityId) ?? []);
  return (
    <section className="adm-workflow-panel" aria-label="Follow-ups">
      <div className="adm-filters">
        <label>
          Task owner
          <select
            aria-label="Task owner"
            value={owner}
            onChange={(e) => {
              setOwner(e.target.value);
              setCursor(undefined);
            }}
          >
            <option value="">Both</option>
            {owners.map((o) => (
              <option value={o.userId} key={o.userId}>
                {o.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Task status
          <select
            aria-label="Task status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setCursor(undefined);
            }}
          >
            {['pending', 'completed', 'cancelled'].map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
            <option value="">All statuses</option>
          </select>
        </label>
        <label className="adm-check">
          <input
            type="checkbox"
            checked={overdue}
            onChange={(e) => {
              setOverdue(e.target.checked);
              setCursor(undefined);
            }}
          />
          Overdue only
        </label>
      </div>
      {initialOverdue && filtersActive && (
        <p className="adm-subtle" role="note">
          This list covers every audience, stage and owner. The overdue count above follows your filters, so it can be smaller.
        </p>
      )}
      <Message error={error} />
      <StaleNote error={staleError} />
      <ul className="crm-wf-task-list">
        {sortTasks(value?.items ?? []).map((item) => (
          <TaskRow
            key={item.task.id}
            item={item}
            brief={briefs.find(item.task.opportunityId)}
            loading={briefs.loading}
            owners={owners}
            onOpen={onOpen}
          />
        ))}
      </ul>
      {!loading && value?.items.length === 0 && <p className="adm-empty">No follow-ups match these filters.</p>}
      <Pager next={value?.nextCursor} current={cursor} loading={loading} setCursor={setCursor} />
    </section>
  );
}
export function CrmEnquiryTasks({
  csrf,
  opportunity,
  expectedRevision,
  staleDraft = false,
  owners,
  onSaved,
}: {
  csrf: string;
  opportunity: CrmOpportunity;
  /** The revision the console's form is based on (see crm-base-revision); defaults to the record's own. */
  expectedRevision?: number;
  /** The form is based on an older version, so these saves will be refused: the buttons stay neutral. */
  staleDraft?: boolean;
  owners: FounderOwner[];
  onSaved: () => Promise<boolean>;
}) {
  const { value, error: readError, staleError: readStale, refresh } = useRead('listTasks', { opportunityId: opportunity.id, limit: 100 });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [owner, setOwner] = useState(opportunity.ownerUserId),
    [kind, setKind] = useState('follow_up'),
    [description, setDescription] = useState(''),
    [dueAt, setDueAt] = useState(''),
    [reason, setReason] = useState('');
  const [selected, setSelected] = useState(''),
    [status, setStatus] = useState('completed'),
    [transitionReason, setTransitionReason] = useState(''),
    [replacement, setReplacement] = useState(''),
    [replacementDue, setReplacementDue] = useState('');
  const [interactionKind, setInteractionKind] = useState('follow_up'),
    [occurredAt, setOccurredAt] = useState(crmLocalDate(new Date().toISOString())),
    [evidence, setEvidence] = useState(''),
    [scheduledAt, setScheduledAt] = useState(''),
    [interactionReason, setInteractionReason] = useState(''),
    [next, setNext] = useState(''),
    [nextDue, setNextDue] = useState('');
  const pending = useRef(new Map<string, PendingCrmWrite>());
  const task = value?.items.find((item) => item.task.id === selected),
    primary = task?.kind === 'next_action' && opportunity.stage !== 'closed';
  async function save(action: string, input: Record<string, unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    let saved = false;
    try {
      await crmWrite(csrf, pending.current, action, input);
      saved = true;
      if (action === 'createTask') {
        setDescription('');
        setReason('');
      }
      if (action === 'transitionTask') {
        setSelected('');
        setTransitionReason('');
      }
      if (action === 'recordInteraction') {
        setEvidence('');
        setInteractionReason('');
      }
      const fresh = await onSaved();
      const tasksFresh = await refresh();
      setNotice(
        fresh && tasksFresh ? 'Saved. Your name is recorded against it.' : 'Saved. Refresh the enquiry to load the latest records.',
      );
    } catch (failure) {
      if (saved) setNotice('Saved. The latest records could not be loaded.');
      else setError(failure instanceof Error ? failure.message : 'Could not confirm the save.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="adm-enquiry-workflows">
      <h3>Follow-ups for this enquiry</h3>
      <Message error={error || readError} stale={readStale} notice={notice} />
      <ul className="adm-history">
        {value?.items.map(({ task, kind }) => (
          <li key={task.id}>
            <strong>{task.description}</strong>
            <small>
              {kindLabel(kind)} · {label(task.status)} · {date(task.dueAt)} · {founderName(owners, task.ownerUserId)}
            </small>
          </li>
        ))}
      </ul>
      {value?.nextCursor && <p className="adm-subtle">More tasks exist. Open the task queue for the next bounded page.</p>}
      <details>
        <summary>Add a follow-up task</summary>
        <form
          className="adm-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save('createTask', {
              opportunityId: opportunity.id,
              expectedRevision: expectedRevision ?? opportunity.revision,
              ownerUserId: owner,
              kind,
              description,
              dueAt: new Date(dueAt).toISOString(),
              reason,
            });
          }}
        >
          <label>
            Task type
            <select aria-label="Task type" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="follow_up">Follow-up</option>
              <option value="call_invitation">Call invitation review</option>
            </select>
          </label>
          <label>
            Responsible founder
            <select aria-label="Responsible founder" value={owner} onChange={(e) => setOwner(e.target.value)}>
              {owners.map((o) => (
                <option key={o.userId} value={o.userId}>
                  {o.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Task description
            <input
              aria-label="Task description"
              required
              maxLength={160}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label>
            Task due (local time)
            <input
              aria-label="Task due (local time)"
              type="datetime-local"
              required
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
            <PastDateWarning value={dueAt} />
          </label>
          <label>
            Task reason
            <textarea aria-label="Task reason" required maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            type="submit"
            {...submitProps({
              disabled: busy || owners.length !== 2 || opportunity.stage === 'closed',
              changed: Boolean(description.trim() || dueAt || reason.trim()),
              refused: staleDraft,
            })}
          >
            Create task
          </button>
        </form>
      </details>
      <details>
        <summary>Complete or cancel a task</summary>
        <form
          className="adm-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!task) return;
            void save('transitionTask', {
              opportunityId: opportunity.id,
              expectedRevision: expectedRevision ?? opportunity.revision,
              taskId: task.task.id,
              expectedTaskRevision: task.revision,
              status,
              reason: transitionReason,
              ...(primary ? { replacementNextAction: { description: replacement, dueAt: new Date(replacementDue).toISOString() } } : {}),
            });
          }}
        >
          <label>
            Pending task
            <select aria-label="Pending task" required value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">Choose a task</option>
              {value?.items
                .filter((i) => i.task.status === 'pending')
                .map((i) => (
                  <option key={i.task.id} value={i.task.id}>
                    {i.task.description}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Task outcome
            <select aria-label="Task outcome" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <label>
            Outcome reason
            <textarea
              aria-label="Outcome reason"
              required
              maxLength={2000}
              value={transitionReason}
              onChange={(e) => setTransitionReason(e.target.value)}
            />
          </label>
          {primary && (
            <>
              <p className="adm-subtle">An open enquiry needs its next action. Record a replacement before finishing this task.</p>
              <label>
                Replacement next action
                <input
                  aria-label="Replacement next action"
                  required
                  maxLength={160}
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                />
              </label>
              <label>
                Replacement due (local time)
                <input
                  aria-label="Replacement due (local time)"
                  required
                  type="datetime-local"
                  value={replacementDue}
                  onChange={(e) => setReplacementDue(e.target.value)}
                />
                <PastDateWarning value={replacementDue} />
              </label>
            </>
          )}
          <button
            type="submit"
            {...submitProps({
              disabled: busy || !task,
              changed: Boolean(task && (transitionReason.trim() || replacement.trim())),
              refused: staleDraft,
            })}
          >
            Record task outcome
          </button>
        </form>
      </details>
      <details>
        <summary>Record a call or follow-up</summary>
        <p className="adm-subtle">Record evidence of an action you took outside the console. This does not send an invitation or email.</p>
        <form
          className="adm-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save('recordInteraction', {
              opportunityId: opportunity.id,
              expectedRevision: expectedRevision ?? opportunity.revision,
              kind: interactionKind,
              occurredAt: new Date(occurredAt).toISOString(),
              evidenceRef: evidence,
              reason: interactionReason,
              ...(interactionKind === 'call_booked'
                ? { scheduledAt: new Date(scheduledAt).toISOString() }
                : { nextAction: { description: next, dueAt: new Date(nextDue).toISOString() } }),
            });
          }}
        >
          <label>
            Recorded action
            <select aria-label="Recorded action" value={interactionKind} onChange={(e) => setInteractionKind(e.target.value)}>
              <option value="follow_up">Follow-up manually recorded</option>
              <option value="call_invited">Call invitation manually recorded</option>
              <option value="call_booked">Call booking manually recorded</option>
            </select>
          </label>
          <label>
            Action happened (local time)
            <input
              aria-label="Action happened (local time)"
              type="datetime-local"
              required
              value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)}
            />
          </label>
          <label>
            Evidence reference
            <input
              aria-label="Evidence reference"
              required
              maxLength={128}
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="Reference to your invitation or conversation"
            />
          </label>
          <label>
            Action reason
            <textarea
              aria-label="Action reason"
              required
              maxLength={2000}
              value={interactionReason}
              onChange={(e) => setInteractionReason(e.target.value)}
            />
          </label>
          {interactionKind === 'call_booked' ? (
            <label>
              Scheduled call (local time)
              <input
                aria-label="Scheduled call (local time)"
                required
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
            </label>
          ) : (
            <>
              <label>
                Follow-up next action
                <input aria-label="Follow-up next action" required maxLength={160} value={next} onChange={(e) => setNext(e.target.value)} />
              </label>
              <label>
                Follow-up due (local time)
                <input
                  aria-label="Follow-up due (local time)"
                  required
                  type="datetime-local"
                  value={nextDue}
                  onChange={(e) => setNextDue(e.target.value)}
                />
                <PastDateWarning value={nextDue} />
              </label>
            </>
          )}
          <button
            type="submit"
            {...submitProps({
              disabled: busy || opportunity.stage === 'closed',
              changed: Boolean(evidence.trim() || interactionReason.trim() || next.trim()),
            })}
          >
            Save manual evidence
          </button>
        </form>
      </details>
      <CrmAudit key={`${opportunity.id}:${opportunity.revision}`} subjectType="opportunity" subjectId={opportunity.id} owners={owners} />
    </section>
  );
}
export function CrmAudit({ subjectType, subjectId, owners }: { subjectType: string; subjectId: string; owners: FounderOwner[] }) {
  const [cursor, setCursor] = useState<string>();
  const { value, error, staleError, loading } = useRead('listWorkflowAudit', { subjectType, subjectId, limit: 25, cursor });
  return (
    <details className="adm-audit">
      <summary>History</summary>
      <Message error={error} stale={staleError} />
      <ol className="adm-history">
        {value?.items.map((item) => (
          <li key={item.id}>
            <strong>{kindLabel(item.kind)}</strong>
            <small>
              {founderName(owners, item.actorUserId)} · {date(item.occurredAt)}
            </small>
            <p>{item.reason}</p>
          </li>
        ))}
      </ol>
      {!loading && value?.items.length === 0 && <p className="adm-subtle">Nothing recorded yet.</p>}
      <Pager next={value?.nextCursor} current={cursor} loading={loading} setCursor={setCursor} />
    </details>
  );
}
export function CrmCampaigns({ csrf, owners, version = 0 }: { csrf: string; owners: FounderOwner[]; version?: number }) {
  const [cursor, setCursor] = useState<string>(),
    [mappingCursor, setMappingCursor] = useState<string>();
  // The page's Refresh button bumps `version`, which reloads both lists.
  const campaigns = useRead('listCampaigns', { limit: 50, cursor }, version),
    mappings = useRead('listSourceMappings', { limit: 50, cursor: mappingCursor }, version);
  const [campaignId, setCampaignId] = useState(() => crypto.randomUUID()),
    [campaignRevision, setCampaignRevision] = useState(0),
    [name, setName] = useState(''),
    [channel, setChannel] = useState('deck'),
    [campaignStatus, setCampaignStatus] = useState('active'),
    [documentRef, setDocumentRef] = useState(''),
    [providerLink, setProviderLink] = useState(''),
    [reason, setReason] = useState('');
  const [mappingId, setMappingId] = useState(() => crypto.randomUUID()),
    [mappingRevision, setMappingRevision] = useState(0),
    [sourceKey, setSourceKey] = useState(() => crypto.randomUUID().replaceAll('-', '')),
    [mappedCampaign, setMappedCampaign] = useState(''),
    [mappingStatus, setMappingStatus] = useState('active'),
    [mappingReason, setMappingReason] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const pending = useRef(new Map<string, PendingCrmWrite>());
  async function save(action: 'upsertCampaign' | 'upsertSourceMapping', input: Record<string, unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    let saved = false;
    try {
      const result = await crmWrite<Result<'upsertCampaign'> | Result<'upsertSourceMapping'>>(csrf, pending.current, action, input);
      saved = true;
      if (action === 'upsertCampaign') {
        setCampaignId(result.id);
        setCampaignRevision(result.revision);
      } else {
        setMappingId(result.id);
        setMappingRevision(result.revision);
      }
      const fresh = await campaigns.refresh(),
        mappingsFresh = await mappings.refresh();
      setNotice(
        fresh && mappingsFresh
          ? 'Saved. Your name is recorded against it.'
          : 'Saved. Refresh campaign records to see the latest configuration.',
      );
    } catch (failure) {
      if (saved) setNotice('Saved. Latest configuration could not be loaded.');
      else setError(failure instanceof Error ? failure.message : 'Could not confirm the save.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="adm-workflow-panel" aria-label="Sources and campaigns">
      <Message error={error || campaigns.error || mappings.error} stale={campaigns.staleError || mappings.staleError} notice={notice} />
      <div className="adm-workflow-columns">
        <div>
          <h3>Campaigns</h3>
          {!campaigns.loading && campaigns.value?.items.length === 0 && <p className="adm-subtle">No campaigns yet.</p>}
          <ul className="adm-history">
            {campaigns.value?.items.map((item) => (
              <li key={item.id}>
                <strong>{item.name}</strong>
                <small>
                  {item.channel} · {label(item.status)} · revision {item.revision}
                </small>
              </li>
            ))}
          </ul>
          <Pager next={campaigns.value?.nextCursor} current={cursor} loading={campaigns.loading} setCursor={setCursor} />
          <form
            className="adm-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save('upsertCampaign', {
                id: campaignId,
                expectedRevision: campaignRevision,
                name,
                channel,
                status: campaignStatus,
                documentRef: documentRef || null,
                providerLinkId: providerLink || null,
                reason,
              });
            }}
          >
            <h3>{campaignRevision ? 'Update campaign' : 'Create campaign'}</h3>
            <label>
              Campaign to edit
              <select
                aria-label="Campaign to edit"
                value={campaignRevision ? campaignId : ''}
                onChange={(e) => {
                  const item = campaigns.value?.items.find((c) => c.id === e.target.value);
                  setCampaignId(item?.id ?? crypto.randomUUID());
                  setCampaignRevision(item?.revision ?? 0);
                  setName(item?.name ?? '');
                  setChannel(item?.channel ?? 'deck');
                  setCampaignStatus(item?.status ?? 'active');
                  setDocumentRef(item?.documentRef ?? '');
                  setProviderLink(item?.providerLinkId ?? '');
                  setReason('');
                }}
              >
                <option value="">New campaign</option>
                {campaigns.value?.items.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Campaign name
              <input aria-label="Campaign name" required maxLength={160} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Channel
              <input aria-label="Channel" required maxLength={160} value={channel} onChange={(e) => setChannel(e.target.value)} />
            </label>
            <label>
              Campaign status
              <select aria-label="Campaign status" value={campaignStatus} onChange={(e) => setCampaignStatus(e.target.value)}>
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
            <label>
              Document reference (optional)
              <input
                aria-label="Document reference (optional)"
                maxLength={128}
                value={documentRef}
                onChange={(e) => setDocumentRef(e.target.value)}
              />
            </label>
            <label>
              Provider link reference (optional)
              <input
                aria-label="Provider link reference (optional)"
                maxLength={128}
                value={providerLink}
                onChange={(e) => setProviderLink(e.target.value)}
              />
            </label>
            <label>
              Campaign change reason
              <textarea
                aria-label="Campaign change reason"
                required
                maxLength={2000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <button
              type="submit"
              {...submitProps({
                disabled: busy,
                changed: Boolean(
                  campaignRevision
                    ? reason.trim() ||
                        campaigns.value?.items.some(
                          (c) => c.id === campaignId && (c.name !== name || c.channel !== channel || c.status !== campaignStatus),
                        )
                    : name.trim() || reason.trim(),
                ),
              })}
            >
              Save campaign
            </button>
          </form>
          {campaignRevision > 0 && (
            <CrmAudit key={`${campaignId}:${campaignRevision}`} subjectType="campaign" subjectId={campaignId} owners={owners} />
          )}
        </div>
        <div>
          <h3>Source mappings</h3>
          {!mappings.loading && mappings.value?.items.length === 0 && <p className="adm-subtle">No source mappings yet.</p>}
          <ul className="adm-history">
            {mappings.value?.items.map((item) => (
              <li key={item.id}>
                <strong>{campaigns.value?.items.find((c) => c.id === item.campaignId)?.name ?? 'Campaign on another page'}</strong>
                <small>
                  {label(item.status)} · revision {item.revision}
                </small>
                <code className="adm-source-key">{item.sourceKey}</code>
              </li>
            ))}
          </ul>
          <Pager next={mappings.value?.nextCursor} current={mappingCursor} loading={mappings.loading} setCursor={setMappingCursor} />
          <form
            className="adm-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save('upsertSourceMapping', {
                id: mappingId,
                expectedRevision: mappingRevision,
                sourceKey,
                campaignId: mappedCampaign,
                status: mappingStatus,
                reason: mappingReason,
              });
            }}
          >
            <h3>{mappingRevision ? 'Update source mapping' : 'Create source mapping'}</h3>
            <label>
              Source mapping to edit
              <select
                aria-label="Source mapping to edit"
                value={mappingRevision ? mappingId : ''}
                onChange={(e) => {
                  const item = mappings.value?.items.find((m) => m.id === e.target.value);
                  setMappingId(item?.id ?? crypto.randomUUID());
                  setMappingRevision(item?.revision ?? 0);
                  setSourceKey(item?.sourceKey ?? crypto.randomUUID().replaceAll('-', ''));
                  setMappedCampaign(item?.campaignId ?? '');
                  setMappingStatus(item?.status ?? 'active');
                  setMappingReason('');
                }}
              >
                <option value="">New source mapping</option>
                {mappings.value?.items.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.sourceKey}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Mapped campaign
              <select aria-label="Mapped campaign" required value={mappedCampaign} onChange={(e) => setMappedCampaign(e.target.value)}>
                <option value="">Choose a campaign</option>
                {campaigns.value?.items.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
                {mappedCampaign && !campaigns.value?.items.some((c) => c.id === mappedCampaign) && (
                  <option value={mappedCampaign}>Current campaign (another page)</option>
                )}
              </select>
            </label>
            <label>
              Link code
              <input
                aria-label="Link code"
                required
                minLength={16}
                maxLength={128}
                pattern="[A-Za-z0-9_-]{16,128}"
                value={sourceKey}
                onChange={(e) => setSourceKey(e.target.value)}
              />
            </label>
            <p className="adm-subtle">Use this code in the supported enquiry link. Do not encode an email address or recipient name.</p>
            <label>
              Mapping status
              <select aria-label="Mapping status" value={mappingStatus} onChange={(e) => setMappingStatus(e.target.value)}>
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
            <label>
              Mapping change reason
              <textarea
                aria-label="Mapping change reason"
                required
                maxLength={2000}
                value={mappingReason}
                onChange={(e) => setMappingReason(e.target.value)}
              />
            </label>
            <button
              type="submit"
              {...submitProps({ disabled: busy, changed: Boolean(mappingReason.trim() || (mappingRevision === 0 && mappedCampaign)) })}
            >
              Save source mapping
            </button>
          </form>
          {mappingRevision > 0 && (
            <CrmAudit key={`${mappingId}:${mappingRevision}`} subjectType="source_mapping" subjectId={mappingId} owners={owners} />
          )}
        </div>
      </div>
      <Callout className="adm-provider-status">
        Deck tracking: not connected. Our Papermark plan does not let us import deck views. Saving a mapping does not turn tracking on or
        tell us who opened the deck.
      </Callout>
    </section>
  );
}
type DuplicateItem = Result<'listDuplicates'>['items'][number];
/** Candidates that share an email address belong together; each group is one merge decision. */
export function groupDuplicates<T extends { contact: { email: string } }>(items: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.contact.email.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()];
}
/** One line describing a record the way a founder recognises it: "received 13 Oct 2026, Investor, New". */
export function recordSummary(contact: { createdAt: string; interests: readonly string[] }, briefs: EnquiryBrief[]): string {
  const first = briefs[0];
  return first
    ? `received ${dayOnly(first.receivedAt)}, ${label(first.audience)}, ${label(first.stage)}`
    : `received ${dayOnly(contact.createdAt)}${contact.interests.length ? `, ${contact.interests.map(label).join(' / ')}` : ''}`;
}
/** Plain-English consequence shown before the merge button. Undo is not offered by the backend, so it says so. */
export function mergeSummary(
  keep: DuplicateItem['contact'],
  keepBriefs: EnquiryBrief[],
  fold: DuplicateItem['contact'],
  foldBriefs: EnquiryBrief[],
): string {
  const moved = foldBriefs.length
    ? `${pluralise(foldBriefs.length, 'enquiry', 'enquiries')} from ${fold.name} will move to ${keep.name}`
    : `${fold.name}'s enquiries will move to ${keep.name}`;
  return `Keep ${keep.name} (${recordSummary(keep, keepBriefs)}). Fold in ${fold.name} (${recordSummary(fold, foldBriefs)}). ${moved}. Both original sign-ups and all answers stay saved. This can't be undone.`;
}
export function MergeCard({
  contact,
  briefs,
  owners,
  role,
  groupLoaded,
  onKeep,
}: {
  contact: DuplicateItem['contact'];
  briefs: EnquiryBrief[];
  owners: FounderOwner[];
  role: 'keep' | 'fold' | null;
  groupLoaded: boolean;
  onKeep: () => void;
}) {
  return (
    <button
      type="button"
      className={`crm-wf-card${role === 'keep' ? ' is-keep' : ''}${role === 'fold' ? ' is-fold' : ''}`}
      aria-pressed={role === 'keep'}
      onClick={onKeep}
    >
      <span className="crm-wf-card-tag">
        {role === 'keep' ? 'Keeping this one' : role === 'fold' ? 'Will be folded in' : 'Click to keep this one'}
      </span>
      <strong>{contact.name}</strong>
      <span>{contact.email}</span>
      <small>{contact.emailEvidence.status === 'verified' ? 'Email verified' : 'Email not verified'}</small>
      {briefs.length === 0 ? (
        <span className="crm-wf-fields">
          <span className="crm-wf-key">Audience</span>
          <span>{contact.interests.length ? contact.interests.map(label).join(', ') : '—'}</span>
          <span className="crm-wf-key">Received</span>
          <span>{dayOnly(contact.createdAt)}</span>
          {groupLoaded && (
            <>
              <span className="crm-wf-key">Enquiry</span>
              <span>Not in the 200 newest enquiries</span>
            </>
          )}
        </span>
      ) : (
        briefs.map((brief, index) => (
          <span key={brief.id} style={{ display: 'contents' }}>
            {index > 0 && <span className="crm-wf-sep" />}
            <span className="crm-wf-fields">
              <span className="crm-wf-key">Organisation</span>
              <span>{brief.organisation ?? '—'}</span>
              <span className="crm-wf-key">Audience</span>
              <span>{label(brief.audience)}</span>
              <span className="crm-wf-key">Stage</span>
              <span>{label(brief.stage)}</span>
              <span className="crm-wf-key">Owner</span>
              <span>{founderName(owners, brief.ownerUserId)}</span>
              <span className="crm-wf-key">Received</span>
              <span>{dayOnly(brief.receivedAt)}</span>
              {brief.amount && (
                <>
                  <span className="crm-wf-key">Indicative amount</span>
                  <span>{brief.amount}</span>
                </>
              )}
            </span>
          </span>
        ))
      )}
    </button>
  );
}
/**
 * The card the founder clicks is the contact that is KEPT (`target`, the canonical record the enquiries move to). With exactly two
 * records the other one is folded in (`source`); with more, the founder picks which to fold in, one merge at a time.
 */
export function chooseKeep(
  group: Array<{ contact: { id: string } }>,
  clicked: { contact: { id: string } },
): { target: string; source: string } {
  const others = group.filter((other) => other.contact.id !== clicked.contact.id);
  return { target: clicked.contact.id, source: others.length === 1 ? (others[0]?.contact.id ?? '') : '' };
}
/** The merge request body, named as the contract names it (`crmMergeInputSchema`). */
export function mergeInput(source: string, target: string, sourceRevision: number, targetRevision: number, reason: string) {
  return {
    sourceContactId: source,
    targetContactId: target,
    sourceExpectedRevision: sourceRevision,
    targetExpectedRevision: targetRevision,
    confirmed: true,
    reason,
  };
}
export function CrmDuplicates({
  csrf,
  owners,
  onChanged,
  version = 0,
}: {
  csrf: string;
  owners: FounderOwner[];
  onChanged: () => Promise<void>;
  /** The page's Refresh button bumps this to reload the candidates. */
  version?: number;
}) {
  const [cursor, setCursor] = useState<string>(),
    [query, setQuery] = useState(''),
    [source, setSource] = useState(''),
    [target, setTarget] = useState(''),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [lastMergedTarget, setLastMergedTarget] = useState('');
  const [sourceProof, setSourceProof] = useState<Result<'getContactProvenance'>>(null),
    [targetProof, setTargetProof] = useState<Result<'getContactProvenance'>>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const candidates = useRead('listDuplicates', { limit: 50, cursor, query: query || undefined }, version),
    index = useEnquiryIndex(),
    generation = useRef(0),
    pending = useRef(new Map<string, PendingCrmWrite>());
  useEffect(() => {
    const current = ++generation.current;
    setSourceProof(null);
    setTargetProof(null);
    setConfirmed(false);
    if (!source || !target || source === target) return;
    void Promise.all([
      crmJson<Result<'getContactProvenance'>>(workflowUrl('getContactProvenance', { contactId: source })),
      crmJson<Result<'getContactProvenance'>>(workflowUrl('getContactProvenance', { contactId: target })),
    ])
      .then(([a, b]) => {
        if (current === generation.current) {
          setSourceProof(a);
          setTargetProof(b);
        }
      })
      .catch((failure) => {
        if (current === generation.current) setError(failure instanceof Error ? failure.message : 'Could not load the records to merge.');
      });
    return () => {
      generation.current++;
    };
  }, [source, target]);
  async function merge() {
    if (!sourceProof || !targetProof) return;
    setBusy(true);
    setError('');
    setNotice('');
    let saved = false;
    try {
      const receipt = await crmWrite<Result<'mergeContacts'>>(
        csrf,
        pending.current,
        'mergeContacts',
        mergeInput(source, target, sourceProof.originalRevision, targetProof.originalRevision, reason),
      );
      saved = true;
      setLastMergedTarget(receipt.targetContactId);
      setConfirmed(false);
      setSource('');
      setTarget('');
      setReason('');
      const refreshed = await candidates.refresh();
      await onChanged();
      const n = receipt.movedOpportunityCount;
      setNotice(
        `Merged. ${pluralise(n, 'enquiry', 'enquiries')} now ${n === 1 ? 'links' : 'link'} to the contact you kept. The original sign-ups and answers are still saved.${refreshed ? '' : ' Refresh to see the updated list.'}`,
      );
    } catch (failure) {
      if (saved) setNotice('Merged. Refresh the page to see the updated links.');
      else setError(failure instanceof Error ? failure.message : 'Could not confirm the merge.');
    } finally {
      setBusy(false);
    }
  }
  const items = candidates.value?.items ?? [],
    groups = groupDuplicates(items),
    briefsOf = (contactId: string) => index.rows.filter((row) => row.contactId === contactId),
    keepItem = items.find((item) => item.contact.id === target),
    foldItem = items.find((item) => item.contact.id === source);
  function keep(group: DuplicateItem[], item: DuplicateItem) {
    const choice = chooseKeep(group, item);
    setTarget(choice.target);
    setSource(choice.source);
    setError('');
  }
  return (
    <section className="adm-workflow-panel" aria-label="Duplicates">
      <div className="adm-filters">
        <label>
          Search duplicates
          <input
            aria-label="Duplicate search"
            type="search"
            maxLength={160}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(undefined);
            }}
          />
        </label>
      </div>
      <Message error={error || candidates.error} stale={candidates.staleError} notice={notice} />
      {groups.map((group) => {
        const first = group[0]!;
        const other = group.length < first.matchingUnmergedContactCount;
        const active = group.some((item) => item.contact.id === target);
        return (
          <fieldset className="crm-wf-group" key={first.contact.email.toLowerCase()}>
            <legend>
              {pluralise(first.matchingUnmergedContactCount, 'record', 'records')} for {first.contact.email}. Click the one to keep.
            </legend>
            <div className="crm-wf-cards">
              {group.map((item) => {
                const role = item.contact.id === target ? 'keep' : active && item.contact.id === source ? 'fold' : null;
                return (
                  <div className="crm-wf-cardwrap" key={item.contact.id}>
                    <MergeCard
                      contact={item.contact}
                      briefs={briefsOf(item.contact.id)}
                      owners={owners}
                      role={role}
                      groupLoaded={index.loaded}
                      onKeep={() => keep(group, item)}
                    />
                    {active && group.length > 2 && item.contact.id !== target && (
                      <button type="button" aria-pressed={item.contact.id === source} onClick={() => setSource(item.contact.id)}>
                        {item.contact.id === source ? 'Folding this one in' : 'Fold this one in'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {other && (
              <p className="adm-subtle">The other record is on another page of results. Use the search or the next page to find it.</p>
            )}
          </fieldset>
        );
      })}
      {index.truncated && (
        <p className="adm-subtle">Details are shown for the 200 newest enquiries. Older records show only what the contact itself holds.</p>
      )}
      <Pager next={candidates.value?.nextCursor} current={cursor} loading={candidates.loading} setCursor={setCursor} />
      {!candidates.loading && items.length === 0 && <p className="adm-empty">No duplicates found on this page.</p>}
      {keepItem && (
        <form
          className="adm-form adm-merge-form"
          onSubmit={(e) => {
            e.preventDefault();
            void merge();
          }}
        >
          <h3>Merge duplicates</h3>
          {foldItem ? (
            <Callout tone="warn" role="status" className="crm-wf-summary">
              {mergeSummary(keepItem.contact, briefsOf(keepItem.contact.id), foldItem.contact, briefsOf(foldItem.contact.id))}
            </Callout>
          ) : (
            <p className="adm-subtle">Now choose which record to fold in.</p>
          )}
          <label>
            Why are you merging these?
            <textarea aria-label="Merge reason" required maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <label className="adm-check">
            <input type="checkbox" required checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I have checked both
            records and understand this can&apos;t be undone.
          </label>
          <button
            type="submit"
            className="adm-irreversible"
            disabled={busy || !confirmed || !sourceProof || !targetProof || source === target || !foldItem}
          >
            <CrmIcon name="warning" />
            Merge into {keepItem.contact.name}
          </button>
        </form>
      )}
      {(target || lastMergedTarget) && <CrmAudit subjectType="contact" subjectId={target || lastMergedTarget} owners={owners} />}
    </section>
  );
}
/** One CSV cell: quoted when needed, and neutralised so a spreadsheet never runs it as a formula. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
const CSV_COLUMNS = [
  'submission_id',
  'captured_at',
  'completed_at',
  'first_completed_at',
  'name',
  'email',
  'organisation',
  'country',
  'interests',
  'marketing_opt_in_at_capture',
  'canonical_contact_name',
  'canonical_contact_email',
  'campaign',
  'channel',
  'source_hint',
  'answers_json',
] as const;
/** The same rows as the JSON download, flattened: one line per original submission. Answers stay as JSON in the last column. */
export function submissionsToCsv(page: Pick<Result<'exportSubmissions'>, 'items'>): string {
  const lines = page.items.map(({ submission, initialContact, firstCompletedAt, canonicalContact, attribution }) =>
    [
      submission.submissionId,
      submission.capturedAt,
      submission.completedAt,
      firstCompletedAt,
      submission.contact.name,
      submission.contact.email,
      submission.contact.organisationName,
      submission.contact.country,
      submission.contact.interests.join('; '),
      initialContact.marketingOptIn ? 'yes' : 'no',
      canonicalContact.name,
      canonicalContact.email,
      attribution.campaign?.name,
      attribution.campaign?.channel,
      attribution.sourceHint,
      JSON.stringify(submission.questionnaires),
    ]
      .map(csvCell)
      .join(','),
  );
  return `\uFEFF${[CSV_COLUMNS.join(','), ...lines].join('\r\n')}\r\n`;
}
export function CrmExports({ csrf, filters, owners }: { csrf: string; filters: Record<string, unknown>; owners: FounderOwner[] }) {
  const [limit, setLimit] = useState('100'),
    [campaignId, setCampaignId] = useState(''),
    [from, setFrom] = useState(''),
    [before, setBefore] = useState(''),
    [cursor, setCursor] = useState<string>();
  const [value, setValue] = useState<Result<'exportSubmissions'> | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const campaigns = useRead('listCampaigns', { limit: 100 }),
    pending = useRef(new Map<string, PendingCrmWrite>());
  async function generate(nextCursor?: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const page = await crmWrite<Result<'exportSubmissions'>>(csrf, pending.current, 'exportSubmissions', {
        ...filters,
        limit: Number(limit),
        ...(campaignId ? { campaignId } : {}),
        ...(from ? { capturedFrom: new Date(from).toISOString() } : {}),
        ...(before ? { capturedBefore: new Date(before).toISOString() } : {}),
        ...(nextCursor ? { cursor: nextCursor } : {}),
      });
      setValue(page);
      setCursor(nextCursor);
      setNotice(`${page.items.length} original submissions prepared in this bounded export. Download when ready.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not confirm the export.');
    } finally {
      setBusy(false);
    }
  }
  function download(format: 'json' | 'csv') {
    if (!value) return;
    const body = format === 'csv' ? submissionsToCsv(value) : JSON.stringify(value, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `intafaced-original-submissions-${new Date(value.generatedAt).toISOString().replaceAll(':', '-')}.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="adm-workflow-panel" aria-label="Exports">
      <Message error={error || campaigns.error} stale={campaigns.staleError} notice={notice} />
      <form
        className="adm-form adm-export-form"
        onSubmit={(e) => {
          e.preventDefault();
          void generate();
        }}
      >
        <p>Current audience, stage and owner filters apply. Name search does not apply to exports.</p>
        <label>
          Rows per export
          <input
            aria-label="Rows per export"
            type="number"
            required
            min={1}
            max={200}
            value={limit}
            onChange={(e) => {
              setLimit(e.target.value);
              setValue(null);
            }}
          />
        </label>
        <label>
          Export campaign
          <select
            aria-label="Export campaign"
            value={campaignId}
            onChange={(e) => {
              setCampaignId(e.target.value);
              setValue(null);
            }}
          >
            <option value="">All campaigns</option>
            {campaigns.value?.items.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Captured from (local time)
          <input
            aria-label="Captured from (local time)"
            type="datetime-local"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setValue(null);
            }}
          />
        </label>
        <label>
          Captured before (local time)
          <input
            aria-label="Captured before (local time)"
            type="datetime-local"
            value={before}
            onChange={(e) => {
              setBefore(e.target.value);
              setValue(null);
            }}
          />
        </label>
        <label className="adm-check">
          <input required type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I need these private
          enquiry records for founder follow-up and will handle the exported file securely.
        </label>
        <button type="submit" {...submitProps({ disabled: busy || !confirmed, changed: confirmed })}>
          Prepare export
        </button>
      </form>
      {value && (
        <div className="adm-export-receipt">
          <strong>
            {value.items.length} originals · {date(value.generatedAt)}
          </strong>
          <p>Original answers are preserved. Campaign linkage does not verify the recipient.</p>
          <div className="adm-pagination">
            <button type="button" onClick={() => download('csv')}>
              Download CSV
            </button>
            <button type="button" onClick={() => download('json')}>
              Download JSON
            </button>
            <button
              type="button"
              disabled={busy || !value.nextCursor || !confirmed}
              onClick={() => void generate(value.nextCursor ?? undefined)}
            >
              Prepare next page
            </button>
            {cursor && (
              <button type="button" disabled={busy} onClick={() => void generate()}>
                Return to first export
              </button>
            )}
          </div>
          <CrmAudit subjectType="export" subjectId={value.exportId} owners={owners} />
        </div>
      )}
    </section>
  );
}
