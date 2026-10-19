import { useState } from 'react';
import { PaySection } from '../../../components';
import { NotLiveCard } from '../../chrome/NotLiveCard';
import { reason } from '../../chrome/copy';
import { developersCopy as c } from './copy';
import { CodeTabs } from './Signing';
import { signingSnippets, verifySnippets, type SnippetLanguage } from './model';

/** Plain written guidance for the merchant's own integration. Nothing here is an operator or founder tool. */
export function Docs() {
  const { t } = c.useCopy();
  const [signLang, setSignLang] = useState<SnippetLanguage>('typescript');
  const [verifyLang, setVerifyLang] = useState<SnippetLanguage>('typescript');
  return (
    <div className="stack">
      <PaySection title={t('docsStartTitle')} description={t('docsStartBody')}>
        <ol className="pp-steps-list">
          <li>
            <a className="text-link" href="/pay/developer/keys#create">
              {t('docsStep1')}
            </a>
          </li>
          <li>{t('docsStep2')}</li>
          <li>
            <a className="text-link" href="/pay/developer/webhooks#add">
              {t('docsStep3')}
            </a>
          </li>
          <li>{t('docsStep4')}</li>
        </ol>
      </PaySection>
      <PaySection title={t('docsKeysTitle')}>
        <p>{t('docsKeysBody')}</p>
        <ul>
          <li>{t('docsKeysRead')}</li>
          <li>{t('docsKeysWrite')}</li>
          <li>{t('docsKeysRefund')}</li>
        </ul>
      </PaySection>
      <PaySection title={t('docsSignTitle')} description={t('docsSignBody')}>
        <pre className="pp-code" aria-label={t('recipeCanonical')}>
          {'INTAFACED-REQ-V1\nMETHOD\n/path?query\ntimestamp\nnonce\nbody-sha256'}
        </pre>
        <p className="muted">{t('recipeWindow')}</p>
        <CodeTabs lang={signLang} setLang={setSignLang} snippets={signingSnippets} />
        <a className="text-link" href="/pay/developer/signing">
          {t('docsSignLink')}
        </a>
      </PaySection>
      <PaySection title={t('docsEventsTitle')} description={t('docsEventsBody')}>
        <ul>
          <li>{t('docsEventsOnce')}</li>
          <li>{t('docsEventsRetry')}</li>
          <li>{t('docsEventsSecret')}</li>
        </ul>
        <CodeTabs lang={verifyLang} setLang={setVerifyLang} snippets={verifySnippets} />
        <a className="text-link" href="/pay/developer/webhooks">
          {t('docsEventsLink')}
        </a>
      </PaySection>
      <PaySection title={t('docsSdkTitle')}>
        <NotLiveCard reason={reason('reasonDocs')} title={t('docsSdkCardTitle')} needs="SDK publishing decision" code="owner.decision">
          {t('docsSdkBody')}
        </NotLiveCard>
      </PaySection>
    </div>
  );
}
