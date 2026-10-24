import { ContactSupport } from './ContactSupport';
import { supportRecoveryCopy } from './support-recovery-copy';
import './public-pages.css';

/**
 * /cannot-sign-in: what happens when nothing else gets a person back in (I-signin-sessions-24, J-identity-05 #5). It says
 * how a support-assisted recovery works, and that a second person approves and nobody at Support sees the link, then shows
 * how to reach Support signed out.
 */
export function CannotSignIn() {
  const { t } = supportRecoveryCopy.useCopy();
  return (
    <div className="pub-page">
      <header className="pub-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{t('title')}</h1>
      </header>
      <p className="muted">{t('intro')}</p>
      <h2>{t('stepsHeading')}</h2>
      <ol>
        <li>{t('stepCase')}</li>
        <li>{t('stepApprove')}</li>
        <li>{t('stepLink')}</li>
        <li>{t('stepAfter')}</li>
      </ol>
      <p className="pub-notice" role="note">
        {t('never')}
      </p>
      <p>
        {t('tryReset')}{' '}
        <a className="text-link" href="/login">
          {t('toSignIn')}
        </a>
      </p>
      <ContactSupport context="recovery" />
    </div>
  );
}
