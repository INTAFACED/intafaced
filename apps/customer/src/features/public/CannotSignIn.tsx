// volt-room: /cannot-sign-in
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { ContactSupport } from './help/ContactSupport';
import { supportRecoveryCopy } from './support-recovery-copy';

/**
 * /cannot-sign-in: what happens when nothing else gets a person back in (I-signin-sessions-24, J-identity-05 #5). It says
 * how a support-assisted recovery works, and that a second person approves and nobody at Support sees the link, then shows
 * how to reach Support signed out.
 */
export function CannotSignIn() {
  const { t } = supportRecoveryCopy.useCopy();
  return (
    <FlowTemplate
      title={t('title')}
      description={t('eyebrow')}
      state={{ kind: 'ready' }}
      step={
        <div className="lt-stack">
          <p className="lt-muted">{t('intro')}</p>
          <h2>{t('stepsHeading')}</h2>
          <ol>
            <li>{t('stepCase')}</li>
            <li>{t('stepApprove')}</li>
            <li>{t('stepLink')}</li>
            <li>{t('stepAfter')}</li>
          </ol>
          <p className="lt-note" role="note">
            {t('never')}
          </p>
          <p>
            {t('tryReset')}{' '}
            <a className="lt-link" href="/login">
              {t('toSignIn')}
            </a>
          </p>
        </div>
      }
      help={<ContactSupport context="recovery" />}
    />
  );
}
