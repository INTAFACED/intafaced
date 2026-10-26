import { useMemo } from 'react';
import type { ApiKeyRecord } from '@intafaced/contracts/api-keys';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Failure, Loading } from '../../shared/ui';
import { apiKeysCopy as copy } from './api-keys-copy';
import { readDeveloperKeys } from './developer-keys-api';
import './security.css';
import './api-keys.css';

/** What to do with a key, said once on the list and once on the create form. */
export function KeySafety() {
  const { t } = copy.useCopy();
  return (
    <section data-testid="security__card" className="api-keys__safety security__card" aria-labelledby="api-keys-safety">
      <h2 id="api-keys-safety">{t('safetyTitle')}</h2>
      <ul>
        <li>{t('safetyOnePurpose')}</li>
        <li>{t('safetyLeast')}</li>
        <li>{t('safetySource')}</li>
        <li>{t('safetyIps')}</li>
        <li>{t('safetyAgents')}</li>
        <li>{t('safetyWithdraw')}</li>
      </ul>
    </section>
  );
}

function stateOf(key: ApiKeyRecord, now: number): 'stateRevoked' | 'stateEnded' | 'stateActive' {
  if (key.revoked) return 'stateRevoked';
  if (key.expiresAt !== null && Date.parse(key.expiresAt) <= now) return 'stateEnded';
  return 'stateActive';
}

/**
 * The developer room's key list (`/uc/safe/api-keys`, DV-keys-01 and DV-keys-03, J-developer-03 #1): the safety
 * guidance even with no keys, the owner's key cap and how much of it is used, and every key with each column the
 * service returns. It never holds or shows a secret.
 */
export function ApiKeys() {
  const { t, languageFor, requestedLocale } = copy.useCopy();
  const { api, userId } = useSession();
  const { resource, reload } = useResource((signal) => readDeveloperKeys(api, signal), `developer-keys:${userId}`);
  const when = useMemo(
    () => new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }),
    [requestedLocale],
  );
  const at = (iso: string) => (
    <time dateTime={iso} dir="auto">
      {when.format(new Date(iso))} UTC
    </time>
  );
  const now = Date.now();
  return (
    <div className="api-keys" lang={languageFor('title')}>
      <header className="api-keys__head">
        <h1>{t('title')}</h1>
        <p className="muted">{t('intro')}</p>
        <a className="button button--primary" href="/uc/safe/api-keys/new">
          {t('create')}
        </a>
      </header>
      <KeySafety />
      {resource.status === 'loading' && <Loading label={t('loading')} />}
      {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
      {resource.status === 'ready' && (
        <>
          <section data-testid="security__card" className="api-keys__cap security__card" aria-labelledby="api-keys-cap" role="status">
            <h2 id="api-keys-cap">{t('capTitle')}</h2>
            <p>
              {resource.data.cap.limit === null
                ? t('capUnset')
                : resource.data.cap.live >= resource.data.cap.limit
                  ? `${t('capUsed', { live: resource.data.cap.live, limit: resource.data.cap.limit })} ${t('capFull')}`
                  : t('capUsed', { live: resource.data.cap.live, limit: resource.data.cap.limit })}
            </p>
          </section>
          {resource.data.keys.length === 0 ? (
            <p role="status">{t('empty')}</p>
          ) : (
            <div className="api-keys__table-wrap">
              <table data-testid="api-keys__table" className="api-keys__table">
                <thead>
                  <tr>
                    <th scope="col">{t('colName')}</th>
                    <th scope="col">{t('colPrefix')}</th>
                    <th scope="col">{t('colMode')}</th>
                    <th scope="col">{t('colScopes')}</th>
                    <th scope="col">{t('colIps')}</th>
                    <th scope="col">{t('colCreated')}</th>
                    <th scope="col">{t('colEnds')}</th>
                    <th scope="col">{t('colLastUsed')}</th>
                    <th scope="col">{t('colState')}</th>
                  </tr>
                </thead>
                <tbody>
                  {resource.data.keys.map((key) => (
                    <tr key={key.id} data-key-id={key.id}>
                      <th scope="row">
                        <bdi lang="und">{key.name}</bdi>
                      </th>
                      <td>
                        <code lang="und">{key.prefix}</code>
                      </td>
                      <td>{t(key.mode === 'live' ? 'modeLive' : 'modeSandbox')}</td>
                      <td>
                        <bdi lang="und">{key.scopes.join(', ')}</bdi>
                      </td>
                      <td>{key.ipAllowlist.length === 0 ? t('anyIp') : <bdi lang="und">{key.ipAllowlist.join(', ')}</bdi>}</td>
                      <td>{at(key.createdAt)}</td>
                      <td>{key.expiresAt === null ? t('noEnd') : at(key.expiresAt)}</td>
                      <td>{key.lastUsedAt === null ? t('neverUsed') : at(key.lastUsedAt)}</td>
                      <td>{t(stateOf(key, now))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted">
            {t('revokeWhere')}{' '}
            <a className="text-link" href="/uc/safe">
              {t('security')}
            </a>
          </p>
        </>
      )}
    </div>
  );
}
