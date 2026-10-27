import { useState } from 'react';
import { Button } from '@intafaced/ui';
import { EmptyState, Field } from '../../../ui-kit';
import { PaySection } from '../../../components';
import { Gate, SelectField, PortalLoading } from '../../components';
import { EntityList } from '../../ui/EntityList';
import { DateTime } from '../../ui/DateTime';
import { PortalReview } from '../../ui/PortalReview';
import { StatusChip, ToneChip } from '../../ui/StatusChip';
import { useUrlParam } from '../../hooks';
import { useResource, type Resource } from '../../../../../shared/resource';
import { Checkbox } from '@intafaced/ui';
import type { SettingsBApi } from '../b-client';
import { developersCopy as c } from './copy';
import { keyScopes, isPayKey } from './model';
import { SecretReveal, type Revealed } from './SecretReveal';
import type { ApiKey } from './schemas';
import { useMerchantAccess, readyAccess } from '../../access/MerchantAccess';

export function Keys({ api, scopes }: { api: SettingsBApi; scopes: readonly string[] }) {
  const keys = useResource((signal) => api.keysList(signal), 'dev:keys');
  const approved = readyAccess(useMerchantAccess())?.kybStatus === 'approved';
  return <KeysView resource={keys.resource} reload={keys.reload} api={api} scopes={scopes} approved={approved} />;
}

export function KeyRevoke({ api, apiKey, onDone }: { api: Pick<SettingsBApi, 'keyRevoke'>; apiKey: ApiKey; onDone: () => void }) {
  const { t } = c.useCopy();
  if (apiKey.revoked) return null;
  return (
    <PortalReview
      title={t('revokeKey')}
      description={t('revokeEffect')}
      review={
        <dl className="pay-details">
          <div>
            <dt>{t('colName')}</dt>
            <dd>
              {apiKey.name} · <code>{apiKey.prefix}</code>
            </dd>
          </div>
          <div>
            <dt>{t('colPermissions')}</dt>
            <dd>{apiKey.scopes.join(', ')}</dd>
          </div>
        </dl>
      }
      perform={() => api.keyRevoke(apiKey.id)}
      onConfirmed={onDone}
    />
  );
}

export function KeysView({
  resource,
  reload,
  api,
  scopes,
  approved = false,
}: {
  resource: Resource<ApiKey[]>;
  reload: () => void;
  api: SettingsBApi;
  scopes: readonly string[];
  /** The business has been approved, so the note must not say live keys are waiting for that approval. */
  approved?: boolean;
}) {
  const { t } = c.useCopy();
  const [q, setQ] = useUrlParam('q');
  const [status, setStatus] = useUrlParam('status');
  const [revealed, setRevealed] = useState<Revealed>(null);
  return (
    <div className="stack">
      <p className="pp-callout">
        <strong>{t('testOnlyTitle')}</strong> {approved ? t('testOnlyBodyApproved') : t('testOnlyBody')}
      </p>
      {revealed && <SecretReveal {...revealed} onHide={() => setRevealed(null)} />}
      <PaySection
        title={t('keysTitle')}
        description={t('keysBody')}
        action={
          <Button variant="secondary" onClick={reload}>
            {t('refresh')}
          </Button>
        }
      >
        <div className="pp-filter-row" role="search" aria-label={t('keysTitle')}>
          <Field label={t('search')} value={q} onChange={(e) => setQ(e.target.value)} hint={t('searchInList')} />
          <SelectField
            label={t('colStatus')}
            value={status}
            onChange={setStatus}
            options={[
              ['', t('allStatuses')],
              ['active', t('statusActive')],
              ['revoked', t('statusRevoked')],
            ]}
          />
        </div>
        {resource.status === 'loading' ? (
          <PortalLoading />
        ) : (
          <Gate resource={resource} retry={reload}>
            {(all) => {
              const mine = all.filter((k) => isPayKey(k.scopes));
              const rows = mine.filter(
                (k) =>
                  (!status || (k.revoked ? 'revoked' : 'active') === status) &&
                  `${k.name} ${k.prefix} ${k.scopes.join(' ')}`.toLowerCase().includes(q.trim().toLowerCase()),
              );
              return (
                <>
                  <p className="muted pp-count" role="status">
                    {mine.length >= 200 ? t('newestKeys', { n: rows.length }) : t('keysCount', { shown: rows.length, total: mine.length })}
                  </p>
                  {rows.length === 0 ? (
                    <EmptyState
                      title={mine.length ? t('noKeysMatch') : t('noKeysTitle')}
                      action={
                        mine.length ? undefined : (
                          <a className="text-link" href="#create">
                            {t('createKeyAction')}
                          </a>
                        )
                      }
                    >
                      {mine.length ? t('noKeysMatchBody') : t('noKeysBody')}
                    </EmptyState>
                  ) : (
                    <EntityList
                      label={t('keysTitle')}
                      rows={rows}
                      rowKey={(k) => k.id}
                      href={(k) => `/pay/developer/signing?key=${encodeURIComponent(k.id)}`}
                      columns={[
                        {
                          header: t('colName'),
                          cell: (k) => (
                            <>
                              <strong>{k.name}</strong>
                              <small className="pay-cell-note">
                                <code>{k.prefix}</code>
                              </small>
                            </>
                          ),
                        },
                        { header: t('colMode'), cell: (k) => <ModeChip mode={k.mode} /> },
                        { header: t('colPermissions'), cell: (k) => k.scopes.join(', ') },
                        {
                          header: t('colLastUsed'),
                          cell: (k) => (k.lastUsedAt ? <DateTime value={k.lastUsedAt} /> : <span className="muted">{t('neverUsed')}</span>),
                        },
                        { header: t('colProtection'), cell: (k) => <KeyProtection apiKey={k} /> },
                        { header: t('colStatus'), cell: (k) => <StatusChip entity="key" value={k.revoked ? 'revoked' : 'active'} /> },
                        {
                          header: <span className="pp-sr">{t('colActions')}</span>,
                          cell: (k) => <KeyRevoke api={api} apiKey={k} onDone={reload} />,
                        },
                      ]}
                      card={(k) => ({
                        title: (
                          <>
                            {k.name} <code>{k.prefix}</code>
                          </>
                        ),
                        time: (
                          <>
                            {k.lastUsedAt ? (
                              <>
                                {t('usedAt')} <DateTime value={k.lastUsedAt} />
                              </>
                            ) : (
                              t('neverUsed')
                            )}
                            {!k.revoked && <> · {protectionLine(k, t)}</>}
                          </>
                        ),
                        status: <StatusChip entity="key" value={k.revoked ? 'revoked' : 'active'} />,
                      })}
                    />
                  )}
                </>
              );
            }}
          </Gate>
        )}
      </PaySection>
      <div id="create">
        <CreateKey
          api={api}
          scopes={scopes}
          onCreated={(created) => {
            setRevealed({ title: t('newKeyTitle'), secret: created.key, what: t('newKeyWhat') });
            reload();
          }}
        />
      </div>
    </div>
  );
}

type T = ReturnType<typeof c.useCopy>['t'];

const ipsLine = (k: ApiKey, t: T): string =>
  k.ipAllowlist.length === 0 ? t('protIpsNone') : k.ipAllowlist.length === 1 ? t('protIpsOne') : t('protIps', { n: k.ipAllowlist.length });

/** How the key is protected, in words: whether requests must be signed and which addresses may use it. Never a secret. */
function protectionLine(k: ApiKey, t: T): string {
  const ips = ipsLine(k, t);
  return `${k.requireSignature ? t('protSigned') : t('protNotSigned')} · ${ips}`;
}

/** The saved signing and allowed-address state of one key, as shown on its row. */
export function KeyProtection({ apiKey }: { apiKey: ApiKey }) {
  const { t } = c.useCopy();
  if (apiKey.revoked) return <span className="muted">{t('protRevoked')}</span>;
  return (
    <span className="pp-protection">
      <ToneChip
        tone={apiKey.requireSignature ? 'done' : 'progress'}
        label={apiKey.requireSignature ? t('protSigned') : t('protNotSigned')}
      />
      <small className="pay-cell-note">
        {ipsLine(apiKey, t)}
        {apiKey.requireNonEmptyIpAllowlist ? ` · ${t('protIpRequired')}` : ''}
      </small>
    </span>
  );
}

export function ModeChip({ mode }: { mode: 'live' | 'sandbox' }) {
  const { t } = c.useCopy();
  return <ToneChip tone="progress" label={mode === 'sandbox' ? t('modeTest') : t('modeLive')} />;
}

export function CreateKey({
  api,
  scopes,
  onCreated,
}: {
  api: Pick<SettingsBApi, 'keyCreate'>;
  scopes: readonly string[];
  onCreated: (created: { key: string; prefix: string }) => void;
}) {
  const { t } = c.useCopy();
  const offered = keyScopes.filter((scope) => scopes.includes(scope));
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>(['pay:read']);
  const picked = chosen.filter((scope) => offered.includes(scope as (typeof keyScopes)[number]));
  const trimmed = name.trim();
  const nameError = name.length > 0 && (trimmed.length < 1 || trimmed.length > 64) ? t('errKeyName') : undefined;
  const blocked = offered.length === 0;
  return (
    <PaySection title={t('createKeyTitle')} description={t('createKeyBody')}>
      {blocked && (
        <p className="pp-callout" role="status">
          {t('createKeyOwnerOnly')}
        </p>
      )}
      <div data-testid="form-stack" className="form-stack pp-form">
        <Field
          label={t('keyNameLabel')}
          hint={t('keyNameHint')}
          value={name}
          maxLength={64}
          error={nameError}
          disabled={blocked}
          onChange={(e) => setName(e.target.value)}
        />
        <fieldset className="pp-fieldset" disabled={blocked}>
          <legend>{t('colPermissions')}</legend>
          {keyScopes.map((scope) => (
            <label key={scope} className="pp-check">
              <Checkbox
                checked={picked.includes(scope)}
                disabled={!offered.includes(scope)}
                onCheckedChange={(on) => setChosen(on ? [...new Set([...chosen, scope])] : chosen.filter((x) => x !== scope))}
              />
              <span>
                <strong>{scope}</strong> <small className="muted">{t(`scope_${scope.replace(':', '_')}` as 'scope_pay_read')}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <PortalReview
          title={t('createKeyAction')}
          variant="primary"
          description={t('createKeyReview')}
          disabled={blocked || !trimmed || Boolean(nameError) || picked.length === 0}
          disabledReason={blocked ? t('createKeyOwnerOnly') : t('createKeyNeeds')}
          review={
            <dl className="pay-details">
              <div>
                <dt>{t('colName')}</dt>
                <dd>{trimmed}</dd>
              </div>
              <div>
                <dt>{t('colMode')}</dt>
                <dd>{t('modeTest')}</dd>
              </div>
              <div>
                <dt>{t('colPermissions')}</dt>
                <dd>{picked.join(', ')}</dd>
              </div>
            </dl>
          }
          perform={() => api.keyCreate({ name: trimmed, scopes: picked })}
          onConfirmed={(created) => {
            setName('');
            onCreated(created);
          }}
        />
      </div>
    </PaySection>
  );
}
