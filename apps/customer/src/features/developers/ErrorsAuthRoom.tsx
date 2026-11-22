// volt-room: /developers/errors/auth
import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { developersCopy } from './developers-copy';
import { AuthErrorsCatalogue } from './errors/AuthErrorsCatalogue';

/** /developers/errors/auth on the reading template: every authentication and permission refusal, with its cause and fix. */
export function ErrorsAuthRoom() {
  const { t } = developersCopy.useCopy();
  return (
    <div data-testid="developers-errors-auth">
      <ReadingTemplate
        title={t('errorsAuthTitle')}
        description={`${t('sectionFor')} ${t('audience_exchange')}`}
        state={{ kind: 'ready' }}
        body={<AuthErrorsCatalogue />}
        related={
          <p className="lt-actions">
            <a className="lt-link lt-link-alone" href="/developers/permissions">
              {t('errorsAuthPermissions')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
            </a>
            <a className="lt-link lt-link-alone" href="/developers/errors">
              <span className="lt-arrow lt-arrow-back" aria-hidden="true" /> {t('section_errors')}
            </a>
          </p>
        }
      />
    </div>
  );
}
