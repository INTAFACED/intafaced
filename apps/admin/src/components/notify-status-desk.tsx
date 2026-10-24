'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { Chip, type ChipTone } from '@/components/chip';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchStatusDesk, postStatusChange } from '@/lib/notify/status-browser';
import {
  BASIS_WORDS,
  READING_STATES,
  STATE_WORDS,
  ageWords,
  badgeSnippets,
  checkDefinition,
  readingFor,
  toDraft,
  type ComponentDraft,
  type ReadingState,
  type StatusDefinition,
  type StatusDeskReply,
  type StatusDeskView,
  type StatusPage,
} from '@/lib/notify/status-model';

/**
 * STATUS PAGE DESK (SP-status-01, SP-status-05).
 *
 * What visitors read on /status now, with the source and age of each component's reading; the founders' definition of the
 * page (components, groups, outside sources and three owner values, saved from the revision read with a reason); readings
 * entered by hand for an outside component; and a badge snippet per component. Nothing here sets a state by itself: a
 * state comes from a reading or a published notice, and a blank owner value stays blank.
 */

const TONE: Record<keyof typeof STATE_WORDS, ChipTone> = {
  operational: 'live',
  degraded: 'warn',
  partial_outage: 'danger',
  major_outage: 'danger',
  maintenance: 'info',
  no_data: 'neutral',
  none_defined: 'neutral',
};

function Outcome({ reply }: { reply: StatusDeskReply | null }) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="status-desk-outcome">
        <strong>{reply.what === 'configured' ? 'Saved' : 'Reading stored'}</strong>
        <p>svc-notify stored it.</p>
      </div>
    );
  return (
    <div className="adm-callout" role="alert" data-tone={reply.changed === 'unknown' ? 'warn' : 'danger'} data-testid="status-desk-outcome">
      <strong>{reply.title}</strong>
      <p>{reply.body}</p>
      <p className="dk-muted">{reply.next}</p>
    </div>
  );
}

function Failed({ title, message, code }: { title: string; message: string; code: string | null }) {
  return (
    <div className="adm-callout" data-tone="danger" role="status">
      <strong>{title}</strong>
      <p>{message}</p>
      {code && <p className="dk-muted">Code: {code}</p>}
    </div>
  );
}

function Visible({ page, asOf }: { page: StatusPage; asOf: string }) {
  return (
    <section className="dk-stack" aria-labelledby="status-visible" data-testid="status-visible">
      <h2 id="status-visible">What visitors see now</h2>
      {page.overall === 'none_defined' ? (
        <p className="dk-muted" data-testid="status-visible-none">
          No components are defined, so /status shows no banner and no list.
        </p>
      ) : (
        <p>
          Top level: <Chip tone={TONE[page.overall]}>{STATE_WORDS[page.overall]}</Chip>
        </p>
      )}
      {page.components.length > 0 && (
        <div className="dk-table-wrap" role="region" aria-label="Components as visitors see them" tabIndex={0}>
          <table className="adm-table">
            <thead>
              <tr>
                <th>Component</th>
                <th>Group</th>
                <th>Source</th>
                <th>State</th>
                <th>Why</th>
                <th>Latest reading</th>
              </tr>
            </thead>
            <tbody>
              {page.components.map((c) => (
                <tr key={c.id} data-testid={`status-visible-${c.id}`}>
                  <td>
                    {c.name}
                    <div className="dk-muted dk-packet">{c.id}</div>
                  </td>
                  <td>{c.group ?? '—'}</td>
                  <td data-testid="status-visible-source">{c.source ? `Outside: ${c.source}` : 'Our own'}</td>
                  <td>
                    <Chip tone={TONE[c.state]}>{STATE_WORDS[c.state]}</Chip>
                  </td>
                  <td data-testid="status-visible-why">{BASIS_WORDS[c.basis]}</td>
                  <td data-testid="status-visible-reading">
                    {c.reading
                      ? `${STATE_WORDS[c.reading.state]} from ${c.reading.source}, ${ageWords(c.reading.observedAt, asOf)} (${formatWhen(c.reading.observedAt)})`
                      : 'None'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="dk-muted">
        Staleness window:{' '}
        {page.settings.stalenessSeconds === null ? 'not set (every reading shows as no data)' : `${page.settings.stalenessSeconds} s`}.
        Uptime window: {page.settings.uptimeDays === null ? 'not set (no strip)' : `${page.settings.uptimeDays} days`}.
      </p>
    </section>
  );
}

function ReadingForm({
  definition,
  busy,
  onSubmit,
}: {
  definition: StatusDefinition;
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const outside = definition.components.filter((c) => c.source !== null);
  const [componentId, setComponentId] = useState(outside[0]?.id ?? '');
  const [state, setState] = useState<ReadingState>('operational');
  const chosen = outside.find((c) => c.id === componentId) ?? outside[0];
  return (
    <section className="dk-stack" aria-labelledby="status-reading" data-testid="status-reading">
      <h2 id="status-reading">Enter a reading by hand</h2>
      {!chosen ? (
        <p className="dk-muted" data-testid="status-reading-none">
          No outside component is defined. Give a component a source below to enter its readings by hand.
        </p>
      ) : (
        <>
          <p className="dk-muted">
            For an outside dependency the platform cannot measure. The reading is stored with the time you save it and the source the
            definition names, and it goes stale like any other.
          </p>
          <div className="adm-field">
            <label htmlFor="status-reading-component">Component</label>
            <select
              id="status-reading-component"
              className="adm-select"
              value={chosen.id}
              onChange={(e) => setComponentId(e.target.value)}
              disabled={busy}
            >
              {outside.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.source})
                </option>
              ))}
            </select>
          </div>
          <div className="adm-field">
            <label htmlFor="status-reading-state">State</label>
            <select
              id="status-reading-state"
              className="adm-select"
              value={state}
              onChange={(e) => setState(e.target.value as ReadingState)}
              disabled={busy}
            >
              {READING_STATES.map((s) => (
                <option key={s} value={s}>
                  {STATE_WORDS[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="dk-row">
            <button
              type="button"
              className="adm-btn"
              disabled={busy}
              onClick={() => {
                const reading = readingFor(chosen, state);
                if (reading) onSubmit({ op: 'record', ...reading });
              }}
            >
              Store reading
            </button>
          </div>
        </>
      )}
    </section>
  );
}

const blankRow: ComponentDraft = { id: '', name: '', group: '', source: '' };
const valueText = (v: number | null) => (v === null ? '' : String(v));

function DefinitionForm({
  definition,
  busy,
  onSubmit,
}: {
  definition: StatusDefinition;
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [rows, setRows] = useState<ComponentDraft[]>(() => definition.components.map(toDraft));
  const [cap, setCap] = useState(valueText(definition.componentCap));
  const [staleness, setStaleness] = useState(valueText(definition.stalenessSeconds));
  const [uptime, setUptime] = useState(valueText(definition.uptimeDays));
  const [reason, setReason] = useState('');
  const [why, setWhy] = useState<string | null>(null);
  const edit = (i: number, field: keyof ComponentDraft, value: string) =>
    setRows((all) => all.map((row, j) => (j === i ? { ...row, [field]: value } : row)));
  const save = () => {
    const check = checkDefinition(
      { components: rows, componentCap: cap, stalenessSeconds: staleness, uptimeDays: uptime, reason },
      definition.revision,
    );
    if (!check.ok) {
      setWhy(check.why);
      return;
    }
    setWhy(null);
    onSubmit({ op: 'configure', ...check.body });
  };
  return (
    <section className="dk-stack" aria-labelledby="status-define" data-testid="status-define">
      <h2 id="status-define">Define the page</h2>
      <p className="dk-muted">
        Revision {definition.revision}
        {definition.updatedAt ? `, last changed ${formatWhen(definition.updatedAt)}` : ', never changed'}. The list replaces the one on
        file, in this order. A component with a source is an outside dependency whose readings are entered by hand.
      </p>
      <div className="dk-table-wrap" role="region" aria-label="Components to save" tabIndex={0}>
        <table className="adm-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Name</th>
              <th>Group</th>
              <th>Outside source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} data-testid="status-define-row">
                {(['id', 'name', 'group', 'source'] as const).map((field) => (
                  <td key={field}>
                    <input
                      className="adm-input"
                      aria-label={`Row ${i + 1} ${field === 'source' ? 'outside source' : field}`}
                      value={row[field]}
                      maxLength={field === 'id' ? 40 : 80}
                      onChange={(e) => edit(i, field, e.target.value)}
                      disabled={busy}
                    />
                  </td>
                ))}
                <td>
                  <button
                    type="button"
                    className="adm-btn adm-btn--compact"
                    onClick={() => setRows((all) => all.filter((_, j) => j !== i))}
                    disabled={busy}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="dk-muted">No components in this list. Saving it empties the page.</p>}
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={() => setRows((all) => [...all, blankRow])} disabled={busy}>
          Add component
        </button>
      </div>
      <div className="adm-field">
        <label htmlFor="status-define-cap">Component cap (blank refuses any component)</label>
        <input
          id="status-define-cap"
          className="adm-input"
          inputMode="numeric"
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="status-define-staleness">Staleness window in seconds (blank: every reading shows as no data)</label>
        <input
          id="status-define-staleness"
          className="adm-input"
          inputMode="numeric"
          value={staleness}
          onChange={(e) => setStaleness(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="status-define-uptime">Uptime window in days (blank: no strip)</label>
        <input
          id="status-define-uptime"
          className="adm-input"
          inputMode="numeric"
          value={uptime}
          onChange={(e) => setUptime(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="adm-field">
        <label htmlFor="status-define-reason">Reason (kept with the change)</label>
        <input
          id="status-define-reason"
          className="adm-input"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
        />
      </div>
      {why && (
        <p className="dk-why" role="alert">
          {why}
        </p>
      )}
      <div className="dk-row">
        <button type="button" className="adm-btn" data-tone="primary" onClick={save} disabled={busy}>
          Save the page
        </button>
      </div>
    </section>
  );
}

function Badges({ definition, page }: { definition: StatusDefinition; page: StatusPage | null }) {
  const origin = definition.publicOrigin;
  const targets: { id: string | null; name: string }[] = [
    { id: null, name: 'Whole page' },
    ...definition.components.map((c) => ({ id: c.id, name: c.name })),
  ];
  return (
    <section className="dk-stack" aria-labelledby="status-badges" data-testid="status-badges">
      <h2 id="status-badges">Badges</h2>
      {origin === null ? (
        <div className="adm-callout" data-tone="warn" role="status" data-testid="status-badges-no-origin">
          <strong>The public site address is not set</strong>
          <p>svc-notify has no NOTIFY_PUBLIC_ORIGIN, so a snippet would point nowhere. None is shown.</p>
        </div>
      ) : definition.components.length === 0 ? (
        <p className="dk-muted" data-testid="status-badges-none">
          No components are defined. The whole-page badge reads no components until one is.
        </p>
      ) : null}
      {origin !== null && (
        <>
          <p className="dk-muted">
            An image and a link only, never a frame. The image shows the state svc-notify computes when it is fetched, and is cached no
            longer than the staleness window. The console does not load images from another site, so the image opens on the public site.
          </p>
          {targets.map((t) => {
            const s = badgeSnippets(origin, t.id, t.id === null ? 'Platform' : t.name);
            const state = t.id === null ? page?.overall : page?.components.find((c) => c.id === t.id)?.state;
            return (
              <div key={t.id ?? '_page'} className="dk-stack" data-testid={`status-badge-${t.id ?? 'page'}`}>
                <h3>
                  {t.name} {state && <Chip tone={TONE[state]}>{STATE_WORDS[state]}</Chip>}
                </h3>
                <p>
                  <a className="adm-link" href={s.image} target="_blank" rel="noopener noreferrer">
                    Open the badge image
                  </a>
                </p>
                <div className="adm-field">
                  <label htmlFor={`badge-${t.id ?? 'page'}-image`}>Image link</label>
                  <input
                    id={`badge-${t.id ?? 'page'}-image`}
                    className="adm-input"
                    readOnly
                    value={s.image}
                    data-testid="status-badge-image"
                  />
                </div>
                <div className="adm-field">
                  <label htmlFor={`badge-${t.id ?? 'page'}-html`}>HTML snippet</label>
                  <textarea
                    id={`badge-${t.id ?? 'page'}-html`}
                    className="adm-textarea"
                    readOnly
                    rows={2}
                    value={s.html}
                    data-testid="status-badge-html"
                  />
                </div>
                <div className="adm-field">
                  <label htmlFor={`badge-${t.id ?? 'page'}-md`}>Markdown</label>
                  <input
                    id={`badge-${t.id ?? 'page'}-md`}
                    className="adm-input"
                    readOnly
                    value={s.markdown}
                    data-testid="status-badge-markdown"
                  />
                </div>
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}

export function NotifyStatusDesk({ initial }: { initial: StatusDeskView }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<StatusDeskReply | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Remounts the forms on every fresh read, so they start from what the service holds now.
  const [generation, setGeneration] = useState(0);

  /** Reads the desk again; the caller holds `busy`. */
  const reread = useCallback(async () => {
    const next = await fetchStatusDesk();
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
      const result = await postStatusChange(body);
      setReply(result);
      // A stored change, or an outcome nobody can be sure of, both change what the page should say: read it again before
      // any control is enabled again, so a second click cannot act on the old revision.
      if (result.ok || result.changed === 'unknown') await reread();
      setBusy(false);
    },
    [reread],
  );

  const { definition, page } = view;
  return (
    <div className="dk-stack" data-testid="status-desk">
      <header className="adm-pagehead">
        <h1>Status page</h1>
        <p className="dk-muted">
          The public /status page as svc-notify serves it, and its definition. <Link href="/notify">Back to notify health</Link>
        </p>
        <div className="dk-row">
          <button type="button" className="adm-btn" onClick={() => void refresh()} disabled={busy}>
            {busy ? 'Reading…' : 'Read again'}
          </button>
          <span className="dk-asof">As of {formatAsOf(view.asOf)}</span>
        </div>
        {loadFailed && <p className="dk-why">The console could not read the page again. What is shown is the last read.</p>}
      </header>
      <Outcome reply={reply} />
      {page.kind === 'ok' ? (
        <Visible page={page.data} asOf={view.asOf} />
      ) : (
        <Failed title="The public page could not be read" message={page.message} code={page.code} />
      )}
      {definition.kind === 'ok' ? (
        <div key={generation} className="dk-stack">
          <ReadingForm definition={definition.data} busy={busy} onSubmit={(b) => void submit(b)} />
          <DefinitionForm definition={definition.data} busy={busy} onSubmit={(b) => void submit(b)} />
          <Badges definition={definition.data} page={page.kind === 'ok' ? page.data : null} />
        </div>
      ) : (
        <Failed title="The definition could not be read" message={definition.message} code={definition.code} />
      )}
    </div>
  );
}
