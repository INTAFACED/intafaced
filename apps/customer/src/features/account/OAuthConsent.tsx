import { useMemo, useRef, useState } from 'react';
import { Button } from '@intafaced/ui';
import { EmptyState, Failure, Loading, Page } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { useSession } from '../session/session';
import { appsCopy, scopeCopyKey } from '../developers/apps/apps-copy';
import { Refused } from '../developers/apps/AppsRoom';
import { decideAuthorize, previewAuthorize } from '../developers/apps/oauth-api';
import { followableRedirect, parseAuthorizeSearch } from '../developers/apps/oauth-model';
import '../developers/apps/apps.css';

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
  const eyebrow = t('consentEyebrow');
  if (!parsed.ok)
    return (
      <Page eyebrow={eyebrow} title={t('problemTitle')}>
        <div className="consent-room" role="alert">
          <p>{t('problemBody')}</p>
          <p>{t(`problem_${parsed.problem}` as const)}</p>
        </div>
      </Page>
    );
  if (!userId)
    return (
      <Page eyebrow={eyebrow} title={t('consentSignedOutTitle')}>
        <EmptyState
          title={t('consentSignedOutTitle')}
          action={
            <a className="button button--primary" href={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`}>
              {t('signIn')}
            </a>
          }
        >
          {t('consentSignedOutBody')}
        </EmptyState>
      </Page>
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
    location.assign(target);
  }
  if (preview.resource.status === 'loading') return <Loading label={t('consentLoading')} />;
  if (preview.resource.status === 'failed')
    return (
      <Page eyebrow={eyebrow} title={t('consentFailed')}>
        <div className="consent-room">
          {preview.resource.failure.code?.startsWith('oauth.') ? (
            <Refused failure={preview.resource.failure} t={t} />
          ) : (
            <Failure result={preview.resource.failure} retry={preview.reload} />
          )}
        </div>
      </Page>
    );
  const info = preview.resource.data;
  return (
    <Page eyebrow={eyebrow} title={t('consentTitle', { app: info.appName })}>
      <div className="consent-room" data-testid="oauth-consent">
        {info.logoUrl ? <img src={info.logoUrl} alt="" width={48} height={48} referrerPolicy="no-referrer" /> : null}
        {info.appDescription ? <p>{info.appDescription}</p> : null}
        {info.developerOwnAccount ? <p className="risk-note">{t('consentOwn')}</p> : null}
        <p>{t('consentLead', { app: info.appName })}</p>
        <ul className="consent-scopes">
          {info.scopes.map((scope) => {
            const key = scopeCopyKey(scope);
            return (
              <li key={scope}>
                <strong>{key ? t(key) : scope}</strong>
                <br />
                <code>{scope}</code>
                {key ? null : <span className="muted"> · {t('consentNoDescription')}</span>}
              </li>
            );
          })}
        </ul>
        <p className="muted">{t('consentNote')}</p>
        {stopped === 'done' ? <p role="status">{t('consentDone')}</p> : null}
        {stopped === 'no-redirect' ? (
          <p role="alert">
            {t('consentNoRedirect')} <a href="/home">{t('consentGoBack')}</a>
          </p>
        ) : null}
        {refused ? <Refused failure={refused} t={t} /> : null}
        {stopped ? null : (
          <div className="consent-actions">
            <Button disabled={busy !== null} onClick={() => decide('allow')}>
              {busy === 'allow' ? t('sending') : t('allow')}
            </Button>
            <Button variant="secondary" disabled={busy !== null} onClick={() => decide('deny')}>
              {busy === 'deny' ? t('sending') : t('deny')}
            </Button>
          </div>
        )}
      </div>
    </Page>
  );
}
