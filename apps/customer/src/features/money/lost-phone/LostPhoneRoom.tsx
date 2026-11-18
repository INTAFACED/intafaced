import { useState, type FormEvent } from 'react';
import { Button } from '@intafaced/ui';
import { FlowTemplate, type Refusal, type RoomState } from '@intafaced/ui/lit/templates';
import {
  EXTRA_CONTROLS,
  EXTRA_CONTROLS_ASSETS,
  safetyChangeOutputSchema,
  safetyReadOutputSchema,
  type ExtraControl,
  type SafetyRead,
} from '@intafaced/contracts/identity-safety';
import { defineCopy } from '../../../shared/i18n';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session/session';

/**
 * Lost phone or compromised account (BK-safe-01, J-bank-18 #4), on the flow template. From the bank: the ordered steps
 * after a lost phone, which open Security's compromised-account path; the step-up extras (opt-in checks a send to another
 * person must pass above an allowance the person sets, at least the owner's number of them, or refused while that number
 * is not published); and the location signal (an optional consent; only while it is on does a sign-in keep its region).
 * Identity holds both (`account.safety.*`); the bank holds a send above the allowance (`bank.extra_controls_pending`).
 */
const copy = defineCopy('money.lost-phone', {
  title: 'Lost phone or compromised account',
  description: 'If your phone is lost or someone else may have got in, secure the account first. Then add checks to large sends.',
  stepsTitle: 'If your phone is lost or someone got in',
  stepSecure: 'Secure the account: every session and key ends and the account is frozen, so no money leaves.',
  stepSecureLink: 'My account is compromised',
  stepCards: 'Freeze your cards.',
  stepCardsLink: 'Open cards',
  stepSecurity: 'Change your password and your second step on a device you trust.',
  stepSecurityLink: 'Open Security',
  stepScam: 'Money left that you did not send? Report it with the transfer.',
  stepScamLink: 'Report a scam',
  extrasTitle: 'Extra checks for large sends',
  extrasBody:
    'Choose checks a send to another person must pass above an allowance you set. None of these checks can be done yet, so while they are on, a send above your allowance waits and nothing is sent.',
  extrasMinimum: 'Choose at least {n} checks.',
  extrasMinimumNotSet: 'The number of checks a large send needs is not set, so extra checks cannot be turned on yet.',
  control_known_locations: 'Known locations (needs location sharing)',
  control_trusted_contacts: 'A trusted contact confirms',
  control_secret_qr: 'A secret QR code',
  control_video_fallback: 'A video call',
  allowanceLabel: 'Allowance',
  assetLabel: 'Asset',
  passwordLabel: 'Your password',
  saveExtras: 'Save extra checks',
  removeExtras: 'Remove extra checks',
  extrasOn: 'On: a send to another person above {amount} {asset} waits.',
  extrasOff: 'No extra checks are set.',
  extrasSaved: 'Extra checks saved.',
  extrasRemoved: 'Extra checks removed.',
  locationTitle: 'Location signal',
  locationBody:
    'Share the region you sign in from, so a sign-in from somewhere new stands out. Nothing is kept while this is off, and turning it off deletes what was kept.',
  locationToggle: 'Share my sign-in location',
  locationSince: 'On since',
  locationSignals: 'Recent sign-in regions',
  locationNone: 'No sign-in region is kept yet. The next sign-in adds one.',
  locationOff: 'Off: no location is kept.',
  locationTurnedOn: 'Location sharing is on.',
  locationTurnedOff: 'Location sharing is off, and the kept regions were deleted.',
  summaryTitle: 'What these do',
  summarySecure: 'Securing the account does not move money and is not undone by signing in again.',
  summaryExtras: 'Changing or removing extra checks takes your password.',
  summaryLocation: 'Only the region is kept, never your exact place.',
  signedOutTitle: 'Sign in to continue',
  signedOutBody: 'These settings belong to your account.',
  signIn: 'Sign in',
  readFailedTitle: 'Your safety settings could not be read',
  readFailedBody: 'Try again in a moment. You can still secure the account.',
  refusedTitle: 'It was not changed',
});
type T = ReturnType<typeof copy.useCopy>['t'];

function refusalOf(out: Extract<ApiResult<unknown>, { ok: false }>, t: T): Refusal {
  return { variant: 'refused', title: t('refusedTitle'), body: out.message, ...(out.code ? { reference: out.code } : {}) };
}

function roomState(
  signedIn: boolean,
  read: ReturnType<typeof useResource<SafetyRead>>['resource'],
  refusal: Refusal | null,
  t: T,
): RoomState {
  if (!signedIn)
    return {
      kind: 'refused',
      refusal: {
        variant: 'refused',
        title: t('signedOutTitle'),
        body: t('signedOutBody'),
        action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent('/bank/safety/lost-phone')}` },
      },
    };
  if (read.status === 'failed')
    return { kind: 'ready', partial: { missing: { variant: 'refused', title: t('readFailedTitle'), body: t('readFailedBody') } } };
  if (refusal) return { kind: 'ready', partial: { missing: refusal } };
  return { kind: 'ready' };
}

export function LostPhoneRoom() {
  const { t } = copy.useCopy();
  const { api, userId } = useSession();
  const [held, setHeld] = useState<SafetyRead | null>(null);
  const { resource } = useResource<SafetyRead>(
    (signal) =>
      userId
        ? api.query('identity', 'account.safety.read', undefined, safetyReadOutputSchema, { signal })
        : Promise.resolve({ ok: false as const, reason: 'unauthorized' as const, message: t('signedOutBody') }),
    `safety-read:${userId ?? 'out'}`,
  );
  const safety = held ?? (resource.status === 'ready' ? resource.data : null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<ExtraControl[] | null>(null);
  const [amount, setAmount] = useState<string | null>(null);
  const [asset, setAsset] = useState<(typeof EXTRA_CONTROLS_ASSETS)[number] | null>(null);
  const [password, setPassword] = useState('');

  const controls = picked ?? safety?.extraControls.controls ?? [];
  const allowance = amount ?? safety?.extraControls.allowance?.amount ?? '';
  const allowanceAsset = asset ?? safety?.extraControls.allowance?.assetId ?? 'USDT';

  async function change(procedure: string, body: object, done: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    setNotice('');
    const out = await api.mutate('identity', procedure, body, safetyChangeOutputSchema);
    setBusy(false);
    if (!out.ok) {
      setRefusal(refusalOf(out, t));
      return;
    }
    const { changed: _changed, ...next } = out.data;
    setHeld(next);
    setPicked(null);
    setAmount(null);
    setAsset(null);
    setPassword('');
    setNotice(done);
  }

  function saveExtras(e: FormEvent) {
    e.preventDefault();
    void change(
      'account.safety.setExtraControls',
      { controls, allowance: { amount: allowance.trim(), assetId: allowanceAsset }, password },
      t('extrasSaved'),
    );
  }

  const minimum = safety?.extraControls.minimum ?? null;
  const savedAllowance = safety?.extraControls.allowance ?? null;
  const location = safety?.location;

  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      state={roomState(Boolean(userId), resource, refusal, t)}
      step={
        <div>
          <section aria-labelledby="lost-phone-steps" data-testid="lost-phone__steps">
            <h2 id="lost-phone-steps">{t('stepsTitle')}</h2>
            <ol>
              <li>
                {t('stepSecure')}{' '}
                <a className="text-link" href="/uc/safe/compromised">
                  {t('stepSecureLink')}
                </a>
              </li>
              <li>
                {t('stepCards')}{' '}
                <a className="text-link" href="/bank/cards">
                  {t('stepCardsLink')}
                </a>
              </li>
              <li>
                {t('stepSecurity')}{' '}
                <a className="text-link" href="/uc/safe">
                  {t('stepSecurityLink')}
                </a>
              </li>
              <li>
                {t('stepScam')}{' '}
                <a className="text-link" href="/bank/safety/scam">
                  {t('stepScamLink')}
                </a>
              </li>
            </ol>
          </section>

          {notice ? (
            <p role="status" data-testid="lost-phone__notice">
              {notice}
            </p>
          ) : null}

          <section aria-labelledby="lost-phone-extras" data-testid="lost-phone__extras">
            <h2 id="lost-phone-extras">{t('extrasTitle')}</h2>
            <p>{t('extrasBody')}</p>
            <p data-testid="lost-phone__extras-minimum" data-status={minimum === null ? 'not_set' : 'set'}>
              {minimum === null ? t('extrasMinimumNotSet') : t('extrasMinimum', { n: minimum })}
            </p>
            <p data-testid="lost-phone__extras-state" data-status={savedAllowance ? 'on' : 'off'}>
              {savedAllowance ? t('extrasOn', { amount: savedAllowance.amount, asset: savedAllowance.assetId }) : t('extrasOff')}
            </p>
            <form aria-label={t('extrasTitle')} onSubmit={saveExtras}>
              <fieldset>
                {EXTRA_CONTROLS.map((control) => (
                  <label key={control} className="field">
                    <input
                      type="checkbox"
                      name="controls"
                      value={control}
                      checked={controls.includes(control)}
                      onChange={(e) => setPicked(e.target.checked ? [...controls, control] : controls.filter((c) => c !== control))}
                    />
                    <span>{t(`control_${control}`)}</span>
                  </label>
                ))}
              </fieldset>
              <label className="field">
                <span>{t('allowanceLabel')}</span>
                <input name="allowance" inputMode="decimal" value={allowance} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <label className="field">
                <span>{t('assetLabel')}</span>
                <select
                  name="allowanceAsset"
                  value={allowanceAsset}
                  onChange={(e) => setAsset(e.target.value as (typeof EXTRA_CONTROLS_ASSETS)[number])}
                >
                  {EXTRA_CONTROLS_ASSETS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('passwordLabel')}</span>
                <input
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <Button type="submit" variant="primary" loading={busy} disabled={busy || !password || !allowance.trim()}>
                {t('saveExtras')}
              </Button>
              {savedAllowance ? (
                <Button
                  type="button"
                  disabled={busy || !password}
                  onClick={() => void change('account.safety.clearExtraControls', { password }, t('extrasRemoved'))}
                >
                  {t('removeExtras')}
                </Button>
              ) : null}
            </form>
          </section>

          <section aria-labelledby="lost-phone-location" data-testid="lost-phone__location">
            <h2 id="lost-phone-location">{t('locationTitle')}</h2>
            <p>{t('locationBody')}</p>
            <label className="field">
              <input
                type="checkbox"
                name="locationConsent"
                checked={location?.consent ?? false}
                disabled={busy || !location}
                onChange={(e) =>
                  void change(
                    'account.safety.setLocationConsent',
                    { consent: e.target.checked },
                    e.target.checked ? t('locationTurnedOn') : t('locationTurnedOff'),
                  )
                }
              />
              <span>{t('locationToggle')}</span>
            </label>
            {location?.consent ? (
              <div data-testid="lost-phone__signals">
                {location.changedAt ? (
                  <p>
                    {t('locationSince')} <time dateTime={location.changedAt}>{new Date(location.changedAt).toLocaleString()}</time>
                  </p>
                ) : null}
                <h3>{t('locationSignals')}</h3>
                {location.signals.length === 0 ? (
                  <p>{t('locationNone')}</p>
                ) : (
                  <ul>
                    {location.signals.map((s) => (
                      <li key={s.at} data-testid="lost-phone__signal" data-region={s.region}>
                        {s.region} · <time dateTime={s.at}>{new Date(s.at).toLocaleString()}</time>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <p data-testid="lost-phone__location-off">{t('locationOff')}</p>
            )}
          </section>
        </div>
      }
      summary={
        <div>
          <h2>{t('summaryTitle')}</h2>
          <p>{t('summarySecure')}</p>
          <p>{t('summaryExtras')}</p>
          <p>{t('summaryLocation')}</p>
        </div>
      }
    />
  );
}
