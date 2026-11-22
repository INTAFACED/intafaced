import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { ContactCard } from './ContactCard';
import { supportRecoveryCopy } from './support-recovery-copy';

const READY = { kind: 'ready' } as const;

/**
 * /cannot-sign-in: what happens when nothing else gets a person back in (I-signin-sessions-24, J-identity-05 #5), on the
 * flow template. It says how a support-assisted recovery works, and that a second person approves and nobody at Support
 * sees the link, then shows how to reach Support signed out.
 */
export function CannotSignIn() {
  const { t } = supportRecoveryCopy.useCopy();
  return (
    <FlowTemplate
      title={t('title')}
      description={t('eyebrow')}
      state={READY}
      step={
        <>
          <p className="lt-hint">{t('intro')}</p>
          <h2>{t('stepsHeading')}</h2>
          <ol>
            <li>{t('stepCase')}</li>
            <li>{t('stepApprove')}</li>
            <li>{t('stepLink')}</li>
            <li>{t('stepAfter')}</li>
          </ol>
          <p role="note">
            <strong>{t('never')}</strong>
          </p>
          <p>
            {t('tryReset')}{' '}
            <a className="lt-link" href="/login">
              {t('toSignIn')}
            </a>
          </p>
        </>
      }
      help={<ContactCard context="recovery" />}
    />
  );
}
