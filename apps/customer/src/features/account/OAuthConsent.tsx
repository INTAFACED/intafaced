// volt-room: /oauth/authorize
import { useMemo, useRef, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { useSession } from '../session';
import { Empty, Failure, Loading } from './kit-parts';
import {
  appsCopy,
  decideAuthorize,
  followableRedirect,
  parseAuthorizeSearch,
  previewAuthorize,
  Refused,
  scopeCopyKey,
} from '../developers';
import { leaveTo } from '../../app/location';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * /oauth/authorize: an app asks to use the signed-in person's account. The request is read from the address and refused on
 * the page, with no redirect, when it lacks `state`, a PKCE challenge or S256: the page cannot trust a return address it has
 * not checked. The service checks the app, its return address and its scopes; nothing is issued until the person presses Allow.
 */
export function OAuthConsent() {
  const { t } = appsCopy.useCopy();
  const { api, userId } = useSession();
  const parsed = useMemo(() => parseAuthorizeSearch(location.search), []);
  const request = parsed.ok ? parsed.request : null;
  const preview = useResource(
    (signal) =>
      request && userId
        ? previewAuthorize(api, request, signal)
        : Promise.resolve({ ok: false as const, reason: 'error' as const, message: '' }),
    `oauth-preview:${userId ?? 'out'}:${request?.clientId ?? ''}`,
  );
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const sent = useRef(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [stopped, setStopped] = useState<'no-redirect' | 'done' | null>(null);
  if (!parsed.ok)
    return (
      <FlowTemplate
        title={t('problemTitle')}
        state={{ kind: 'ready' }}
        step={
          <div className="lt-stack" role="alert">
            <p className="lt-muted">{t('problemBody')}</p>
            <p>{t(`problem_${parsed.problem}` as const)}</p>
          </div>
        }
      />
    );
  if (!userId)
    return (
      <FlowTemplate
        title={t('consentSignedOutTitle')}
        state={{ kind: 'ready' }}
        step={
          <Empty
            title={t('consentSignedOutTitle')}
            action={
              <a
                className="lt-button lt-button-primary"
                href={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`}
              >
                {t('signIn')}
              </a>
            }
          >
            {t('consentSignedOutBody')}
          </Empty>
        }
      />
    );
  async function decide(decision: 'allow' | 'deny') {
    if (sent.current || !request) return;
    sent.current = true;
    setBusy(decision);
    setRefused(null);
    const result = await decideAuthorize(api, request, decision);
    if (!result.ok) {
      // The answer may or may not have been recorded: a lost reply is not retried by the page.
      sent.current = result.reason === 'uncertain';
      setBusy(null);
      return setRefused(result);
    }
    const target = followableRedirect(result.data.redirectTo);
    if (!target) {
      setBusy(null);
      return setStopped('no-redirect');
    }
    setStopped('done');
    leaveTo(target);
  }
  if (preview.resource.status === 'loading')
    return <FlowTemplate title={t('consentLoading')} state={{ kind: 'ready' }} step={<Loading label={t('consentLoading')} />} />;
  if (preview.resource.status === 'failed')
    return (
      <FlowTemplate
        title={t('consentFailed')}
        state={{ kind: 'ready' }}
        step={
          <div className="lt-stack">
            {preview.resource.failure.code?.startsWith('oauth.') ? (
              <Refused failure={preview.resource.failure} t={t} />
            ) : (
              <Failure result={preview.resource.failure} retry={preview.reload} />
            )}
          </div>
        }
      />
    );
  const info = preview.resource.data;
  return (
    <div data-testid="oauth-consent">
      <FlowTemplate
        title={t('consentTitle', { app: info.appName })}
        description={info.appDescription ?? undefined}
        state={{ kind: 'ready' }}
        step={
          <div className="lt-stack">
            {info.logoUrl ? <img src={info.logoUrl} alt="" width={48} height={48} referrerPolicy="no-referrer" /> : null}
            {info.developerOwnAccount ? <p className="lt-note lt-note-warn">{t('consentOwn')}</p> : null}
            <p>{t('consentLead', { app: info.appName })}</p>
            <ul className="lt-list lt-list-rule">
              {info.scopes.map((scope) => {
                const key = scopeCopyKey(scope);
                return (
                  <li key={scope} className="lt-stack-tight">
                    <strong>{key ? t(key) : scope}</strong>
                    <span>
                      <code className="lt-mono">{scope}</code>
                      {key ? null : <span className="lt-muted"> · {t('consentNoDescription')}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="lt-muted">{t('consentNote')}</p>
            {stopped === 'done' ? <p role="status">{t('consentDone')}</p> : null}
            {stopped === 'no-redirect' ? (
              <p role="alert">
                {t('consentNoRedirect')}{' '}
                <a className="lt-link" href="/home">
                  {t('consentGoBack')}
                </a>
              </p>
            ) : null}
            {refused ? <Refused failure={refused} t={t} /> : null}
          </div>
        }
        actions={
          stopped ? undefined : (
            <div className="lt-actions">
              <Button tone="primary" disabled={busy !== null} onClick={() => decide('allow')}>
                {busy === 'allow' ? t('sending') : t('allow')}
              </Button>
              <Button tone="secondary" disabled={busy !== null} onClick={() => decide('deny')}>
                {busy === 'deny' ? t('sending') : t('deny')}
              </Button>
            </div>
          )
        }
      />
    </div>
  );
}
