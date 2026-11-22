// volt-room: /uc/safe/api-keys/:keyId
import { useMemo, useRef, useState, type FormEvent } from 'react';
import type { ApiKeyDetail as Detail } from '@intafaced/contracts/api-keys';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Field } from '@intafaced/ui/lit';
import { KeyValue, SettingsTemplate } from '@intafaced/ui/lit/templates';
import { useSession } from '../session';
import { apiKeysCopy as copy, type ApiKeysPlainKey } from './api-keys-copy';
import { RevokedReason, stateOf } from './ApiKeys';
import { Failure, Loading } from './kit-parts';
import { KeyCallLog, keyCallLogCopy } from './KeyCallLog';
import { KeyUsage, keyUsageCopy } from './KeyUsage';
import { RotateKey } from './RotateKey';
import { RotationRequest } from './RotationRequest';
import {
  changeRefusal,
  endOfDayUtc,
  idlePeriod,
  lastDayUtc,
  readDeveloperKey,
  setDeveloperKeyExpiry,
  type Factor,
} from './developer-keys-api';

/** The key id in `/uc/safe/api-keys/:keyId`, or null when the path names none. */
export function keyIdFromPath(path: string): string | null {
  const match = /^\/uc\/safe\/api-keys\/([0-9a-fA-F-]{36})$/.exec(path.split('?')[0] ?? '');
  return match?.[1]?.toLowerCase() ?? null;
}

/** The new end date: an earlier one saves with no factor, a later one with a passkey or a code (the service decides). */
function ExpiryForm({ detail, onSaved }: { detail: Detail; onSaved: (next: Detail) => void }) {
  const { t } = copy.useCopy();
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ApiKeysPlainKey | null>(null);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [saved, setSaved] = useState(false);
  const sending = useRef(false);

  async function save(form: HTMLFormElement, factor: Factor) {
    if (sending.current) return;
    const expiresAt = endOfDayUtc(String(new FormData(form).get('expiry') ?? ''));
    setSaved(false);
    setFailure(null);
    if (!expiresAt) return setRefusal('setExpiryPick');
    sending.current = true;
    setBusy(true);
    setRefusal(null);
    try {
      const answer = await setDeveloperKeyExpiry(api, detail.key.id, expiresAt, factor);
      if (answer.ok) {
        setSaved(true);
        onSaved({ ...detail, key: answer.data.record });
        return;
      }
      const named = changeRefusal(answer);
      if (named) setRefusal(named);
      else setFailure(answer);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      data-testid="security__card"
      aria-labelledby="api-key-expiry-form"
      noValidate
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void save(event.currentTarget, null);
      }}
    >
      <h2 id="api-key-expiry-form">{t('setExpiryTitle')}</h2>
      <Field label={t('setExpiryLabel')} hint={t('setExpiryHint')} name="expiry" type="date" />
      {refusal && <p role="alert">{t(refusal)}</p>}
      {failure && <Failure result={failure} />}
      {saved && <p role="status">{t('setExpirySaved')}</p>}
      <div className="lt-actions">
        <Button tone="primary" type="submit" disabled={busy}>
          {t('setExpirySave')}
        </Button>
        <Button
          tone="secondary"
          disabled={busy}
          onClick={(event) => {
            const form = event.currentTarget.form;
            if (form) void save(form, { passkey: true });
          }}
        >
          {t('setExpirySavePasskey')}
        </Button>
      </div>
    </form>
  );
}

/**
 * One API key (`/uc/safe/api-keys/:keyId`, DV-keys-03, J-developer-03 #9): its permissions, its end date, the owner's
 * idle expiry (`not set` while the owner has set none, never a default) and its IP policy, and a form to change the end
 * date while the key is live. A key can never change its own end date: the service refuses a key's own call.
 */
export function ApiKeyDetail({ keyId }: { keyId: string }) {
  const { t, languageFor, requestedLocale } = copy.useCopy();
  const usageTitle = keyUsageCopy.useCopy().t('title');
  const callLogTitle = keyCallLogCopy.useCopy().t('title');
  const { api, userId } = useSession();
  const { resource, reload } = useResource((signal) => readDeveloperKey(api, keyId, signal), `developer-key:${userId}:${keyId}`);
  const [updated, setUpdated] = useState<Detail | null>(null);
  const when = useMemo(
    () => new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }),
    [requestedLocale],
  );
  const at = (iso: string) => `${when.format(new Date(iso))} UTC`;
  const idleText = (seconds: number) => {
    const period = idlePeriod(seconds);
    switch (period.key) {
      case 'idleDays':
        return t(period.key, period.params);
      case 'idleHours':
        return t(period.key, period.params);
      case 'idleSeconds':
        return t(period.key, period.params);
      default:
        return t(period.key);
    }
  };
  const now = Date.now();
  const refused = resource.status === 'failed' ? changeRefusal(resource.failure) : null;
  const detail = updated?.key.id === keyId ? updated : resource.status === 'ready' ? resource.data : null;

  const sections = (
    <>
      {resource.status === 'loading' && <Loading label={t('detailLoading')} />}
      {resource.status === 'failed' && (refused ? <p role="alert">{t(refused)}</p> : <Failure result={resource.failure} retry={reload} />)}
      {detail && (
        <>
          <section data-testid="security__card" id="api-key-detail" aria-label={t('detailRegion')}>
            <KeyValue
              rows={[
                { label: t('colPrefix'), value: <code lang="und">{detail.key.prefix}</code> },
                { label: t('colMode'), value: t(detail.key.mode === 'live' ? 'modeLive' : 'modeSandbox') },
                { label: t('colScopes'), value: <bdi lang="und">{detail.key.scopes.join(', ')}</bdi> },
                {
                  label: t('colState'),
                  value: detail.key.revoked ? <RevokedReason apiKey={detail.key} /> : t(stateOf(detail.key, now)),
                },
                { label: t('colCreated'), value: at(detail.key.createdAt) },
                { label: t('colLastUsed'), value: detail.key.lastUsedAt === null ? t('neverUsed') : at(detail.key.lastUsedAt) },
                {
                  label: t('fieldExpiry'),
                  value: (
                    <span data-testid="api-keys__expiry">
                      {detail.key.expiresAt === null
                        ? t('expiryNone')
                        : Date.parse(detail.key.expiresAt) <= now
                          ? t('expiryEnded', { day: lastDayUtc(detail.key.expiresAt) })
                          : t('expiryOn', { day: lastDayUtc(detail.key.expiresAt), at: at(detail.key.expiresAt) })}
                    </span>
                  ),
                },
                {
                  label: t('fieldIdle'),
                  value: (
                    <span data-testid="api-keys__idle">
                      {detail.idleExpirySeconds === null ? t('idleUnset') : idleText(detail.idleExpirySeconds)}
                      <small className="lt-hint">{t(detail.idleExpirySeconds === null ? 'idleUnsetNote' : 'idleSetNote')}</small>
                    </span>
                  ),
                },
                {
                  label: t('fieldIpPolicy'),
                  value: (
                    <span data-testid="api-keys__ip-policy">
                      {detail.key.ipAllowlist.length > 0 ? (
                        <bdi lang="und">{t('ipOnly', { ips: detail.key.ipAllowlist.join(', ') })}</bdi>
                      ) : detail.requireNonEmptyIpAllowlist ? (
                        t('ipNone')
                      ) : (
                        t('ipAny')
                      )}
                      {detail.requireNonEmptyIpAllowlist && detail.key.ipAllowlist.length > 0 && (
                        <small className="lt-hint">{t('ipRequireNonEmpty')}</small>
                      )}
                    </span>
                  ),
                },
                { label: t('fieldSignature'), value: t(detail.key.requireSignature ? 'signatureOn' : 'signatureOff') },
              ]}
            />
          </section>
          <KeyUsage keyId={detail.key.id} />
          {stateOf(detail.key, now) === 'stateActive' ? (
            <>
              <RotationRequest keyId={detail.key.id} />
              <RotateKey keyId={detail.key.id} onRotated={() => undefined} />
              <ExpiryForm detail={detail} onSaved={setUpdated} />
            </>
          ) : (
            <p className="lt-hint">{t('notLive')}</p>
          )}
          <KeyCallLog keyId={detail.key.id} />
        </>
      )}
    </>
  );
  const index: readonly (readonly [string, string])[] = [
    ['api-key-detail', t('detailRegion')],
    ['api-key-usage', usageTitle],
    ['api-key-expiry-form', t('setExpiryTitle')],
    ['api-key-call-log', callLogTitle],
  ];

  return (
    <div lang={languageFor('detailTitle')}>
      <SettingsTemplate
        title={detail ? detail.key.name : t('detailTitle')}
        state={{ kind: 'ready' }}
        roomAction={
          <a className="lt-link" href="/uc/safe/api-keys">
            {t('backToKeys')}
          </a>
        }
        index={
          <nav aria-label={t('detailSectionsLabel')}>
            <ul>
              {index.map(([id, label]) => (
                <li key={id}>
                  <a className="lt-link" href={`#${id}`}>
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        }
        sections={sections}
        explain={<p>{t('detailExplain')}</p>}
      />
    </div>
  );
}
