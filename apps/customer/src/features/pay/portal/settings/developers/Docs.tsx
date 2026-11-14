import { useState } from 'react';
import { Button } from '@intafaced/ui';
import { Field } from '../../../ui-kit';
import { PaySection } from '../../../components';
import { Facts, Gate } from '../../components';
import { useResource } from '../../../../../shared/resource';
import type { SettingsBApi } from '../b-client';
import type { Guide } from './schemas';
import { NotLiveCard } from '../../chrome/NotLiveCard';
import { reason } from '../../chrome/copy';
import { developersCopy as c } from './copy';
import { CodeTabs } from './Signing';
import { signingSnippets, verifySnippets, type SnippetLanguage } from './model';

/** Plain written guidance for the merchant's own integration. Nothing here is an operator or founder tool. */
export function Docs({ api }: { api?: Pick<SettingsBApi, 'webhookCatalogue' | 'webhookGuide'> } = {}) {
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
      {api && <EventCatalogue api={api} />}
      {api && <ReceiverGuide api={api} />}
      <PaySection title={t('docsSdkTitle')}>
        <NotLiveCard reason={reason('reasonDocs')} title={t('docsSdkCardTitle')} needs="SDK publishing decision" code="owner.decision">
          {t('docsSdkBody')}
        </NotLiveCard>
      </PaySection>
    </div>
  );
}

/** Every public event type, its body schema, and how to order and de-duplicate them. Read from the service. */
function EventCatalogue({ api }: { api: Pick<SettingsBApi, 'webhookCatalogue'> }) {
  const { t } = c.useCopy();
  const catalogue = useResource((signal) => api.webhookCatalogue(signal), 'dev:catalogue');
  return (
    <PaySection title={t('catalogueTitle')} description={t('catalogueBody')}>
      <Gate resource={catalogue.resource} retry={catalogue.reload}>
        {(data) => (
          <div className="stack" data-testid="webhook-catalogue">
            {data.events.map((event) => (
              <article key={event.type} data-testid="webhook-catalogue-event" aria-label={event.type}>
                <h4>
                  <code>{event.type}</code>
                </h4>
                <p>{event.summary}</p>
                <pre className="pp-code" aria-label={t('catalogueSchema', { type: event.type })}>
                  {JSON.stringify(event.payloadSchema, null, 2)}
                </pre>
              </article>
            ))}
            <Facts
              items={[
                [
                  t('catalogueOrdering'),
                  <span key="o" data-testid="webhook-catalogue-ordering">
                    {data.ordering}
                  </span>,
                ],
                [
                  t('catalogueDuplicates'),
                  <span key="d" data-testid="webhook-catalogue-duplicates">
                    {data.duplicates}
                  </span>,
                ],
              ]}
            />
          </div>
        )}
      </Gate>
    </PaySection>
  );
}

/** How a receiver checks a delivery: the headers, the tolerance, the raw body, the sender addresses and a published vector. */
function ReceiverGuide({ api }: { api: Pick<SettingsBApi, 'webhookGuide'> }) {
  const { t } = c.useCopy();
  const guide = useResource((signal) => api.webhookGuide(signal), 'dev:guide');
  return (
    <PaySection title={t('guideTitle')} description={t('guideBody')}>
      <Gate resource={guide.resource} retry={guide.reload}>
        {(g) => (
          <div className="stack" data-testid="webhook-guide">
            <Facts
              items={[
                [t('guideTimestamp'), t('guideTimestampBody', { header: g.headers.timestamp })],
                [
                  t('guideTolerance'),
                  <span key="t" data-testid="webhook-guide-tolerance">
                    {g.toleranceSeconds === null ? t('guideToleranceUnset') : t('guideToleranceBody', { n: g.toleranceSeconds })}
                  </span>,
                ],
                [t('guideRawBody'), t('guideRawBodyBody')],
                [
                  t('guideSignature'),
                  <span key="s">
                    <code>{g.headers.signature}</code>: {g.algorithm}
                  </span>,
                ],
                [
                  t('guideSenderIps'),
                  <span key="i" data-testid="webhook-guide-sender-ips">
                    {g.senderIps ? g.senderIps.join(', ') : t('guideSenderIpsUnset')}
                  </span>,
                ],
              ]}
            />
            <section aria-label={t('guideVectorTitle')} data-testid="webhook-guide-vector">
              <h4>{t('guideVectorTitle')}</h4>
              <p className="muted">{t('guideVectorBody')}</p>
              <Facts
                items={[
                  [t('vectorSecret'), <code key="s">{g.vector.secret}</code>],
                  [t('vectorTimestamp'), <code key="t">{g.vector.timestamp}</code>],
                  [
                    t('vectorBody'),
                    <code key="b" className="pp-wrap">
                      {g.vector.body}
                    </code>,
                  ],
                  [
                    t('vectorSignature'),
                    <code key="g" className="pp-wrap">
                      {g.vector.signature}
                    </code>,
                  ],
                ]}
              />
            </section>
            <SignatureChecker vector={g.vector} />
          </div>
        )}
      </Gate>
    </PaySection>
  );
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA256 of `timestamp.body` with the secret, in the browser. Null when the browser has no Web Crypto. */
async function signInBrowser(secret: string, timestamp: string, body: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const enc = new TextEncoder();
  const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`)));
}

/** The receiver's check, run on what the person pastes. Nothing leaves the page. */
function SignatureChecker({ vector }: { vector: Guide['vector'] }) {
  const { t } = c.useCopy();
  const [secret, setSecret] = useState('');
  const [timestamp, setTimestamp] = useState('');
  const [body, setBody] = useState('');
  const [signature, setSignature] = useState('');
  const [verdict, setVerdict] = useState<'valid' | 'invalid' | 'unavailable' | null>(null);
  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setVerdict(null);
  };
  return (
    <section aria-label={t('checkerTitle')} data-testid="webhook-checker">
      <h4>{t('checkerTitle')}</h4>
      <p className="muted">{t('checkerBody')}</p>
      <div className="form-stack pp-form">
        <Button
          variant="secondary"
          onClick={() => {
            setSecret(vector.secret);
            setTimestamp(vector.timestamp);
            setBody(vector.body);
            setSignature(vector.signature);
            setVerdict(null);
          }}
        >
          {t('checkerUseVector')}
        </Button>
        <Field label={t('checkerSecret')} value={secret} onChange={edit(setSecret)} autoComplete="off" />
        <Field label={t('checkerTimestamp')} value={timestamp} onChange={edit(setTimestamp)} inputMode="numeric" />
        <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium text-fg-2">
          <span>{t('checkerBodyLabel')}</span>
          <textarea className="pp-code" rows={4} value={body} onChange={edit(setBody)} spellCheck={false} />
        </label>
        <Field label={t('checkerSignature')} value={signature} onChange={edit(setSignature)} autoComplete="off" />
        <Button
          variant="primary"
          disabled={!secret || !timestamp || !signature}
          onClick={async () => {
            const expected = await signInBrowser(secret, timestamp, body).catch(() => null);
            if (expected === null) return setVerdict('unavailable');
            setVerdict(signature.split(',').some((s) => s.trim().toLowerCase() === expected) ? 'valid' : 'invalid');
          }}
        >
          {t('checkerRun')}
        </Button>
        {verdict && (
          <p
            role="status"
            data-testid="webhook-checker-verdict"
            className={verdict === 'valid' ? 'pay-confirmed' : 'pp-callout pp-callout--warn'}
          >
            {verdict === 'valid' ? t('checkerValid') : verdict === 'invalid' ? t('checkerInvalid') : t('checkerUnavailable')}
          </p>
        )}
      </div>
    </section>
  );
}
