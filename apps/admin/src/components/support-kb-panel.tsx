'use client';

import { useCallback, useRef, useState } from 'react';
import { SUPPORT_KB_AUDIENCES, type SupportKbArticle, type SupportKbAudience } from '@intafaced/contracts';
import { en } from '@intafaced/i18n';
import { fetchKb, postSupportAction, type ActionReply } from '@/lib/support/browser';
import type { SupportActionRequest } from '@/lib/support/model';
import type { SupportKbView } from '@/lib/support/types';
import { ActionOutcome, ConfirmStep, Failed } from './support-action-parts';
import { formatAsOf } from '@/lib/as-of';

/**
 * HELP ARTICLES — publish and unpublish.
 *
 * An article is two translation-catalogue keys (a title and a body), not text typed here: the words live in the
 * catalogue, so this form publishes keys. Publishing bumps the revision, and a publish or unpublish must quote the
 * revision it was made from, so two people cannot overwrite each other. svc-support lists only published articles, so
 * an article that is hidden is not listed; its revision is in the answer the unpublish gave, and is needed to publish it again.
 */

export interface KbForm {
  readonly id: string;
  readonly titleKey: string;
  readonly bodyKey: string;
  /** 0 creates a new article. Otherwise the revision being replaced. */
  readonly baseRevision: string;
  readonly category: string;
  /** Separated by commas. */
  readonly tags: string;
}

export const emptyKbForm: KbForm = { id: '', titleKey: '', bodyKey: '', baseRevision: '0', category: '', tags: '' };

export type KbStep =
  | { readonly kind: 'publish' }
  | { readonly kind: 'unpublish'; readonly id: string; readonly revision: number }
  | { readonly kind: 'audience'; readonly id: string; readonly revision: number; readonly audience: SupportKbAudience };

/** The words for who may read an article. An article with no audience on the wire is public. */
export const KB_AUDIENCE_WORDS: Record<SupportKbAudience, string> = {
  public: 'Everyone',
  signed_in: 'Signed-in customers only',
  staff: 'Staff only',
};

export const kbAudienceOf = (a: SupportKbArticle): SupportKbAudience => a.audience ?? 'public';

export function kbPublishRequest(form: KbForm): SupportActionRequest | null {
  const base = form.baseRevision.trim() === '' ? NaN : Number(form.baseRevision);
  const tags = form.tags
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  if (!form.id.trim() || !form.titleKey.trim() || !form.bodyKey.trim() || !Number.isInteger(base) || base < 0 || tags.length > 20)
    return null;
  return {
    action: 'kb_publish',
    id: form.id.trim(),
    titleKey: form.titleKey.trim(),
    bodyKey: form.bodyKey.trim(),
    baseRevision: base,
    ...(form.category.trim() ? { category: form.category.trim() } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

export function kbPublishWhy(form: KbForm, busy: boolean): string | null {
  if (busy) return 'A step is already in progress.';
  if (!form.id.trim()) return 'Give the article an id.';
  if (!form.titleKey.trim() || !form.bodyKey.trim()) return 'Give both the title key and the body key.';
  const base = form.baseRevision.trim() === '' ? NaN : Number(form.baseRevision);
  if (!Number.isInteger(base) || base < 0) return 'The revision is a whole number: 0 for a new article.';
  return kbPublishRequest(form) ? null : 'Use at most 20 tags.';
}

/** The English words behind a catalogue key, or null when the catalogue has no text for it. */
export function kbEnglishText(key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(en, key)) return null;
  const text: unknown = (en as Record<string, unknown>)[key];
  return typeof text === 'string' && text.trim() !== '' ? text : null;
}

export interface KbPanelViewProps {
  readonly kb: SupportKbView | null;
  readonly loading: boolean;
  readonly form: KbForm;
  readonly step: KbStep | null;
  readonly busy: boolean;
  readonly outcome: ActionReply | null;
  readonly onRefresh: () => void;
  readonly onField: (patch: Partial<KbForm>) => void;
  readonly onEdit: (article: SupportKbArticle) => void;
  readonly onStep: (step: KbStep | null) => void;
  readonly onSend: () => void;
}

export function KbPanelView(p: KbPanelViewProps) {
  const why = kbPublishWhy(p.form, p.busy);
  const articles = p.kb?.articles;
  const editing = p.step !== null;
  return (
    <section className="dk-stack" aria-label="Help articles" data-testid="kb-panel">
      <div className="adm-pagehead">
        <div>
          <h2>Help articles</h2>
          <p>The published help library customers read. Publish a new article or a new version, or hide one.</p>
          <p className="dk-muted" data-testid="kb-catalogue-note">
            Article text lives in the help catalogue in the code, not in a store this desk can write to. Publishing here points an article
            at catalogue keys. Text for a new article has to be added to the catalogue in the code first.
          </p>
        </div>
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={p.onRefresh} disabled={p.loading || p.busy}>
          {p.loading ? 'Reading…' : 'Refresh articles'}
        </button>
        <span className="dk-asof">{p.kb ? `As of ${formatAsOf(p.kb.asOf)}` : 'No read yet'}</span>
      </div>
      {!p.kb && <p className="dk-why">svc-support could not be read. Nothing is shown rather than a guess.</p>}
      {articles && articles.kind === 'failed' && <Failed name="Help articles" part={articles} />}
      {articles && articles.kind === 'ok' && (
        <>
          {articles.data.length === 0 ? (
            <p className="dk-muted" data-testid="kb-empty">
              svc-support says no articles are published.
            </p>
          ) : (
            <div className="dk-table-wrap" role="region" aria-label="Published articles" tabIndex={0}>
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Article</th>
                    <th>Title (English)</th>
                    <th>Title key</th>
                    <th>Topic</th>
                    <th>Revision</th>
                    <th>Who can read it</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {articles.data.map((a) => (
                    <tr key={a.id}>
                      <td className="dk-packet">{a.id}</td>
                      <td data-testid="kb-title">
                        {kbEnglishText(a.titleKey) ?? <span className="dk-muted">No English text in the catalogue for this key</span>}
                      </td>
                      <td className="dk-packet">{a.titleKey}</td>
                      <td>{a.category ?? '—'}</td>
                      <td>{a.revision ?? '—'}</td>
                      <td>
                        <select
                          className="adm-input"
                          aria-label={`Who can read ${a.id}`}
                          data-testid="kb-audience"
                          value={kbAudienceOf(a)}
                          disabled={p.busy || editing || a.revision === undefined}
                          onChange={(e) => {
                            const next = e.target.value as SupportKbAudience;
                            if (a.revision !== undefined && next !== kbAudienceOf(a))
                              p.onStep({ kind: 'audience', id: a.id, revision: a.revision, audience: next });
                          }}
                        >
                          {SUPPORT_KB_AUDIENCES.map((v) => (
                            <option key={v} value={v}>
                              {KB_AUDIENCE_WORDS[v]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <div className="dk-row">
                          <button type="button" className="adm-btn" disabled={p.busy || editing} onClick={() => p.onEdit(a)}>
                            Edit as new version
                          </button>
                          <button
                            type="button"
                            className="adm-btn"
                            disabled={p.busy || editing || a.revision === undefined}
                            onClick={() => a.revision !== undefined && p.onStep({ kind: 'unpublish', id: a.id, revision: a.revision })}
                          >
                            Unpublish
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {p.step?.kind === 'unpublish' && (
        <ConfirmStep
          title={`Hide ${p.step.id} from customers?`}
          consequence="It disappears from the help library and from search. Publish it again with the revision svc-support gives you."
          confirmLabel="Yes, unpublish"
          busy={p.busy}
          onConfirm={p.onSend}
          onCancel={() => p.onStep(null)}
        />
      )}

      {p.step?.kind === 'audience' && (
        <ConfirmStep
          title={`Make ${p.step.id} readable by ${KB_AUDIENCE_WORDS[p.step.audience].toLowerCase()}?`}
          consequence="The article revision goes up by one. A reader outside that audience gets the same answer as for an article that does not exist."
          confirmLabel="Yes, change who can read it"
          busy={p.busy}
          onConfirm={p.onSend}
          onCancel={() => p.onStep(null)}
        />
      )}

      <h3>Publish an article</h3>
      <p className="dk-muted">
        The title and body are translation-catalogue keys, not text, and each key must already have its English text in the catalogue in the
        code. Use 0 as the revision for a new article; for a new version, use the revision in the table.
      </p>
      <div className="dk-row">
        {(
          [
            ['id', 'Article id', 'kb-account-access'],
            ['titleKey', 'Title key', 'support.kb.account_access.title'],
            ['bodyKey', 'Body key', 'support.kb.account_access.body'],
          ] as const
        ).map(([field, label]) => (
          <div className="adm-field" key={field}>
            <label htmlFor={`kb-${field}`}>{label}</label>
            <input
              id={`kb-${field}`}
              className="adm-input"
              value={p.form[field]}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              disabled={p.busy || editing}
              onChange={(e) => p.onField({ [field]: e.target.value })}
            />
          </div>
        ))}
      </div>
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="kb-baseRevision">Revision you are replacing</label>
          <input
            id="kb-baseRevision"
            className="adm-input"
            inputMode="numeric"
            value={p.form.baseRevision}
            autoComplete="off"
            disabled={p.busy || editing}
            onChange={(e) => p.onField({ baseRevision: e.target.value })}
          />
        </div>
        <div className="adm-field">
          <label htmlFor="kb-category">Topic (optional)</label>
          <input
            id="kb-category"
            className="adm-input"
            value={p.form.category}
            maxLength={200}
            autoComplete="off"
            disabled={p.busy || editing}
            onChange={(e) => p.onField({ category: e.target.value })}
          />
        </div>
        <div className="adm-field">
          <label htmlFor="kb-tags">Tags (optional, separated by commas)</label>
          <input
            id="kb-tags"
            className="adm-input"
            value={p.form.tags}
            autoComplete="off"
            disabled={p.busy || editing}
            onChange={(e) => p.onField({ tags: e.target.value })}
          />
        </div>
      </div>
      {p.step?.kind === 'publish' ? (
        <ConfirmStep
          title={`Publish ${p.form.id.trim()}?`}
          consequence={
            p.form.baseRevision.trim() === '0'
              ? 'Customers can read it straight away.'
              : 'This replaces the published version, and customers read the new one straight away. The revision goes up by one.'
          }
          confirmLabel="Yes, publish"
          busy={p.busy}
          onConfirm={p.onSend}
          onCancel={() => p.onStep(null)}
        />
      ) : (
        <div className="dk-row">
          <button
            type="button"
            className="adm-btn"
            data-tone="primary"
            disabled={why !== null || editing}
            onClick={() => p.onStep({ kind: 'publish' })}
          >
            Review publish
          </button>
          {(why ?? (editing ? 'Finish or cancel the step above first.' : null)) && (
            <span className="dk-why">{why ?? 'Finish or cancel the step above first.'}</span>
          )}
        </div>
      )}
      <ActionOutcome reply={p.outcome} testId="kb-outcome" />
    </section>
  );
}

export function KbPanel({ initial }: { initial: SupportKbView | null }) {
  const [kb, setKb] = useState<SupportKbView | null>(initial);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<KbForm>(emptyKbForm);
  const [step, setStep] = useState<KbStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionReply | null>(null);
  const lock = useRef(false);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    const next = await fetchKb();
    if (mine === seq.current) {
      setKb(next);
      setLoading(false);
    }
  }, []);

  async function send() {
    if (lock.current || !step) return;
    const request: SupportActionRequest | null =
      step.kind === 'publish'
        ? kbPublishRequest(form)
        : step.kind === 'audience'
          ? { action: 'kb_audience', id: step.id, baseRevision: step.revision, audience: step.audience }
          : { action: 'kb_unpublish', id: step.id, baseRevision: step.revision };
    if (!request) return;
    lock.current = true;
    setBusy(true);
    try {
      const reply = await postSupportAction(request);
      setOutcome(reply);
      setStep(null);
      if (reply.ok && step.kind === 'publish') setForm(emptyKbForm);
      // Read the list again either way, so "outcome not known" is followed by what is true.
      await refresh();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <KbPanelView
      kb={kb}
      loading={loading}
      form={form}
      step={step}
      busy={busy}
      outcome={outcome}
      onRefresh={() => void refresh()}
      onField={(patch) => setForm((f) => ({ ...f, ...patch }))}
      onEdit={(a) =>
        setForm({
          id: a.id,
          titleKey: a.titleKey,
          bodyKey: a.bodyKey,
          baseRevision: String(a.revision ?? a.version ?? 0),
          category: a.category ?? '',
          tags: (a.tags ?? []).join(', '),
        })
      }
      onStep={(next) => {
        if (!busy) setStep(next);
      }}
      onSend={() => void send()}
    />
  );
}
