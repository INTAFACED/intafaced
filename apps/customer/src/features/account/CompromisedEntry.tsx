import { defineCopy } from '../../shared/i18n';

const copy = defineCopy('account.compromised-entry', {
  title: 'Think someone got in?',
  body: 'If someone else may have signed in, or you saw money leave that you did not send, secure the account in one step. If a message asked for your password or codes, report it.',
  compromised: 'My account is compromised',
  report: 'Report a scam message',
});

/** Security's way into the compromised-account case and the scam report (J-identity-13 #2 and #3). */
export function CompromisedEntry() {
  const { t, languageFor } = copy.useCopy();
  return (
    <section
      data-testid="security__compromised"
      className="security__card"
      aria-labelledby="security-compromised"
      lang={languageFor('title')}
    >
      <h2 id="security-compromised">{t('title')}</h2>
      <p>{t('body')}</p>
      <ul>
        <li>
          <a className="text-link" href="/uc/safe/compromised">
            {t('compromised')}
          </a>
        </li>
        <li>
          <a className="text-link" href="/support/new?topic=phishing">
            {t('report')}
          </a>
        </li>
      </ul>
    </section>
  );
}

const guides = defineCopy('account.scam-guides-link', { link: 'Official channels and scam guides' });

/** In the Security checklist: the official channel list and the scam guides (I-signin-sessions-26, J-identity-13 #1). */
export function ScamGuidesLink() {
  const { t, languageFor } = guides.useCopy();
  return (
    <p lang={languageFor('link')}>
      <a className="text-link" href="/help/official-channels">
        {t('link')}
      </a>
    </p>
  );
}
