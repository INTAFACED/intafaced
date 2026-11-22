// volt-room: /pay/developer/signing
// volt-room: portal:developer-signing
import { useState } from 'react';
import { reason } from '../../chrome/copy';
import { DateTime } from '../../ui/DateTime';
import { useUrlParam } from '../../hooks';
import { useResource } from '../../../../../shared/resource';
import type { SettingsBApi } from '../b-client';
import { developersCopy as c } from './copy';
import { DeveloperRoom } from './DeveloperRoom';
import { KeyRevoke, ModeChip } from './Keys';
import { ipProblem, isPayKey, signingSnippets, splitIps, type SnippetLanguage } from './model';
import { SecretReveal, type Revealed } from './SecretReveal';
import type { ApiKey } from './schemas';
import { Field, Segmented } from '@intafaced/ui/lit';
import { Empty, Facts, Gate, NotLive, Section, SelectField, StatusChip } from '../../volt/parts';
import { Review } from '../../volt/Review';

/** One key at a time: its facts, whether signed requests are required, the secret, and where it may be used from. */
function Signing({ api }: { api: SettingsBApi }) {
  const { t } = c.useCopy();
  const keys = useResource((signal) => api.keysList(signal), 'dev:signing:keys');
  const [picked, setPicked] = useUrlParam('key');
  return (
    <div>
      <Gate resource={keys.resource} retry={keys.reload}>
        {(all) => {
          const mine = all.filter((k) => isPayKey(k.scopes));
          const active = mine.filter((k) => !k.revoked);
          const current = mine.find((k) => k.id === picked) ?? active[0];
          return (
            <>
              {mine.length === 0 ? (
                <Empty
                  title={t('noKeysTitle')}
                  action={
                    <a className="lt-link" href="/pay/developer/keys#create">
                      {t('createKeyAction')}
                    </a>
                  }
                >
                  {t('signingNoKeys')}
                </Empty>
              ) : (
                <>
                  <SelectField
                    label={t('pickKey')}
                    value={current?.id ?? ''}
                    onChange={setPicked}
                    options={mine.map((k) => [k.id, `${k.name} · ${k.prefix}${k.revoked ? ` (${t('statusRevoked')})` : ''}`] as const)}
                  />
                  {current && <KeyPanel key={current.id} api={api} apiKey={current} reload={keys.reload} />}
                </>
              )}
              <Recipe />
            </>
          );
        }}
      </Gate>
    </div>
  );
}

function KeyPanel({ api, apiKey, reload }: { api: SettingsBApi; apiKey: ApiKey; reload: () => void }) {
  const { t } = c.useCopy();
  const [revealed, setRevealed] = useState<Revealed>(null);
  return (
    <>
      <Section title={apiKey.name} description={t('keyFactsBody')} action={<KeyRevoke api={api} apiKey={apiKey} onDone={reload} />}>
        <Facts
          items={[
            [t('colPrefix'), <code key="p">{apiKey.prefix}</code>],
            [t('colMode'), <ModeChip key="m" mode={apiKey.mode} />],
            [t('colPermissions'), apiKey.scopes.join(', ')],
            [t('colLastUsed'), apiKey.lastUsedAt ? <DateTime key="u" value={apiKey.lastUsedAt} /> : t('neverUsed')],
            [t('colStatus'), <StatusChip key="s" entity="key" value={apiKey.revoked ? 'revoked' : 'active'} />],
          ]}
        />
        <p className="lt-hint">{t('whoMayChange')}</p>
      </Section>
      {revealed && <SecretReveal {...revealed} onHide={() => setRevealed(null)} />}
      {apiKey.revoked ? (
        <p className="lt-hint" role="status">
          {t('keyIsRevoked')}
        </p>
      ) : (
        <>
          <SigningSettings
            api={api}
            keyId={apiKey.id}
            requireSignature={apiKey.requireSignature}
            requireNonEmptyIpAllowlist={apiKey.requireNonEmptyIpAllowlist}
            onSecret={(secret) => setRevealed({ title: t('signingSecretTitle'), secret, what: t('signingSecretWhat') })}
          />
          <RotateSecret
            api={api}
            keyId={apiKey.id}
            onSecret={(secret) => setRevealed({ title: t('signingSecretNewTitle'), secret, what: t('signingSecretWhat') })}
          />
          <AllowedIps api={api} keyId={apiKey.id} ipAllowlist={apiKey.ipAllowlist} requireSignature={apiKey.requireSignature} />
        </>
      )}
    </>
  );
}

/** On or off, taken from the key list. The list never includes a signing secret. */
type Choice = boolean;

function OnOff({
  name,
  legend,
  hint,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  hint: string;
  value: Choice;
  onChange: (on: boolean) => void;
}) {
  const { t } = c.useCopy();
  return (
    <fieldset>
      <legend>
        <strong>{legend}</strong>
      </legend>
      <small className="lt-hint">{hint}</small>
      <div className="lt-actions" role="radiogroup" aria-label={legend}>
        <label className="lt-field">
          <input type="radio" name={name} checked={value === true} onChange={() => onChange(true)} />
          <span>{t('choiceOn')}</span>
        </label>
        <label className="lt-field">
          <input type="radio" name={name} checked={value === false} onChange={() => onChange(false)} />
          <span>{t('choiceOff')}</span>
        </label>
      </div>
    </fieldset>
  );
}

export function SigningSettings({
  api,
  keyId,
  requireSignature,
  requireNonEmptyIpAllowlist,
  onSecret,
}: {
  api: Pick<SettingsBApi, 'signingSet'>;
  keyId: string;
  requireSignature: boolean;
  requireNonEmptyIpAllowlist: boolean;
  onSecret: (secret: string) => void;
}) {
  const { t } = c.useCopy();
  const [sign, setSign] = useState<Choice>(requireSignature);
  const [needIp, setNeedIp] = useState<Choice>(requireNonEmptyIpAllowlist);
  const [saved, setSaved] = useState<{ sign: boolean; needIp: boolean; secretKept: boolean } | null>(null);
  const signLine = sign ? t('effectSignedOn') : t('effectSignedOff');
  const ipLine = needIp ? t('effectIpOn') : t('effectIpOff');
  return (
    <Section title={t('signedTitle')} description={t('signedBody')}>
      <p className="lt-hint" role="status">
        {t('postureSigning', { signed: requireSignature ? t('yes') : t('no'), ip: requireNonEmptyIpAllowlist ? t('yes') : t('no') })}
      </p>
      <div data-testid="form-stack">
        <OnOff name={`sign-${keyId}`} legend={t('requireSigned')} hint={t('requireSignedHint')} value={sign} onChange={setSign} />
        <OnOff name={`ip-${keyId}`} legend={t('requireIp')} hint={t('requireIpHint')} value={needIp} onChange={setNeedIp} />
        <div aria-live="polite">
          <strong>{t('effectTitle')}</strong>
          <ul>
            <li>{signLine}</li>
            <li>{ipLine}</li>
          </ul>
        </div>
        <Review
          title={t('saveSigning')}
          variant="primary"
          description={t('saveSigningBody')}
          review={
            <ul>
              <li>{signLine}</li>
              <li>{ipLine}</li>
              {sign === true && <li>{t('effectSecretOnce')}</li>}
              {sign === false && <li>{t('effectSecretDeleted')}</li>}
            </ul>
          }
          perform={() => api.signingSet(keyId, sign === true, needIp === true)}
          onConfirmed={(result) => {
            // Signing on without a secret in the answer means one already exists; it is never shown again.
            setSaved({
              sign: result.requireSignature,
              needIp: result.requireNonEmptyIpAllowlist,
              secretKept: result.requireSignature && !result.signingSecret,
            });
            if (result.signingSecret) onSecret(result.signingSecret);
          }}
        />
        {saved && (
          <div className="lt-hint" role="status">
            <p>{t('savedSigning', { signed: saved.sign ? t('yes') : t('no'), ip: saved.needIp ? t('yes') : t('no') })}</p>
            {saved.secretKept && <p>{t('secretExists')}</p>}
          </div>
        )}
      </div>
    </Section>
  );
}

export function RotateSecret({
  api,
  keyId,
  onSecret,
}: {
  api: Pick<SettingsBApi, 'signingRotate'>;
  keyId: string;
  onSecret: (secret: string) => void;
}) {
  const { t } = c.useCopy();
  return (
    <Section title={t('rotateTitle')} description={t('rotateBody')}>
      <Review
        title={t('rotateAction')}
        description={t('rotateReview')}
        review={<p>{t('rotateEffect')}</p>}
        perform={() => api.signingRotate(keyId)}
        onConfirmed={(result) => onSecret(result.signingSecret)}
      />
    </Section>
  );
}

export function AllowedIps({
  api,
  keyId,
  ipAllowlist = [],
  requireSignature = false,
}: {
  api: Pick<SettingsBApi, 'ipsBind' | 'ipsUnbind'>;
  keyId: string;
  ipAllowlist?: string[];
  requireSignature?: boolean;
}) {
  const { t } = c.useCopy();
  const [text, setText] = useState(ipAllowlist.join('\n'));
  const [one, setOne] = useState('');
  const [saved, setSaved] = useState<string[] | null>(null);
  const list = splitIps(text);
  const bad = list.find((ip) => ipProblem(ip));
  const oneBad = one.trim() ? ipProblem(one) : null;
  return (
    <Section title={t('ipsTitle')} description={t('ipsBody')}>
      <p className="lt-hint" role="status">
        {ipAllowlist.length === 0 ? t('ipsCurrentEmpty') : ipAllowlist.join(', ')}
      </p>
      <p className="lt-hint">{requireSignature ? t('effectSignedOn') : t('effectSignedOff')}</p>
      <p className="lt-hint">{t('ipsSigningWarning')}</p>
      <div data-testid="form-stack">
        <label className="lt-field">
          <span>{t('ipsLabel')}</span>
          <textarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-invalid={Boolean(bad)}
            placeholder="203.0.113.10"
          />
          <small className="lt-hint">{bad ? t('errIp', { ip: bad }) : t('ipsHint')}</small>
        </label>
        <Review
          title={t('ipsSave')}
          description={t('ipsReview')}
          disabled={Boolean(bad) || list.length === 0}
          disabledReason={bad ? t('errIpFix') : t('ipsEmptyUseRemoveAll')}
          review={
            <>
              <p className="lt-hint" role="note">
                {t('ipsSigningWarning')}
              </p>
              <p>{t('ipsEffect')}</p>
              <ul>
                {list.map((ip) => (
                  <li key={ip}>
                    <code>{ip}</code>
                  </li>
                ))}
              </ul>
            </>
          }
          perform={() => api.ipsBind(keyId, list)}
          onConfirmed={(result) => setSaved(result.ipAllowlist)}
        />
        {/* An empty list lets the key work from any address, so it is its own choice and never an empty Save. */}
        <Review
          title={t('ipsRemoveAll')}
          variant="sell"
          description={t('ipsRemoveAllReview')}
          review={
            <>
              <p className="lt-hint" role="note">
                {t('ipsSigningWarning')}
              </p>
              <p>{t('ipsEffectEmpty')}</p>
            </>
          }
          perform={() => api.ipsBind(keyId, [])}
          onConfirmed={(result) => {
            setSaved(result.ipAllowlist);
            setText('');
          }}
        />
        <Field
          label={t('ipsRemoveLabel')}
          value={one}
          onChange={(e) => setOne(e.target.value)}
          error={oneBad ? t('errIp', { ip: one }) : undefined}
        />
        <Review
          title={t('ipsRemove')}
          description={t('ipsRemoveReview')}
          disabled={!one.trim() || Boolean(oneBad)}
          disabledReason={t('errIpFix')}
          review={
            <>
              <p className="lt-hint" role="note">
                {t('ipsSigningWarning')}
              </p>
              <p>
                <code>{one.trim()}</code>
              </p>
            </>
          }
          perform={() => api.ipsUnbind(keyId, one.trim())}
          onConfirmed={(result) => {
            setSaved(result.ipAllowlist);
            setOne('');
          }}
        />
        {saved && (
          <div className="lt-hint" role="status">
            <strong>{t('ipsSavedTitle')}</strong>
            {saved.length === 0 ? (
              <p>{t('ipsSavedEmpty')}</p>
            ) : (
              <ul>
                {saved.map((ip) => (
                  <li key={ip}>
                    <code>{ip}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

export function Recipe() {
  const { t } = c.useCopy();
  const [lang, setLang] = useState<SnippetLanguage>('typescript');
  return (
    <Section title={t('recipeTitle')} description={t('recipeBody')}>
      <ol>
        <li>{t('recipeStep1')}</li>
        <li>{t('recipeStep2')}</li>
        <li>{t('recipeStep3')}</li>
        <li>{t('recipeStep4')}</li>
        <li>{t('recipeStep5')}</li>
      </ol>
      <pre className="lt-mono" aria-label={t('recipeCanonical')}>
        {'INTAFACED-REQ-V1\nMETHOD\n/path?query\ntimestamp\nnonce\nbody-sha256'}
      </pre>
      <p className="lt-hint">{t('recipeWindow')}</p>
      <CodeTabs lang={lang} setLang={setLang} snippets={signingSnippets} />
      <NotLive reason={reason('reasonDeveloper')} title={t('testToolTitle')} needs="signature check endpoint">
        {t('testToolBody')}
      </NotLive>
    </Section>
  );
}

export function CodeTabs({
  lang,
  setLang,
  snippets,
}: {
  lang: SnippetLanguage;
  setLang: (l: SnippetLanguage) => void;
  snippets: Record<SnippetLanguage, string>;
}) {
  const { t } = c.useCopy();
  return (
    <div>
      <Segmented
        label={t('language')}
        value={lang}
        onChange={setLang}
        options={[
          { value: 'typescript', label: 'TypeScript' },
          { value: 'python', label: 'Python' },
        ]}
      />
      <pre className="lt-mono" tabIndex={0} aria-label={t('codeSample', { language: lang === 'typescript' ? 'TypeScript' : 'Python' })}>
        <code>{snippets[lang]}</code>
      </pre>
    </div>
  );
}

/** `/pay/developer/signing` on the settings template. */
export function SigningRoom() {
  const { t } = c.useCopy();
  return (
    <DeveloperRoom room="developer-signing" explain={<p>{t('signingExplain')}</p>}>
      {(api) => <Signing api={api} />}
    </DeveloperRoom>
  );
}
