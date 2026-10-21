import { useEffect, useRef, useState } from 'react';
import type { ApiClient, ApiResult } from '../../shared/api';
import { Button, Field, Failure, Loading } from '../../shared/ui';
import { publishedCopy, publishedLanguageFor } from '../../shared/copy';
import { useLocation } from '../../app/location';
import { useSession } from '../session/session';
import { helpCopy as copy } from './help-copy';
import { exactHelpArticle, helpHref, helpSelection, helpVersion, helpWindow, missingHelpVersion, type HelpArticle } from './help-guards';
import { ContactSupport } from './ContactSupport';
import { ActionRequired, RequestEntry } from './HelpFrontDoor';
import { KB_CATEGORIES, inKbCategory, kbCategoryCounts, type KbCategory } from '../more/support-desk';
import { deskCopy } from '../more/support-desk-copy';
import './help.css';
import '../more/support-desk.css';

const CATEGORY_KEY = {
  all: 'categoryAll',
  account: 'categoryAccount',
  security: 'categorySecurity',
  trading: 'categoryTrading',
  money: 'categoryMoney',
  general: 'categoryGeneral',
} as const;

type Actor = { client: ApiClient; owner: string | null; token: string | null };
type Context = { actor: Actor; url: string };
type FailureResult = Extract<ApiResult<unknown>, { ok: false }>;
type Read = { context: Context } & (
  | { status: 'loading' | 'invalid' }
  | { status: 'failed'; failure: FailureResult }
  | {
      status: 'ready';
      value: { kind: 'browse'; articles: HelpArticle[]; limit: number } | { kind: 'article'; article: HelpArticle | null };
    }
);

export function PublicHelp() {
  useLocation();
  const { api, userId, session } = useSession();
  const { t, requestedLocale, languageFor } = copy.useCopy();
  const token = session?.accessToken ?? null;
  const actorRef = useRef<Actor>({ client: api, owner: userId, token });
  if (actorRef.current.client !== api || actorRef.current.owner !== userId || actorRef.current.token !== token)
    actorRef.current = { client: api, owner: userId, token };
  const actor = actorRef.current;
  const contextRef = useRef<Context>({ actor, url: location.href });
  if (contextRef.current.actor !== actor || contextRef.current.url !== location.href) contextRef.current = { actor, url: location.href };
  const context = contextRef.current;
  const selection = helpSelection(location.pathname, location.search);
  const mounted = useRef(true),
    heading = useRef<HTMLHeadingElement | null>(null);
  const [query, setQuery] = useState({ actor, text: '' }),
    [submitted, setSubmitted] = useState({ actor, text: '' });
  const [window, setWindow] = useState({ actor, limit: 100 }),
    [retry, setRetry] = useState(0);
  const [read, setRead] = useState<Read | null>(null);
  const [category, setCategory] = useState<KbCategory>('all');
  const desk = deskCopy.useCopy();
  const limit = window.actor === actor ? window.limit : 100;
  const queryText = query.actor === actor ? query.text : '';
  const filterText = submitted.actor === actor ? submitted.text : '';
  const visible = read?.context === context && location.href === context.url ? read : null;
  const same = (captured: Context) => mounted.current && contextRef.current === captured && location.href === captured.url;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setQuery({ actor, text: '' });
    setSubmitted({ actor, text: '' });
    setWindow({ actor, limit: 100 });
  }, [actor]);
  useEffect(() => {
    const captured = context,
      controller = new AbortController();
    setRead({ context: captured, status: selection.kind === 'invalid' ? 'invalid' : 'loading' });
    async function load() {
      if (!same(captured) || selection.kind === 'invalid') return;
      if (selection.kind === 'article') {
        const answer = await captured.actor.client.query(
          'support',
          'getKb',
          { id: selection.id, ...(selection.version === undefined ? {} : { version: selection.version }) },
          exactHelpArticle(selection),
          { signal: controller.signal },
        );
        if (!same(captured)) return;
        setRead(
          answer.ok
            ? { context: captured, status: 'ready', value: { kind: 'article', article: answer.data } }
            : { context: captured, status: 'failed', failure: answer },
        );
      } else {
        const answer = await captured.actor.client.query('support', 'searchKb', { q: '', limit }, helpWindow(limit), {
          signal: controller.signal,
        });
        if (!same(captured)) return;
        setRead(
          answer.ok
            ? { context: captured, status: 'ready', value: { kind: 'browse', articles: answer.data, limit } }
            : { context: captured, status: 'failed', failure: answer },
        );
      }
    }
    void load();
    return () => controller.abort();
  }, [context, selection.kind === 'browse' ? limit : 0, retry]);
  useEffect(() => {
    if (visible && (selection.kind !== 'browse' || visible.status === 'failed')) heading.current?.focus();
  }, [context, read]);

  const rendered = (article: HelpArticle) => ({
    title: publishedCopy(article.titleKey, requestedLocale),
    body: publishedCopy(article.bodyKey, requestedLocale),
    titleLanguage: publishedLanguageFor(article.titleKey, requestedLocale),
    bodyLanguage: publishedLanguageFor(article.bodyKey, requestedLocale),
  });
  const fallback = (article: HelpArticle) => {
    const text = rendered(article);
    return Boolean((text.title && text.titleLanguage !== requestedLocale) || (text.body && text.bodyLanguage !== requestedLocale));
  };
  const loaded = visible?.status === 'ready' && visible.value.kind === 'browse' ? visible.value : null;
  const articles =
    loaded?.articles.filter((article) => {
      if (!inKbCategory(article.id, category)) return false;
      const text = rendered(article);
      return [text.title ?? '', text.body ?? '', article.id]
        .join(' ')
        .toLocaleLowerCase(requestedLocale)
        .includes(filterText.trim().toLocaleLowerCase(requestedLocale));
    }) ?? [];
  const article = visible?.status === 'ready' && visible.value.kind === 'article' ? visible.value.article : null;
  const missing =
    selection.kind === 'article' && selection.version !== undefined && visible?.status === 'failed' && missingHelpVersion(visible.failure);
  const invalid = selection.kind === 'invalid';
  const readyNull = visible?.status === 'ready' && visible.value.kind === 'article' && visible.value.article === null;
  const title = invalid
    ? t('invalid')
    : selection.kind === 'browse'
      ? t('title')
      : article
        ? (rendered(article).title ?? t('textUnavailable'))
        : missing
          ? t('versionMissing')
          : readyNull
            ? t('notReturned')
            : visible?.status === 'failed'
              ? t('unavailable')
              : t('loadingArticle');
  const titleLanguage = article ? (rendered(article).titleLanguage ?? languageFor('textUnavailable')) : languageFor('title');
  const original = selection.kind === 'article' && (
    <div className="help__original">
      <p className="muted">{t('requestedArticle')}</p>
      <p lang="und" className="help__private">
        {selection.id}
      </p>
      <p className="muted">
        {selection.version === undefined ? (
          t('latestRequested')
        ) : (
          <>
            {t('requestedVersion')} <span lang="zxx">{selection.version}</span>
          </>
        )}
      </p>
    </div>
  );
  const support = (articleRecovery = false) => (
    <div className="help__side">
      <ContactSupport />
      {articleRecovery && (
        <a href="/findPwd" className="help__link text-link">
          {t('recovery')}
        </a>
      )}
    </div>
  );
  return (
    <div className="help" lang={languageFor('title')}>
      {selection.kind !== 'browse' && (
        <a href="/help" className="help__link text-link">
          {t('back')}
        </a>
      )}
      <header className="help__heading">
        <h1 ref={heading} tabIndex={-1} lang={titleLanguage}>
          {title}
        </h1>
        {selection.kind === 'browse' && <p className="muted">{t('description')}</p>}
        {article && (
          <p className="help__caption muted">
            {helpVersion(article) === undefined ? (
              t('publishedAnswer')
            ) : (
              <>
                {t('publishedVersion')} <span lang="zxx">{helpVersion(article)}</span>
              </>
            )}{' '}
            ·{' '}
            <span lang="und" className="help__private">
              {article.id}
            </span>
          </p>
        )}
        {article && fallback(article) && <p className="help__caption muted">{t('englishFallback')}</p>}
      </header>
      {invalid ? (
        <>
          <section className="help__card help__measure">
            <p>{t('invalidBody')}</p>
            <a href="/help" className="help__link text-link">
              {t('browse')}
            </a>
          </section>
          {support()}
        </>
      ) : selection.kind === 'browse' ? (
        <>
          <ActionRequired />
          <form
            className="help__search"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted({ actor, text: queryText });
            }}
          >
            <Field
              label={t('searchLabel')}
              name="help-search"
              placeholder={t('searchPlaceholder')}
              maxLength={200}
              value={queryText}
              onChange={(event) => setQuery({ actor, text: event.target.value })}
            />
            <Button type="submit">{t('search')}</Button>
          </form>
          <div className="help__request">
            <RequestEntry />
          </div>
          <p className="help__caption muted" role="status">
            {loaded ? (
              <>
                <span lang="zxx">{loaded.articles.length}</span> {t('loaded')} · {t('window')} <span lang="zxx">{loaded.limit}</span>
              </>
            ) : (
              t('loadingCatalogue')
            )}
          </p>
          <div className="help__browse">
            <div>
              {(!visible || visible.status === 'loading') && <Loading label={t('loadingCatalogue')} />}
              {visible?.status === 'failed' && (
                <section className="help__card">
                  <div lang="und">
                    <Failure result={visible.failure} />
                  </div>
                  <p className="muted">{t('retryCatalogue')}</p>
                  <Button onClick={() => setRetry((value) => value + 1)}>{t('retry')}</Button>
                </section>
              )}
              {loaded && (
                <>
                  <div className="support-chips" role="group" aria-label={desk.t('categoriesLabel')}>
                    {KB_CATEGORIES.filter((id) => kbCategoryCounts(loaded.articles.map((row) => row.id))[id]).map((id) => (
                      <button
                        type="button"
                        key={id}
                        className={`support-chip${category === id ? ' support-chip--on' : ''}`}
                        aria-pressed={category === id}
                        onClick={() => setCategory(id)}
                      >
                        {desk.t(CATEGORY_KEY[id])}{' '}
                        <span aria-hidden="true">{kbCategoryCounts(loaded.articles.map((row) => row.id))[id]}</span>
                      </button>
                    ))}
                  </div>
                  <div className="help__list">
                    {articles.map((row) => {
                      const text = rendered(row);
                      return (
                        <article className="help__row" key={row.id}>
                          <div className="help__row-heading">
                            <h2 lang={text.titleLanguage ?? languageFor('textUnavailable')}>{text.title ?? t('textUnavailable')}</h2>
                            <a
                              href={helpHref(row.id, helpVersion(row))}
                              className="help__link text-link"
                              aria-label={`${t('readAnswer')}: ${text.title ?? t('textUnavailable')}`}
                            >
                              {t('readAnswer')} →
                            </a>
                          </div>
                          <p className="muted" lang={text.bodyLanguage ?? languageFor('bodyUnavailable')}>
                            {text.body?.split(/(?<=[.!?])\s+/)[0] ?? t('bodyUnavailable')}
                          </p>
                          <p className="help__caption muted">
                            {helpVersion(row) === undefined ? (
                              t('publishedAnswer')
                            ) : (
                              <>
                                {t('publishedVersion')} <span lang="zxx">{helpVersion(row)}</span>
                              </>
                            )}
                          </p>
                          {fallback(row) && <p className="help__caption muted">{t('englishFallback')}</p>}
                        </article>
                      );
                    })}
                  </div>
                  {!articles.length && (
                    <div className="help__empty" role="status">
                      <h2>{t(loaded.articles.length ? 'noMatches' : 'empty')}</h2>
                      <p className="muted">{t(loaded.articles.length ? 'noMatchesBody' : 'emptyBody')}</p>
                    </div>
                  )}
                  {filterText && (
                    <p className="help__caption muted" role="status">
                      <span lang="zxx">{articles.length}</span> {t('matches')}
                    </p>
                  )}
                  {loaded.articles.length === loaded.limit && loaded.limit < 500 && (
                    <Button variant="secondary" onClick={() => setWindow({ actor, limit: loaded.limit + 100 })}>
                      {t('loadMore')}
                    </Button>
                  )}
                  {loaded.articles.length === 500 && <p className="help__caption muted">{t('maximumWindow')}</p>}
                </>
              )}
            </div>
            {support()}
          </div>
        </>
      ) : (
        <>
          {!article && original}
          {(!visible || visible.status === 'loading') && <Loading label={t('loadingArticle')} />}
          {article && (
            <>
              <article className="help__body help__measure" lang={rendered(article).bodyLanguage ?? languageFor('bodyUnavailable')}>
                {rendered(article).body ? (
                  rendered(article)
                    .body!.split(/(?<=[.!?])\s+/)
                    .map((paragraph, index) => <p key={index}>{paragraph}</p>)
                ) : (
                  <p>{t('bodyUnavailable')}</p>
                )}
              </article>
              {selection.version !== undefined && (
                <div className="help__measure help__latest">
                  <a href={helpHref(selection.id)} className="help__link text-link">
                    {t('readLatest')}
                  </a>
                  <p className="help__caption muted">{t('latestBoundary')}</p>
                </div>
              )}
              {support(true)}
            </>
          )}
          {missing && (
            <>
              <p className="muted help__measure">{t('versionMissingBody')}</p>
              <section className="help__card help__measure">
                <h2>{t('latestTitle')}</h2>
                <p className="muted">{t('latestBody')}</p>
                <a href={helpHref(selection.id)} className="button button--primary">
                  {t('readLatestShort')}
                </a>
              </section>
              <ContactSupport />
              <p className="help__caption muted">{t('resultBoundary')}</p>
            </>
          )}
          {visible?.status === 'failed' && !missing && (
            <>
              <section className="help__card help__measure">
                <div lang="und">
                  <Failure result={visible.failure} />
                </div>
                <p className="muted">{t('retryArticle')}</p>
                <Button onClick={() => setRetry((value) => value + 1)}>{t('retry')}</Button>
              </section>
              {support()}
            </>
          )}
          {readyNull && (
            <>
              <p className="muted help__measure">{t('notReturnedBody')}</p>
              {!session && (
                <section className="help__card help__measure" role="status" data-testid="help-sign-in">
                  <h2>{t('signInTitle')}</h2>
                  <p className="muted">{t('signInBody')}</p>
                  <a className="button button--primary" href={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`}>
                    {t('signInAction')}
                  </a>
                </section>
              )}
              {selection.version !== undefined && (
                <a href={helpHref(selection.id)} className="help__link text-link">
                  {t('readLatest')}
                </a>
              )}
              {support()}
            </>
          )}
        </>
      )}
    </div>
  );
}
