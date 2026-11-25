// volt-room: /developers
import { useMemo, useState, type FormEvent } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { developersCopy } from './developers-copy';
import { createDocsSearch } from './developers-search';
import { AUDIENCES, SECTIONS, type Section } from './developers-model';

const key = (id: string) => id.replace(/-/g, '_');
type PortalCopy = ReturnType<typeof developersCopy.useCopy>['t'];
type SectionKey = Extract<Parameters<PortalCopy>[0], `section_${string}`>;
type BlockerKey = Extract<Parameters<PortalCopy>[0], `blocker_${string}`>;
const sectionKey = (id: string) => `section_${key(id)}` as SectionKey;
const blockerKey = (id: string) => `blocker_${key(id)}` as BlockerKey;

function sectionState(section: Section, t: PortalCopy): string | null {
  if (section.page) return null;
  if (section.published) return t('published');
  return section.waitsFor ? t('waitsFor', { blocker: t(blockerKey(section.id)) }) : t('unpublished');
}

/** /developers on the reading template: the portal home, its search, the base addresses and every section by audience. Public. */
export function DevelopersHome() {
  const { t } = developersCopy.useCopy();
  return (
    <div data-testid="developers-home">
      <ReadingTemplate
        title={t('title')}
        description={t('lead')}
        state={{ kind: 'ready' }}
        meta={
          <section aria-labelledby="dev-access">
            <h2 id="dev-access">{t('accessTitle')}</h2>
            <p>{t('accessBody')}</p>
          </section>
        }
        body={
          <>
            <DocsSearch />
            <section aria-labelledby="dev-hosts">
              <h2 id="dev-hosts">{t('hostsTitle')}</h2>
              <p>{t('hostsLead')}</p>
              <a className="lt-link lt-link-alone" href="/developers/hosts">
                {t('hostsOpen')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
              </a>
            </section>
            {AUDIENCES.map((audience) => (
              <section key={audience} aria-labelledby={`dev-${audience}`}>
                <h2 id={`dev-${audience}`}>{t(`audience_${audience}` as const)}</h2>
                <p>
                  <small>{t(`audience_${audience}_note` as const)}</small>
                </p>
                <p data-testid="developers-access">{t(`access_${audience}` as const)}</p>
                <ul>
                  {SECTIONS.filter((section) => section.audience === audience).map((section) => {
                    const state = sectionState(section, t);
                    return (
                      <li
                        key={section.id}
                        data-section-state={section.page ? 'page' : section.published ? 'published' : 'waiting'}
                        data-waits-for={section.waitsFor}
                      >
                        <a className="lt-link" href={`/developers/${section.id}`}>
                          {t(sectionKey(section.id))}
                        </a>
                        {state ? (
                          <>
                            {' '}
                            <small>{state}</small>
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </>
        }
        related={
          <section aria-labelledby="dev-merchant">
            <h2 id="dev-merchant">{t('merchantTitle')}</h2>
            <p>{t('merchantBody')}</p>
            <a className="lt-link lt-link-alone" href="/pay/developer">
              {t('merchantOpen')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
            </a>
          </section>
        }
      />
    </div>
  );
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
    <section aria-labelledby="dev-search">
      <h2 id="dev-search">{t('searchTitle')}</h2>
      <form role="search" className="lt-field-row" onSubmit={submit}>
        <Field
          type="search"
          label={t('searchLabel')}
          aria-label={t('searchLabel')}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" tone="secondary">
          {t('searchButton')}
        </Button>
      </form>
      {query && results.length === 0 ? <p role="status">{t('searchEmpty', { query })}</p> : null}
      {results.length ? (
        <nav aria-label={t('searchMatches', { query })}>
          <ul>
            {results.map((result) => (
              <li key={result.href}>
                <a className="lt-link" href={result.href}>
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
