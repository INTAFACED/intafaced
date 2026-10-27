import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useResource } from '../../shared/resource';
import { Button, EmptyState, Field } from '../../shared/ui';
import { isHiddenPath } from '../../app/feature-registry';
import { useApi, useSession } from '../session/session';
import { helpHref } from '../public/help-guards';
import { t as legacyText } from './copy';
import { Details, Read, type useAction } from './common';
import { deskCopy } from './support-desk-copy';
import { HIDDEN_FEATURE_ARTICLES, KB_CATEGORIES, inKbCategory, kbCategoryCounts, type KbCategory } from './support-desk';
import { kbSchema, type KbArticle } from './support-schemas';
import { kbArticleText } from '../public/kb-text';
import { readRelated, sendArticleFeedback } from './support-calls';

const CATEGORY_KEY = {
  all: 'categoryAll',
  account: 'categoryAccount',
  security: 'categorySecurity',
  trading: 'categoryTrading',
  money: 'categoryMoney',
  general: 'categoryGeneral',
} as const satisfies Record<KbCategory, Parameters<typeof deskCopy.t>[0]>;

// The desk's search lives on this history entry: words carried from the public help search (/support?q=…) are moved off
// the address onto it, and each later search replaces them. Reading it has no side effect, so a render React throws away, or
// the desk mounting again on the same entry, still finds the words; a fresh visit to /support starts with none. The kept
// search belongs to the account that ran it, so another person signing in on this tab never sees it.
const SEARCH_KEY = 'supportHelpSearch';
const clip = (q: string) => q.trim().slice(0, 200);
const stateOf = (): Record<string, unknown> => {
  const state: unknown = history.state;
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
};

export function readDeskSearch(userId: string | null): string {
  const carried = new URL(location.href).searchParams.get('q');
  if (carried !== null) return clip(carried);
  const kept = stateOf()[SEARCH_KEY] as { userId?: unknown; q?: unknown } | undefined;
  return kept && kept.userId === userId && typeof kept.q === 'string' ? clip(kept.q) : '';
}

export function keepDeskSearch(userId: string | null, q: string) {
  const url = new URL(location.href);
  const kept = stateOf()[SEARCH_KEY] as { userId?: unknown; q?: unknown } | undefined;
  if (!url.searchParams.has('q') && (kept ? kept.userId === userId && kept.q === q : q === '')) return;
  url.searchParams.delete('q');
  history.replaceState({ ...stateOf(), [SEARCH_KEY]: { userId, q } }, '', `${url.pathname}${url.search}${url.hash}`);
}

/** The published help library: server search, topic chips, the full text of each answer, and a link to its own page. */
export function SupportHelpArticles({ action, onStartRequest }: { action: ReturnType<typeof useAction>; onStartRequest: () => void }) {
  const copy = deskCopy.useCopy();
  const api = useApi(),
    { userId } = useSession();
  const depositsHidden = isHiddenPath('/uc/recharge');
  // Words carried from the public help search open the desk's search already run.
  const [carried] = useState(() => readDeskSearch(userId));
  const [draft, setDraft] = useState(carried),
    [search, setSearch] = useState(carried),
    [category, setCategory] = useState<KbCategory>('all');
  const kb = useResource(
    (signal) => api.query('support', 'searchKb', { q: search, limit: 50 }, z.array(kbSchema), { signal }),
    `kb:${search}`,
  );
  useEffect(() => keepDeskSearch(userId, search), [userId, search]);
  return (
    <section className="support-pane" aria-label={copy.t('tabHelp')}>
      <p className="muted">{copy.t('helpIntro')}</p>
      <form
        className="more-inline"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(clip(draft));
          setCategory('all');
        }}
      >
        <Field label={copy.t('searchHelp')} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={200} />
        <Button type="submit" variant="secondary">
          {copy.t('search')}
        </Button>
      </form>
      <Read resource={kb.resource} retry={kb.reload}>
        {(rows) => {
          const visible = rows.filter((row) => row.published !== false && !(depositsHidden && HIDDEN_FEATURE_ARTICLES.has(row.id)));
          if (visible.length === 0)
            return (
              <EmptyState
                title={copy.t(search ? 'noArticlesTitle' : 'noPublishedTitle')}
                action={
                  <Button variant="secondary" onClick={onStartRequest}>
                    {copy.t('startRequestFromHelp')}
                  </Button>
                }
              >
                {copy.t(search ? 'noArticlesBody' : 'noPublishedBody')}
              </EmptyState>
            );
          const counts = kbCategoryCounts(visible.map((row) => row.id));
          const chips = KB_CATEGORIES.filter((id) => counts[id]);
          const shown = visible.filter((row) => inKbCategory(row.id, category));
          return (
            <>
              <div className="support-chips" role="group" aria-label={copy.t('categoriesLabel')}>
                {chips.map((id) => (
                  <button
                    type="button"
                    key={id}
                    className={`support-chip${category === id ? ' support-chip--on' : ''}`}
                    aria-pressed={category === id}
                    onClick={() => setCategory(id)}
                  >
                    {copy.t(CATEGORY_KEY[id])} <span aria-hidden="true">{counts[id]}</span>
                  </button>
                ))}
              </div>
              <p className="muted" role="status">
                {shown.length === 1 ? copy.t('articleCountOne') : copy.t('articleCount', { count: shown.length })}
              </p>
              <div data-testid="more-articles" className="more-articles">
                {shown.map((row) => (
                  <Article key={row.id} row={row} action={action} hiddenIds={depositsHidden ? HIDDEN_FEATURE_ARTICLES : EMPTY} />
                ))}
              </div>
              <Button variant="ghost" onClick={onStartRequest}>
                {copy.t('startRequestFromHelp')}
              </Button>
            </>
          );
        }}
      </Read>
    </section>
  );
}

const EMPTY: ReadonlySet<string> = new Set();
function Article({ row, action, hiddenIds }: { row: KbArticle; action: ReturnType<typeof useAction>; hiddenIds: ReadonlySet<string> }) {
  const copy = deskCopy.useCopy();
  const [opened, setOpened] = useState(false);
  const missing = (key: string) => legacyText('support.published.article.text.is.unavailable.for', { value1: key });
  const text = kbArticleText(row);
  const title = text.title ?? missing(row.titleKey);
  const body = text.body;
  return (
    <details onToggle={(event) => event.currentTarget.open && setOpened(true)}>
      <summary lang={text.titleLanguage ?? 'und'}>{title}</summary>
      {body ? <p lang={text.bodyLanguage ?? 'und'}>{body}</p> : <p className="muted">{missing(row.bodyKey)}</p>}
      <a className="text-link" href={helpHref(row.id, row.version)}>
        {copy.t('readArticle')} →
      </a>
      <ArticleFeedback row={row} title={title} action={action} />
      {opened && <RelatedArticles id={row.id} hiddenIds={hiddenIds} />}
    </details>
  );
}

/** "Did this answer help?" One answer per account for each version, so a repeat is answered with the first one. */
function ArticleFeedback({ row, title, action }: { row: KbArticle; title: string; action: ReturnType<typeof useAction> }) {
  const copy = deskCopy.useCopy();
  const api = useApi(),
    { userId } = useSession();
  const send = (helpful: boolean) => {
    // One id per decision: the service answers a repeat of this id with the first result.
    const clientRequestId = `kb-feedback:${crypto.randomUUID()}`;
    let kept: boolean | null = null;
    action.stage({
      title: () => deskCopy.t('feedbackTitle'),
      reference: row.id,
      confirm: () => deskCopy.t('feedbackConfirm'),
      success: () => deskCopy.t(kept === false ? 'feedbackKept' : 'feedbackThanks'),
      content: () => (
        <Details
          items={[
            [deskCopy.t('feedbackRowArticle'), <span lang="und">{title}</span>],
            [deskCopy.t('feedbackRowAnswer'), deskCopy.t(helpful ? 'feedbackYes' : 'feedbackNo')],
          ]}
        />
      ),
      run: async () => {
        const result = await sendArticleFeedback(api, { articleId: row.id, userId, helpful, clientRequestId });
        // A repeat returns the first vote. Say so when it is not the answer just given.
        if (result.ok) kept = result.data.helpful === helpful;
        return result;
      },
    });
  };
  return (
    <div className="support-feedback" role="group" aria-label={copy.t('feedbackQuestion')}>
      <small>{copy.t('feedbackQuestion')}</small>
      <Button variant="secondary" disabled={action.disabled} onClick={() => send(true)}>
        {copy.t('feedbackYes')}
      </Button>
      <Button variant="secondary" disabled={action.disabled} onClick={() => send(false)}>
        {copy.t('feedbackNo')}
      </Button>
      <small className="muted">{copy.t('feedbackOne')}</small>
    </div>
  );
}

/** Published articles that share a topic or tag with this one. Read only when the article is opened. */
function RelatedArticles({ id, hiddenIds }: { id: string; hiddenIds: ReadonlySet<string> }) {
  const copy = deskCopy.useCopy();
  const api = useApi();
  const related = useResource((signal) => readRelated(api, id, signal), `kb-related:${id}`);
  return (
    <div className="support-related">
      <h4>{copy.t('relatedHeading')}</h4>
      <Read resource={related.resource} retry={related.reload}>
        {(rows) => {
          const visible = rows.filter((row) => row.id !== id && row.published !== false && !hiddenIds.has(row.id));
          return visible.length === 0 ? (
            <p className="muted">{copy.t('relatedNone')}</p>
          ) : (
            <ul>
              {visible.map((row) => {
                const text = kbArticleText(row);
                return (
                  <li key={row.id}>
                    <a className="text-link" lang={text.titleLanguage ?? 'und'} href={helpHref(row.id, row.version)}>
                      {text.title ?? legacyText('support.published.article.text.is.unavailable.for', { value1: row.titleKey })}
                    </a>
                  </li>
                );
              })}
            </ul>
          );
        }}
      </Read>
    </div>
  );
}
