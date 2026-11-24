// volt-room: /developers/permissions
// volt-room: /developers/:section
import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { type JSX } from 'react';
import { developersCopy } from './developers-copy';
import { BackLink } from './DocPage';
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
import { sectionById, type Audience, type PageSectionId } from './developers-model';
import { ChangelogPage } from './ChangelogPages';
import { StatusPage } from './StatusPage';
import { ErrorsPage } from './errors/TradeErrorsCatalogue';
import { RateLimitsPage } from './rate-limits/RateLimitsPage';
import { ExplorerPage } from './explorer/ExplorerPage';
import { BotPolicyPage } from './trading/BotPolicyPage';
import { OrderTypesPage } from './trading/OrderTypesPage';
import { IdempotencyPage } from './idempotency/IdempotencyPage';
import { QuantApiPage } from './quant/QuantApiPage';
import { DeveloperSupportPage } from './support/DeveloperSupportPage';

const key = (id: string) => id.replace(/-/g, '_');
type PortalCopy = ReturnType<typeof developersCopy.useCopy>['t'];
type SectionKey = Extract<Parameters<PortalCopy>[0], `section_${string}`>;
type BlockerKey = Extract<Parameters<PortalCopy>[0], `blocker_${string}`>;
const sectionKey = (id: string) => `section_${key(id)}` as SectionKey;
const blockerKey = (id: string) => `blocker_${key(id)}` as BlockerKey;

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

/** /developers/:section: the section's written page, or, for a section with no page here, where it is published or what it waits for. */
export function SectionPage({ id }: { id: string }) {
  const { t } = developersCopy.useCopy();
  const section = sectionById(id)!;
  const title = t(sectionKey(id));
  if (section.page) {
    const Written = PAGES[section.id];
    return <Written title={title} />;
  }
  const audience: Audience = section.audience;
  return (
    <div data-testid={`developers-${id}`}>
      <ReadingTemplate
        title={title}
        description={`${t('sectionFor')} ${t(`audience_${audience}` as const)}`}
        state={{ kind: 'ready' }}
        body={
          <section className="lt-stack" role="status" data-waits-for={section.waitsFor}>
            {section.published ? (
              <a className="lt-button lt-button-primary" href={section.published.href}>
                {t('sectionOpenPublished')} <span className="lt-arrow lt-arrow-out" aria-hidden="true" />
              </a>
            ) : (
              <p>{section.waitsFor ? t('waitsForBody', { blocker: t(blockerKey(section.id)) }) : t('unpublished')}</p>
            )}
          </section>
        }
        footer={<BackLink label={t('back')} />}
      />
    </div>
  );
}

/** An address under /developers that names no section: said plainly, with the way back to the list. */
export function UnknownSection() {
  const { t } = developersCopy.useCopy();
  return (
    <ReadingTemplate
      title={t('unknownTitle')}
      state={{ kind: 'ready' }}
      body={<p role="status">{t('unknownBody')}</p>}
      footer={<BackLink label={t('back')} />}
    />
  );
}
