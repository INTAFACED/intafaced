import { SUPPORT_KB_LIBRARY } from '@intafaced/contracts/support-desk-settings-procedures';
import { useResource } from '../../shared/resource';
import { Button } from '@intafaced/ui/lit';
import { useSession } from '../session';
import { helpCopy as copy } from './help-copy';
import { helpCategoryHref, helpSectionHref } from './help-library';

/**
 * The topics on the help front door: the categories support staff made, each with its sections and how many published
 * answers each holds. None made is said plainly; there is no built-in topic list.
 */
export function HelpLibraryNav() {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const library = useResource((signal) => api.call(SUPPORT_KB_LIBRARY, undefined, { signal }), `help-library:${userId ?? 'public'}`);
  const read = library.resource;
  return (
    <nav className="lt-stack" aria-label={t('libraryTitle')} data-testid="help-library">
      {/* With no topic made, a "Browse by topic" heading would head nothing: the one line below says so. */}
      {read.status === 'ready' && read.data.categories.length === 0 ? null : (
        <h2 lang={languageFor('libraryTitle')}>{t('libraryTitle')}</h2>
      )}
      {read.status === 'loading' ? (
        <p className="lt-hint">{t('loadingLibrary')}</p>
      ) : read.status === 'failed' ? (
        <>
          <p className="lt-hint" lang={languageFor('libraryUnread')}>
            {t('libraryUnread')}
          </p>
          <Button tone="secondary" onClick={library.reload}>
            {t('retry')}
          </Button>
        </>
      ) : read.data.categories.length === 0 ? (
        <p className="lt-hint" role="status" lang={languageFor('libraryEmpty')}>
          {t('libraryEmpty')}
        </p>
      ) : (
        <ul className="lt-stack">
          {read.data.categories.map((category) => (
            <li key={category.id}>
              <a className="lt-link lt-link-alone" href={helpCategoryHref(category.id)} lang="und">
                {category.name}
              </a>
              {category.sections.length > 0 && (
                <ul>
                  {category.sections.map((section) => (
                    <li key={section.id}>
                      <a href={helpSectionHref(section.id)} className="lt-link lt-link-alone" lang="und">
                        {section.name}
                      </a>{' '}
                      <span className="lt-hint">
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
