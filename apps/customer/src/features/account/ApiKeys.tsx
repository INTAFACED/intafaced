// volt-room: /uc/safe/api-keys
import { useMemo, useRef, useState, type FormEvent } from 'react';
import type { ApiKeyRecord } from '@intafaced/contracts/api-keys';
import type { ApiResult } from '../../shared/api';
import { useSession } from '../session';
import { useResource } from '../../shared/resource';
import { Button, Field, Tag } from '@intafaced/ui/lit';
import { SettingsTemplate, Sheet as KitSheet } from '@intafaced/ui/lit/templates';
import { apiKeysCopy as copy, type ApiKeysPlainKey } from './api-keys-copy';
import { apiVersionCopy } from './api-version-copy';
import { Failure, Loading } from './kit-parts';
import { changeRefusal, readDeveloperKeys, readKeySubaccounts, revokeDeveloperKey } from './developer-keys-api';
import { OrgKeys } from './OrgKeys';
import { ApiVersionPanel } from './ApiVersionPanel';
import { RevokeAllKeys } from './ApiKeysRevokeAll';

/** What to do with a key, said once on the list and once on the create form. */
export function KeySafety() {
  const { t } = copy.useCopy();
  return (
    <section data-testid="security__card" aria-labelledby="api-keys-safety">
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

/** Outside apps given access to the account (I-signin-sessions-29): none can be authorised yet, and the section says so. */
function ConnectedApps() {
  const { t } = copy.useCopy();
  return (
    <section data-testid="security__card" aria-labelledby="api-keys-apps">
      <h2 id="api-keys-apps">{t('appsTitle')}</h2>
      <p className="lt-hint">{t('appsEmpty')}</p>
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
    <span>
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

export type Sheet = {
  key: ApiKeyRecord;
  busy: boolean;
  refusal: ApiKeysPlainKey | null;
  failure: Extract<ApiResult<unknown>, { ok: false }> | null;
};

/**
 * The revoke sheet: what happens, an optional reason, and one Revoke. No second factor, so a key can always be
 * switched off; the service records the person and their reason, and the list then shows it on the row.
 */
export function RevokeSheet({ sheet, onClose, onSubmit }: { sheet: Sheet; onClose: () => void; onSubmit: (reason: string) => void }) {
  const { t } = copy.useCopy();
  return (
    <KitSheet open title={t('revokeTitle')} onClose={onClose}>
      <form
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
        {sheet.refusal && <p role="alert">{t(sheet.refusal)}</p>}
        {sheet.failure && <Failure result={sheet.failure} />}
        <div className="lt-actions">
          <Button type="submit" tone="primary" disabled={sheet.busy}>
            {sheet.busy ? t('revoking') : t('revokeConfirm')}
          </Button>
          <Button tone="secondary" disabled={sheet.busy} onClick={onClose}>
            {t('revokeKeep')}
          </Button>
        </div>
      </form>
    </KitSheet>
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
  const versionTitle = apiVersionCopy.useCopy().t('title');
  const { api, userId } = useSession();
  const { resource, reload } = useResource((signal) => readDeveloperKeys(api, signal), `developer-keys:${userId}`);
  // The names of the sub-accounts keys are bound to; a key whose sub-account is not listed shows its id instead.
  const { resource: subaccounts } = useResource((signal) => readKeySubaccounts(api, signal), `developer-key-subaccounts:${userId}`);
  const labels = useMemo(
    () => new Map(subaccounts.status === 'ready' ? subaccounts.data.map((row) => [row.id, row.nickname ?? row.label]) : []),
    [subaccounts],
  );
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [notice, setNotice] = useState<ApiKeysPlainKey | null>(null);
  const sending = useRef(false);
  // The Account column (J-developer-15 #1) shows once the person has a sub-account or a key bound to one; with a single
  // account every row would only say "This account".
  const showAccount = labels.size > 0 || (resource.status === 'ready' && resource.data.keys.some((key) => key.accountId !== null));
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

  const sections = (
    <>
      <div className="lt-sections">
        <KeySafety />
        <div className="lt-stack">
          {notice && <p role="status">{t(notice)}</p>}
          {resource.status === 'loading' && <Loading label={t('loading')} />}
          {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
          {resource.status === 'ready' && (
            <>
              <section data-testid="security__card" aria-labelledby="api-keys-cap" role="status">
                <h2 id="api-keys-cap">{t('capTitle')}</h2>
                <p>
                  {resource.data.cap.limit === null
                    ? t('capUnset')
                    : resource.data.cap.live >= resource.data.cap.limit
                      ? `${t('capUsed', { live: resource.data.cap.live, limit: resource.data.cap.limit })} ${t('capFull')}`
                      : t('capUsed', { live: resource.data.cap.live, limit: resource.data.cap.limit })}
                </p>
              </section>
              <RevokeAllKeys
                liveKeys={resource.data.keys.filter((key) => stateOf(key, now) === 'stateActive').length}
                onDone={() => {
                  setNotice(null);
                  reload();
                }}
              />
              {resource.data.keys.length === 0 ? (
                <p role="status">{t('empty')}</p>
              ) : (
                <div>
                  <table data-testid="api-keys__table" className="lt-table">
                    <thead>
                      <tr>
                        <th scope="col">{t('colName')}</th>
                        <th scope="col">{t('colPrefix')}</th>
                        <th scope="col">{t('colMode')}</th>
                        {showAccount && <th scope="col">{t('colAccount')}</th>}
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
                              <a className="lt-link" href={`/uc/safe/api-keys/${key.id}`}>
                                <bdi lang="und">{key.name}</bdi>
                              </a>
                              {key.kind === 'agent' && (
                                <>
                                  {' '}
                                  <Tag data-testid="api-keys__agent">{t('agentBadge')}</Tag>
                                </>
                              )}
                            </th>
                            <td>
                              <code lang="und">{key.prefix}</code>
                            </td>
                            <td>{t(key.mode === 'live' ? 'modeLive' : 'modeSandbox')}</td>
                            {showAccount && (
                              <td data-testid="api-keys__account">
                                {key.accountId === null ? (
                                  t('accountOwn')
                                ) : (
                                  <>
                                    {t('subaccount')}: <bdi lang="und">{labels.get(key.accountId) ?? key.accountId}</bdi>
                                  </>
                                )}
                              </td>
                            )}
                            <td>
                              <bdi lang="und">{key.scopes.join(', ')}</bdi>
                            </td>
                            <td>{key.ipAllowlist.length === 0 ? t('anyIp') : <bdi lang="und">{key.ipAllowlist.join(', ')}</bdi>}</td>
                            <td>{at(key.createdAt)}</td>
                            <td>{key.expiresAt === null ? t('noEnd') : at(key.expiresAt)}</td>
                            <td>{key.lastUsedAt === null ? t('neverUsed') : at(key.lastUsedAt)}</td>
                            <td>{state === 'stateRevoked' ? <RevokedReason apiKey={key} /> : t(state)}</td>
                            <td>
                              {!key.revoked && (
                                <Button
                                  tone="secondary"
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
        </div>
        <ApiVersionPanel />
        <OrgKeys at={at} />
        <ConnectedApps />
      </div>
      {sheet && <RevokeSheet sheet={sheet} onClose={() => !sheet.busy && setSheet(null)} onSubmit={(reason) => void revoke(reason)} />}
    </>
  );

  return (
    <div lang={languageFor('title')}>
      <SettingsTemplate
        title={t('title')}
        description={t('intro')}
        state={{ kind: 'ready' }}
        roomAction={
          <a className="lt-button lt-button-primary" href="/uc/safe/api-keys/new">
            {t('create')}
          </a>
        }
        index={
          <nav aria-label={t('sectionsLabel')}>
            <ul>
              {INDEX.map(([id, label]) => (
                <li key={id}>
                  <a className="lt-link" href={`#${id}`}>
                    {label === 'versionTitle' ? versionTitle : t(label)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        }
        sections={sections}
        explain={<p>{t('explain')}</p>}
      />
    </div>
  );
}

/** The room's sections, each a link to its heading. */
const INDEX = [
  ['api-keys-safety', 'safetyTitle'],
  ['api-keys-cap', 'capTitle'],
  ['api-version-title', 'versionTitle'],
  ['api-keys-apps', 'appsTitle'],
] as const;
