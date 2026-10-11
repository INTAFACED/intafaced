'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CrmWorkflowsContract, CrmOpportunity } from '@intafaced/contracts';
import { crmJson, crmWrite, workflowUrl, crmLabel as label, crmDate as date, crmLocalDate, type PendingCrmWrite } from '@/lib/crm-browser';
import { founderName, type FounderOwner } from './founder-names';
type Result<K extends keyof CrmWorkflowsContract> = Awaited<ReturnType<CrmWorkflowsContract[K]>>;
function sourceLabel(source: { campaignId: string | null; sourceKey: string | null }): string {
  if (source.campaignId) return 'Mapped campaign';
  if (source.sourceKey) return 'Unmapped source hint';
  return 'Source unknown';
}
function useRead<K extends keyof CrmWorkflowsContract>(view: K, input: Record<string, unknown>) {
  const [value, setValue] = useState<Result<K> | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const url = workflowUrl(view, input),
    generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const data = await crmJson<Result<K>>(url);
      if (current === generation.current) setValue(data);
      return true;
    } catch (failure) {
      if (current === generation.current) {
        setError(failure instanceof Error ? failure.message : 'Records unavailable.');
        setValue(null);
      }
      return false;
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  return { value, error, loading, refresh };
}
function Message({ error, notice }: { error?: string; notice?: string }) {
  return (
    <>
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
    </>
  );
}
function Pager({ next, loading, setCursor }: { next?: string | null; loading: boolean; setCursor: (value: string | undefined) => void }) {
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
export function CrmMetrics({ filters, onTasks }: { filters: Record<string, unknown>; onTasks: () => void }) {
  const { value, error, loading } = useRead('metrics', filters);
  let observation = loading ? 'Loading global totals…' : 'Reporting unavailable';
  if (value) observation = `observed ${date(value.observedAt)}`;
  return (
    <section className="adm-crm-overview" aria-label="CRM totals">
      <div className="adm-crm-summary-strip" aria-live="polite">
        <strong>
          {loading
            ? 'Loading totals…'
            : `${value?.totals.opportunities.toLocaleString() ?? '—'} ${value?.totals.opportunities === 1 ? 'enquiry' : 'enquiries'}`}
        </strong>
        <span>{value?.totals.incompleteSubmissions.toLocaleString() ?? '—'} incomplete</span>
        <span>{value?.totals.overdueTasks.toLocaleString() ?? '—'} overdue</span>
        <span>{value?.totals.manualCallInvitations.toLocaleString() ?? '—'} invitations</span>
        <small>Global totals · audience, stage and owner filtered · search applies to list only</small>
      </div>
      <Message error={error} />
      <details className="adm-crm-report-details">
        <summary aria-label="Open reports, attribution and plan status">Reports</summary>
        <div className="adm-crm-report-popover">
          <h2>Reports and attribution</h2>
          <p className="adm-subtle">Totals {observation}.</p>
          <p className="adm-subtle">
            Audience, stage and owner filters apply to global totals. Name search affects the enquiry list only. Indicative amounts are not
            received funds.
          </p>
          {value && (
            <>
              <div className="adm-metric-grid">
                {[
                  ['Enquiries', value.totals.opportunities, 'Audience opportunities'],
                  ['Incomplete', value.totals.incompleteSubmissions, 'Saved details, questions unfinished'],
                  ['Overdue', value.totals.overdueTasks, 'Pending tasks past their due time'],
                  ['Call invitations', value.totals.manualCallInvitations, 'Manually recorded evidence'],
                ].map(([name, count, help]) => (
                  <div className="adm-metric" key={String(name)}>
                    <span>{name}</span>
                    <strong>{typeof count === 'number' ? count.toLocaleString() : '—'}</strong>
                    <small>{help}</small>
                  </div>
                ))}
              </div>
              <p className="adm-subtle">
                {value.totals.submissions} submissions · {value.totals.canonicalContacts} canonical contacts ·{' '}
                {value.totals.manualCallBookings} manually recorded call bookings
              </p>
              <div className="adm-report-breakdown">
                {value.byStage.map((item) => (
                  <span key={`${item.audience}:${item.stage}`}>
                    {label(item.audience)} / {label(item.stage)} <strong>{item.count}</strong>
                  </span>
                ))}
                <button type="button" onClick={onTasks}>
                  Review due tasks
                </button>
              </div>
              <details className="adm-audit">
                <summary>Captured opportunities by source</summary>
                <ul className="adm-history">
                  {value.bySource.map((source, index) => (
                    <li key={index}>
                      <strong>
                        {sourceLabel(source)} · {source.count}
                      </strong>
                      {source.sourceKey && <code className="adm-source-key">{source.sourceKey}</code>}
                      <small>Recipient identity remains unknown.</small>
                    </li>
                  ))}
                </ul>
                {value.sourceGroupsTruncated && (
                  <p className="adm-subtle">This report contains the first 200 source groups; more groups exist.</p>
                )}
              </details>
            </>
          )}
          <p className="adm-provider-status">
            Papermark Free · API access unavailable. Deck views cannot be imported on this plan; a source link does not verify a reader.
          </p>
        </div>
      </details>
    </section>
  );
}
export function CrmTasks({ owners, onOpen }: { owners: FounderOwner[]; onOpen: (id: string) => void }) {
  const [owner, setOwner] = useState(''),
    [status, setStatus] = useState('pending'),
    [overdue, setOverdue] = useState(false),
    [cursor, setCursor] = useState<string>();
  const [observedAt] = useState(() => new Date().toISOString());
  const { value, error, loading, refresh } = useRead('listTasks', {
    limit: 50,
    cursor,
    ownerUserId: owner || undefined,
    status: status || undefined,
    dueBefore: overdue ? observedAt : undefined,
  });
  return (
    <section className="adm-workflow-panel">
      <div className="adm-section-heading">
        <div>
          <h2>Follow-up queue</h2>
          <p className="adm-subtle">Prioritise overdue reviews and incomplete enquiries without losing their originals.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          Refresh tasks
        </button>
      </div>
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
            <option value="">Both founders</option>
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
      <Message error={error} />
      <div className="adm-task-list">
        {value?.items.map(({ task, kind }) => (
          <article key={task.id} className="adm-task-row">
            <div>
              <strong>{task.description}</strong>
              <small>
                {label(kind)} · {founderName(owners, task.ownerUserId)} · {date(task.dueAt)}
              </small>
            </div>
            <span className="adm-status-pill">{label(task.status)}</span>
            <button type="button" onClick={() => onOpen(task.opportunityId)}>
              Review enquiry
            </button>
          </article>
        ))}
      </div>
      {!loading && value?.items.length === 0 && <p className="adm-empty">No tasks match these filters.</p>}
      <Pager next={value?.nextCursor} loading={loading} setCursor={setCursor} />
    </section>
  );
}
export function CrmEnquiryTasks({
  csrf,
  opportunity,
  owners,
  onSaved,
}: {
  csrf: string;
  opportunity: CrmOpportunity;
  owners: FounderOwner[];
  onSaved: () => Promise<boolean>;
}) {
  const { value, error: readError, refresh } = useRead('listTasks', { opportunityId: opportunity.id, limit: 100 });
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
      setNotice(fresh && tasksFresh ? 'Saved with founder attribution.' : 'Saved. Refresh the enquiry to load the latest records.');
    } catch (failure) {
      if (saved) setNotice('Saved. The latest records could not be loaded.');
      else setError(failure instanceof Error ? failure.message : 'Could not confirm the save.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="adm-enquiry-workflows">
      <h3>Tasks and manually recorded follow-up</h3>
      <Message error={error || readError} notice={notice} />
      <ul className="adm-history">
        {value?.items.map(({ task, kind }) => (
          <li key={task.id}>
            <strong>{task.description}</strong>
            <small>
              {label(kind)} · {label(task.status)} · {date(task.dueAt)} · {founderName(owners, task.ownerUserId)}
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
              expectedRevision: opportunity.revision,
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
          </label>
          <label>
            Task reason
            <textarea aria-label="Task reason" required maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button type="submit" disabled={busy || owners.length !== 2 || opportunity.stage === 'closed'}>
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
              expectedRevision: opportunity.revision,
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
              </label>
            </>
          )}
          <button type="submit" disabled={busy || !task}>
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
              expectedRevision: opportunity.revision,
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
              </label>
            </>
          )}
          <button type="submit" disabled={busy || opportunity.stage === 'closed'}>
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
  const { value, error, loading } = useRead('listWorkflowAudit', { subjectType, subjectId, limit: 25, cursor });
  return (
    <details className="adm-audit">
      <summary>Attributed workflow audit</summary>
      <Message error={error} />
      <ol className="adm-history">
        {value?.items.map((item) => (
          <li key={item.id}>
            <strong>{label(item.kind)}</strong>
            <small>
              {founderName(owners, item.actorUserId)} · {date(item.occurredAt)}
            </small>
            <p>{item.reason}</p>
          </li>
        ))}
      </ol>
      {!loading && value?.items.length === 0 && <p className="adm-subtle">No workflow changes recorded.</p>}
      <Pager next={value?.nextCursor} loading={loading} setCursor={setCursor} />
    </details>
  );
}
export function CrmCampaigns({ csrf, owners }: { csrf: string; owners: FounderOwner[] }) {
  const [cursor, setCursor] = useState<string>(),
    [mappingCursor, setMappingCursor] = useState<string>();
  const campaigns = useRead('listCampaigns', { limit: 50, cursor }),
    mappings = useRead('listSourceMappings', { limit: 50, cursor: mappingCursor });
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
        fresh && mappingsFresh ? 'Saved with founder attribution.' : 'Saved. Refresh campaign records to see the latest configuration.',
      );
    } catch (failure) {
      if (saved) setNotice('Saved. Latest configuration could not be loaded.');
      else setError(failure instanceof Error ? failure.message : 'Could not confirm the save.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="adm-workflow-panel">
      <div className="adm-section-heading">
        <div>
          <h2>Campaigns and source links</h2>
          <p className="adm-subtle">A source hint identifies a campaign, never the identity of a deck reader.</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void campaigns.refresh();
            void mappings.refresh();
          }}
        >
          Refresh campaigns
        </button>
      </div>
      <Message error={error || campaigns.error || mappings.error} notice={notice} />
      <div className="adm-workflow-columns">
        <div>
          <h3>Campaigns</h3>
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
          <Pager next={campaigns.value?.nextCursor} loading={campaigns.loading} setCursor={setCursor} />
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
            <button type="submit" disabled={busy}>
              Save campaign
            </button>
          </form>
          {campaignRevision > 0 && (
            <CrmAudit key={`${campaignId}:${campaignRevision}`} subjectType="campaign" subjectId={campaignId} owners={owners} />
          )}
        </div>
        <div>
          <h3>Source mappings</h3>
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
          <Pager next={mappings.value?.nextCursor} loading={mappings.loading} setCursor={setMappingCursor} />
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
              Opaque source hint
              <input
                aria-label="Opaque source hint"
                required
                minLength={16}
                maxLength={128}
                pattern="[A-Za-z0-9_-]{16,128}"
                value={sourceKey}
                onChange={(e) => setSourceKey(e.target.value)}
              />
            </label>
            <p className="adm-subtle">Use this hint in the supported enquiry link. Do not encode an email address or recipient name.</p>
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
            <button type="submit" disabled={busy}>
              Save source mapping
            </button>
          </form>
          {mappingRevision > 0 && (
            <CrmAudit key={`${mappingId}:${mappingRevision}`} subjectType="source_mapping" subjectId={mappingId} owners={owners} />
          )}
        </div>
      </div>
      <p className="adm-provider-status">
        Papermark Free · API access unavailable. Provider views cannot be imported on this plan. Saving a mapping does not enable analytics
        or verify a recipient.
      </p>
    </section>
  );
}
export function CrmDuplicates({ csrf, owners, onChanged }: { csrf: string; owners: FounderOwner[]; onChanged: () => Promise<void> }) {
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
  const candidates = useRead('listDuplicates', { limit: 50, cursor, query: query || undefined }),
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
        if (current === generation.current) setError(failure instanceof Error ? failure.message : 'Provenance unavailable.');
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
      const receipt = await crmWrite<Result<'mergeContacts'>>(csrf, pending.current, 'mergeContacts', {
        sourceContactId: source,
        targetContactId: target,
        sourceExpectedRevision: sourceProof.originalRevision,
        targetExpectedRevision: targetProof.originalRevision,
        confirmed: true,
        reason,
      });
      saved = true;
      setLastMergedTarget(receipt.targetContactId);
      setConfirmed(false);
      setSource('');
      setTarget('');
      const refreshed = await candidates.refresh();
      await onChanged();
      setNotice(
        `Merge saved: ${receipt.movedOpportunityCount} enquiries now link to the canonical contact. Originals remain preserved.${refreshed ? '' : ' Refresh duplicate records.'}`,
      );
    } catch (failure) {
      if (saved) setNotice('Merge saved. Refresh the workspace to load canonical links.');
      else setError(failure instanceof Error ? failure.message : 'Could not confirm the merge.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="adm-workflow-panel">
      <h2>Duplicate review</h2>
      <p className="adm-subtle">Matching email is a review hint. It never verifies identity or merges public enquiries automatically.</p>
      <div className="adm-filters">
        <label>
          Duplicate search
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
      <Message error={error || candidates.error} notice={notice} />
      <div className="adm-table-scroll">
        <table className="adm-crm-table">
          <caption className="adm-sr-only">Unmerged duplicate candidates</caption>
          <thead>
            <tr>
              <th>Original contact</th>
              <th>Email evidence</th>
              <th>Matching contacts</th>
            </tr>
          </thead>
          <tbody>
            {candidates.value?.items.map((item) => (
              <tr key={item.contact.id}>
                <td>
                  {item.contact.name}
                  <small>{item.contact.email}</small>
                </td>
                <td>{label(item.contact.emailEvidence.status)}</td>
                <td>{item.matchingUnmergedContactCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager next={candidates.value?.nextCursor} loading={candidates.loading} setCursor={setCursor} />
      {!candidates.loading && candidates.value?.items.length === 0 && (
        <p className="adm-empty">No matching unmerged contacts on this page.</p>
      )}
      <form
        className="adm-form adm-merge-form"
        onSubmit={(e) => {
          e.preventDefault();
          void merge();
        }}
      >
        <h3>Controlled contact merge</h3>
        <div className="adm-workflow-columns">
          <label>
            Original contact to link
            <select aria-label="Original contact to link" required value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Choose the source</option>
              {candidates.value?.items.map((item) => (
                <option value={item.contact.id} key={item.contact.id}>
                  {item.contact.name} · {item.contact.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            Canonical contact to keep
            <select aria-label="Canonical contact to keep" required value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose the target</option>
              {candidates.value?.items
                .filter((item) => item.contact.id !== source)
                .map((item) => (
                  <option value={item.contact.id} key={item.contact.id}>
                    {item.contact.name} · {item.contact.email}
                  </option>
                ))}
            </select>
          </label>
        </div>
        {sourceProof && targetProof && (
          <div className="adm-provenance-grid">
            {[
              ['Original source', sourceProof],
              ['Canonical target', targetProof],
            ].map(([title, raw]) => {
              const proof = raw as NonNullable<Result<'getContactProvenance'>>;
              return (
                <section key={String(title)}>
                  <h4>{String(title)}</h4>
                  <strong>{proof.originalContact.name}</strong>
                  <p>{proof.originalContact.email}</p>
                  <small>
                    {label(proof.originalContact.emailEvidence.status)} · revision {proof.originalRevision}
                  </small>
                  <p>{proof.firstKnownSource?.campaign?.name ?? 'Campaign source unknown'} · recipient unknown</p>
                </section>
              );
            })}
          </div>
        )}
        <label>
          Merge reason
          <textarea aria-label="Merge reason" required maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <label className="adm-check">
          <input type="checkbox" required checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I reviewed both records.
          Keep all original contacts and answers; move the source enquiries to the selected canonical contact.
        </label>
        <button type="submit" disabled={busy || !confirmed || !sourceProof || !targetProof || source === target}>
          Confirm contact merge
        </button>
      </form>
      {(target || lastMergedTarget) && <CrmAudit subjectType="contact" subjectId={target || lastMergedTarget} owners={owners} />}
    </section>
  );
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
  function download() {
    if (!value) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `intafaced-original-submissions-${new Date(value.generatedAt).toISOString().replaceAll(':', '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="adm-workflow-panel">
      <h2>Controlled original-submission export</h2>
      <p className="adm-subtle">
        Each request exports at most 200 original submissions with initial consent, preserved answers, canonical contact linkage and source
        snapshots. No automatic bulk download.
      </p>
      <Message error={error || campaigns.error} notice={notice} />
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
        <button type="submit" disabled={busy || !confirmed}>
          Prepare original export
        </button>
      </form>
      {value && (
        <div className="adm-export-receipt">
          <strong>
            {value.items.length} originals · {date(value.generatedAt)}
          </strong>
          <p>Original answers are preserved. Campaign linkage does not verify the recipient.</p>
          <div className="adm-pagination">
            <button type="button" onClick={download}>
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
