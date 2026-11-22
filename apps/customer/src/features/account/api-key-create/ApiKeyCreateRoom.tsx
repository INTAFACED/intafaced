import { useId, useState, type FormEvent } from 'react';
import type { ApiKeyCreateOutput, ApiKeyList, ApiKeyScopeEntry } from '@intafaced/contracts/api-keys';
import { Button, ChoiceGroup, Field, Select, TextArea } from '@intafaced/ui/lit';
import { Checkbox, FlowTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session';
import { apiKeysCopy as copy, type ApiKeysPlainKey } from '../api-keys-copy';
import { failureRefusal } from '../failure-refusal';
import type { Subaccount } from '../subaccount-guards';
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
} from '../developer-keys-api';

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
const FORM_ID = 'api-key-create-form';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type Made = ApiKeyCreateOutput & { key: string };

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

/** What to do with a key, said once on the list and once here. */
function KeySafety() {
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

/** The key, once: copy, download as an environment file, and a box to tick before the panel can close. */
function ShownOnce({ made, onDone }: { made: Made; onDone: () => void }) {
  const { t } = copy.useCopy();
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const file = `data:text/plain;charset=utf-8,${encodeURIComponent(environmentFile(made.key, made.signingSecret))}`;
  return (
    <section data-testid="security__card" aria-labelledby="api-key-secret">
      <h2 id="api-key-secret">{t('createdTitle')}</h2>
      <p role="alert">
        <strong>{t('createdOnce')}</strong>
      </p>
      <p>
        <bdi lang="und">{made.record.name}</bdi> ·{' '}
        <code className="lt-mono" lang="und">
          {made.record.prefix}
        </code>
      </p>
      <output data-testid="api-keys__key" aria-label={t('createdTitle')}>
        <code className="lt-mono" lang="und">
          {made.key}
        </code>
      </output>
      {made.signingSecret && (
        <>
          <h3 id="api-key-signing-secret">{t('signingTitle')}</h3>
          <p>{t('signingOnce')}</p>
          <output data-testid="api-keys__signing-secret" aria-labelledby="api-key-signing-secret">
            <code className="lt-mono" lang="und">
              {made.signingSecret}
            </code>
          </output>
        </>
      )}
      <div className="lt-actions">
        <Button
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
        <a
          className="lt-button lt-button-secondary"
          href={file}
          download={`${made.record.name.replace(/[^A-Za-z0-9_-]+/g, '-') || 'api-key'}.env`}
        >
          {t('download')}
        </a>
      </div>
      {copied === 'failed' && <p>{t('copyFailed')}</p>}
      <Checkbox label={t('stored')} checked={stored} onChange={(event) => setStored(event.currentTarget.checked)} />
      <Button tone="primary" disabled={!stored} onClick={onDone}>
        {t('done')}
      </Button>
    </section>
  );
}

/**
 * Create a personal API key (`/uc/safe/api-keys/new`, DV-keys-01 and DV-keys-02, J-developer-03 #2 to #6 and #8), on the
 * flow template: name, a preset or chosen permissions from those this sign-in may delegate, literal IP addresses, an
 * optional end date, and a fresh second factor. Every refusal is the service's own, named here; nothing is checked only
 * in the browser. The key is held in memory for the shown-once panel and dropped when it closes or the page is left.
 */
export function ApiKeyCreateRoom() {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const { resource } = useResource((signal) => readForm(api, signal), `developer-key-form:${userId}`);
  const [preset, setPreset] = useState<Preset>('custom');
  const agentHintId = useId();
  const [ticked, setTicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ApiKeysPlainKey | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [made, setMade] = useState<Made | null>(null);

  // A key for an organisation (DV-console-01): opened from that organisation's area on the key page. The form says so,
  // and it must name the sub-account the key reaches.
  const orgId = new URLSearchParams(window.location.search).get('org') ?? '';
  const here = window.location.pathname + window.location.search;
  let state: RoomState = { kind: 'ready' };
  if (resource.status === 'loading') state = { kind: 'loading' };
  else if (resource.status === 'failed') state = { kind: 'refused', refusal: failureRefusal(resource.failure, here) };
  else if (failure && !made) state = { kind: 'ready', partial: { missing: failureRefusal(failure, here) } };
  const ready = resource.status === 'ready' ? resource.data : null;
  const scopes = ready?.scopes ?? [];
  const offered = scopes.filter((entry) => entry.onKey);
  const blocked = scopes.filter((entry) => !entry.onKey);

  function choose(next: Preset) {
    setPreset(next);
    if (next !== 'custom') setTicked(presetScopes(next, scopes));
  }

  async function submit(form: HTMLFormElement, how: 'code' | 'passkey') {
    if (busy || !userId || !ready) return;
    const data = new FormData(form);
    const code = String(data.get('otp') ?? '').trim();
    const ends = String(data.get('ends') ?? '');
    const expiresAt = ends ? endOfDayUtc(ends) : undefined;
    const ips = ipLines(String(data.get('ips') ?? ''));
    const accountId = String(data.get('accountId') ?? '');
    const agent = data.get('agent') === 'on';
    const asked = {
      name: String(data.get('name') ?? ''),
      scopes: [...ticked],
      ...(ips.length > 0 ? { ips } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(accountId ? { accountId } : {}),
      ...(orgId ? { orgId } : {}),
      ...(agent ? { kind: 'agent' as const } : {}),
    };
    const factor: Factor = how === 'passkey' ? { passkey: true } : code ? { code } : null;
    setBusy(true);
    setRefusal(null);
    setFailure(null);
    try {
      const answer = await createDeveloperKey(api, userId, ready.keys, asked, factor);
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
      setBusy(false);
    }
  }

  const subaccounts = ready?.subaccounts ?? null;
  return (
    <div lang={languageFor('formTitle')}>
      <FlowTemplate
        title={t('formTitle')}
        description={resource.status === 'loading' ? t('scopesLoading') : t('formIntro')}
        roomAction={
          <a className="lt-link" href="/uc/safe/api-keys">
            {t('backToKeys')}
          </a>
        }
        state={state}
        step={
          made ? (
            <ShownOnce made={made} onDone={() => window.location.assign('/uc/safe/api-keys')} />
          ) : ready ? (
            <form
              id={FORM_ID}
              data-testid="security__card"
              aria-label={t('formTitle')}
              noValidate
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                void submit(event.currentTarget, 'code');
              }}
            >
              <Field label={t('name')} hint={t('nameHint')} name="name" autoComplete="off" maxLength={64} />
              <Select
                label={t('subaccount')}
                hint={t(subaccounts === null ? 'subaccountUnread' : orgId ? 'subaccountOrgHint' : 'subaccountHint')}
                name="accountId"
                defaultValue=""
                disabled={subaccounts === null}
                required={orgId !== ''}
                options={[
                  ['', t(orgId ? 'subaccountChoose' : 'subaccountNone')],
                  ...(subaccounts ?? []).map((row) => [row.id, row.nickname ?? row.label] as const),
                ]}
              />
              <Checkbox label={t('agentKey')} name="agent" aria-describedby={agentHintId} />
              <p id={agentHintId} className="lt-hint">
                {t('agentKeyHint')}
              </p>
              <ChoiceGroup
                legend={t('permissions')}
                name="preset"
                options={PRESETS.map((choice) => ({ value: choice, label: t(PRESET_LABEL[choice]) }))}
                value={preset}
                onChange={choose}
              />
              <div>
                <p className="lt-hint" role="status">
                  {t(PRESET_SUMMARY[preset])} {ticked.length === 0 ? t('noScopes') : ''}
                </p>
                <ul>
                  {offered.map((entry) => (
                    <li key={entry.scope}>
                      <Checkbox
                        name="scope"
                        value={entry.scope}
                        checked={ticked.includes(entry.scope)}
                        onChange={(event) => {
                          const on = event.currentTarget.checked;
                          setPreset('custom');
                          setTicked((current) => (on ? [...current, entry.scope] : current.filter((scope) => scope !== entry.scope)));
                        }}
                        label={
                          <>
                            <code className="lt-mono" lang="und">
                              {entry.scope}
                            </code>{' '}
                            <span className="lt-hint">{t(entry.access === 'read' ? 'accessRead' : 'accessWrite')}</span>
                          </>
                        }
                      />
                    </li>
                  ))}
                </ul>
                {blocked.length > 0 && (
                  <div data-testid="api-keys__blocked">
                    <h3>{t('blockedTitle')}</h3>
                    <ul>
                      {blocked.map((entry) => (
                        <li key={entry.scope}>
                          <code className="lt-mono" lang="und">
                            {entry.scope}
                          </code>
                          : {t(`blocked_${entry.blockedBy ?? 'interactive_only'}`)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <TextArea label={t('ips')} hint={t('ipsHint')} name="ips" rows={3} spellCheck={false} />
              <Field label={t('ends')} hint={t('endsHint')} name="ends" type="date" />
              <fieldset>
                <legend>{t('confirmTitle')}</legend>
                <Field label={t('otp')} name="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
              </fieldset>
              {refusal && <p role="alert">{t(refusal)}</p>}
            </form>
          ) : null
        }
        actions={
          ready && !made ? (
            <div className="lt-actions">
              <Button form={FORM_ID} type="submit" tone="primary" disabled={busy}>
                {busy ? t('working') : t('submit')}
              </Button>
              <Button
                form={FORM_ID}
                disabled={busy}
                onClick={(event) => {
                  const form = event.currentTarget.form;
                  if (form) void submit(form, 'passkey');
                }}
              >
                {t('submitPasskey')}
              </Button>
            </div>
          ) : null
        }
        summary={<KeySafety />}
      />
    </div>
  );
}
