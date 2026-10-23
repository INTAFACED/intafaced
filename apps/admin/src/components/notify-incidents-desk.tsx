'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { Chip, type ChipTone } from '@/components/chip';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchIncidentDesk, postIncidentChange } from '@/lib/notify/incidents-browser';
import {
  IMPACTS,
  approvalFor,
  checkIncidentDraft,
  incidentsFrom,
  templateGroups,
  type Impact,
  type Incident,
  type IncidentDeskReply,
  type IncidentDeskView,
  type IncidentTemplate,
  type OperatorNotice,
  type PublishApproval,
} from '@/lib/notify/incidents-model';

/**
 * INCIDENT DESK (SP-status-02).
 *
 * Declare an incident (from a template, or written here), ask for the approval its publish spends, approve another
 * founder's request, publish, post updates and resolve. svc-notify publishes nothing one person decided alone: identity
 * refuses a founder approving their own request, and svc-notify refuses the approver publishing. A published entry is
 * never edited, and a resolved incident takes no further update. Templates are the founders' own wording; none is seeded.
 */

type Submit = (body: Record<string, unknown>) => void;

const STATE: Record<Incident['state'], { label: string; tone: ChipTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  open: { label: 'Open', tone: 'danger' },
  resolved: { label: 'Resolved', tone: 'live' },
};

const IMPACT_WORDS: Record<Impact, string> = { none: 'None', minor: 'Minor', major: 'Major', critical: 'Critical' };

function Outcome({ reply }: { reply: IncidentDeskReply | null }) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="incident-desk-outcome">
        <strong>Done: {reply.what}</strong>
      </div>
    );
  return (
    <div
      className="adm-callout"
      role="alert"
      data-tone={reply.changed === 'unknown' ? 'warn' : 'danger'}
      data-testid="incident-desk-outcome"
      data-code={reply.code ?? ''}
    >
      <strong>{reply.title}</strong>
      <p>{reply.body}</p>
      <p className="dk-muted">{reply.next}</p>
      {reply.code && <p className="dk-muted">Code: {reply.code}</p>}
    </div>
  );
}

function Failed({ title, message }: { title: string; message: string }) {
  return (
    <div className="adm-callout" data-tone="danger" role="status">
      <strong>{title}</strong>
      <p>{message}</p>
    </div>
  );
}

function ImpactSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: Impact | null;
  onChange: (v: Impact | null) => void;
  disabled: boolean;
}) {
  return (
    <select
      id={id}
      className="adm-select"
      value={value ?? ''}
      onChange={(e) => onChange((e.target.value || null) as Impact | null)}
      disabled={disabled}
    >
      <option value="">Not named</option>
      {IMPACTS.map((i) => (
        <option key={i} value={i}>
          {IMPACT_WORDS[i]}
        </option>
      ))}
    </select>
  );
}

function ComponentChecks({
  name,
  components,
  chosen,
  onChange,
  disabled,
}: {
  name: string;
  components: readonly { id: string; name: string }[];
  chosen: readonly string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  if (components.length === 0) return <p className="dk-muted">No components are defined on the status page.</p>;
  return (
    <fieldset className="dk-row">
      <legend>Affected components</legend>
      {components.map((c) => (
        <label key={c.id}>
          <input
            type="checkbox"
            name={name}
            checked={chosen.includes(c.id)}
            onChange={(e) => onChange(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))}
            disabled={disabled}
          />{' '}
          {c.name}
        </label>
      ))}
    </fieldset>
  );
}

function DeclareForm({
  templates,
  components,
  busy,
  onSubmit,
}: {
  templates: readonly IncidentTemplate[];
  components: readonly { id: string; name: string }[];
  busy: boolean;
  onSubmit: Submit;
}) {
  const [templateId, setTemplateId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [impact, setImpact] = useState<Impact | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [why, setWhy] = useState<string | null>(null);
  const pick = (id: string) => {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setTitle(t.title);
    setBody(t.body);
    setImpact(t.impact);
    setChosen([...t.components]);
  };
  const save = () => {
    const input = { title, body, impact, components: chosen, parentId: null, resolves: false };
    const check = checkIncidentDraft(input);
    if (!check.ok) return setWhy(check.why);
    setWhy(null);
    onSubmit({ op: 'draft', ...input });
  };
  return (
    <section className="dk-stack" aria-labelledby="incident-declare" data-testid="incident-declare">
      <h2 id="incident-declare">Declare an incident</h2>
      <div className="adm-field">
        <label htmlFor="incident-template">Template</label>
        <select id="incident-template" className="adm-select" value={templateId} onChange={(e) => pick(e.target.value)} disabled={busy}>
          <option value="">{templates.length === 0 ? 'No templates' : 'Write it here'}</option>
          {templateGroups(templates).map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {templates.length === 0 && (
          <small className="dk-muted" data-testid="incident-templates-none">
            No templates are defined. Write the incident here, or define a template below.
          </small>
        )}
      </div>
      <div className="adm-field">
        <label htmlFor="incident-title">Title</label>
        <input
          id="incident-title"
          className="adm-input"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="incident-body">First update</label>
        <textarea
          id="incident-body"
          className="adm-textarea"
          rows={3}
          value={body}
          maxLength={8000}
          onChange={(e) => setBody(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="incident-impact">Impact</label>
        <ImpactSelect id="incident-impact" value={impact} onChange={setImpact} disabled={busy} />
      </div>
      <ComponentChecks name="incident-components" components={components} chosen={chosen} onChange={setChosen} disabled={busy} />
      {why && (
        <p className="dk-why" role="alert">
          {why}
        </p>
      )}
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={save} disabled={busy}>
          Save draft
        </button>
        <span className="dk-muted">Nothing is public until a second founder approves and it is published.</span>
      </div>
    </section>
  );
}

function EntryActions({
  entry,
  approval,
  me,
  busy,
  onSubmit,
}: {
  entry: OperatorNotice;
  approval: PublishApproval | null;
  me: string;
  busy: boolean;
  onSubmit: Submit;
}) {
  if (entry.status === 'published') return null;
  const live = approval && (approval.status === 'PENDING' || approval.status === 'APPROVED') ? approval : null;
  if (!live)
    return (
      <div className="dk-row">
        {approval && <span className="dk-muted">The last approval is {approval.status.toLowerCase()}.</span>}
        <button type="button" className="adm-btn" onClick={() => onSubmit({ op: 'request', noticeId: entry.id })} disabled={busy}>
          Ask for approval
        </button>
      </div>
    );
  const askedBy = live.requesterId === me ? 'you' : 'another founder';
  if (live.status === 'PENDING')
    return (
      <div className="dk-row" data-testid="incident-approval" data-status="PENDING" data-approval-id={live.approvalId}>
        <span className="dk-muted">Waiting for a founder other than the one who asked (asked by {askedBy}).</span>
        <button
          type="button"
          className="adm-btn"
          onClick={() => onSubmit({ op: 'approve', noticeId: entry.id, approvalId: live.approvalId })}
          disabled={busy}
        >
          Approve
        </button>
      </div>
    );
  if (live.approverId === me)
    return (
      <div className="dk-row" data-testid="incident-approval" data-status="APPROVED" data-approval-id={live.approvalId}>
        <span className="dk-muted">Approved by you. The founder who asked publishes it: svc-notify refuses the approver.</span>
      </div>
    );
  return (
    <div
      className="dk-row"
      data-testid="incident-approval"
      data-status="APPROVED"
      data-approval-id={live.approvalId}
      data-operation-id={live.operationId}
    >
      <span className="dk-muted">Approved by another founder. Publishing spends the approval once.</span>
      <button
        type="button"
        className="adm-btn"

        onClick={() => onSubmit({ op: 'publish', noticeId: entry.id, approvalId: live.approvalId, operationId: live.operationId })}
        disabled={busy}
      >
        Publish
      </button>
    </div>
  );
}

function UpdateForm({ incident, busy, onSubmit }: { incident: Incident; busy: boolean; onSubmit: Submit }) {
  const [body, setBody] = useState('');
  const [impact, setImpact] = useState<Impact | null>(null);
  const [resolves, setResolves] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const id = `incident-update-${incident.root.id}`;
  const save = () => {
    const input = { title: incident.root.title, body, impact, components: [], parentId: incident.root.id, resolves };
    const check = checkIncidentDraft(input);
    if (!check.ok) return setWhy(check.why);
    setWhy(null);
    onSubmit({ op: 'draft', ...input });
  };
  return (
    <div className="dk-stack" data-testid="incident-update">
      <div className="adm-field">
        <label htmlFor={`${id}-body`}>Update</label>
        <textarea
          id={`${id}-body`}
          className="adm-textarea"
          rows={2}
          value={body}
          maxLength={8000}
          onChange={(e) => setBody(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="adm-field">
        <label htmlFor={`${id}-impact`}>Impact now</label>
        <ImpactSelect id={`${id}-impact`} value={impact} onChange={setImpact} disabled={busy} />
      </div>
      <label>
        <input type="checkbox" checked={resolves} onChange={(e) => setResolves(e.target.checked)} disabled={busy} /> This update resolves
        the incident (final)
      </label>
      {why && (
        <p className="dk-why" role="alert">
          {why}
        </p>
      )}
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={save} disabled={busy}>
          Save update draft
        </button>
      </div>
    </div>
  );
}

function IncidentCard({
  incident,
  approvals,
  names,
  me,
  busy,
  onSubmit,
}: {
  incident: Incident;
  approvals: readonly PublishApproval[];
  names: ReadonlyMap<string, string>;
  me: string;
  busy: boolean;
  onSubmit: Submit;
}) {
  const { root, entries, state } = incident;
  return (
    <article className="dk-stack" data-testid="incident" data-incident-id={root.id} data-state={state}>
      <h3>
        {root.title} <Chip tone={STATE[state].tone}>{STATE[state].label}</Chip>
      </h3>
      <p className="dk-muted">
        Impact: {root.impact ? IMPACT_WORDS[root.impact] : 'not named'}. Components:{' '}
        {root.components.length === 0 ? 'none named' : root.components.map((c) => names.get(c) ?? c).join(', ')}.
      </p>
      <ol className="dk-stack" aria-label={`Timeline of ${root.title}`}>
        {entries.map((entry) => (
          <li key={entry.id} data-testid="incident-entry" data-status={entry.status}>
            <p>
              <strong>{entry.status === 'published' ? `Published ${formatWhen(entry.publishedAt)}` : 'Draft'}</strong>
              {entry.parentId === null ? ' · first update' : entry.resolves ? ' · resolves the incident' : ' · update'}
              {entry.impact && entry.parentId !== null ? ` · impact ${IMPACT_WORDS[entry.impact]}` : ''}
              {entry.authorId === me ? ' · written by you' : ''}
            </p>
            <p>{entry.body}</p>
            <EntryActions entry={entry} approval={approvalFor(entry.id, approvals)} me={me} busy={busy} onSubmit={onSubmit} />
          </li>
        ))}
      </ol>
      {state === 'open' && <UpdateForm incident={incident} busy={busy} onSubmit={onSubmit} />}
      {state === 'resolved' && <p className="dk-muted">Resolved, and final. If it happens again, declare a new incident.</p>}
    </article>
  );
}

const blankTemplate = { id: '', name: '', group: '', title: '', body: '' };

function Templates({
  templates,
  components,
  busy,
  onSubmit,
}: {
  templates: readonly IncidentTemplate[];
  components: readonly { id: string; name: string }[];
  busy: boolean;
  onSubmit: Submit;
}) {
  const [draft, setDraft] = useState(blankTemplate);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const field = (key: keyof typeof blankTemplate) => ({
    value: draft[key],
    onChange: (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: e.target.value })),
    disabled: busy,
  });
  return (
    <section className="dk-stack" aria-labelledby="incident-templates" data-testid="incident-templates">
      <h2 id="incident-templates">Templates</h2>
      {templates.length === 0 ? (
        <p className="dk-muted">No templates are defined. None is supplied: the wording is yours.</p>
      ) : (
        <ul className="dk-stack">
          {templates.map((t) => (
            <li key={t.id} data-testid={`incident-template-${t.id}`}>
              <strong>{t.name}</strong> <span className="dk-muted">({t.group ?? 'No group'})</span>: {t.title}
              <button
                type="button"
                className="adm-btn adm-btn--compact"
                onClick={() => onSubmit({ op: 'retire-template', id: t.id })}
                disabled={busy}
              >
                Retire
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3>Define a template</h3>
      {(
        [
          ['id', 'Template id (lowercase, digits, dashes)'],
          ['name', 'Name'],
          ['group', 'Group (optional)'],
          ['title', 'Incident title'],
        ] as const
      ).map(([key, label]) => (
        <div className="adm-field" key={key}>
          <label htmlFor={`template-${key}`}>{label}</label>
          <input id={`template-${key}`} className="adm-input" {...field(key)} />
        </div>
      ))}
      <div className="adm-field">
        <label htmlFor="template-body">First update</label>
        <textarea id="template-body" className="adm-textarea" rows={2} {...field('body')} />
      </div>
      <div className="adm-field">
        <label htmlFor="template-impact">Impact</label>
        <ImpactSelect id="template-impact" value={impact} onChange={setImpact} disabled={busy} />
      </div>
      <ComponentChecks name="template-components" components={components} chosen={chosen} onChange={setChosen} disabled={busy} />
      <div className="dk-row">
        <button
          type="button"
          className="adm-btn"
          onClick={() => onSubmit({ op: 'define-template', ...draft, impact, components: chosen })}
          disabled={busy}
        >
          Save template
        </button>
      </div>
    </section>
  );
}

export function NotifyIncidentsDesk({ initial }: { initial: IncidentDeskView }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<IncidentDeskReply | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Approvals this founder approved on this visit: identity lists a decided approval to its requester only.
  const [decided, setDecided] = useState<readonly PublishApproval[]>([]);
  // Remounts the forms on every fresh read, so they start from what the services hold now.
  const [generation, setGeneration] = useState(0);

  const reread = useCallback(async () => {
    const next = await fetchIncidentDesk();
    setLoadFailed(next === null);
    if (next) {
      setView(next);
      setGeneration((g) => g + 1);
    }
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setReply(null);
    await reread();
    setBusy(false);
  }, [reread]);

  const submit = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      const result = await postIncidentChange(body);
      setReply(result);
      if (result.ok && result.approval) {
        const approval = result.approval;
        setDecided((list) => [...list.filter((a) => a.approvalId !== approval.approvalId), approval]);
      }
      // Read again before any control is enabled: a refusal can still have changed state (a spent approval).
      await reread();
      setBusy(false);
    },
    [reread],
  );

  const onSubmit: Submit = (b) => void submit(b);
  const components = view.components.kind === 'ok' ? view.components.data : [];
  const names = new Map(components.map((c) => [c.id, c.name]));
  const listed = view.approvals.kind === 'ok' ? view.approvals.data : [];
  const approvals = [...listed, ...decided.filter((a) => !listed.some((l) => l.approvalId === a.approvalId))];
  return (
    <div className="dk-stack" data-testid="incident-desk">
      <header className="adm-pagehead">
        <h1>Incidents</h1>
        <p className="dk-muted">
          Incidents on the public status page. <Link href="/notify/status">Status page desk</Link> ·{' '}
          <Link href="/notify">Notify health</Link>
        </p>
        <div className="dk-row">
          <button type="button" className="adm-btn" onClick={() => void refresh()} disabled={busy}>
            {busy ? 'Reading…' : 'Read again'}
          </button>
          <span className="dk-asof">As of {formatAsOf(view.asOf)}</span>
        </div>
        {loadFailed && <p className="dk-why">The console could not read the desk again. What is shown is the last read.</p>}
      </header>
      <Outcome reply={reply} />
      {view.components.kind === 'failed' && (
        <Failed title="The status page components could not be read" message={view.components.message} />
      )}
      {view.approvals.kind === 'failed' && <Failed title="Approvals could not be read" message={view.approvals.message} />}
      <div key={generation} className="dk-stack">
        {view.templates.kind === 'ok' ? (
          <DeclareForm templates={view.templates.data} components={components} busy={busy} onSubmit={onSubmit} />
        ) : (
          <Failed title="Templates could not be read" message={view.templates.message} />
        )}
        <section className="dk-stack" aria-labelledby="incident-list">
          <h2 id="incident-list">Incidents</h2>
          {view.notices.kind === 'failed' ? (
            <Failed title="Incidents could not be read" message={view.notices.message} />
          ) : incidentsFrom(view.notices.data).length === 0 ? (
            <p className="dk-muted" data-testid="incidents-none">
              No incidents, drafted or published.
            </p>
          ) : (
            incidentsFrom(view.notices.data).map((incident) => (
              <IncidentCard
                key={incident.root.id}
                incident={incident}
                approvals={approvals}
                names={names}
                me={view.me}
                busy={busy}
                onSubmit={onSubmit}
              />
            ))
          )}
        </section>
        {view.templates.kind === 'ok' && (
          <Templates templates={view.templates.data} components={components} busy={busy} onSubmit={onSubmit} />
        )}
      </div>
    </div>
  );
}
