import { useMemo, useState, type FormEvent, type JSX } from 'react';
import { StateBlock } from '@intafaced/ui';
import { useSession } from '../session/session';
import { developersCopy } from './developers-copy';
import { liveCopy } from './developers-live-copy';
import { hostsView, readDeveloperHosts, readRegionalRule, regionalRuleView } from './developers-values';
import { useRead } from './use-read';
import { createDocsSearch } from './developers-search';
import { ConnectivityPage, DataTermsPage, OpenApiPage, PermissionsPage, QuickstartPage, ReferencePage, RestPage } from './DocsPages';
import {
  AUDIENCES,
  SECTIONS,
  developersRoute,
  hostRows,
  hostTable,
  sectionById,
  type Audience,
  type PageSectionId,
  type Section,
} from './developers-model';
import { ChangelogPage, UpcomingPage } from './ChangelogPages';
import { StatusPage } from './StatusPage';
import { AppsRoom } from './apps/AppsRoom';
import '../public/public-pages.css';

const key = (id: string) => id.replace(/-/g, '_');
type SectionKey = Extract<Parameters<ReturnType<typeof developersCopy.useCopy>['t']>[0], `section_${string}`>;
const sectionKey = (id: string) => `section_${key(id)}` as SectionKey;

/** One page per section the model marks `page: true`: a section id without a component here does not compile. */
const PAGES: Record<PageSectionId, (props: { title: string }) => JSX.Element> = {
  permissions: PermissionsPage,
  rest: RestPage,
  reference: ReferencePage,
  changelog: () => <ChangelogPage />,
  'data-terms': DataTermsPage,
  connectivity: ConnectivityPage,
  quickstart: QuickstartPage,
  openapi: OpenApiPage,
  status: () => <StatusPage />,
};

/** /developers and the pages under it: the portal home, the base-address table and one page per section. Public: no sign-in needed. */
export function DevelopersRoutes({ path }: { path: string }) {
  const route = developersRoute(path);
  if (route.kind === 'hosts') return <Hosts />;
  if (route.kind === 'status') return <StatusPage />;
  if (route.kind === 'changelog') return <ChangelogPage />;
  if (route.kind === 'upcoming') return <UpcomingPage />;
  if (route.kind === 'apps') return <AppsRoom />;
  if (route.kind === 'errors-auth') return <ErrorsAuth />;
  if (route.kind === 'section') return <SectionPage id={route.id} />;
  if (route.kind === 'unknown' && path.split(/[?#]/)[0]!.replace(/\/+$/, '') !== '/developers') return <Unknown />;
  return <Home />;
}

function Home() {
  const { t } = developersCopy.useCopy();
  return (
    <div className="pub-page" data-testid="developers-home">
      <header className="pub-heading">
        <h1>{t('title')}</h1>
        <p className="muted">{t('lead')}</p>
      </header>
      <section className="pub-card" aria-labelledby="dev-access">
        <h2 id="dev-access">{t('accessTitle')}</h2>
        <p>{t('accessBody')}</p>
      </section>
      <DocsSearch />
      <section className="pub-card" aria-labelledby="dev-hosts">
        <h2 id="dev-hosts">{t('hostsTitle')}</h2>
        <p>{t('hostsLead')}</p>
        <a className="text-link" href="/developers/hosts">
          {t('hostsOpen')} →
        </a>
      </section>
      {AUDIENCES.map((audience) => (
        <section className="pub-card" key={audience} aria-labelledby={`dev-${audience}`}>
          <h2 id={`dev-${audience}`}>{t(`audience_${audience}` as const)}</h2>
          <p className="muted">{t(`audience_${audience}_note` as const)}</p>
          <p data-testid="developers-access">{t(`access_${audience}` as const)}</p>
          <ul>
            {SECTIONS.filter((section) => section.audience === audience).map((section) => (
              <li key={section.id}>
                <a className="text-link" href={`/developers/${section.id}`}>
                  {t(sectionKey(section.id))}
                </a>{' '}
                <span className="muted">{sectionState(section, t)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section className="pub-card" aria-labelledby="dev-merchant">
        <h2 id="dev-merchant">{t('merchantTitle')}</h2>
        <p>{t('merchantBody')}</p>
        <a className="text-link" href="/pay/developer">
          {t('merchantOpen')} →
        </a>
      </section>
    </div>
  );
}

function Hosts() {
  const { t } = developersCopy.useCopy();
  const { t: live } = liveCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => readDeveloperHosts(api, signal), [api]);
  const view = hostsView(read);
  return (
    <div className="pub-page" data-testid="developers-hosts">
      <header className="pub-heading">
        <h1>{t('hostsTitle')}</h1>
        <p className="muted">{t('hostsPageLead')}</p>
      </header>
      <section className="pub-card">
        {view.kind === 'loading' ? (
          <StateBlock kind="loading" rows={9} rowHeight={32} label={live('loading')} />
        ) : view.kind === 'failed' ? (
          <StateBlock kind="error" title={live('loadFailed')} onRetry={reload} retryLabel={live('tryAgain')} />
        ) : (
          <>
            {view.unsetCode ? (
              <p className="pub-notice" role="status" data-testid="developers-hosts-unset" data-code={view.unsetCode}>
                {t('hostsUnpublished')}
              </p>
            ) : null}
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('colProtocol')}</th>
                  <th scope="col">{t('colEnvironment')}</th>
                  <th scope="col">{t('colHost')}</th>
                </tr>
              </thead>
              <tbody>
                {hostRows(hostTable(view.read)).map((row) => (
                  <tr key={`${row.protocol}:${row.environment}`} data-host-state={row.cell.state}>
                    <td>{t(`protocol_${row.protocol}` as const)}</td>
                    <td>{t(`environment_${row.environment}` as const)}</td>
                    <td>{row.cell.state === 'set' ? <code>{row.cell.host}</code> : t('hostUnset')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <RegionalRule />
        <a className="text-link" href="/developers">
          ← {t('hostsBack')}
        </a>
      </section>
    </div>
  );
}

/** The owner's rule for the regional hosts, read from svc-trade; until it is published the page says it waits for the owner. */
function RegionalRule() {
  const { t } = developersCopy.useCopy();
  const { t: live } = liveCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => readRegionalRule(api, signal), [api]);
  const view = regionalRuleView(read);
  if (view.kind === 'loading') return <StateBlock kind="loading" rows={1} rowHeight={24} label={live('loading')} />;
  if (view.kind === 'failed') return <StateBlock kind="error" title={live('loadFailed')} onRetry={reload} retryLabel={live('tryAgain')} />;
  return view.kind === 'set' ? (
    <p data-testid="developers-regional-rule" data-rule-state="set">
      {view.rule}
    </p>
  ) : (
    <p className="muted" role="status" data-testid="developers-regional-rule" data-rule-state="unset" data-code={view.code}>
      {t('hostsRegional')}
    </p>
  );
}

function SectionPage({ id }: { id: string }) {
  const { t } = developersCopy.useCopy();
  const section = sectionById(id)!;
  const title = t(sectionKey(id));
  if (section.page) {
    const Written = PAGES[section.id];
    return <Written title={title} />;
  }
  const audience: Audience = section.audience;
  return (
    <div className="pub-page" data-testid={`developers-${id}`}>
      <header className="pub-heading">
        <h1>{title}</h1>
        <p className="muted">
          {t('sectionFor')} {t(`audience_${audience}` as const)}
        </p>
      </header>
      <section className="pub-notice" role="status">
        {section.published ? (
          <a className="button button--primary" href={section.published.href}>
            {t('sectionOpenPublished')} ↗
          </a>
        ) : (
          <p>{section.waitsFor ? t('waitsForBody', { slice: section.waitsFor }) : t('unpublished')}</p>
        )}
      </section>
      <a className="text-link" href="/developers">
        ← {t('back')}
      </a>
    </div>
  );
}

type PortalCopy = ReturnType<typeof developersCopy.useCopy>['t'];

function sectionState(section: Section, t: PortalCopy): string {
  if (section.page) return t('pageHere');
  if (section.published) return t('published');
  return section.waitsFor ? t('waitsFor', { slice: section.waitsFor }) : t('unpublished');
}

/** Searches the portal's own page titles and the routes the reference lists; nothing leaves the browser. */
function DocsSearch() {
  const { t, requestedLocale } = developersCopy.useCopy();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setQuery(draft.trim());
  };
  // One index per language; `t` is rebuilt every render, the language is what really changes it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const search = useMemo(() => createDocsSearch((id) => t(sectionKey(id)), t('hostsTitle')), [requestedLocale]);
  const results = query ? search(query) : [];
  return (
    <section className="pub-card" aria-labelledby="dev-search">
      <h2 id="dev-search">{t('searchTitle')}</h2>
      <form role="search" className="pub-form" onSubmit={submit}>
        <input type="search" aria-label={t('searchLabel')} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" className="button">
          {t('searchButton')}
        </button>
      </form>
      {query && results.length === 0 ? <p role="status">{t('searchEmpty', { query })}</p> : null}
      {results.length ? (
        <nav aria-label={t('searchMatches', { query })}>
          <ul>
            {results.map((result) => (
              <li key={result.href}>
                <a className="text-link" href={result.href}>
                  {result.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </section>
  );
}

function ErrorsAuth() {
  const { t } = developersCopy.useCopy();
  return (
    <div className="pub-page" data-testid="developers-errors-auth">
      <header className="pub-heading">
        <h1>{t('errorsAuthTitle')}</h1>
        <p className="muted">
          {t('sectionFor')} {t('audience_exchange')}
        </p>
      </header>
      <section className="pub-notice" role="status">
        <p>{t('errorsAuthBody')}</p>
        <a className="text-link" href="/developers/permissions">
          {t('errorsAuthPermissions')} →
        </a>
      </section>
      <a className="text-link" href="/developers/errors">
        ← {t('section_errors')}
      </a>
    </div>
  );
}

function Unknown() {
  const { t } = developersCopy.useCopy();
  return (
    <div className="pub-page">
      <section className="pub-notice" role="status">
        <h1>{t('unknownTitle')}</h1>
        <p>{t('unknownBody')}</p>
        <a className="text-link" href="/developers">
          ← {t('back')}
        </a>
      </section>
    </div>
  );
}
