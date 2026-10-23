import { useEffect, useRef, useState } from 'react';
import type { ApiClient, ApiResult } from '../../shared/api';
import { Button, Field, Failure, Loading } from '../../shared/ui';
import { publishedCopy, publishedLanguageFor } from '../../shared/copy';
import { useLocation } from '../../app/location';
import { useResource } from '../../shared/resource';
import { useSession } from '../session/session';
import { helpCopy as copy } from './help-copy';
import { exactHelpArticle, helpHref, helpSelection, helpVersion, helpWindow, missingHelpVersion, type HelpArticle } from './help-guards';
import { ContactSupport } from './ContactSupport';
import { ActionRequired, RequestEntry } from './HelpFrontDoor';
import { helpCentreSwitchedOff, useHelpCentre } from './help-centre';
import { HelpLibraryNav } from './HelpLibrary';
import { supportKbParagraphs } from '@intafaced/contracts/support-kb-library';
import './help.css';
import '../more/support-desk.css';

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
  const helpCentre = useHelpCentre();
  const limit = window.actor === actor ? window.limit : 100;
  const queryText = query.actor === actor ? query.text : '';
  const filterText = submitted.actor === actor ? submitted.text : '';
  const visible = read?.context === context && location.href === context.url ? read : null;
  const switchedOff = helpCentreSwitchedOff(helpCentre, visible?.status === 'failed' ? visible.failure : null);
  // The switch is read before any answer is drawn, so a switched-off help centre never flashes its answers first.
  const settingsLoading = helpCentre.status === 'loading';
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

  // An answer typed in the desk carries its own text in its own language; a catalogue-keyed one is looked up.
  const rendered = (article: HelpArticle) =>
    article.title && article.body
      ? { title: article.title, body: article.body, titleLanguage: article.language, bodyLanguage: article.language, stored: true }
      : {
          title: publishedCopy(article.titleKey, requestedLocale),
          body: publishedCopy(article.bodyKey, requestedLocale),
          titleLanguage: publishedLanguageFor(article.titleKey, requestedLocale),
          bodyLanguage: publishedLanguageFor(article.bodyKey, requestedLocale),
          stored: false,
        };
  /** Paragraphs as the reader sees them: a stored body by its blank lines, a catalogue body by its sentences. */
  const paragraphs = (article: HelpArticle) => {
    const text = rendered(article);
    if (!text.body) return [];
    return text.stored ? supportKbParagraphs(text.body) : text.body.split(/(?<=[.!?])\s+/);
  };
  const fallback = (article: HelpArticle) => {
    const text = rendered(article);
    if (text.stored) return false;
    return Boolean((text.title && text.titleLanguage !== requestedLocale) || (text.body && text.bodyLanguage !== requestedLocale));
  };
  const loaded = visible?.status === 'ready' && visible.value.kind === 'browse' ? visible.value : null;
  const typed = filterText.trim();
  // The service ranks a search: a labelled answer comes before one that only mentions the words. Answers on this page whose
  // translated text matches follow, so a catalogue answer found by its words in the reader's language is never lost.
  const ranked = useResource(
    (signal): Promise<ApiResult<HelpArticle[]>> =>
      typed
        ? actor.client.query('support', 'searchKb', { q: typed, limit }, helpWindow(limit), { signal })
        : Promise.resolve({ ok: true, data: [] }),
    `help-search:${actor.owner ?? 'public'}:${limit}:${typed}`,
  );
  const textMatches = (article: HelpArticle) => {
    const text = rendered(article);
    return [text.title ?? '', text.body ?? '', article.id]
      .join(' ')
      .toLocaleLowerCase(requestedLocale)
      .includes(typed.toLocaleLowerCase(requestedLocale));
  };
  const rankedRows = ranked.resource.status === 'ready' ? ranked.resource.data : [];
  const rankedIds = new Set(rankedRows.map((row) => row.id));
  const articles = !loaded
    ? []
    : !typed
      ? loaded.articles
      : [...rankedRows, ...loaded.articles.filter((article) => !rankedIds.has(article.id) && textMatches(article))];
  const article = visible?.status === 'ready' && visible.value.kind === 'article' ? visible.value.article : null;
  const missing =
    selection.kind === 'article' && selection.version !== undefined && visible?.status === 'failed' && missingHelpVersion(visible.failure);
  const invalid = selection.kind === 'invalid';
  const readyNull = visible?.status === 'ready' && visible.value.kind === 'article' && visible.value.article === null;
  const title = switchedOff
    ? t('title')
    : invalid
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
  const titleLanguage =
    article && !switchedOff ? (rendered(article).titleLanguage ?? languageFor('textUnavailable')) : languageFor('title');
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
      {selection.kind !== 'browse' && !switchedOff && (
        <a href="/help" className="help__link text-link">
          {t('back')}
        </a>
      )}
      <header className="help__heading">
        <h1 ref={heading} tabIndex={-1} lang={titleLanguage}>
          {title}
        </h1>
        {selection.kind === 'browse' && !switchedOff && <p className="muted">{t('description')}</p>}
        {article && !switchedOff && (
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
        {article && !switchedOff && fallback(article) && <p className="help__caption muted">{t('englishFallback')}</p>}
      </header>
      {settingsLoading ? (
        <Loading label={t('loadingCatalogue')} />
      ) : switchedOff ? (
        <>
          <section className="help__card help__measure" role="status" data-testid="help-centre-off">
            <h2 lang={languageFor('switchedOffTitle')}>{t('switchedOffTitle')}</h2>
            <p className="muted" lang={languageFor('switchedOffBody')}>
              {t('switchedOffBody')}
            </p>
          </section>
          <div className="help__request">
            <RequestEntry />
          </div>
          {support()}
        </>
      ) : invalid ? (
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
            <RequestEntry query={queryText} />
          </div>
          <HelpLibraryNav />
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
                            {paragraphs(row)[0] ?? t('bodyUnavailable')}
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
                  {typed && ranked.resource.status === 'loading' && <Loading label={t('searching')} />}
                  {typed && ranked.resource.status === 'failed' && (
                    <p className="help__caption muted" role="status" data-testid="help-search-unranked">
                      {t('searchUnranked')}
                    </p>
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
                  paragraphs(article).map((paragraph, index) => <p key={index}>{paragraph}</p>)
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
