// volt-room: /uc/safe/api-keys/new
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiKeyCreateOutput, ApiKeyList, ApiKeyScopeEntry } from '@intafaced/contracts/api-keys';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Checkbox, Field, Radio } from '@intafaced/ui/lit';
import { FlowTemplate, SelectField, TextAreaField } from '@intafaced/ui/lit/templates';
import { useSession } from '../session';
import { Failure, Loading } from './kit-parts';
import { apiKeysCopy as copy, scopeWords, type ApiKeysPlainKey } from './api-keys-copy';
import { KeySafety } from './ApiKeys';
import type { Subaccount } from './subaccount-guards';
import {
  createDeveloperKey,
  createRefusal,
  endOfDayUtc,
  environmentFile,
  ipLines,
  presetScopes,
  readDeveloperKeys,
  readKeyScopes,
  readKeySubaccounts,
  type Factor,
  type Preset,
} from './developer-keys-api';
import { leaveTo } from '../../app/location';

const PRESETS: readonly Preset[] = ['read', 'trade', 'lead', 'copy', 'custom'];
const PRESET_LABEL: Record<Preset, ApiKeysPlainKey> = {
  read: 'presetRead',
  trade: 'presetTrade',
  lead: 'presetLead',
  copy: 'presetCopy',
  custom: 'presetCustom',
};
const PRESET_SUMMARY: Record<Preset, ApiKeysPlainKey> = {
  read: 'presetSummaryRead',
  trade: 'presetSummaryTrade',
  lead: 'presetSummaryLead',
  copy: 'presetSummaryCopy',
  custom: 'presetSummaryCustom',
};

/** `subaccounts` null: they could not be read, so the form makes a key for this account only and says so. */
type Ready = { keys: ApiKeyList['keys']; scopes: ApiKeyScopeEntry[]; subaccounts: Subaccount[] | null };

async function readForm(api: ReturnType<typeof useSession>['api'], signal: AbortSignal): Promise<ApiResult<Ready>> {
  const [keys, scopes, subaccounts] = await Promise.all([
    readDeveloperKeys(api, signal),
    readKeyScopes(api, signal),
    readKeySubaccounts(api, signal),
  ]);
  if (!keys.ok) return keys;
  if (!scopes.ok) return scopes;
  // Choosing a sub-account is optional: a failed read leaves the form open for a key of this account.
  return { ok: true, data: { keys: keys.data.keys, scopes: scopes.data.scopes, subaccounts: subaccounts.ok ? subaccounts.data : null } };
}

/** The key, once: copy, download as an environment file, and a box to tick before the panel can close. */
export function ShownOnce({ made, onDone }: { made: ApiKeyCreateOutput & { key: string }; onDone: () => void }) {
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
    <section className="lt-stack" data-testid="security__card" aria-labelledby="api-key-secret">
      <h2 id="api-key-secret">{t('createdTitle')}</h2>
      <p role="alert">{t('createdOnce')}</p>
      <p>
        <bdi lang="und">{made.record.name}</bdi> · <code lang="und">{made.record.prefix}</code>
      </p>
      <output data-testid="api-keys__key" className="lt-mono" aria-label={t('createdTitle')}>
        <code lang="und">{made.key}</code>
      </output>
      {made.signingSecret && (
        <>
          <h3 id="api-key-signing-secret">{t('signingTitle')}</h3>
          <p>{t('signingOnce')}</p>
          <output data-testid="api-keys__signing-secret" className="lt-mono" aria-labelledby="api-key-signing-secret">
            <code lang="und">{made.signingSecret}</code>
          </output>
        </>
      )}
      <div className="lt-actions">
        <Button
          tone="secondary"
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
            className="lt-button lt-button-secondary"
            href={href}
            download={`${made.record.name.replace(/[^A-Za-z0-9_-]+/g, '-') || 'api-key'}.env`}
          >
            {t('download')}
          </a>
        )}
      </div>
      {copied === 'failed' && <p>{t('copyFailed')}</p>}
      <Checkbox checked={stored} onCheckedChange={setStored}>
        {t('stored')}
      </Checkbox>
      <div className="lt-actions">
        <Button tone="primary" disabled={!stored} onClick={onDone}>
          {t('done')}
        </Button>
      </div>
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
  const [accountId, setAccountId] = useState('');
  const [ipsText, setIpsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ApiKeysPlainKey | null>(null);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [made, setMade] = useState<(ApiKeyCreateOutput & { key: string }) | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const back = (
    <a className="lt-link lt-link-alone" href="/uc/safe/api-keys">
      <span className="lt-arrow lt-arrow-back" aria-hidden="true" /> {t('backToKeys')}
    </a>
  );
  const safety = <KeySafety />;

  if (resource.status === 'loading')
    return (
      <div lang={languageFor('formTitle')}>
        <FlowTemplate
          title={t('formTitle')}
          description={t('formIntro')}
          roomAction={back}
          state={{ kind: 'ready' }}
          step={<Loading label={t('scopesLoading')} />}
          summary={safety}
        />
      </div>
    );
  if (resource.status === 'failed')
    return (
      <div lang={languageFor('formTitle')}>
        <FlowTemplate
          title={t('formTitle')}
          description={t('formIntro')}
          roomAction={back}
          state={{ kind: 'ready' }}
          step={<Failure result={resource.failure} retry={reload} />}
          summary={safety}
        />
      </div>
    );
  if (made)
    return (
      <div lang={languageFor('formTitle')}>
        <FlowTemplate
          title={t('formTitle')}
          description={t('formIntro')}
          roomAction={back}
          state={{ kind: 'ready' }}
          step={<ShownOnce made={made} onDone={() => leaveTo('/uc/safe/api-keys')} />}
        />
      </div>
    );

  const { keys, scopes, subaccounts } = resource.data;
  // A key for an organisation (DV-console-01): opened from that organisation's area on the key page. The form says so,
  // and it must name the sub-account the key reaches.
  const orgId = new URLSearchParams(window.location.search).get('org') ?? '';
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
    const chosenAccountId = String(data.get('accountId') ?? '');
    const agent = data.get('agent') === 'on';
    const asked = {
      name: String(data.get('name') ?? ''),
      scopes: [...ticked],
      ...(ips.length > 0 ? { ips } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(chosenAccountId ? { accountId: chosenAccountId } : {}),
      ...(orgId ? { orgId } : {}),
      ...(agent ? { kind: 'agent' as const } : {}),
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

  const summary = PRESET_SUMMARY[preset];
  return (
    <div lang={languageFor('formTitle')}>
      <FlowTemplate
        title={t('formTitle')}
        description={t('formIntro')}
        roomAction={back}
        state={{ kind: 'ready' }}
        step={
          <form
            className="lt-stack"
            data-testid="security__card"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              void submit(event.currentTarget, 'code');
            }}
          >
            <Field label={t('name')} hint={t('nameHint')} name="name" autoComplete="off" maxLength={64} />
            <SelectField
              label={t('subaccount')}
              name="accountId"
              value={accountId}
              onChange={setAccountId}
              disabled={subaccounts === null}
              required={orgId !== ''}
              hint={t(subaccounts === null ? 'subaccountUnread' : orgId ? 'subaccountOrgHint' : 'subaccountHint')}
              options={[
                { value: '', label: t(orgId ? 'subaccountChoose' : 'subaccountNone'), disabled: orgId !== '' },
                ...(subaccounts ?? []).map((row) => ({ value: row.id, label: row.nickname ?? row.label })),
              ]}
            />
            <div className="lt-stack-tight">
              <Checkbox name="agent" aria-describedby="api-key-agent-hint">
                {t('agentKey')}
              </Checkbox>
              <small id="api-key-agent-hint" className="lt-hint">
                {t('agentKeyHint')}
              </small>
            </div>
            <fieldset className="lt-stack">
              <legend>{t('permissions')}</legend>
              <div className="lt-toolbar" role="radiogroup" aria-label={t('permissions')}>
                {PRESETS.map((choice) => (
                  <Radio key={choice} name="preset" checked={preset === choice} onSelect={() => choose(choice)}>
                    {t(PRESET_LABEL[choice])}
                  </Radio>
                ))}
              </div>
              <p className="lt-hint" role="status">
                {t(summary)} {ticked.length === 0 ? t('noScopes') : ''}
              </p>
              <ul className="lt-list">
                {offered.map((entry) => (
                  <li key={entry.scope}>
                    <Checkbox
                      name="scope"
                      value={entry.scope}
                      checked={ticked.includes(entry.scope)}
                      onCheckedChange={(on) => {
                        setPreset('custom');
                        setTicked((current) => (on ? [...current, entry.scope] : current.filter((scope) => scope !== entry.scope)));
                      }}
                    >
                      {scopeWords(t, entry.scope)}{' '}
                      <code lang="und" className="lt-hint">
                        {entry.scope}
                      </code>{' '}
                      <span className="lt-hint">{t(entry.access === 'read' ? 'accessRead' : 'accessWrite')}</span>
                    </Checkbox>
                  </li>
                ))}
              </ul>
              {blocked.length > 0 && (
                <div className="lt-stack-tight" data-testid="api-keys__blocked">
                  <h3>{t('blockedTitle')}</h3>
                  <ul className="lt-list">
                    {blocked.map((entry) => (
                      <li key={entry.scope} className="lt-muted">
                        {scopeWords(t, entry.scope)} — {t(`blocked_${entry.blockedBy ?? 'interactive_only'}`)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </fieldset>
            <TextAreaField
              label={t('ips')}
              name="ips"
              rows={3}
              spellCheck={false}
              value={ipsText}
              onChange={setIpsText}
              hint={t('ipsHint')}
            />
            <Field label={t('ends')} hint={t('endsHint')} name="ends" type="date" />
            <fieldset className="lt-stack">
              <legend>{t('confirmTitle')}</legend>
              <Field label={t('otp')} name="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
            </fieldset>
            {refusal && <p role="alert">{t(refusal)}</p>}
            {failure && <Failure result={failure} />}
            <div className="lt-actions">
              <Button tone="primary" type="submit" disabled={busy}>
                {busy ? t('working') : t('submit')}
              </Button>
              <Button
                tone="secondary"
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
        }
        summary={safety}
      />
    </div>
  );
}
