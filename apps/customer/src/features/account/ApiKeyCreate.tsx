import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiKeyCreateOutput, ApiKeyList, ApiKeyScopeEntry } from '@intafaced/contracts/api-keys';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import { apiKeysCopy as copy, type ApiKeysCopyKey } from './api-keys-copy';
import { KeySafety } from './ApiKeys';
import {
  createDeveloperKey,
  createRefusal,
  endOfDayUtc,
  environmentFile,
  ipLines,
  presetScopes,
  readDeveloperKeys,
  readKeyScopes,
  type Factor,
  type Preset,
} from './developer-keys-api';

type Ready = { keys: ApiKeyList['keys']; scopes: ApiKeyScopeEntry[] };

async function readForm(api: ReturnType<typeof useSession>['api'], signal: AbortSignal): Promise<ApiResult<Ready>> {
  const [keys, scopes] = await Promise.all([readDeveloperKeys(api, signal), readKeyScopes(api, signal)]);
  if (!keys.ok) return keys;
  if (!scopes.ok) return scopes;
  return { ok: true, data: { keys: keys.data.keys, scopes: scopes.data.scopes } };
}

/** The key, once: copy, download as an environment file, and a box to tick before the panel can close. */
function ShownOnce({ made, onDone }: { made: ApiKeyCreateOutput & { key: string }; onDone: () => void }) {
  const { t } = copy.useCopy();
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([environmentFile(made.key, made.signingSecret)], { type: 'text/plain' }));
    setHref(url);
    return () => URL.revokeObjectURL(url);
  }, [made.key, made.signingSecret]);
  return (
    <section data-testid="security__card" className="api-keys__secret security__card" aria-labelledby="api-key-secret">
      <h2 id="api-key-secret">{t('createdTitle')}</h2>
      <p className="api-keys__warning" role="alert">
        {t('createdOnce')}
      </p>
      <p>
        <bdi lang="und">{made.record.name}</bdi> · <code lang="und">{made.record.prefix}</code>
      </p>
      <output data-testid="api-keys__key" className="api-keys__key" aria-label={t('createdTitle')}>
        <code lang="und">{made.key}</code>
      </output>
      {made.signingSecret && (
        <>
          <h3 id="api-key-signing-secret">{t('signingTitle')}</h3>
          <p>{t('signingOnce')}</p>
          <output data-testid="api-keys__signing-secret" className="api-keys__key" aria-labelledby="api-key-signing-secret">
            <code lang="und">{made.signingSecret}</code>
          </output>
        </>
      )}
      <div className="api-keys__actions">
        <Button
          variant="secondary"
          onClick={() => {
            const write = navigator.clipboard?.writeText(made.key) ?? Promise.reject(new Error('no clipboard'));
            write.then(
              () => setCopied('yes'),
              () => setCopied('failed'),
            );
          }}
        >
          {copied === 'yes' ? t('copied') : t('copy')}
        </Button>
        {href && (
          <a
            className="button button--secondary"
            href={href}
            download={`${made.record.name.replace(/[^A-Za-z0-9_-]+/g, '-') || 'api-key'}.env`}
          >
            {t('download')}
          </a>
        )}
      </div>
      {copied === 'failed' && <p className="error-text">{t('copyFailed')}</p>}
      <label className="api-keys__stored">
        <input type="checkbox" checked={stored} onChange={(event) => setStored(event.currentTarget.checked)} />
        <span>{t('stored')}</span>
      </label>
      <Button disabled={!stored} onClick={onDone}>
        {t('done')}
      </Button>
    </section>
  );
}

/**
 * Create a personal API key (`/uc/safe/api-keys/new`, DV-keys-01 and DV-keys-02, J-developer-03 #2 to #6 and #8):
 * name, a preset or chosen permissions from those this sign-in may delegate, literal IP addresses, an optional end date,
 * and a fresh second factor. Every refusal is the service's own, named here; nothing is checked only in the browser.
 * The key is held in memory for the shown-once panel and dropped when it closes or the page is left.
 */
export function ApiKeyCreate() {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const { resource, reload } = useResource((signal) => readForm(api, signal), `developer-key-form:${userId}`);
  const [preset, setPreset] = useState<Preset>('custom');
  const [ticked, setTicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Exclude<ApiKeysCopyKey, 'capUsed'> | null>(null);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [made, setMade] = useState<(ApiKeyCreateOutput & { key: string }) | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (resource.status === 'loading') return <Loading label={t('scopesLoading')} />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  if (made)
    return (
      <div className="api-keys">
        <ShownOnce made={made} onDone={() => window.location.assign('/uc/safe/api-keys')} />
      </div>
    );
  const { keys, scopes } = resource.data;
  const offered = scopes.filter((entry) => entry.onKey);
  const blocked = scopes.filter((entry) => !entry.onKey);

  function choose(next: Preset) {
    setPreset(next);
    if (next !== 'custom') setTicked(presetScopes(next, scopes));
  }

  async function submit(form: HTMLFormElement, how: 'code' | 'passkey') {
    if (busy || !userId) return;
    const data = new FormData(form);
    const code = String(data.get('otp') ?? '').trim();
    const ends = String(data.get('ends') ?? '');
    const expiresAt = ends ? endOfDayUtc(ends) : undefined;
    const ips = ipLines(String(data.get('ips') ?? ''));
    const asked = {
      name: String(data.get('name') ?? ''),
      scopes: [...ticked],
      ...(ips.length > 0 ? { ips } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
    const factor: Factor = how === 'passkey' ? { passkey: true } : code ? { code } : null;
    setBusy(true);
    setRefusal(null);
    setFailure(null);
    try {
      const answer = await createDeveloperKey(api, userId, keys, asked, factor);
      if (!mounted.current) return;
      if (!answer.ok) {
        const named = createRefusal(answer);
        if (named) setRefusal(named);
        else if (answer.reason === 'uncertain') setRefusal('uncertain');
        else setFailure(answer);
        return;
      }
      if (answer.data.key === null) return setRefusal('replayed');
      setMade({ ...answer.data, key: answer.data.key });
    } finally {
      const field = form.elements.namedItem('otp');
      if (field instanceof HTMLInputElement) field.value = '';
      if (mounted.current) setBusy(false);
    }
  }

  const summary: ApiKeysCopyKey =
    preset === 'read' ? 'presetSummaryRead' : preset === 'trade' ? 'presetSummaryTrade' : 'presetSummaryCustom';
  return (
    <div className="api-keys" lang={languageFor('formTitle')}>
      <header className="api-keys__head">
        <a className="text-link" href="/uc/safe/api-keys">
          {t('backToKeys')}
        </a>
        <h1>{t('formTitle')}</h1>
        <p className="muted">{t('formIntro')}</p>
      </header>
      <form
        data-testid="security__card"
        className="api-keys__form security__card"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void submit(event.currentTarget, 'code');
        }}
      >
        <Field label={t('name')} hint={t('nameHint')} name="name" autoComplete="off" maxLength={64} />
        <fieldset className="api-keys__scopes">
          <legend>{t('permissions')}</legend>
          <div className="api-keys__presets" role="radiogroup" aria-label={t('permissions')}>
            {(['read', 'trade', 'custom'] as const).map((choice) => (
              <label key={choice}>
                <input type="radio" name="preset" checked={preset === choice} onChange={() => choose(choice)} />
                <span>{t(choice === 'read' ? 'presetRead' : choice === 'trade' ? 'presetTrade' : 'presetCustom')}</span>
              </label>
            ))}
          </div>
          <p className="muted" role="status">
            {t(summary)} {ticked.length === 0 ? t('noScopes') : ''}
          </p>
          <ul className="api-keys__scope-list">
            {offered.map((entry) => (
              <li key={entry.scope}>
                <label>
                  <input
                    type="checkbox"
                    name="scope"
                    value={entry.scope}
                    checked={ticked.includes(entry.scope)}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      setPreset('custom');
                      setTicked((current) => (on ? [...current, entry.scope] : current.filter((scope) => scope !== entry.scope)));
                    }}
                  />
                  <code lang="und">{entry.scope}</code>{' '}
                  <span className="muted">{t(entry.access === 'read' ? 'accessRead' : 'accessWrite')}</span>
                </label>
              </li>
            ))}
          </ul>
          {blocked.length > 0 && (
            <div data-testid="api-keys__blocked" className="api-keys__blocked">
              <h3>{t('blockedTitle')}</h3>
              <ul>
                {blocked.map((entry) => (
                  <li key={entry.scope}>
                    <code lang="und">{entry.scope}</code>: {t(`blocked_${entry.blockedBy ?? 'interactive_only'}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </fieldset>
        <label className="field">
          <span>{t('ips')}</span>
          <textarea name="ips" rows={3} spellCheck={false} aria-describedby="api-key-ips-hint" />
          <small id="api-key-ips-hint" className="muted">
            {t('ipsHint')}
          </small>
        </label>
        <Field label={t('ends')} hint={t('endsHint')} name="ends" type="date" />
        <fieldset className="api-keys__confirm">
          <legend>{t('confirmTitle')}</legend>
          <Field label={t('otp')} name="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
        </fieldset>
        {refusal && (
          <p className="error-text" role="alert">
            {t(refusal)}
          </p>
        )}
        {failure && <Failure result={failure} />}
        <div className="api-keys__actions">
          <Button type="submit" disabled={busy}>
            {busy ? t('working') : t('submit')}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={(event) => {
              const form = event.currentTarget.form;
              if (form) void submit(form, 'passkey');
            }}
          >
            {t('submitPasskey')}
          </Button>
        </div>
      </form>
      <KeySafety />
    </div>
  );
}
