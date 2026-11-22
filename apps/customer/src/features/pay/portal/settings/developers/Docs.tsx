import { useState, type ReactNode } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { KeyValue, RefusalBox } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../../../shared/api';
import { useResource, type Resource } from '../../../../../shared/resource';
import { portalCopy } from '../../copy';
import { reason } from '../../chrome/copy';
import { isNotLive, notLiveReason, refusalText, refusalTitle } from '../../refusal';
import type { SettingsBApi } from '../b-client';
import type { Guide } from './schemas';
import { developersCopy as c } from './copy';
import { signingSnippets, verifySnippets, type SnippetLanguage } from './model';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** One part of the guide: its heading, what it is for, and its content. */
function Part({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`docs-${id}`} data-testid="pay-section">
      <h2 id={`docs-${id}`}>{title}</h2>
      {description && <p className="lt-hint">{description}</p>}
      {children}
    </section>
  );
}

/** A part that is not live: what it waits for, the allowlisted blocker's code, and its own words. Never a fake row. */
function NotLive({
  reason: why,
  title,
  needs,
  code,
  children,
}: {
  reason: string;
  title?: string;
  needs?: string;
  code?: string;
  children?: ReactNode;
}) {
  return (
    <section
      className="lt-refusal"
      data-refusal="parked"
      data-testid="pfo-soon"
      aria-label={title ?? why}
      data-needs={needs}
      data-code={code}
    >
      <p className="lt-refusal-title">{why}</p>
      {code && (
        <p className="lt-ref">
          <code>{code}</code>
        </p>
      )}
      {title && <h3>{title}</h3>}
      {children && <p className="lt-refusal-body">{children}</p>}
    </section>
  );
}

/** A refused read in plain words, or the not-live card when the service has not switched the feature on. */
function Refused({ result, retry }: { result: Failed; retry: () => void }) {
  const { t } = portalCopy.useCopy();
  if (isNotLive(result)) return <NotLive reason={notLiveReason(result)} />;
  return (
    <div data-testid="failure">
      <RefusalBox
        refusal={{
          variant: result.reason === 'unreachable' ? 'unreachable' : 'refused',
          title: refusalTitle(result),
          body: refusalText(result),
          reference: result.requestId,
        }}
      />
      {result.reason === 'unauthorized' ? (
        <a
          className="lt-link"
          href={`/login?redirect=${encodeURIComponent(typeof location === 'undefined' ? '/pay/merchant' : location.pathname + location.search)}`}
        >
          {t('signIn')}
        </a>
      ) : // Asking again never turns a "you may not" into a "yes", so a refusal for permission has no Try again.
      result.reason !== 'uncertain' && result.reason !== 'forbidden' ? (
        <Button onClick={retry}>{t('tryAgain')}</Button>
      ) : null}
    </div>
  );
}

/** Loading and refusal for one read that is not a list. */
function Read<T>({ resource, retry, children }: { resource: Resource<T>; retry: () => void; children: (data: T) => ReactNode }) {
  const { t } = portalCopy.useCopy();
  if (resource.status === 'loading')
    return (
      <p className="lt-hint" role="status">
        {t('loading')}
      </p>
    );
  if (resource.status === 'failed') return <Refused result={resource.failure} retry={retry} />;
  return <>{children(resource.data)}</>;
}

/** The same sample in each language a merchant may write, one picked at a time. */
function CodeTabs({
  lang,
  setLang,
  snippets,
}: {
  lang: SnippetLanguage;
  setLang: (l: SnippetLanguage) => void;
  snippets: Record<SnippetLanguage, string>;
}) {
  const { t } = c.useCopy();
  return (
    <div>
      <div role="group" aria-label={t('language')} className="lt-actions">
        {(['typescript', 'python'] as const).map((l) => (
          <Button key={l} tone={lang === l ? 'secondary' : 'quiet'} aria-pressed={lang === l} onClick={() => setLang(l)}>
            {l === 'typescript' ? 'TypeScript' : 'Python'}
          </Button>
        ))}
      </div>
      <pre className="lt-code" tabIndex={0} aria-label={t('codeSample', { language: lang === 'typescript' ? 'TypeScript' : 'Python' })}>
        <code>{snippets[lang]}</code>
      </pre>
    </div>
  );
}

/** Plain written guidance for the merchant's own integration. Nothing here is an operator or founder tool. */
export function Docs({ api }: { api?: Pick<SettingsBApi, 'webhookCatalogue' | 'webhookGuide'> } = {}) {
  const { t } = c.useCopy();
  const [signLang, setSignLang] = useState<SnippetLanguage>('typescript');
  const [verifyLang, setVerifyLang] = useState<SnippetLanguage>('typescript');
  return (
    <>
      <Part id="start" title={t('docsStartTitle')} description={t('docsStartBody')}>
        <ol>
          <li>
            <a className="lt-link" href="/pay/developer/keys#create">
              {t('docsStep1')}
            </a>
          </li>
          <li>{t('docsStep2')}</li>
          <li>
            <a className="lt-link" href="/pay/developer/webhooks#add">
              {t('docsStep3')}
            </a>
          </li>
          <li>{t('docsStep4')}</li>
        </ol>
      </Part>
      <Part id="keys" title={t('docsKeysTitle')}>
        <p>{t('docsKeysBody')}</p>
        <ul>
          <li>{t('docsKeysRead')}</li>
          <li>{t('docsKeysWrite')}</li>
          <li>{t('docsKeysRefund')}</li>
        </ul>
      </Part>
      <Part id="sign" title={t('docsSignTitle')} description={t('docsSignBody')}>
        <pre className="lt-code" aria-label={t('recipeCanonical')}>
          {'INTAFACED-REQ-V1\nMETHOD\n/path?query\ntimestamp\nnonce\nbody-sha256'}
        </pre>
        <p className="lt-hint">{t('recipeWindow')}</p>
        <CodeTabs lang={signLang} setLang={setSignLang} snippets={signingSnippets} />
        <a className="lt-link" href="/pay/developer/signing">
          {t('docsSignLink')}
        </a>
      </Part>
      <Part id="events" title={t('docsEventsTitle')} description={t('docsEventsBody')}>
        <ul>
          <li>{t('docsEventsOnce')}</li>
          <li>{t('docsEventsRetry')}</li>
          <li>{t('docsEventsSecret')}</li>
        </ul>
        <CodeTabs lang={verifyLang} setLang={setVerifyLang} snippets={verifySnippets} />
        <a className="lt-link" href="/pay/developer/webhooks">
          {t('docsEventsLink')}
        </a>
      </Part>
      {api && <EventCatalogue api={api} />}
      {api && <ReceiverGuide api={api} />}
      <Part id="sdk" title={t('docsSdkTitle')}>
        <NotLive reason={reason('reasonDocs')} title={t('docsSdkCardTitle')} needs="SDK publishing decision" code="owner.decision">
          {t('docsSdkBody')}
        </NotLive>
      </Part>
    </>
  );
}

/** Every public event type, its body schema, and how to order and de-duplicate them. Read from the service. */
function EventCatalogue({ api }: { api: Pick<SettingsBApi, 'webhookCatalogue'> }) {
  const { t } = c.useCopy();
  const catalogue = useResource((signal) => api.webhookCatalogue(signal), 'dev:catalogue');
  return (
    <Part id="catalogue" title={t('catalogueTitle')} description={t('catalogueBody')}>
      <Read resource={catalogue.resource} retry={catalogue.reload}>
        {(data) => (
          <div data-testid="webhook-catalogue">
            {data.events.map((event) => (
              <article key={event.type} data-testid="webhook-catalogue-event" aria-label={event.type}>
                <h4>
                  <code>{event.type}</code>
                </h4>
                <p>{event.summary}</p>
                <pre className="lt-code" aria-label={t('catalogueSchema', { type: event.type })}>
                  {JSON.stringify(event.payloadSchema, null, 2)}
                </pre>
              </article>
            ))}
            <KeyValue
              rows={[
                { label: t('catalogueOrdering'), value: <span data-testid="webhook-catalogue-ordering">{data.ordering}</span> },
                { label: t('catalogueDuplicates'), value: <span data-testid="webhook-catalogue-duplicates">{data.duplicates}</span> },
              ]}
            />
          </div>
        )}
      </Read>
    </Part>
  );
}

/** How a receiver checks a delivery: the headers, the tolerance, the raw body, the sender addresses and a published vector. */
function ReceiverGuide({ api }: { api: Pick<SettingsBApi, 'webhookGuide'> }) {
  const { t } = c.useCopy();
  const guide = useResource((signal) => api.webhookGuide(signal), 'dev:guide');
  return (
    <Part id="guide" title={t('guideTitle')} description={t('guideBody')}>
      <Read resource={guide.resource} retry={guide.reload}>
        {(g) => (
          <div data-testid="webhook-guide">
            <KeyValue
              rows={[
                { label: t('guideTimestamp'), value: t('guideTimestampBody', { header: g.headers.timestamp }) },
                {
                  label: t('guideTolerance'),
                  value: (
                    <span data-testid="webhook-guide-tolerance">
                      {g.toleranceSeconds === null ? t('guideToleranceUnset') : t('guideToleranceBody', { n: g.toleranceSeconds })}
                    </span>
                  ),
                },
                { label: t('guideRawBody'), value: t('guideRawBodyBody') },
                {
                  label: t('guideSignature'),
                  value: (
                    <span>
                      <code>{g.headers.signature}</code>: {g.algorithm}
                    </span>
                  ),
                },
                {
                  label: t('guideSenderIps'),
                  value: (
                    <span data-testid="webhook-guide-sender-ips">{g.senderIps ? g.senderIps.join(', ') : t('guideSenderIpsUnset')}</span>
                  ),
                },
              ]}
            />
            <section aria-label={t('guideVectorTitle')} data-testid="webhook-guide-vector">
              <h4>{t('guideVectorTitle')}</h4>
              <p className="lt-hint">{t('guideVectorBody')}</p>
              <KeyValue
                rows={[
                  { label: t('vectorSecret'), value: <code>{g.vector.secret}</code>, ltr: true },
                  { label: t('vectorTimestamp'), value: <code>{g.vector.timestamp}</code>, ltr: true },
                  { label: t('vectorBody'), value: <code className="lt-wrap">{g.vector.body}</code>, ltr: true },
                  { label: t('vectorSignature'), value: <code className="lt-wrap">{g.vector.signature}</code>, ltr: true },
                ]}
              />
            </section>
            <SignatureChecker vector={g.vector} />
          </div>
        )}
      </Read>
    </Part>
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
      <p className="lt-hint">{t('checkerBody')}</p>
      <form className="lt-reading-main" onSubmit={(event) => event.preventDefault()}>
        <div className="lt-actions">
          <Button
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
        </div>
        <Field label={t('checkerSecret')} value={secret} onChange={edit(setSecret)} autoComplete="off" />
        <Field label={t('checkerTimestamp')} value={timestamp} onChange={edit(setTimestamp)} inputMode="numeric" />
        <label className="lt-field">
          <span>{t('checkerBodyLabel')}</span>
          <textarea className="lt-mono" rows={4} value={body} onChange={edit(setBody)} spellCheck={false} />
        </label>
        <Field label={t('checkerSignature')} value={signature} onChange={edit(setSignature)} autoComplete="off" />
        <div className="lt-actions">
          <Button
            tone="primary"
            disabled={!secret || !timestamp || !signature}
            onClick={async () => {
              const expected = await signInBrowser(secret, timestamp, body).catch(() => null);
              if (expected === null) return setVerdict('unavailable');
              setVerdict(signature.split(',').some((s) => s.trim().toLowerCase() === expected) ? 'valid' : 'invalid');
            }}
          >
            {t('checkerRun')}
          </Button>
        </div>
        {verdict && (
          <p role="status" data-testid="webhook-checker-verdict" data-verdict={verdict} data-dir={verdict === 'valid' ? 'up' : 'down'}>
            {verdict === 'valid' ? t('checkerValid') : verdict === 'invalid' ? t('checkerInvalid') : t('checkerUnavailable')}
          </p>
        )}
      </form>
    </section>
  );
}
