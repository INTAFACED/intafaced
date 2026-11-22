import { type JSX } from 'react';
import { developersCopy } from './developers-copy';
import {
  AuthenticationPage,
  ConnectivityPage,
  DataTermsPage,
  OpenApiPage,
  PermissionsPage,
  QuickstartPage,
  ReferencePage,
  RestPage,
  WebSocketPage,
} from './DocsPages';
import { developersRoute, sectionById, type Audience, type PageSectionId } from './developers-model';
import { ChangelogPage, UpcomingPage } from './ChangelogPages';
import { StatusPage } from './StatusPage';
import { AppsRoom } from './apps/AppsRoom';
import { DevelopersHome } from './DevelopersHome';
import { HostsRoom } from './HostsRoom';
import { ErrorsAuthRoom } from './ErrorsAuthRoom';
import { SandboxRoutes } from './sandbox/SandboxRoutes';
import { ErrorsPage } from './errors/TradeErrorsCatalogue';
import { RateLimitsPage } from './rate-limits/RateLimitsPage';
import { ExplorerPage } from './explorer/ExplorerPage';
import { BotPolicyPage } from './trading/BotPolicyPage';
import { OrderTypesPage } from './trading/OrderTypesPage';
import { IdempotencyPage } from './idempotency/IdempotencyPage';
import { QuantApiPage } from './quant/QuantApiPage';
import { DeveloperSupportPage } from './support/DeveloperSupportPage';
import '../../shared/public-pages.css';

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
  authentication: AuthenticationPage,
  errors: ErrorsPage,
  'rate-limits': RateLimitsPage,
  explorer: ExplorerPage,
  'order-types': OrderTypesPage,
  'bot-policy': BotPolicyPage,
  idempotency: IdempotencyPage,
  quant: QuantApiPage,
  websocket: WebSocketPage,
  support: DeveloperSupportPage,
};

/** /developers and the pages under it: the portal home, the base-address table and one page per section. Public: no sign-in needed. */
export function DevelopersRoutes({ path }: { path: string }) {
  if (/^\/developers\/sandbox(\/|$)/.test(path.split(/[?#]/)[0]!)) return <SandboxRoutes path={path} />;
  const route = developersRoute(path);
  if (route.kind === 'hosts') return <HostsRoom />;
  if (route.kind === 'status') return <StatusPage />;
  if (route.kind === 'changelog') return <ChangelogPage />;
  if (route.kind === 'upcoming') return <UpcomingPage />;
  if (route.kind === 'apps') return <AppsRoom />;
  if (route.kind === 'errors-auth') return <ErrorsAuthRoom />;
  if (route.kind === 'section') return <SectionPage id={route.id} />;
  if (route.kind === 'unknown' && path.split(/[?#]/)[0]!.replace(/\/+$/, '') !== '/developers') return <Unknown />;
  return <DevelopersHome />;
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
