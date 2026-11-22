import { DocPage } from '../DocPage';
import { useSession } from '../../session';
import { supportNewHref, useSupportContact } from '../../more';
import { developerSupportCopy } from './support-copy';

/**
 * /developers/support (J-developer-17 #5; DV-portal-03): the API support route. It names what to send with an API problem,
 * the owner's support contacts (each blank one reads "contact not set"), and the request form, which works with or without
 * contacts. It never asks for a key or a secret.
 */
export function DeveloperSupportPage({ title }: { title: string }) {
  const { t } = developerSupportCopy.useCopy();
  const { session } = useSession();
  const contact = useSupportContact();
  const channels = [
    { id: 'email', label: t('email'), value: contact.email },
    { id: 'phone', label: t('phone'), value: contact.phone },
    { id: 'chat-hours', label: t('chatHours'), value: contact.chatHours },
  ] as const;
  return (
    <DocPage id="support" title={title} lead={t('lead')} back={t('back')}>
      <section aria-labelledby="dev-support-catalogue" data-testid="developers-support-catalogue">
        <h2 id="dev-support-catalogue">{t('catalogueTitle')}</h2>
        <ul>
          <li>
            <a className="lt-link lt-link-alone" href="/developers/errors">
              {t('catalogueErrors')}
            </a>
          </li>
          <li>
            <a className="lt-link lt-link-alone" href="/developers/errors/auth">
              {t('catalogueAuth')}
            </a>
          </li>
          <li>
            <a className="lt-link lt-link-alone" href="/developers/status">
              {t('catalogueStatus')}
            </a>
          </li>
        </ul>
      </section>
      <section aria-labelledby="dev-support-send" data-testid="developers-support-send">
        <h2 id="dev-support-send">{t('sendTitle')}</h2>
        <ul>
          <li>{t('sendRequestId')}</li>
          <li>{t('sendWhen')}</li>
          <li>{t('sendCall')}</li>
          <li>{t('sendAddress')}</li>
          <li>{t('sendHeaders')}</li>
        </ul>
        <h3>{t('neverTitle')}</h3>
        <p role="note" data-testid="developers-support-never">
          {t('neverKey')}
        </p>
      </section>
      <section aria-labelledby="dev-support-contacts" data-testid="developers-support-contacts">
        <h2 id="dev-support-contacts">{t('contactsTitle')}</h2>
        {contact.status === 'loading' ? (
          <p className="lt-hint" role="status">
            {t('contactLoading')}
          </p>
        ) : (
          <>
            {contact.status === 'unread' ? <p role="status">{t('contactUnread')}</p> : null}
            <dl>
              {channels.map((channel) => (
                <div key={channel.id} data-testid={`developers-support-contact-${channel.id}`} data-state={channel.value ? 'set' : 'unset'}>
                  <dt>{channel.label}</dt>
                  <dd>{channel.value ? <span lang="zxx">{channel.value}</span> : <strong>{t('contactNotSet')}</strong>}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </section>
      <section aria-labelledby="dev-support-ticket" data-testid="developers-support-ticket">
        <h2 id="dev-support-ticket">{t('ticketTitle')}</h2>
        <p>{t('ticketBody')}</p>
        {session ? (
          <a className="lt-button lt-button-primary" href={supportNewHref(t('ticketSubject'))}>
            {t('ticketOpen')}
          </a>
        ) : (
          <a className="lt-button lt-button-primary" href={`/login?next=${encodeURIComponent('/developers/support')}`}>
            {t('ticketSignIn')}
          </a>
        )}
      </section>
    </DocPage>
  );
}
