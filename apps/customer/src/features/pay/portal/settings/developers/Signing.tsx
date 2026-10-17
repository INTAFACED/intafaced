import { useState } from 'react';
import { Button, Checkbox } from '@intafaced/ui';
import { EmptyState, Field } from '../../../ui-kit';
import { PaySection } from '../../../components';
import { Facts, Gate, SelectField } from '../../components';
import { NotLiveCard } from '../../chrome/NotLiveCard';
import { reason } from '../../chrome/copy';
import { DateTime } from '../../ui/DateTime';
import { PortalReview } from '../../ui/PortalReview';
import { StatusChip } from '../../ui/StatusChip';
import { useUrlParam } from '../../hooks';
import { useResource } from '../../../../../shared/resource';
import type { SettingsBApi } from '../b-client';
import { developersCopy as c } from './copy';
import { KeyRevoke, ModeChip } from './Keys';
import { ipProblem, isPayKey, signingSnippets, splitIps, type SnippetLanguage } from './model';
import { SecretReveal, type Revealed } from './SecretReveal';
import type { ApiKey } from './schemas';

/** One key at a time: its facts, whether signed requests are required, the secret, and where it may be used from. */
export function Signing({ api }: { api: SettingsBApi }) {
  const { t } = c.useCopy();
  const keys = useResource((signal) => api.keysList(signal), 'dev:signing:keys');
  const [picked, setPicked] = useUrlParam('key');
  return (
    <div className="stack">
      <Gate resource={keys.resource} retry={keys.reload}>
        {(all) => {
          const mine = all.filter((k) => isPayKey(k.scopes));
          const active = mine.filter((k) => !k.revoked);
          const current = mine.find((k) => k.id === picked) ?? active[0];
          return (
            <>
              {mine.length === 0 ? (
                <EmptyState
                  title={t('noKeysTitle')}
                  action={
                    <a className="text-link" href="/pay/developer/keys#create">
                      {t('createKeyAction')}
                    </a>
                  }
                >
                  {t('signingNoKeys')}
                </EmptyState>
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
      <PaySection title={apiKey.name} description={t('keyFactsBody')} action={<KeyRevoke api={api} apiKey={apiKey} onDone={reload} />}>
        <Facts
          items={[
            [t('colPrefix'), <code key="p">{apiKey.prefix}</code>],
            [t('colMode'), <ModeChip key="m" mode={apiKey.mode} />],
            [t('colPermissions'), apiKey.scopes.join(', ')],
            [t('colLastUsed'), apiKey.lastUsedAt ? <DateTime key="u" value={apiKey.lastUsedAt} /> : t('neverUsed')],
            [t('colStatus'), <StatusChip key="s" entity="key" value={apiKey.revoked ? 'revoked' : 'active'} />],
          ]}
        />
        <p className="muted">{t('whoMayChange')}</p>
      </PaySection>
      {revealed && <SecretReveal {...revealed} onHide={() => setRevealed(null)} />}
      {apiKey.revoked ? (
        <p className="pp-callout" role="status">
          {t('keyIsRevoked')}
        </p>
      ) : (
        <>
          <SigningSettings
            api={api}
            keyId={apiKey.id}
            onSecret={(secret) => setRevealed({ title: t('signingSecretTitle'), secret, what: t('signingSecretWhat') })}
          />
          <RotateSecret
            api={api}
            keyId={apiKey.id}
            onSecret={(secret) => setRevealed({ title: t('signingSecretNewTitle'), secret, what: t('signingSecretWhat') })}
          />
          <AllowedIps api={api} keyId={apiKey.id} />
        </>
      )}
    </>
  );
}

export function SigningSettings({
  api,
  keyId,
  onSecret,
}: {
  api: Pick<SettingsBApi, 'signingSet'>;
  keyId: string;
  onSecret: (secret: string) => void;
}) {
  const { t } = c.useCopy();
  const [sign, setSign] = useState(false);
  const [needIp, setNeedIp] = useState(false);
  // The saved setting cannot be read, so nothing is saved until the person has chosen.
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState<{ sign: boolean; needIp: boolean } | null>(null);
  return (
    <PaySection title={t('signedTitle')} description={t('signedBody')}>
      <p className="pp-callout" role="status">
        {t('settingNotReadable')}
      </p>
      <div className="form-stack pp-form">
        <label className="pp-check">
          <Checkbox
            checked={sign}
            onCheckedChange={(on) => {
              setSign(Boolean(on));
              setTouched(true);
            }}
          />
          <span>
            <strong>{t('requireSigned')}</strong>
            <small className="muted">{t('requireSignedHint')}</small>
          </span>
        </label>
        <label className="pp-check">
          <Checkbox
            checked={needIp}
            onCheckedChange={(on) => {
              setNeedIp(Boolean(on));
              setTouched(true);
            }}
          />
          <span>
            <strong>{t('requireIp')}</strong>
            <small className="muted">{t('requireIpHint')}</small>
          </span>
        </label>
        <div className="pp-effect" aria-live="polite">
          <strong>{t('effectTitle')}</strong>
          <ul>
            <li>{sign ? t('effectSignedOn') : t('effectSignedOff')}</li>
            <li>{needIp ? t('effectIpOn') : t('effectIpOff')}</li>
          </ul>
        </div>
        <PortalReview
          title={t('saveSigning')}
          variant="primary"
          description={t('saveSigningBody')}
          disabled={!touched}
          disabledReason={t('chooseFirst')}
          review={
            <ul>
              <li>{sign ? t('effectSignedOn') : t('effectSignedOff')}</li>
              <li>{needIp ? t('effectIpOn') : t('effectIpOff')}</li>
              {sign && <li>{t('effectSecretOnce')}</li>}
            </ul>
          }
          perform={() => api.signingSet(keyId, sign, needIp)}
          onConfirmed={(result) => {
            setSaved({ sign: result.requireSignature, needIp: result.requireNonEmptyIpAllowlist });
            if (result.signingSecret) onSecret(result.signingSecret);
          }}
        />
        {saved && (
          <p className="pay-confirmed" role="status">
            {t('savedSigning', { signed: saved.sign ? t('yes') : t('no'), ip: saved.needIp ? t('yes') : t('no') })}
          </p>
        )}
      </div>
    </PaySection>
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
    <PaySection title={t('rotateTitle')} description={t('rotateBody')}>
      <PortalReview
        title={t('rotateAction')}
        description={t('rotateReview')}
        review={<p>{t('rotateEffect')}</p>}
        perform={() => api.signingRotate(keyId)}
        onConfirmed={(result) => onSecret(result.signingSecret)}
      />
    </PaySection>
  );
}

export function AllowedIps({ api, keyId }: { api: Pick<SettingsBApi, 'ipsBind' | 'ipsUnbind'>; keyId: string }) {
  const { t } = c.useCopy();
  const [text, setText] = useState('');
  const [one, setOne] = useState('');
  const [saved, setSaved] = useState<string[] | null>(null);
  const list = splitIps(text);
  const bad = list.find((ip) => ipProblem(ip));
  const oneBad = one.trim() ? ipProblem(one) : null;
  return (
    <PaySection title={t('ipsTitle')} description={t('ipsBody')}>
      <p className="pp-callout" role="status">
        {t('settingNotReadable')}
      </p>
      <div className="form-stack pp-form">
        <label className="field">
          <span>{t('ipsLabel')}</span>
          <textarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-invalid={Boolean(bad)}
            placeholder="203.0.113.10"
          />
          <small className={bad ? 'error-text' : undefined}>{bad ? t('errIp', { ip: bad }) : t('ipsHint')}</small>
        </label>
        <PortalReview
          title={t('ipsSave')}
          description={t('ipsReview')}
          disabled={Boolean(bad)}
          disabledReason={t('errIpFix')}
          review={
            <>
              <p>{list.length ? t('ipsEffect') : t('ipsEffectEmpty')}</p>
              {list.length > 0 && (
                <ul>
                  {list.map((ip) => (
                    <li key={ip}>
                      <code>{ip}</code>
                    </li>
                  ))}
                </ul>
              )}
            </>
          }
          perform={() => api.ipsBind(keyId, list)}
          onConfirmed={(result) => setSaved(result.ipAllowlist)}
        />
        <Field
          label={t('ipsRemoveLabel')}
          value={one}
          onChange={(e) => setOne(e.target.value)}
          error={oneBad ? t('errIp', { ip: one }) : undefined}
        />
        <PortalReview
          title={t('ipsRemove')}
          description={t('ipsRemoveReview')}
          disabled={!one.trim() || Boolean(oneBad)}
          disabledReason={t('errIpFix')}
          review={
            <p>
              <code>{one.trim()}</code>
            </p>
          }
          perform={() => api.ipsUnbind(keyId, one.trim())}
          onConfirmed={(result) => {
            setSaved(result.ipAllowlist);
            setOne('');
          }}
        />
        {saved && (
          <div className="pay-confirmed" role="status">
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
    </PaySection>
  );
}

export function Recipe() {
  const { t } = c.useCopy();
  const [lang, setLang] = useState<SnippetLanguage>('typescript');
  return (
    <PaySection title={t('recipeTitle')} description={t('recipeBody')}>
      <ol className="pp-steps-list">
        <li>{t('recipeStep1')}</li>
        <li>{t('recipeStep2')}</li>
        <li>{t('recipeStep3')}</li>
        <li>{t('recipeStep4')}</li>
        <li>{t('recipeStep5')}</li>
      </ol>
      <pre className="pp-code" aria-label={t('recipeCanonical')}>
        {'INTAFACED-REQ-V1\nMETHOD\n/path?query\ntimestamp\nnonce\nbody-sha256'}
      </pre>
      <p className="muted">{t('recipeWindow')}</p>
      <CodeTabs lang={lang} setLang={setLang} snippets={signingSnippets} />
      <NotLiveCard reason={reason('reasonDeveloper')} title={t('testToolTitle')} needs="signature check endpoint">
        {t('testToolBody')}
      </NotLiveCard>
    </PaySection>
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
    <div className="pp-code-tabs">
      <div role="group" aria-label={t('language')} className="pp-actions">
        {(['typescript', 'python'] as const).map((l) => (
          <Button key={l} variant={lang === l ? 'secondary' : 'ghost'} aria-pressed={lang === l} onClick={() => setLang(l)}>
            {l === 'typescript' ? 'TypeScript' : 'Python'}
          </Button>
        ))}
      </div>
      <pre className="pp-code" tabIndex={0} aria-label={t('codeSample', { language: lang === 'typescript' ? 'TypeScript' : 'Python' })}>
        <code>{snippets[lang]}</code>
      </pre>
    </div>
  );
}
