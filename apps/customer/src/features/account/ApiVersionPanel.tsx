import { useRef, useState, type FormEvent } from 'react';
import { API_DEPRECATIONS, API_VERSIONS, LATEST_API_VERSION } from '@intafaced/contracts/api-versions';
import { IDENTITY_API_VERSION_GET, IDENTITY_API_VERSION_SET } from '@intafaced/contracts/identity-api-version-procedures';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Select } from '@intafaced/ui/lit';
import { useSession } from '../session';
import { apiVersionCopy as copy } from './api-version-copy';
import { Failure, Loading } from './kit-parts';

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
    <section data-testid="api-version" aria-labelledby="api-version-title">
      <h2 id="api-version-title">{t('title')}</h2>
      <p className="lt-hint">{t('intro')}</p>
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
                <span className="lt-hint"> · {t('setAt', { when: `${resource.data.setAt.slice(0, 16).replace('T', ' ')} UTC` })}</span>
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
      <form className="lt-toolbar" onSubmit={(event) => void save(event)}>
        <Select label={t('choose')} value={choice} onChange={setChoice} disabled={busy} options={[...API_VERSIONS].reverse()} />{' '}
        <Button tone="primary" type="submit" disabled={busy || resource.status !== 'ready'}>
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
        <ul data-testid="api-version__deprecations">
          {API_DEPRECATIONS.map((d) => (
            <li key={d.id}>
              <code>
                {d.method} {d.path} {d.field}
              </code>{' '}
              · {t('colReplacement')}: <code>{d.replacement}</code> · {t('colSince')} {d.deprecatedIn} · {t('colRemoval')}:{' '}
              {d.sunset ?? t('removalNotSet')}
            </li>
          ))}
        </ul>
      )}
      <p className="lt-hint">{t('deprecationsNote')}</p>
    </section>
  );
}
