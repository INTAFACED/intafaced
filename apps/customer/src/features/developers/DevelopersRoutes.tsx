import { developersCopy } from './developers-copy';
import { AUDIENCES, ENVIRONMENTS, PROTOCOLS, SECTIONS, developersRoute, hostTable, sectionById, type Audience } from './developers-model';
import '../public/public-pages.css';

const key = (id: string) => id.replace(/-/g, '_');
type SectionKey = Extract<Parameters<ReturnType<typeof developersCopy.useCopy>['t']>[0], `section_${string}`>;
const sectionKey = (id: string) => `section_${key(id)}` as SectionKey;

/** /developers and the pages under it: the portal home, the base-address table and one page per section. Public: no sign-in needed. */
export function DevelopersRoutes({ path }: { path: string }) {
  const route = developersRoute(path);
  if (route.kind === 'hosts') return <Hosts />;
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
          <ul>
            {SECTIONS.filter((section) => section.audience === audience).map((section) => (
              <li key={section.id}>
                <a className="text-link" href={`/developers/${section.id}`}>
                  {t(sectionKey(section.id))}
                </a>{' '}
                <span className="muted">{section.published ? t('published') : t('unpublished')}</span>
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
  const rows = hostTable();
  return (
    <div className="pub-page" data-testid="developers-hosts">
      <header className="pub-heading">
        <h1>{t('hostsTitle')}</h1>
        <p className="muted">{t('hostsPageLead')}</p>
      </header>
      <section className="pub-card">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('colProtocol')}</th>
              <th scope="col">{t('colEnvironment')}</th>
              <th scope="col">{t('colHost')}</th>
            </tr>
          </thead>
          <tbody>
            {PROTOCOLS.flatMap((protocol) =>
              ENVIRONMENTS.map((environment) => {
                const row = rows.find((entry) => entry.protocol === protocol && entry.environment === environment)!;
                return (
                  <tr key={`${protocol}:${environment}`} data-host-state={row.cell.state}>
                    <td>{t(`protocol_${protocol}` as const)}</td>
                    <td>{t(`environment_${environment}` as const)}</td>
                    <td lang="und">{row.cell.state === 'set' ? row.cell.host : <span lang={undefined}>{t('hostUnset')}</span>}</td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
        <p className="muted">{t('hostsRegional')}</p>
        <a className="text-link" href="/developers">
          ← {t('hostsBack')}
        </a>
      </section>
    </div>
  );
}

function SectionPage({ id }: { id: string }) {
  const { t } = developersCopy.useCopy();
  const section = sectionById(id)!;
  const audience: Audience = section.audience;
  return (
    <div className="pub-page" data-testid={`developers-${id}`}>
      <header className="pub-heading">
        <h1>{t(sectionKey(id))}</h1>
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
          <p>{t('unpublished')}</p>
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
