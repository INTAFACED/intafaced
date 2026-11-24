// volt-room: /wallet/conventions/:convention
import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../../shared/preferences';
import { portfolioCopy } from './portfolio-copy';
import { CONVENTIONS, type Convention } from './portfolio-paths';

/** /wallet/conventions/<id>: one convention the portfolio follows, in plain words, on the reading template. */
export function ConventionPage({ id }: { id: string }) {
  const { language } = usePreferences();
  const { t } = portfolioCopy.forLocale(language);
  const known = (CONVENTIONS as readonly string[]).includes(id) ? (id as Convention) : null;
  return (
    <ReadingTemplate
      title={known ? t(`conv_${known}`) : t('conventionMissing')}
      state={{ kind: 'ready' }}
      body={known ? <p>{t(`conv_${known}_body`)}</p> : null}
      related={
        <p>
          <a className="lt-link" href="/wallet">
            {t('tokenBack')}
          </a>
        </p>
      }
    />
  );
}
