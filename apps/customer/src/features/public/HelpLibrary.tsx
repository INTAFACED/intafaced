import { SUPPORT_HELP_CENTRE_OFF } from '@intafaced/contracts/support-help-centre';
import { supportKbParagraphs } from '@intafaced/contracts/support-kb-library';
import { readContract } from '../../shared/contract-call';
import { useResource } from '../../shared/resource';
import { Button, Failure, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import { ContactSupport } from './ContactSupport';
import { helpCopy as copy } from './help-copy';
import { helpHref } from './help-guards';
import {
  HELP_SECTION_WINDOW,
  helpCategoryHref,
  helpLibraryRead,
  helpSectionHref,
  helpSectionRead,
  type HelpLibraryPath,
} from './help-library';
import './help.css';

/**
 * The topics on the help front door: the categories support staff made, each with its sections and how many published
 * answers each holds. None made is said plainly; there is no built-in topic list.
 */
export function HelpLibraryNav() {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const library = useResource((signal) => readContract(api, helpLibraryRead, undefined, { signal }), `help-library:${userId ?? 'public'}`);
  const read = library.resource;
  return (
    <nav className="help__card help__library" aria-label={t('libraryTitle')} data-testid="help-library">
      <h2 lang={languageFor('libraryTitle')}>{t('libraryTitle')}</h2>
      {read.status === 'loading' ? (
        <p className="muted">{t('loadingLibrary')}</p>
      ) : read.status === 'failed' ? (
        <>
          <p className="muted" lang={languageFor('libraryUnread')}>
            {t('libraryUnread')}
          </p>
          <Button variant="secondary" onClick={library.reload}>
            {t('retry')}
          </Button>
        </>
      ) : read.data.categories.length === 0 ? (
        <p className="muted" role="status" lang={languageFor('libraryEmpty')}>
          {t('libraryEmpty')}
        </p>
      ) : (
        <ul className="help__topics">
          {read.data.categories.map((category) => (
            <li key={category.id}>
              <a data-testid="help__link" className="help__link text-link" href={helpCategoryHref(category.id)} lang="und">
                {category.name}
              </a>
              {category.sections.length > 0 && (
                <ul>
                  {category.sections.map((section) => (
                    <li key={section.id}>
                      <a href={helpSectionHref(section.id)} className="text-link" lang="und">
                        {section.name}
                      </a>{' '}
                      <span className="muted help__caption">
                        {t('answersLabel')} <span lang="zxx">{section.articleCount}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

/** A refusal the page has its own words for: switched off, or a topic that is not there. */
function libraryRefusal(failure: { message?: string; status?: number }) {
  if (failure.message === SUPPORT_HELP_CENTRE_OFF) return 'off' as const;
  if (failure.status === 404) return 'missing' as const;
  return null;
}

function Crumbs({ category }: { category?: { id: string; name: string } }) {
  const { t, languageFor } = copy.useCopy();
  return (
    <nav aria-label={t('breadcrumbs')} className="help__crumbs">
      <a href="/help" data-testid="help__link" className="help__link text-link" lang={languageFor('libraryHome')}>
        {t('libraryHome')}
      </a>
      {category && (
        <>
          {' › '}
          <a href={helpCategoryHref(category.id)} data-testid="help__link" className="help__link text-link" lang="und">
            {category.name}
          </a>
        </>
      )}
    </nav>
  );
}

function Refused({ kind }: { kind: 'off' | 'missing' }) {
  const { t, languageFor } = copy.useCopy();
  const title = kind === 'off' ? 'switchedOffTitle' : 'libraryMissingTitle';
  const body = kind === 'off' ? 'switchedOffBody' : 'libraryMissingBody';
  return (
    <>
      <Crumbs />
      <header data-testid="help__heading" className="help__heading">
        <h1 lang={languageFor(title)} tabIndex={-1}>
          {t(title)}
        </h1>
      </header>
      <section className="help__card help__measure" role="status" data-testid={kind === 'off' ? 'help-centre-off' : 'help-topic-missing'}>
        <p className="muted" lang={languageFor(body)}>
          {t(body)}
        </p>
      </section>
      <ContactSupport />
    </>
  );
}

/** `/help/category/<id>`: one category and its sections, each with its count of published answers. */
function CategoryPage({ id }: { id: string }) {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const library = useResource((signal) => readContract(api, helpLibraryRead, undefined, { signal }), `help-library:${userId ?? 'public'}`);
  const read = library.resource;
  if (read.status === 'loading') return <Loading label={t('loadingLibrary')} />;
  if (read.status === 'failed') {
    const refused = libraryRefusal(read.failure);
    if (refused) return <Refused kind={refused} />;
    return (
      <>
        <Crumbs />
        <div lang="und">
          <Failure result={read.failure} />
        </div>
        <Button onClick={library.reload}>{t('retry')}</Button>
      </>
    );
  }
  const category = read.data.categories.find((row) => row.id === id);
  if (!category) return <Refused kind="missing" />;
  return (
    <>
      <Crumbs />
      <header data-testid="help__heading" className="help__heading">
        <h1 lang="und">{category.name}</h1>
      </header>
      <div className="help__browse">
        <div data-testid="help__list" className="help__list">
          {category.sections.length === 0 && (
            <div data-testid="help__empty" className="help__empty" role="status">
              <h2 lang={languageFor('categoryEmptyTitle')}>{t('categoryEmptyTitle')}</h2>
            </div>
          )}
          {category.sections.map((section) => (
            <article data-testid="help__row" className="help__row" key={section.id}>
              <div data-testid="help__row-heading" className="help__row-heading">
                <h2 lang="und">{section.name}</h2>
                <a
                  href={helpSectionHref(section.id)}
                  data-testid="help__link"
                  className="help__link text-link"
                  aria-label={`${t('openSection')}: ${section.name}`}
                >
                  {t('openSection')} →
                </a>
              </div>
              <p className="help__caption muted">
                {t('answersLabel')} <span lang="zxx">{section.articleCount}</span>
              </p>
            </article>
          ))}
        </div>
        <div className="help__side">
          <ContactSupport />
        </div>
      </div>
    </>
  );
}

/** `/help/section/<id>`: only the published answers filed under this section, or an honest empty state. */
function SectionPage({ id }: { id: string }) {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const page = useResource(
    (signal) => readContract(api, helpSectionRead, { sectionId: id, limit: HELP_SECTION_WINDOW }, { signal }),
    `help-section:${id}:${userId ?? 'public'}`,
  );
  const read = page.resource;
  if (read.status === 'loading') return <Loading label={t('loadingCatalogue')} />;
  if (read.status === 'failed') {
    const refused = libraryRefusal(read.failure);
    if (refused) return <Refused kind={refused} />;
    return (
      <>
        <Crumbs />
        <div lang="und">
          <Failure result={read.failure} />
        </div>
        <Button onClick={page.reload}>{t('retry')}</Button>
      </>
    );
  }
  const { category, section, articles } = read.data;
  return (
    <>
      <Crumbs category={category} />
      <header data-testid="help__heading" className="help__heading">
        <h1 lang="und">{section.name}</h1>
      </header>
      <div className="help__browse">
        <div data-testid="help__list" className="help__list">
          {articles.length === 0 ? (
            <div data-testid="help__empty" className="help__empty" role="status">
              <h2 lang={languageFor('sectionEmptyTitle')}>{t('sectionEmptyTitle')}</h2>
              <p className="muted" lang={languageFor('sectionEmptyBody')}>
                {t('sectionEmptyBody')}
              </p>
            </div>
          ) : (
            articles.map((row) => {
              const title = row.title ?? row.id;
              const first = row.body ? supportKbParagraphs(row.body)[0] : undefined;
              return (
                <article data-testid="help__row" className="help__row" key={row.id}>
                  <div data-testid="help__row-heading" className="help__row-heading">
                    <h2 lang={row.language ?? 'und'}>{title}</h2>
                    <a
                      href={helpHref(row.id)}
                      data-testid="help__link"
                      className="help__link text-link"
                      aria-label={`${t('readAnswer')}: ${title}`}
                    >
                      {t('readAnswer')} →
                    </a>
                  </div>
                  {first && (
                    <p className="muted" lang={row.language ?? 'und'}>
                      {first}
                    </p>
                  )}
                </article>
              );
            })
          )}
          {articles.length === HELP_SECTION_WINDOW && <p className="help__caption muted">{t('sectionWindow')}</p>}
        </div>
        <div className="help__side">
          <ContactSupport />
        </div>
      </div>
    </>
  );
}

export function HelpLibrary({ at }: { at: Exclude<HelpLibraryPath, null> }) {
  const { languageFor } = copy.useCopy();
  return (
    <div data-testid="help" className="help" lang={languageFor('title')}>
      {at.kind === 'category' ? <CategoryPage id={at.id} /> : <SectionPage id={at.id} />}
    </div>
  );
}
