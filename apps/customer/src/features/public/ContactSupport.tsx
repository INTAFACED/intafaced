import { useSession } from '../session/session';
import { supportContactEmail } from '../more/support-contact';
import { supportMailto } from '../more/support-desk';
import { contactCopy } from './contact-copy';
import './public-pages.css';

/**
 * How to reach a person without signing in. The support service only takes requests from a signed-in account and has no public
 * intake, so a signed-out visitor gets the honest path: a plain email address and a prepared draft. Signed in, the same card
 * points at the real desk. It never sits behind a sign-in wall itself.
 */
export function ContactSupport({ context = 'general' }: { context?: 'general' | 'recovery' }) {
  const copy = contactCopy.useCopy();
  const { session } = useSession();
  if (session)
    return (
      <aside className="contact-card" aria-labelledby="contact-title">
        <h2 id="contact-title">{copy.t('titleSignedIn')}</h2>
        <p className="muted">{copy.t('bodySignedIn')}</p>
        <a className="button button--primary" href="/support">
          {copy.t('openDesk')}
        </a>
      </aside>
    );
  const to = supportContactEmail();
  const subject = copy.t(context === 'recovery' ? 'mailSubject' : 'mailSubjectGeneral');
  return (
    <aside className="contact-card" aria-labelledby="contact-title">
      <h2 id="contact-title">{copy.t(context === 'recovery' ? 'titleRecovery' : 'titleSignedOut')}</h2>
      <p className="muted">{copy.t(context === 'recovery' ? 'bodyRecovery' : 'bodySignedOut')}</p>
      <h3>{copy.t('includeHeading')}</h3>
      <ul>
        <li>{copy.t('includeHandle')}</li>
        <li>{copy.t('includeWhat')}</li>
        <li>{copy.t('includeWhen')}</li>
      </ul>
      <p className="contact-card__warning" role="note">
        {copy.t('neverShare')}
      </p>
      {to ? (
        <>
          <a className="button button--primary" href={supportMailto(to, subject, copy.t('mailBody'))}>
            {copy.t('write')}
          </a>
          <p className="muted contact-card__small">
            {copy.t('addressLabel')} <span lang="zxx">{to}</span>
          </p>
          <p className="muted contact-card__small">
            {copy.t('noForm')} {copy.t('noPromise')}
          </p>
        </>
      ) : (
        <p role="status" data-testid="support-email-unset">
          <strong>{copy.t('addressNotSet')}</strong> {copy.t('addressNotSetNote')}
        </p>
      )}
    </aside>
  );
}
