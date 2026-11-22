// volt-room: /oauth/authorize
import { useMemo, useRef, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { FlowTemplate, type Refusal, type RoomState } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { useSession } from '../session';
import { failureRefusal } from './failure-refusal';
import {
  appsCopy,
  decideAuthorize,
  followableRedirect,
  parseAuthorizeSearch,
  previewAuthorize,
  refusalCopyKey,
  scopeCopyKey,
} from '../developers';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type T = ReturnType<typeof appsCopy.useCopy>['t'];

/** The service's refusal in the developer area's own words, with its code as the reference. */
function serviceRefusal(failure: Failed, title: string, t: T): Refusal {
  const key = refusalCopyKey(failure.code);
  return {
    variant: failure.reason === 'uncertain' ? 'unreachable' : 'refused',
    title,
    body: key ? t(key) : t('otherRefusal'),
    reference: failure.code ? `${t('codeLabel')}: ${failure.code}` : undefined,
  };
}

/**
 * /oauth/authorize, on the flow template: an app asks to use the signed-in person's account. The request is read from the
 * address and refused on the page, with no redirect, when it lacks `state`, a PKCE challenge or S256: the page cannot trust
 * a return address it has not checked. The service checks the app, its return address and its scopes; nothing is issued
 * until the person presses Allow.
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
  const [refused, setRefused] = useState<Failed | null>(null);
  const [stopped, setStopped] = useState<'no-redirect' | 'done' | null>(null);
  const here = location.pathname + location.search;

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

  let title = t('consentFailed');
  let state: RoomState = { kind: 'ready' };
  if (!parsed.ok) {
    title = t('problemTitle');
    state = {
      kind: 'refused',
      refusal: { variant: 'refused', title: t('problemTitle'), body: `${t('problemBody')} ${t(`problem_${parsed.problem}` as const)}` },
    };
  } else if (!userId) {
    title = t('consentSignedOutTitle');
    state = {
      kind: 'refused',
      refusal: {
        variant: 'refused',
        title: t('consentSignedOutTitle'),
        body: t('consentSignedOutBody'),
        action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(here)}` },
      },
    };
  } else if (preview.resource.status === 'loading') {
    title = t('consentLoading');
    state = { kind: 'loading' };
  } else if (preview.resource.status === 'failed') {
    const failure = preview.resource.failure;
    state = {
      kind: 'refused',
      refusal: failure.code?.startsWith('oauth.') ? serviceRefusal(failure, t('consentFailed'), t) : failureRefusal(failure, here),
    };
  } else {
    title = t('consentTitle', { app: preview.resource.data.appName });
    if (refused) state = { kind: 'ready', partial: { missing: serviceRefusal(refused, t('refusedHeading'), t) } };
  }
  const info = state.kind === 'ready' && preview.resource.status === 'ready' ? preview.resource.data : null;

  return (
    <FlowTemplate
      title={title}
      state={state}
      step={
        info ? (
          <div data-testid="oauth-consent">
            {info.logoUrl ? <img src={info.logoUrl} alt="" width={48} height={48} referrerPolicy="no-referrer" /> : null}
            {info.appDescription ? <p>{info.appDescription}</p> : null}
            {info.developerOwnAccount ? (
              <p>
                <strong>{t('consentOwn')}</strong>
              </p>
            ) : null}
            <p>{t('consentLead', { app: info.appName })}</p>
            <ul>
              {info.scopes.map((scope) => {
                const key = scopeCopyKey(scope);
                return (
                  <li key={scope}>
                    <strong>{key ? t(key) : scope}</strong>
                    <br />
                    <code className="lt-mono">{scope}</code>
                    {key ? null : <span className="lt-hint"> · {t('consentNoDescription')}</span>}
                  </li>
                );
              })}
            </ul>
            {stopped === 'done' ? <p role="status">{t('consentDone')}</p> : null}
            {stopped === 'no-redirect' ? (
              <p role="alert">
                {t('consentNoRedirect')}{' '}
                <a className="lt-link" href="/home">
                  {t('consentGoBack')}
                </a>
              </p>
            ) : null}
          </div>
        ) : null
      }
      actions={
        info && !stopped ? (
          <div className="lt-actions">
            <Button tone="primary" disabled={busy !== null} onClick={() => decide('allow')}>
              {busy === 'allow' ? t('sending') : t('allow')}
            </Button>
            <Button disabled={busy !== null} onClick={() => decide('deny')}>
              {busy === 'deny' ? t('sending') : t('deny')}
            </Button>
          </div>
        ) : null
      }
      summary={info ? <p className="lt-hint">{t('consentNote')}</p> : null}
    />
  );
}
