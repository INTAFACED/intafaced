// volt-room: /help
// volt-room: /helpdetail
import { useEffect, useRef, useState } from 'react';
import { parsesAs, type ApiClient, type ApiResult } from '../../shared/api';
import { SUPPORT_GET_KB, SUPPORT_SEARCH_KB } from '@intafaced/contracts/support-customer-procedures';
import { Button } from '@intafaced/ui/lit';
import { ReadingTemplate, SelectField, TextField, type RoomState } from '@intafaced/ui/lit/templates';
import { useLocation } from '../../app/location';
import { safeReturnTo } from '../../app/navigation';
import { useResource } from '../../shared/resource';
import { useSession } from '../session';
import { helpCopy as copy } from './help-copy';
import { exactHelpArticle, helpHref, helpSelection, helpVersion, helpWindow, missingHelpVersion, type HelpArticle } from './help-guards';
import { ContactSupport } from './help/ContactSupport';
import { HelpFeedback } from './HelpFeedback';
import { HostDispatch } from './HostDispatch';
import { ActionRequired, RequestEntry } from './HelpFrontDoor';
import { helpCentreSwitchedOff, useHelpCentre } from './help-centre';
import { HelpLibraryNav } from './HelpLibrary';
import { kbArticleText } from './kb-text';
import { canonicalUiLocale, uiLocaleDescriptor } from '../../shared/locale';
import { supportKbParagraphs } from '@intafaced/contracts/support-kb-library';
import { FailureNote, Waiting } from '../more';

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
  // A reader's pick holds for the answer it was made on; another answer opens in the reader's own language again.
  const [picked, setPicked] = useState<{ id: string; code: string } | null>(null);
  const helpCentre = useHelpCentre();
  const settings = helpCentre.status === 'ready' ? helpCentre.data : null;
  // The owner's offered languages, compared by canonical code (an owner's `pt-br` is the catalogue's `pt-BR`). None offered
  // (blank) draws no picker: the reader reads in the site language.
  const offered = settings?.languages?.length ? settings.languages.map((tag) => ({ tag, code: canonicalLanguage(tag) })) : null;
  const pickedHere = picked && selection.kind === 'article' && picked.id === selection.id ? picked.code : null;
  const offers = (code: string | null | undefined) => Boolean(code && offered?.some((row) => row.code === code));
  const defaultCode = settings?.defaultLanguage ? canonicalLanguage(settings.defaultLanguage) : null;
  const reading = !offered
    ? null
    : offers(pickedHere)
      ? pickedHere!
      : offers(requestedLocale)
        ? requestedLocale
        : offers(defaultCode)
          ? defaultCode!
          : offered[0]!.code;
  const readingLocale = (selection.kind === 'article' && reading && canonicalUiLocale(reading)) || requestedLocale;
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
        const answer = await captured.actor.client.call(
          SUPPORT_GET_KB,
          { id: selection.id, ...(selection.version === undefined ? {} : { version: selection.version }) },
          { signal: controller.signal, accept: parsesAs(exactHelpArticle(selection)) },
        );
        if (!same(captured)) return;
        setRead(
          answer.ok
            ? { context: captured, status: 'ready', value: { kind: 'article', article: answer.data } }
            : { context: captured, status: 'failed', failure: answer },
        );
      } else {
        const answer = await captured.actor.client.call(
          SUPPORT_SEARCH_KB,
          { q: '', limit },
          { signal: controller.signal, accept: parsesAs(helpWindow(limit)) },
        );
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

  const rendered = (article: HelpArticle) => kbArticleText(article, readingLocale);
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
  /** The language the reader actually sees, when it is not the one they asked for: the body's, or else the title's. */
  const shownInstead = (article: HelpArticle) => {
    if (!reading) return null;
    const text = rendered(article);
    const languages = [text.bodyLanguage, text.titleLanguage].filter((tag): tag is string => Boolean(tag)).map(canonicalLanguage);
    return languages.find((code) => code !== reading) ?? null;
  };
  const loaded = visible?.status === 'ready' && visible.value.kind === 'browse' ? visible.value : null;
  const typed = filterText.trim();
  // The service ranks a search: a labelled answer comes before one that only mentions the words. Answers on this page whose
  // translated text matches follow, so a catalogue answer found by its words in the reader's language is never lost.
  const ranked = useResource(
    (signal): Promise<ApiResult<HelpArticle[]>> =>
      typed && loaded && !switchedOff
        ? actor.client.call(SUPPORT_SEARCH_KB, { q: typed, limit }, { signal, accept: parsesAs(helpWindow(limit)) })
        : Promise.resolve({ ok: true, data: [] }),
    `help-search:${actor.owner ?? 'public'}:${limit}:${typed}:${Boolean(loaded && !switchedOff)}`,
  );
  const textMatches = (article: HelpArticle) => {
    const text = rendered(article);
    return [text.title ?? '', text.body ?? '', article.id]
      .join(' ')
      .toLocaleLowerCase(requestedLocale)
      .includes(typed.toLocaleLowerCase(requestedLocale));
  };
  const rankedRows = ranked.resource.status === 'ready' ? ranked.resource.data : [];
  // Until the ranking answers, no count or "no matches" is said: the labelled answer may only be found by the service.
  const ranking = Boolean(typed) && ranked.resource.status === 'loading';
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
  const instead = article && !switchedOff ? shownInstead(article) : null;
  const titleLanguage =
    article && !switchedOff ? (rendered(article).titleLanguage ?? languageFor('textUnavailable')) : languageFor('title');
  const original = selection.kind === 'article' && (
    <div className="lt-stack" data-testid="help-original">
      <p className="lt-hint">{t('requestedArticle')}</p>
      <p lang="und" className="lt-mono lt-wrap" data-testid="help-private">
        {selection.id}
      </p>
      <p className="lt-hint">
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
    <div className="lt-stack">
      <ContactSupport />
      {/* The deployment's host check sits under the Help room itself, never under each answer. */}
      {!articleRecovery && <HostDispatch />}
      {articleRecovery && (
        <a href="/findPwd" className="lt-link lt-link-alone" data-testid="help-link">
          {t('recovery')}
        </a>
      )}
    </div>
  );
  const retryButton = (
    <Button tone="primary" onClick={() => setRetry((value) => value + 1)}>
      {t('retry')}
    </Button>
  );
  // The room's state: the switch is read first (nothing drawn until it answers), and a switched-off help centre is the
  // template's refusal, with the way to a person still under it.
  const state: RoomState = settingsLoading
    ? { kind: 'loading' }
    : switchedOff
      ? { kind: 'refused', refusal: { variant: 'refused', title: t('switchedOffTitle'), body: t('switchedOffBody') } }
      : { kind: 'ready' };
  const meta = !settingsLoading && !switchedOff && (selection.kind !== 'browse' || article) && (
    <div className="lt-stack">
      {selection.kind !== 'browse' && (
        <a href="/help" className="lt-link lt-link-alone" data-testid="help-link">
          <span className="lt-arrow lt-arrow-back" aria-hidden="true" /> {t('back')}
        </a>
      )}
      {article && (
        <div className="lt-stack" data-testid="help-heading">
          <p className="lt-hint">
            {helpVersion(article) === undefined ? (
              t('publishedAnswer')
            ) : (
              <>
                {t('publishedVersion')} <span lang="zxx">{helpVersion(article)}</span>
              </>
            )}{' '}
          </p>
          {offered && reading && (
            <div className="lt-stack">
              <SelectField
                label={t('articleLanguage')}
                name="help-language"
                value={reading}
                onChange={(code) => setPicked({ id: article.id, code })}
                options={offered.map((row) => ({ value: row.code, label: languageName(row.code, row.code), lang: row.code }))}
              />
              {instead && (
                <p className="lt-hint" role="status" data-testid="help-language-fallback">
                  {t('languageFallback', {
                    wanted: languageName(reading, requestedLocale),
                    shown: languageName(instead, requestedLocale),
                  })}
                </p>
              )}
            </div>
          )}
          {!offered && fallback(article) && <p className="lt-hint">{t('englishFallback')}</p>}
        </div>
      )}
    </div>
  );
  const browse = loaded && (
    <>
      <div className="lt-stack" data-testid="help-list">
        {articles.map((row) => {
          const text = rendered(row);
          return (
            <article data-testid="help__row" className="lt-stack" key={row.id}>
              <h2 lang={text.titleLanguage ?? languageFor('textUnavailable')}>{text.title ?? t('textUnavailable')}</h2>
              <a
                href={helpHref(row.id, helpVersion(row))}
                className="lt-link lt-link-alone"
                data-testid="help-row-open"
                aria-label={`${t('readAnswer')}: ${text.title ?? t('textUnavailable')}`}
              >
                {t('readAnswer')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
              </a>
              <p lang={text.bodyLanguage ?? languageFor('bodyUnavailable')}>{paragraphs(row)[0] ?? t('bodyUnavailable')}</p>
              <p className="lt-hint">
                {helpVersion(row) === undefined ? (
                  t('publishedAnswer')
                ) : (
                  <>
                    {t('publishedVersion')} <span lang="zxx">{helpVersion(row)}</span>
                  </>
                )}
              </p>
              {fallback(row) && <p className="lt-hint">{t('englishFallback')}</p>}
            </article>
          );
        })}
      </div>
      {!articles.length && !ranking && (
        <div className="lt-empty" role="status" data-testid="help-empty">
          <h2 className="lt-empty-title">{t(loaded.articles.length ? 'noMatches' : 'empty')}</h2>
          <p className="lt-empty-body">{t(loaded.articles.length ? 'noMatchesBody' : 'emptyBody')}</p>
          {typed && <RequestEntry query={typed} found={false} contact />}
        </div>
      )}
      {ranking && <Waiting label={t('searching')} />}
      {typed && ranked.resource.status === 'failed' && (
        <p className="lt-hint" role="status" data-testid="help-search-unranked">
          {t('searchUnranked')}
        </p>
      )}
      {typed && !ranking && (
        <p className="lt-hint" role="status">
          <span lang="zxx">{articles.length}</span> {t('matches')}
        </p>
      )}
      {loaded.articles.length === loaded.limit && loaded.limit < 500 && (
        <div className="lt-actions">
          <Button tone="secondary" onClick={() => setWindow({ actor, limit: loaded.limit + 100 })}>
            {t('loadMore')}
          </Button>
        </div>
      )}
      {loaded.articles.length === 500 && <p className="lt-hint">{t('maximumWindow')}</p>}
    </>
  );
  const body = settingsLoading ? null : switchedOff ? null : invalid ? (
    <div className="lt-stack">
      <p>{t('invalidBody')}</p>
      <a href="/help" className="lt-link lt-link-alone" data-testid="help-link">
        {t('browse')}
      </a>
    </div>
  ) : selection.kind === 'browse' ? (
    <div className="lt-stack">
      <ActionRequired />
      <form
        className="lt-stack"
        data-testid="help-search"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted({ actor, text: queryText });
        }}
      >
        <TextField
          label={t('searchLabel')}
          name="help-search"
          placeholder={t('searchPlaceholder')}
          maxLength={200}
          value={queryText}
          onChange={(text) => setQuery({ actor, text })}
        />
        <div className="lt-actions">
          <Button type="submit" tone="primary">
            {t('search')}
          </Button>
        </div>
      </form>
      <div className="lt-stack" data-testid="help-request">
        <RequestEntry query={typed} found={!typed || !loaded || ranking || articles.length > 0} />
      </div>
      <HelpLibraryNav />
      <p className="lt-hint" role="status">
        {loaded ? (
          <>
            <span lang="zxx">{loaded.articles.length}</span> {t('loaded')} · {t('window')} <span lang="zxx">{loaded.limit}</span>
          </>
        ) : (
          t('loadingCatalogue')
        )}
      </p>
      {(!visible || visible.status === 'loading') && <Waiting label={t('loadingCatalogue')} />}
      {visible?.status === 'failed' && (
        <div className="lt-stack">
          <div lang="und">
            <FailureNote result={visible.failure} />
          </div>
          <p className="lt-hint">{t('retryCatalogue')}</p>
          <div className="lt-actions">{retryButton}</div>
        </div>
      )}
      {browse}
    </div>
  ) : (
    <div className="lt-stack">
      {!article && original}
      {(!visible || visible.status === 'loading') && <Waiting label={t('loadingArticle')} />}
      {article && (
        <>
          <article data-testid="help__body" className="lt-stack" lang={rendered(article).bodyLanguage ?? languageFor('bodyUnavailable')}>
            {rendered(article).body ? (
              paragraphs(article).map((paragraph, index) => <p key={index}>{paragraph}</p>)
            ) : (
              <p>{t('bodyUnavailable')}</p>
            )}
          </article>
          {selection.version !== undefined && (
            <div className="lt-stack">
              <a href={helpHref(selection.id)} className="lt-link lt-link-alone" data-testid="help-link">
                {t('readLatest')}
              </a>
              <p className="lt-hint">{t('latestBoundary')}</p>
            </div>
          )}
          {selection.version === undefined && helpVersion(article) !== undefined && (
            <HelpFeedback key={`${article.id}:${helpVersion(article)}`} articleId={article.id} version={helpVersion(article)!} />
          )}
        </>
      )}
      {missing && (
        <>
          <p className="lt-hint">{t('versionMissingBody')}</p>
          <section className="lt-stack">
            <h2>{t('latestTitle')}</h2>
            <p className="lt-hint">{t('latestBody')}</p>
            <div className="lt-actions">
              <a href={helpHref(selection.id)} className="lt-button lt-button-primary">
                {t('readLatestShort')}
              </a>
            </div>
          </section>
          <p className="lt-hint">{t('resultBoundary')}</p>
        </>
      )}
      {visible?.status === 'failed' && !missing && (
        <div className="lt-stack">
          <div lang="und">
            <FailureNote result={visible.failure} />
          </div>
          <p className="lt-hint">{t('retryArticle')}</p>
          <div className="lt-actions">{retryButton}</div>
        </div>
      )}
      {readyNull && (
        <>
          <p className="lt-hint">{t('notReturnedBody')}</p>
          {!session && (
            <section className="lt-stack" role="status" data-testid="help-sign-in">
              <h2>{t('signInTitle')}</h2>
              <p className="lt-hint">{t('signInBody')}</p>
              <div className="lt-actions">
                <a
                  className="lt-button lt-button-primary"
                  href={`/login?redirect=${encodeURIComponent(safeReturnTo(location.pathname + location.search))}`}
                >
                  {t('signInAction')}
                </a>
              </div>
            </section>
          )}
          {selection.version !== undefined && (
            <a href={helpHref(selection.id)} className="lt-link lt-link-alone" data-testid="help-link">
              {t('readLatest')}
            </a>
          )}
        </>
      )}
    </div>
  );
  // Where a person is reached from: under every answer and refusal, the contact card and the hosts' check; under a
  // switched-off help centre the request entry first; none while the switch or the answer is still on its way.
  const contact = settingsLoading ? undefined : switchedOff ? (
    <div className="lt-stack">
      <div className="lt-stack" data-testid="help-request">
        <RequestEntry />
      </div>
      {support()}
    </div>
  ) : invalid || selection.kind === 'browse' ? (
    support()
  ) : article ? (
    support(true)
  ) : missing ? (
    <ContactSupport />
  ) : visible?.status === 'failed' || readyNull ? (
    support()
  ) : undefined;
  return (
    <div data-room="help" data-testid="help" lang={languageFor('title')}>
      <div data-testid={switchedOff ? 'help-centre-off' : undefined}>
        <ReadingTemplate
          title={title}
          titleLang={titleLanguage}
          titleRef={heading}
          description={selection.kind === 'browse' && !switchedOff && !settingsLoading ? t('description') : undefined}
          state={state}
          meta={meta || undefined}
          body={body}
          contact={contact}
        />
      </div>
    </div>
  );
}

/** A tag in the catalogue's canonical spelling where the catalogue knows it (`pt-br` → `pt-BR`), else as the owner wrote it. */
function canonicalLanguage(tag: string): string {
  return canonicalUiLocale(tag) ?? tag;
}

/** A language by its name, written in the given language; the app's own name for a catalogue language, else the tag. */
function languageName(code: string, inLanguage: string): string {
  const known = canonicalUiLocale(code);
  if (known && known === inLanguage) return uiLocaleDescriptor(known).nativeName;
  try {
    return new Intl.DisplayNames([inLanguage], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}
