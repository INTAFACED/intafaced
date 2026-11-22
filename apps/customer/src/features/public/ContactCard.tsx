import { useSession } from '../session';
import { chatCopy, supportMailto, useSupportContact } from '../more';
import { contactCopy } from './contact-copy';

/**
 * How to reach a person without signing in, drawn from the kit: the same card, words and finders as `ContactSupport`
 * (which the help rooms still draw). The support service only takes requests from a signed-in account and has no public
 * intake, so a signed-out visitor gets the honest path: a plain email address and a prepared draft. Signed in, the same
 * card points at the real desk. It never sits behind a sign-in wall itself.
 */
export function ContactCard({ context = 'general' }: { context?: 'general' | 'recovery' }) {
  const copy = contactCopy.useCopy();
  const { session } = useSession();
  const contact = useSupportContact();
  if (session)
    return (
      <aside data-testid="contact-card" aria-labelledby="contact-title">
        <h2 id="contact-title">{copy.t('titleSignedIn')}</h2>
        <p className="lt-hint">{copy.t('bodySignedIn')}</p>
        <a className="lt-button lt-button-primary" href="/support">
          {copy.t('openDesk')}
        </a>
      </aside>
    );
  const to = contact.email;
  const subject = copy.t(context === 'recovery' ? 'mailSubject' : 'mailSubjectGeneral');
  return (
    <aside data-testid="contact-card" aria-labelledby="contact-title">
      <h2 id="contact-title">{copy.t(context === 'recovery' ? 'titleRecovery' : 'titleSignedOut')}</h2>
      <p className="lt-hint">{copy.t(context === 'recovery' ? 'bodyRecovery' : 'bodySignedOut')}</p>
      <p data-testid="support-chat-link">
        <a className="lt-link" href="/support/chat">
          <chatCopy.Copy k="openChat" />
        </a>
      </p>
      <h3>{copy.t('includeHeading')}</h3>
      <ul>
        <li>{copy.t('includeHandle')}</li>
        <li>{copy.t('includeWhat')}</li>
        <li>{copy.t('includeWhen')}</li>
      </ul>
      <p role="note">
        <strong>{copy.t('neverShare')}</strong>
      </p>
      {to ? (
        <>
          <a className="lt-button lt-button-primary" href={supportMailto(to, subject, copy.t('mailBody'))}>
            {copy.t('write')}
          </a>
          <p className="lt-hint">
            {copy.t('addressLabel')} <span lang="zxx">{to}</span>
          </p>
          <p className="lt-hint">
            {copy.t('noForm')} {copy.t('noPromise')}
          </p>
        </>
      ) : contact.status === 'loading' ? (
        <p className="lt-hint" role="status">
          {copy.t('loadingContact')}
        </p>
      ) : contact.status === 'unread' ? (
        <p role="status" data-testid="support-contact-unread">
          {copy.t('contactUnread')}
        </p>
      ) : (
        <p role="status" data-testid="support-email-unset">
          <strong>{copy.t('addressNotSet')}</strong> {copy.t('addressNotSetNote')}
        </p>
      )}
      {contact.phone ? (
        <p className="lt-hint" data-testid="support-phone">
          {copy.t('phoneLabel')} <span lang="zxx">{contact.phone}</span>
        </p>
      ) : (
        contact.status === 'ready' && (
          <p className="lt-hint" data-testid="support-phone-unset">
            {copy.t('phoneNotSet')}
          </p>
        )
      )}
      {contact.chatHours && (
        <p className="lt-hint" data-testid="support-hours">
          {copy.t('hoursLabel')} <span lang="und">{contact.chatHours}</span>
        </p>
      )}
      {contact.status === 'unread' && to && (
        <p className="lt-hint" role="status">
          {copy.t('contactUnread')}
        </p>
      )}
    </aside>
  );
}
