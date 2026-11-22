import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { supportMailto, useSupportContact } from '../more';
import { usePartnerSettings } from './partner-settings';
import { pagesCopy } from './public-pages-copy';

/**
 * /partner on the reading template: where a partnership enquiry goes. The form is on the invitation site at the founders'
 * join address; this page points at it, or at the support email, or says neither is set. Programme terms show only when the
 * founders publish them.
 */
export function PartnerPage() {
  const copy = pagesCopy.useCopy();
  const settings = usePartnerSettings();
  const form = settings.formHref;
  const contact = useSupportContact();
  const to = contact.email;
  return (
    <ReadingTemplate
      title={copy.t('partnerTitle')}
      description={copy.t('partnerLead')}
      state={{ kind: 'ready' }}
      body={
        <>
          <section aria-labelledby="partner-form">
            <h2 id="partner-form">{copy.t('partnerFormTitle')}</h2>
            <p>{copy.t(form ? 'partnerFormBody' : 'partnerNoFormBody')}</p>
            {settings.status === 'loading' ? null : form ? (
              <a className="lt-button lt-button-primary" href={form} data-testid="partner-form-link">
                {copy.t('partnerOpenForm')} <span className="lt-arrow lt-arrow-out" aria-hidden="true" />
              </a>
            ) : to ? (
              <>
                <a
                  className="lt-button lt-button-primary"
                  href={supportMailto(to, copy.t('partnerMailSubject'), copy.t('partnerMailBody'))}
                >
                  {copy.t('partnerEmail')}
                </a>
                <p>
                  <small lang="zxx">{to}</small>
                </p>
              </>
            ) : contact.status === 'loading' ? null : contact.status === 'unread' ? (
              <p role="status" data-testid="support-contact-unread">
                {copy.t('partnerEmailUnread')}
              </p>
            ) : (
              <p role="status" data-testid="support-email-unset">
                {copy.t('partnerEmailNotSet')}
              </p>
            )}
          </section>
          <section aria-labelledby="partner-include">
            <h2 id="partner-include">{copy.t('partnerIncludeTitle')}</h2>
            <ul>
              <li>{copy.t('partnerInclude1')}</li>
              <li>{copy.t('partnerInclude2')}</li>
              <li>{copy.t('partnerInclude3')}</li>
            </ul>
            <p>{copy.t('partnerBoundary')}</p>
          </section>
          <section aria-labelledby="partner-terms">
            <h2 id="partner-terms">{copy.t('partnerTermsTitle')}</h2>
            {settings.terms ? (
              <p className="lt-prose-lines" data-testid="partner-terms">
                {settings.terms}
              </p>
            ) : settings.status === 'loading' ? null : settings.status === 'unread' ? (
              <p role="status" data-testid="partner-terms-unread">
                {copy.t('partnerTermsUnread')}
              </p>
            ) : (
              <p role="status" data-testid="partner-terms-unset">
                {copy.t('partnerTermsNotSet')}
              </p>
            )}
          </section>
        </>
      }
      related={
        <section aria-labelledby="partner-merchant">
          <h2 id="partner-merchant">{copy.t('partnerMerchantTitle')}</h2>
          <p>{copy.t('partnerMerchantBody')}</p>
          <a className="lt-link lt-link-alone" href="/pay/merchant">
            {copy.t('partnerMerchantOpen')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
          </a>
        </section>
      }
    />
  );
}
