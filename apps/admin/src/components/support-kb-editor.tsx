'use client';

import { useCallback, useState } from 'react';
import type { SupportKbDraft, SupportKbHistory, SupportKbTemplate } from '@intafaced/contracts';
import { formatAsOf } from '@/lib/as-of';
import { founderMutationHeaders } from '@/lib/founder-browser';
import { baseRevisionOf, KB_ID, labelsFrom, previewParagraphs, type KbAuthoringView } from '@/lib/support/kb-authoring';
import { ConfirmStep } from './support-action-parts';

/**
 * WRITE A HELP ARTICLE — draft, review, publish (SP-kb-01, SP-kb-02).
 *
 * An author types an article into a section, from a template or not, and saves it as a draft: a new revision that no
 * reader sees. The preview shows the words exactly as typed, so markup reads as text. A draft goes to review; a second
 * person approves it (svc-support refuses the author), and only then can it be published. Every write takes a second
 * click and names the revision it was made from, so two people cannot overwrite each other.
 */

/** A refusal as the BFF explains it. */
type RefusalView = { readonly title: string; readonly body: string; readonly next?: string; readonly code?: string | null };

type Step = 'save' | 'submit' | 'approve' | 'send_back' | 'publish';
type Outcome = { readonly ok: true; readonly summary: string } | { readonly ok: false; readonly refusal: RefusalView };

const STATE_WORDS: Record<string, string> = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  published: 'Published',
  sent_back: 'Sent back',
};

const SUMMARY: Record<Step, (d: Record<string, unknown>) => string> = {
  save: (d) => `Draft saved as revision ${String(d.revision)}. No reader sees it.`,
  submit: (d) => `Revision ${String(d.revision)} is in review.`,
  approve: (d) => `Revision ${String(d.revision)} is approved.`,
  send_back: (d) => `Revision ${String(d.revision)} was sent back to its author.`,
  publish: (d) => `Published as version ${String(d.version)}.`,
};

async function readView(id: string): Promise<KbAuthoringView | null> {
  const query = KB_ID.test(id) ? `?id=${encodeURIComponent(id)}` : '';
  const res = await fetch(`/api/support/kb-authoring${query}`, { cache: 'no-store', credentials: 'same-origin' });
  return res.ok ? ((await res.json()) as KbAuthoringView) : null;
}

async function send(body: Record<string, unknown>): Promise<Outcome & { data?: Record<string, unknown> }> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    // Nothing was sent: the session nonce could not be had.
    const why = error instanceof Error ? error.message : 'Your founder session is unavailable.';
    return { ok: false, refusal: { title: 'Nothing was sent', body: why, next: 'Sign in again.', code: 'admin.session_unavailable' } };
  }
  try {
    const res = await fetch('/api/support/kb-authoring', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok?: boolean; data?: Record<string, unknown>; refusal?: RefusalView; code?: string };
    if (json.ok && json.data) return { ok: true, summary: '', data: json.data };
    if (json.refusal) return { ok: false, refusal: json.refusal };
    // The founder gate refused before svc-support was asked: nothing was saved.
    if (typeof json.code === 'string') {
      return { ok: false, refusal: { title: 'Nothing was sent', body: 'The founder console refused the request.', code: json.code } };
    }
  } catch {
    // Falls through: the outcome is unknown, so the page says to read the state again.
  }
  return {
    ok: false,
    refusal: {
      title: 'The outcome is unknown',
      body: 'The answer did not arrive, so this page cannot say whether it was saved.',
      next: 'Read the article again before trying once more.',
      code: 'admin.outcome_unknown',
    },
  };
}

export function KbEditor({ initial }: { initial: KbAuthoringView }) {
  const [view, setView] = useState(initial);
  const [id, setId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [language, setLanguage] = useState('en');
  const [sectionId, setSectionId] = useState('');
  const [labels, setLabels] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [reason, setReason] = useState('');
  const [armed, setArmed] = useState<Step | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const reload = useCallback(async (articleId: string) => {
    const next = await readView(articleId);
    if (next) setView(next);
  }, []);

  const sections =
    view.library.kind === 'ok' ? view.library.data.categories.flatMap((c) => c.sections.map((s) => ({ ...s, category: c.name }))) : [];
  const templates: SupportKbTemplate[] = view.templates.kind === 'ok' ? view.templates.data.filter((t) => !t.retired) : [];
  const history: SupportKbHistory | null = view.history?.kind === 'ok' ? view.history.data : null;
  const draft: SupportKbDraft | null = view.draft?.kind === 'ok' ? view.draft.data : null;
  const base = baseRevisionOf(history);
  const ready = KB_ID.test(id) && title.trim() !== '' && body.trim() !== '' && sectionId !== '';

  async function run(step: Step) {
    setBusy(true);
    const payload: Record<string, unknown> =
      step === 'save'
        ? {
            action: 'draft_save',
            id,
            title,
            body,
            language,
            sectionId,
            tags: labelsFrom(labels),
            templateId: templateId || null,
            baseRevision: base,
          }
        : step === 'send_back'
          ? { action: 'send_back', id, revision: draft?.revision ?? 0, reason }
          : { action: step, id, revision: draft?.revision ?? 0 };
    const reply = await send(payload);
    setOutcome(reply.ok ? { ok: true, summary: SUMMARY[step](reply.data ?? {}) } : reply);
    setArmed(null);
    setBusy(false);
    await reload(id);
  }

  const confirmFor: Record<Step, { title: string; consequence: string; label: string }> = {
    save: {
      title: 'Save this draft?',
      consequence: `It becomes revision ${base + 1}. No reader sees it until it is reviewed and published.`,
      label: 'Yes, save the draft',
    },
    submit: {
      title: 'Send this draft for review?',
      consequence: 'Another person must approve it before it can be published.',
      label: 'Yes, send for review',
    },
    approve: {
      title: 'Approve this draft?',
      consequence: 'You confirm you read it. The author cannot approve their own draft.',
      label: 'Yes, approve',
    },
    send_back: { title: 'Send this draft back?', consequence: 'It goes back to its author with your reason.', label: 'Yes, send it back' },
    publish: { title: 'Publish this draft?', consequence: 'Readers see it in its section straight away.', label: 'Yes, publish' },
  };

  return (
    <section className="dk-stack" aria-label="Write a help article" data-testid="kb-editor">
      <header>
        <h2>Write a help article</h2>
        <p className="dk-muted">
          A draft is never shown to readers. It needs a second person&apos;s approval before it is published. Read {formatAsOf(view.asOf)}.
        </p>
      </header>

      <div className="dk-form">
        <label htmlFor="kbe-id">Article id (letters, numbers and dashes)</label>
        <input
          id="kbe-id"
          className="adm-input"
          value={id}
          onChange={(e) => setId(e.target.value.trim().toLowerCase())}
          onBlur={() => void reload(id)}
          disabled={busy}
        />
        <label htmlFor="kbe-section">Section</label>
        {view.library.kind === 'failed' ? (
          <p className="dk-muted">The sections could not be read: {view.library.why}</p>
        ) : sections.length === 0 ? (
          <p className="dk-muted">No sections exist yet. Make a category and a section first.</p>
        ) : null}
        <select id="kbe-section" className="adm-input" value={sectionId} onChange={(e) => setSectionId(e.target.value)} disabled={busy}>
          <option value="">Pick a section</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.category} › {s.name}
            </option>
          ))}
        </select>
        <label htmlFor="kbe-template">Template</label>
        <select
          id="kbe-template"
          className="adm-input"
          value={templateId}
          disabled={busy}
          onChange={(e) => {
            const picked = templates.find((t) => t.id === e.target.value);
            setTemplateId(e.target.value);
            if (picked && body.trim() === '') setBody(picked.body);
          }}
        >
          <option value="">{templates.length === 0 ? 'No templates are written yet' : 'No template'}</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <label htmlFor="kbe-title">Title</label>
        <input id="kbe-title" className="adm-input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        <label htmlFor="kbe-body">Body (blank lines split paragraphs)</label>
        <textarea id="kbe-body" className="adm-input" rows={8} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} />
        <label htmlFor="kbe-language">Language</label>
        <input
          id="kbe-language"
          className="adm-input"
          value={language}
          onChange={(e) => setLanguage(e.target.value.trim())}
          disabled={busy}
        />
        <label htmlFor="kbe-labels">Labels (separated by commas)</label>
        <input id="kbe-labels" className="adm-input" value={labels} onChange={(e) => setLabels(e.target.value)} disabled={busy} />
      </div>

      <div aria-label="Preview" role="region" data-testid="kbe-preview" className="adm-callout">
        <strong>Preview</strong>
        {title.trim() ? <h3>{title}</h3> : <p className="dk-muted">No title yet.</p>}
        {previewParagraphs(body).map((paragraph, n) => (
          <p key={n}>{paragraph}</p>
        ))}
      </div>

      <p>
        <button type="button" className="adm-btn" disabled={busy || !ready || armed !== null} onClick={() => setArmed('save')}>
          Review draft
        </button>{' '}
        <span className="dk-muted">Saved from revision {base}.</span>
      </p>

      {draft && (
        <div data-testid="kbe-draft">
          <p>
            Newest draft: revision {draft.revision}, <strong>{STATE_WORDS[draft.state] ?? draft.state}</strong>.
          </p>
          <p>
            <button type="button" className="adm-btn" disabled={busy || armed !== null} onClick={() => setArmed('submit')}>
              Send for review
            </button>{' '}
            <button type="button" className="adm-btn" disabled={busy || armed !== null} onClick={() => setArmed('approve')}>
              Approve
            </button>{' '}
            <button
              type="button"
              className="adm-btn"
              disabled={busy || armed !== null || reason.trim() === ''}
              onClick={() => setArmed('send_back')}
            >
              Send back
            </button>{' '}
            <button type="button" className="adm-btn" disabled={busy || armed !== null} onClick={() => setArmed('publish')}>
              Publish
            </button>
          </p>
          <label htmlFor="kbe-reason">Reason for sending back</label>
          <input id="kbe-reason" className="adm-input" value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
        </div>
      )}

      {armed && (
        <ConfirmStep
          title={confirmFor[armed].title}
          consequence={confirmFor[armed].consequence}
          confirmLabel={confirmFor[armed].label}
          busy={busy}
          onConfirm={() => void run(armed)}
          onCancel={() => setArmed(null)}
        />
      )}

      {outcome && (
        <div
          className="adm-callout"
          role={outcome.ok ? 'status' : 'alert'}
          data-tone={outcome.ok ? 'ok' : 'danger'}
          data-testid="kbe-outcome"
        >
          <strong>{outcome.ok ? 'Done' : outcome.refusal.title}</strong>
          <p>{outcome.ok ? outcome.summary : outcome.refusal.body}</p>
          {!outcome.ok && outcome.refusal.code && <p className="dk-muted">Code: {outcome.refusal.code}</p>}
        </div>
      )}

      {history && (
        <div className="dk-table-wrap" role="region" aria-label="Article history" tabIndex={0}>
          <table className="adm-table">
            <thead>
              <tr>
                <th>Revision</th>
                <th>Kind</th>
                <th>State</th>
                <th>Who can read</th>
                <th>Live</th>
              </tr>
            </thead>
            <tbody>
              {history.versions.map((v) => (
                <tr key={v.revision}>
                  <td>{v.revision}</td>
                  <td>{v.draft ? 'Draft' : 'Version'}</td>
                  <td>{v.state ? (STATE_WORDS[v.state] ?? v.state) : '—'}</td>
                  <td>{v.audience === 'signed_in' ? 'Signed-in customers' : v.audience === 'staff' ? 'Staff only' : 'Everyone'}</td>
                  <td>{v.live ? 'Live' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Review trail</h3>
          {history.trail.length === 0 ? (
            <p className="dk-muted">No review moves yet.</p>
          ) : (
            <ul>
              {history.trail.map((row, n) => (
                <li key={n}>
                  Revision {row.revision}: {row.action.replace('_', ' ')} · {formatAsOf(row.at)}
                  {row.reason ? ` · ${row.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
