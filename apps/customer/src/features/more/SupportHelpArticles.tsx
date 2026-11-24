import { useEffect, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { TextField } from '@intafaced/ui/lit/templates';
import { useResource } from '../../shared/resource';
import { isHiddenPath } from '../../app/feature-registry';
import { useApi, useSession } from '../session';
import { helpHref, kbArticleText } from '../public';
import { t as legacyText } from './copy';
import { KitDetails, type KitAction } from './volt-action';
import { EmptyNote, KitRead } from './volt-parts';
import { deskCopy } from './support-desk-copy';
import { HIDDEN_FEATURE_ARTICLES, KB_CATEGORIES, inKbCategory, kbCategoryCounts, type KbCategory } from './support-desk';
import type { KbArticle } from './support-schemas';
import { SUPPORT_SEARCH_KB } from '@intafaced/contracts/support-customer-procedures';
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
export function SupportHelpArticles({ action, onStartRequest }: { action: KitAction; onStartRequest: () => void }) {
  const copy = deskCopy.useCopy();
  const api = useApi(),
    { userId } = useSession();
  const depositsHidden = isHiddenPath('/uc/recharge');
  // Words carried from the public help search open the desk's search already run.
  const [carried] = useState(() => readDeskSearch(userId));
  const [draft, setDraft] = useState(carried),
    [search, setSearch] = useState(carried),
    [category, setCategory] = useState<KbCategory>('all');
  const kb = useResource((signal) => api.call(SUPPORT_SEARCH_KB, { q: search, limit: 50 }, { signal }), `kb:${search}`);
  useEffect(() => keepDeskSearch(userId, search), [userId, search]);
  return (
    <section className="lt-stack" aria-label={copy.t('tabHelp')}>
      <p className="lt-hint">{copy.t('helpIntro')}</p>
      <form
        className="lt-toolbar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(clip(draft));
          setCategory('all');
        }}
      >
        <TextField label={copy.t('searchHelp')} value={draft} onChange={setDraft} maxLength={200} />
        <Button type="submit" tone="secondary">
          {copy.t('search')}
        </Button>
      </form>
      <KitRead resource={kb.resource} retry={kb.reload}>
        {(rows) => {
          const visible = rows.filter((row) => row.published !== false && !(depositsHidden && HIDDEN_FEATURE_ARTICLES.has(row.id)));
          if (visible.length === 0)
            return (
              <EmptyNote
                title={copy.t(search ? 'noArticlesTitle' : 'noPublishedTitle')}
                action={
                  <Button tone="secondary" onClick={onStartRequest}>
                    {copy.t('startRequestFromHelp')}
                  </Button>
                }
              >
                {copy.t(search ? 'noArticlesBody' : 'noPublishedBody')}
              </EmptyNote>
            );
          const counts = kbCategoryCounts(visible.map((row) => row.id));
          const chips = KB_CATEGORIES.filter((id) => counts[id]);
          const shown = visible.filter((row) => inKbCategory(row.id, category));
          return (
            <>
              <div className="lt-actions" role="group" aria-label={copy.t('categoriesLabel')}>
                {chips.map((id) => (
                  <Button
                    key={id}
                    tone={category === id ? 'primary' : 'secondary'}
                    aria-pressed={category === id}
                    onClick={() => setCategory(id)}
                  >
                    {copy.t(CATEGORY_KEY[id])} <span aria-hidden="true">{counts[id]}</span>
                  </Button>
                ))}
              </div>
              <p className="lt-hint" role="status">
                {shown.length === 1 ? copy.t('articleCountOne') : copy.t('articleCount', { count: shown.length })}
              </p>
              <div className="lt-stack" data-testid="support-articles">
                {shown.map((row) => (
                  <Article key={row.id} row={row} action={action} hiddenIds={depositsHidden ? HIDDEN_FEATURE_ARTICLES : EMPTY} />
                ))}
              </div>
              <Button tone="quiet" onClick={onStartRequest}>
                {copy.t('startRequestFromHelp')}
              </Button>
            </>
          );
        }}
      </KitRead>
    </section>
  );
}

const EMPTY: ReadonlySet<string> = new Set();
function Article({ row, action, hiddenIds }: { row: KbArticle; action: KitAction; hiddenIds: ReadonlySet<string> }) {
  const copy = deskCopy.useCopy();
  const [opened, setOpened] = useState(false);
  const missing = (key: string) => legacyText('support.published.article.text.is.unavailable.for', { value1: key });
  const text = kbArticleText(row);
  const title = text.title ?? missing(row.titleKey);
  const body = text.body;
  return (
    <details onToggle={(event) => event.currentTarget.open && setOpened(true)}>
      <summary lang={text.titleLanguage ?? 'und'}>{title}</summary>
      {body ? <p lang={text.bodyLanguage ?? 'und'}>{body}</p> : <p className="lt-hint">{missing(row.bodyKey)}</p>}
      <p>
        <a className="lt-link lt-link-alone" href={helpHref(row.id, row.version)}>
          {copy.t('readArticle')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
        </a>
      </p>
      <ArticleFeedback row={row} title={title} action={action} />
      {opened && <RelatedArticles id={row.id} hiddenIds={hiddenIds} />}
    </details>
  );
}

/** "Did this answer help?" One answer per account for each version, so a repeat is answered with the first one. */
function ArticleFeedback({ row, title, action }: { row: KbArticle; title: string; action: KitAction }) {
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
        <KitDetails
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
    <div className="lt-actions" role="group" aria-label={copy.t('feedbackQuestion')}>
      <small>{copy.t('feedbackQuestion')}</small>
      <Button tone="secondary" disabled={action.disabled} onClick={() => send(true)}>
        {copy.t('feedbackYes')}
      </Button>
      <Button tone="secondary" disabled={action.disabled} onClick={() => send(false)}>
        {copy.t('feedbackNo')}
      </Button>
      <small className="lt-hint">{copy.t('feedbackOne')}</small>
    </div>
  );
}

/** Published articles that share a topic or tag with this one. Read only when the article is opened. */
function RelatedArticles({ id, hiddenIds }: { id: string; hiddenIds: ReadonlySet<string> }) {
  const copy = deskCopy.useCopy();
  const api = useApi();
  const related = useResource((signal) => readRelated(api, id, signal), `kb-related:${id}`);
  return (
    <div className="lt-stack">
      <h4>{copy.t('relatedHeading')}</h4>
      <KitRead resource={related.resource} retry={related.reload}>
        {(rows) => {
          const visible = rows.filter((row) => row.id !== id && row.published !== false && !hiddenIds.has(row.id));
          return visible.length === 0 ? (
            <p className="lt-hint">{copy.t('relatedNone')}</p>
          ) : (
            <ul>
              {visible.map((row) => {
                const text = kbArticleText(row);
                return (
                  <li key={row.id}>
                    <a className="lt-link lt-link-alone" lang={text.titleLanguage ?? 'und'} href={helpHref(row.id, row.version)}>
                      {text.title ?? legacyText('support.published.article.text.is.unavailable.for', { value1: row.titleKey })}
                    </a>
                  </li>
                );
              })}
            </ul>
          );
        }}
      </KitRead>
    </div>
  );
}
