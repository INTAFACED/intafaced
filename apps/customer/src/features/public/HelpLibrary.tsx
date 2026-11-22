import { SUPPORT_KB_LIBRARY } from '@intafaced/contracts/support-desk-settings-procedures';
import { useResource } from '../../shared/resource';
import { Button } from '../../shared/ui';
import { useSession } from '../session';
import { helpCopy as copy } from './help-copy';
import { helpCategoryHref, helpSectionHref } from './help-library';
import './help.css';

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
              <a className="help__link text-link" href={helpCategoryHref(category.id)} lang="und">
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
