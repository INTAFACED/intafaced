import { useSession } from '../session';
import { chatCopy, supportMailto, useSupportContact } from '../more';
import { contactCopy } from './contact-copy';

/**
 * How to reach a person without signing in, drawn from the Volt kit for the public rooms on a template (the same words,
 * states and test ids as `ContactSupport`, which the rooms not yet moved keep until they move). The support service only
 * takes requests from a signed-in account and has no public intake, so a signed-out visitor gets the honest path: a plain
 * email address and a prepared draft. Signed in, the same card points at the real desk. It never sits behind a sign-in wall.
 */
export function ContactCard({ context = 'general' }: { context?: 'general' | 'recovery' }) {
  const copy = contactCopy.useCopy();
  const { session } = useSession();
  const contact = useSupportContact();
  if (session)
    return (
      <aside data-testid="contact-card" aria-labelledby="contact-title">
        <h2 id="contact-title">{copy.t('titleSignedIn')}</h2>
        <p>{copy.t('bodySignedIn')}</p>
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
      <p>{copy.t(context === 'recovery' ? 'bodyRecovery' : 'bodySignedOut')}</p>
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
          <p>
            <small>
              {copy.t('addressLabel')} <span lang="zxx">{to}</span>
            </small>
          </p>
          <p>
            <small>
              {copy.t('noForm')} {copy.t('noPromise')}
            </small>
          </p>
        </>
      ) : contact.status === 'loading' ? (
        <p role="status">{copy.t('loadingContact')}</p>
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
        <p data-testid="support-phone">
          <small>
            {copy.t('phoneLabel')} <span lang="zxx">{contact.phone}</span>
          </small>
        </p>
      ) : (
        contact.status === 'ready' && (
          <p data-testid="support-phone-unset">
            <small>{copy.t('phoneNotSet')}</small>
          </p>
        )
      )}
      {contact.chatHours && (
        <p data-testid="support-hours">
          <small>
            {copy.t('hoursLabel')} <span lang="und">{contact.chatHours}</span>
          </small>
        </p>
      )}
      {contact.status === 'unread' && to && (
        <p role="status">
          <small>{copy.t('contactUnread')}</small>
        </p>
      )}
    </aside>
  );
}
