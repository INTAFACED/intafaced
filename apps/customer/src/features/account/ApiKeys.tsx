import { useMemo, useRef, useState, type FormEvent } from 'react';
import type { ApiKeyRecord } from '@intafaced/contracts/api-keys';
import type { ApiResult } from '../../shared/api';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, Dialog, Failure, Field, Loading } from '../../shared/ui';
import { apiKeysCopy as copy, type ApiKeysPlainKey } from './api-keys-copy';
import { changeRefusal, readDeveloperKeys, revokeDeveloperKey } from './developer-keys-api';
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

export function stateOf(key: ApiKeyRecord, now: number): 'stateRevoked' | 'stateEnded' | 'stateActive' {
  if (key.revoked) return 'stateRevoked';
  if (key.expiresAt !== null && Date.parse(key.expiresAt) <= now) return 'stateEnded';
  return 'stateActive';
}

/** Who or what revoked a key, as the service recorded it; a key revoked before causes were kept says so. */
export function revokedByKey(key: ApiKeyRecord): ApiKeysPlainKey {
  return key.revokedBy ? `revokedBy_${key.revokedBy}` : 'revokedBy_unknown';
}

/** A revoked key's reason: who or what revoked it, and the person's own words when they gave some. */
export function RevokedReason({ apiKey }: { apiKey: ApiKeyRecord }) {
  const { t } = copy.useCopy();
  return (
    <span className="api-keys__reason">
      {t(revokedByKey(apiKey))}
      {apiKey.revokeReason && (
        <>
          {': '}
          <bdi lang="und">{apiKey.revokeReason}</bdi>
        </>
      )}
    </span>
  );
}

type Sheet = {
  key: ApiKeyRecord;
  busy: boolean;
  refusal: ApiKeysPlainKey | null;
  failure: Extract<ApiResult<unknown>, { ok: false }> | null;
};

/**
 * The revoke sheet: what happens, an optional reason, and one Revoke. No second factor, so a key can always be
 * switched off; the service records the person and their reason, and the list then shows it on the row.
 */
function RevokeSheet({ sheet, onClose, onSubmit }: { sheet: Sheet; onClose: () => void; onSubmit: (reason: string) => void }) {
  const { t } = copy.useCopy();
  return (
    <Dialog title={t('revokeTitle')} onClose={onClose}>
      <form
        className="api-keys__revoke"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          onSubmit(String(new FormData(event.currentTarget).get('reason') ?? ''));
        }}
      >
        <p>
          <bdi lang="und">{sheet.key.name}</bdi> · <code lang="und">{sheet.key.prefix}</code>
        </p>
        <p>{t('revokeBody')}</p>
        <Field label={t('revokeReason')} hint={t('revokeReasonHint')} name="reason" autoComplete="off" />
        {sheet.refusal && (
          <p className="error-text" role="alert">
            {t(sheet.refusal)}
          </p>
        )}
        {sheet.failure && <Failure result={sheet.failure} />}
        <div className="api-keys__actions">
          <Button type="submit" variant="danger" disabled={sheet.busy}>
            {sheet.busy ? t('revoking') : t('revokeConfirm')}
          </Button>
          <Button variant="secondary" disabled={sheet.busy} onClick={onClose}>
            {t('revokeKeep')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * The developer room's key list (`/uc/safe/api-keys`, DV-keys-01 and DV-keys-03, J-developer-03 #1): the safety
 * guidance even with no keys, the owner's key cap and how much of it is used, and every key with each column the
 * service returns. A revoked key says why. Each live key can be revoked here, and its name opens its detail page.
 * It never holds or shows a secret.
 */
export function ApiKeys() {
  const { t, languageFor, requestedLocale } = copy.useCopy();
  const { api, userId } = useSession();
  const { resource, reload } = useResource((signal) => readDeveloperKeys(api, signal), `developer-keys:${userId}`);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [notice, setNotice] = useState<ApiKeysPlainKey | null>(null);
  const sending = useRef(false);
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

  async function revoke(reason: string) {
    if (!sheet || sending.current) return;
    sending.current = true;
    const target = sheet.key;
    setSheet({ ...sheet, busy: true, refusal: null, failure: null });
    try {
      const answer = await revokeDeveloperKey(api, target.id, reason);
      if (answer.ok) {
        setSheet(null);
        setNotice('revokeDone');
        reload();
        return;
      }
      const named = changeRefusal(answer);
      if (answer.reason === 'uncertain') {
        // The revoke may have landed: say so, and read the list again rather than guess.
        setSheet(null);
        setNotice('revokeUncertain');
        reload();
        return;
      }
      setSheet({ key: target, busy: false, refusal: named, failure: named ? null : answer });
    } finally {
      sending.current = false;
    }
  }

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
      {notice && <p role="status">{t(notice)}</p>}
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
                    <th scope="col">{t('colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {resource.data.keys.map((key) => {
                    const state = stateOf(key, now);
                    return (
                      <tr key={key.id} data-key-id={key.id}>
                        <th scope="row">
                          <a className="text-link" href={`/uc/safe/api-keys/${key.id}`}>
                            <bdi lang="und">{key.name}</bdi>
                          </a>
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
                        <td>{state === 'stateRevoked' ? <RevokedReason apiKey={key} /> : t(state)}</td>
                        <td className="api-keys__row-action">
                          {!key.revoked && (
                            <Button
                              variant="secondary"
                              disabled={sheet !== null}
                              onClick={() => {
                                setNotice(null);
                                setSheet({ key, busy: false, refusal: null, failure: null });
                              }}
                            >
                              {t('revoke')}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {sheet && <RevokeSheet sheet={sheet} onClose={() => !sheet.busy && setSheet(null)} onSubmit={(reason) => void revoke(reason)} />}
    </div>
  );
}
