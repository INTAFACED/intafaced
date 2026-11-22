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
            <a className="lt-link" href="/developers/permissions">
              {t('errorsAuthPermissions')} →
            </a>
            <a className="lt-link" href="/developers/errors">
              ← {t('section_errors')}
            </a>
          </p>
        }
      />
    </div>
  );
}
