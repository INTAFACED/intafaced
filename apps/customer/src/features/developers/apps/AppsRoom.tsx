import { useMemo, useState, type FormEvent } from 'react';
import { OAUTH_REDIRECT_URLS_MAX, type OAuthApp } from '@intafaced/contracts/oauth';
import { Button } from '@intafaced/ui';
import { EmptyState, Failure, Loading, Page } from '../../../shared/ui';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session/session';
import { appsCopy, refusalCopyKey } from './apps-copy';
import { firstBadRedirect, parseRedirectInput, parseScopeInput } from './oauth-model';
import { readApps, readLifetimes, registerApp, rollSecret } from './oauth-api';
import './apps.css';

type T = ReturnType<typeof appsCopy.useCopy>['t'];
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Shown = { name: string; secret: string | null; replay: boolean };

/** The service's own `oauth.*` code in the person's words; any other refusal says it was refused and shows its code. */
export function Refused({ failure, t }: { failure: Refusal; t: T }) {
  const code = failure.code;
  const key = refusalCopyKey(code);
  const known = key ? t(key) : t('otherRefusal');
  return (
    <div role="alert" className="apps-refused">
      <strong>{t('refusedHeading')}</strong>
      <p>{known}</p>
      {code ? (
        <p className="muted">
          {t('codeLabel')}: <code>{code}</code>
        </p>
      ) : null}
    </div>
  );
}
function SecretPanel({ shown, onDone, t }: { shown: Shown; onDone: () => void; t: T }) {
  return (
    <section className="apps-secret" role="status" aria-label={t('secretTitle', { name: shown.name })}>
      <h2>{t('secretTitle', { name: shown.name })}</h2>
      {shown.secret ? (
        <>
          <p>{t('secretOnce')}</p>
          <code className="apps-secret__value" data-testid="client-secret">
            {shown.secret}
          </code>
        </>
      ) : (
        <p>{shown.replay ? t('replay', { name: shown.name }) : t('secretPublic', { name: shown.name })}</p>
      )}
      <Button variant="secondary" size={40} onClick={onDone}>
        {t('secretDone')}
      </Button>
    </section>
  );
}

function AppRow({ app, onRolled, t }: { app: OAuthApp; onRolled: (shown: Shown) => void; t: T }) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const status = { pending: 'statusPending', approved: 'statusApproved', suspended: 'statusSuspended' } as const;
  async function roll() {
    setBusy(true);
    setRefused(null);
    const result = await rollSecret(api, app);
    setBusy(false);
    if (!result.ok) return setRefused(result);
    onRolled({ name: app.name, secret: result.data.clientSecret, replay: result.data.clientSecret === null });
  }
  return (
    <li className="apps-row" data-status={app.status} data-testid={`app-${app.clientId}`}>
      <h3>{app.name}</h3>
      {app.description ? <p>{app.description}</p> : null}
      <p>{t(status[app.status])}</p>
      <dl>
        <dt>{t('clientId')}</dt>
        <dd>
          <code>{app.clientId}</code>
        </dd>
        <dt>{t('redirects')}</dt>
        <dd>
          <ul>
            {app.redirectUrls.map((url) => (
              <li key={url}>
                <code>{url}</code>
              </li>
            ))}
          </ul>
        </dd>
        <dt>{t('scopes')}</dt>
        <dd>
          <code>{app.scopes.join(' ')}</code>
        </dd>
        <dt />
        <dd>{app.confidential ? t('kindConfidential') : t('kindPublic')}</dd>
      </dl>
      {app.secretRolledAt ? <p className="muted">{t('secretRolledAt', { when: app.secretRolledAt })}</p> : null}
      {app.confidential ? (
        <>
          <p className="muted">{t('rollNote')}</p>
          <Button variant="secondary" size={40} disabled={busy} onClick={roll}>
            {busy ? t('rolling') : t('rollSecret')}
          </Button>
        </>
      ) : null}
      {refused ? <Refused failure={refused} t={t} /> : null}
    </li>
  );
}

function RegisterForm({ onDone, t }: { onDone: (shown: Shown) => void; t: T }) {
  const { api, userId } = useSession();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [redirects, setRedirects] = useState('');
  const [scopes, setScopes] = useState('');
  const [confidential, setConfidential] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !userId) return;
    const redirectUrls = parseRedirectInput(redirects);
    const scopeList = parseScopeInput(scopes);
    const bad = firstBadRedirect(redirectUrls);
    const found =
      name.trim().length < 2
        ? t('needName')
        : redirectUrls.length === 0
          ? t('needRedirect')
          : redirectUrls.length > OAUTH_REDIRECT_URLS_MAX
            ? t('manyRedirects', { limit: OAUTH_REDIRECT_URLS_MAX })
            : bad
              ? t('badRedirect', { url: bad })
              : scopeList.length === 0
                ? t('needScope')
                : null;
    setProblem(found);
    setRefused(null);
    if (found) return;
    setBusy(true);
    const result = await registerApp(api, userId, {
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      redirectUrls,
      scopes: scopeList,
      confidential,
    });
    setBusy(false);
    if (!result.ok) return setRefused(result);
    setName('');
    setDescription('');
    setRedirects('');
    setScopes('');
    onDone({
      name: result.data.app.name,
      secret: result.data.clientSecret,
      replay: result.data.clientSecret === null && result.data.app.confidential,
    });
  }
  return (
    <form className="apps-form" onSubmit={submit} noValidate>
      <h2>{t('formHeading')}</h2>
      <label className="field">
        <span>{t('name')}</span>
        <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} autoComplete="off" />
      </label>
      <label className="field">
        <span>{t('description')}</span>
        <input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} autoComplete="off" />
        <small>{t('descriptionHint')}</small>
      </label>
      <label className="field">
        <span>{t('redirectsField')}</span>
        <textarea value={redirects} rows={3} onChange={(event) => setRedirects(event.target.value)} spellCheck={false} />
        <small>{t('redirectsHint')}</small>
      </label>
      <label className="field">
        <span>{t('scopesField')}</span>
        <textarea value={scopes} rows={3} onChange={(event) => setScopes(event.target.value)} spellCheck={false} />
        <small>{t('scopesHint')}</small>
      </label>
      <fieldset className="apps-kind">
        <legend>{t('kindField')}</legend>
        <label>
          <input type="radio" name="kind" checked={confidential} onChange={() => setConfidential(true)} /> {t('kindConfidential')}
        </label>
        <label>
          <input type="radio" name="kind" checked={!confidential} onChange={() => setConfidential(false)} /> {t('kindPublic')}
        </label>
      </fieldset>
      {problem ? (
        <p role="alert" className="error-text">
          {problem}
        </p>
      ) : null}
      {refused ? <Refused failure={refused} t={t} /> : null}
      <Button type="submit" disabled={busy}>
        {busy ? t('submitting') : t('submit')}
      </Button>
    </form>
  );
}

/** /developers/apps: the developer's own OAuth apps, the registration form, and the one-time client secret. */
export function AppsRoom() {
  const { t } = appsCopy.useCopy();
  const { api, userId } = useSession();
  const [shown, setShown] = useState<Shown | null>(null);
  const apps = useResource(
    (signal) => (userId ? readApps(api, signal) : Promise.resolve({ ok: true as const, data: { apps: [] as OAuthApp[] } })),
    `oauth-apps:${userId ?? 'out'}`,
  );
  const lifetimes = useResource(
    (signal) =>
      userId
        ? readLifetimes(api, signal)
        : Promise.resolve({
            ok: true as const,
            data: { codeTtlSeconds: null as number | null, accessTokenTtlSeconds: null as number | null },
          }),
    `oauth-lifetimes:${userId ?? 'out'}`,
  );
  // Blank lifetimes are the room's blocker: apps can be registered, but none can sign a person in until both are set.
  const unset =
    lifetimes.resource.status === 'ready' &&
    (lifetimes.resource.data.codeTtlSeconds === null || lifetimes.resource.data.accessTokenTtlSeconds === null);
  const reload = apps.reload;
  const onDone = useMemo(
    () => (value: Shown) => {
      setShown(value);
      reload();
    },
    [reload],
  );
  if (!userId)
    return (
      <Page eyebrow={t('eyebrow')} title={t('title')} description={t('lead')}>
        <EmptyState
          title={t('signedOutTitle')}
          action={
            <a className="button button--primary" href="/login?redirect=%2Fdevelopers%2Fapps">
              {t('signIn')}
            </a>
          }
        >
          {t('signedOutBody')}
        </EmptyState>
      </Page>
    );
  return (
    <Page eyebrow={t('eyebrow')} title={t('title')} description={t('lead')}>
      <div className="apps-room" data-testid="developers-apps">
        {unset ? (
          <p role="status" className="apps-unset" data-code="oauth.lifetime_unset">
            {t('oauth.lifetime_unset')}
          </p>
        ) : null}
        {shown ? <SecretPanel shown={shown} onDone={() => setShown(null)} t={t} /> : null}
        <section aria-labelledby="apps-list">
          <h2 id="apps-list">{t('listHeading')}</h2>
          {apps.resource.status === 'loading' ? (
            <Loading label={t('loading')} />
          ) : apps.resource.status === 'failed' ? (
            <div role="alert">
              <p>{t('readFailed')}</p>
              <Failure result={apps.resource.failure} retry={apps.reload} />
            </div>
          ) : apps.resource.data.apps.length === 0 ? (
            <p>{t('empty')}</p>
          ) : (
            <ul className="apps-list">
              {apps.resource.data.apps.map((app) => (
                <AppRow key={app.id} app={app} onRolled={onDone} t={t} />
              ))}
            </ul>
          )}
        </section>
        <RegisterForm onDone={onDone} t={t} />
      </div>
    </Page>
  );
}
