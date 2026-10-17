import { useState } from 'react';
import { z } from 'zod';
import { publishedCopy, publishedLanguageFor } from '../../shared/copy';
import { useResource } from '../../shared/resource';
import { Button, EmptyState, Field } from '../../shared/ui';
import { isHiddenPath } from '../../app/feature-registry';
import { useApi } from '../session/session';
import { helpHref } from '../public/help-guards';
import { t as legacyText } from './copy';
import { Read } from './common';
import { deskCopy } from './support-desk-copy';
import { KB_CATEGORIES, inKbCategory, kbCategoryCounts, type KbCategory } from './support-desk';
import { kbSchema, type KbArticle } from './support-schemas';

/** Help articles that describe features this release does not offer (Deposits and withdrawals, Paper vs live). */
const HIDDEN_FEATURE_ARTICLES: ReadonlySet<string> = new Set(['kb-deposit-withdraw-honest', 'kb-paper-vs-live']);

const CATEGORY_KEY = {
  all: 'categoryAll',
  account: 'categoryAccount',
  security: 'categorySecurity',
  trading: 'categoryTrading',
  money: 'categoryMoney',
  general: 'categoryGeneral',
} as const satisfies Record<KbCategory, Parameters<typeof deskCopy.t>[0]>;

/** The published help library: server search, topic chips, the full text of each answer, and a link to its own page. */
export function SupportHelpArticles({ onStartRequest }: { onStartRequest: () => void }) {
  const copy = deskCopy.useCopy();
  const api = useApi();
  const depositsHidden = isHiddenPath('/uc/recharge');
  const [draft, setDraft] = useState(''),
    [search, setSearch] = useState(''),
    [category, setCategory] = useState<KbCategory>('all');
  const kb = useResource(
    (signal) => api.query('support', 'searchKb', { q: search, limit: 50 }, z.array(kbSchema), { signal }),
    `kb:${search}`,
  );
  return (
    <section className="support-pane" aria-label={copy.t('tabHelp')}>
      <p className="muted">{copy.t('helpIntro')}</p>
      <form
        className="more-inline"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(draft);
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
              <div className="more-articles">
                {shown.map((row) => (
                  <Article key={row.id} row={row} />
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

function Article({ row }: { row: KbArticle }) {
  const copy = deskCopy.useCopy();
  const missing = (key: string) => legacyText('support.published.article.text.is.unavailable.for', { value1: key });
  const title = publishedCopy(row.titleKey) ?? missing(row.titleKey);
  const body = publishedCopy(row.bodyKey);
  return (
    <details>
      <summary lang={publishedLanguageFor(row.titleKey) ?? 'und'}>{title}</summary>
      {body ? <p lang={publishedLanguageFor(row.bodyKey) ?? 'und'}>{body}</p> : <p className="muted">{missing(row.bodyKey)}</p>}
      <a className="text-link" href={helpHref(row.id, row.version)}>
        {copy.t('readArticle')} →
      </a>
    </details>
  );
}
