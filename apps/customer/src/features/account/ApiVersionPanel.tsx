import { useRef, useState, type FormEvent } from 'react';
import { API_DEPRECATIONS, API_VERSIONS, LATEST_API_VERSION } from '@intafaced/contracts/api-versions';
import { IDENTITY_API_VERSION_GET, IDENTITY_API_VERSION_SET } from '@intafaced/contracts/identity-api-version-procedures';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Loading } from '../../shared/ui';
import { useSession } from '../session';
import { apiVersionCopy as copy } from './api-version-copy';

type Refused = 'refused.version.unknown' | 'refused.identity.api_version_session_only';
const NAMED: Readonly<Record<string, Refused>> = {
  'version.unknown': 'refused.version.unknown',
  'identity.api_version_session_only': 'refused.identity.api_version_session_only',
};

type Outcome =
  | { kind: 'saved' | 'unchanged'; version: string }
  | { kind: 'refused'; key: Refused }
  | { kind: 'failed'; failure: Extract<ApiResult<unknown>, { ok: false }> };

/**
 * The account default API version (J-developer-16 #5): what a key call without the `intafaced-version` header uses, the
 * versions the API publishes, and the deprecated fields with their replacement. The removal date of a deprecated field is
 * the owner's to set, and reads "removal date not set" until then.
 */
export function ApiVersionPanel() {
  const { t } = copy.useCopy();
  const { api, userId } = useSession();
  const { resource, reload } = useResource((signal) => api.call(IDENTITY_API_VERSION_GET, undefined, { signal }), `api-version:${userId}`);
  const [choice, setChoice] = useState<string>(LATEST_API_VERSION);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const sending = useRef(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setOutcome(null);
    try {
      const answer = await api.call(IDENTITY_API_VERSION_SET, { version: choice });
      if (answer.ok) {
        setOutcome({ kind: answer.data.changed ? 'saved' : 'unchanged', version: answer.data.version ?? choice });
        reload();
        return;
      }
      const named = answer.code ? NAMED[answer.code] : undefined;
      setOutcome(named ? { kind: 'refused', key: named } : { kind: 'failed', failure: answer });
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <section data-testid="api-version" className="api-keys__version security__card" aria-labelledby="api-version-title">
      <h2 id="api-version-title">{t('title')}</h2>
      <p className="muted">{t('intro')}</p>
      {resource.status === 'loading' && <Loading label={t('loading')} />}
      {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
      {resource.status === 'ready' && (
        <p data-testid="api-version__default">
          <strong>{t('defaultLabel')}</strong>:{' '}
          {resource.data.version === null ? (
            t('notSet')
          ) : (
            <>
              <code>{resource.data.version}</code>
              {resource.data.setAt ? (
                <span className="muted"> · {t('setAt', { when: `${resource.data.setAt.slice(0, 16).replace('T', ' ')} UTC` })}</span>
              ) : null}
            </>
          )}
        </p>
      )}
      <h3>{t('versionsTitle')}</h3>
      <ul data-testid="api-version__versions">
        {[...API_VERSIONS].reverse().map((version) => (
          <li key={version}>
            <code>{version}</code>
            {version === LATEST_API_VERSION ? ` · ${t('newest')}` : ''}
          </li>
        ))}
      </ul>
      <form className="api-keys__version-form" onSubmit={(event) => void save(event)}>
        <label>
          {t('choose')}{' '}
          <select value={choice} onChange={(event) => setChoice(event.target.value)} disabled={busy}>
            {[...API_VERSIONS].reverse().map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </select>
        </label>{' '}
        <Button type="submit" disabled={busy || resource.status !== 'ready'}>
          {busy ? t('saving') : t('save')}
        </Button>
      </form>
      {outcome?.kind === 'saved' || outcome?.kind === 'unchanged' ? (
        <p role="status" data-testid="api-version__outcome">
          {t(outcome.kind, { version: outcome.version })}
        </p>
      ) : null}
      {outcome?.kind === 'refused' ? (
        <p role="alert" data-testid="api-version__outcome">
          {t(outcome.key)}
        </p>
      ) : null}
      {outcome?.kind === 'failed' ? <Failure result={outcome.failure} /> : null}
      <h3>{t('deprecationsTitle')}</h3>
      {API_DEPRECATIONS.length === 0 ? (
        <p>{t('deprecationsNone')}</p>
      ) : (
        <table data-testid="api-version__deprecations">
          <thead>
            <tr>
              <th scope="col">{t('colField')}</th>
              <th scope="col">{t('colReplacement')}</th>
              <th scope="col">{t('colSince')}</th>
              <th scope="col">{t('colRemoval')}</th>
            </tr>
          </thead>
          <tbody>
            {API_DEPRECATIONS.map((d) => (
              <tr key={d.id}>
                <th scope="row">
                  <code>
                    {d.method} {d.path} {d.field}
                  </code>
                </th>
                <td>
                  <code>{d.replacement}</code>
                </td>
                <td>{d.deprecatedIn}</td>
                <td>{d.sunset ?? t('removalNotSet')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">{t('deprecationsNote')}</p>
    </section>
  );
}
