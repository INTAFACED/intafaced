import { useEffect, useRef, useState, type FormEvent } from 'react';
import { signWithBrowserWallet, useSession } from '../session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Field } from '@intafaced/ui/lit';
import { ServiceOffNotice } from '@intafaced/ui/lit/templates';
import { serviceOffCopy } from '../../shared/service-off';
import { Failure, Loading } from './kit-parts';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { shortAddress } from '../protocol';
import { signinMethodsCopy as copy } from './signin-methods-copy';
import { cleanPhone, methodStepUp, walletMethod, waysIn, type MethodName } from './signin-methods';
import { confirmWithStepUp, type StepUpMethod } from './security-step-up';
import { IDENTITY_SIGNIN_METHODS } from '@intafaced/contracts/identity-signin-methods-procedures';
import { IDENTITY_LINK_SIGNIN_METHOD } from '@intafaced/contracts/identity-link-signin-method-procedures';
import { IDENTITY_WALLET_LINK_CHALLENGE } from '@intafaced/contracts/identity-wallet-link-challenge-procedures';
import { IDENTITY_LINK_PROVIDER_START } from '@intafaced/contracts/identity-link-provider-start-procedures';
import { IDENTITY_UNLINK_SIGNIN_METHOD } from '@intafaced/contracts/identity-unlink-signin-method-procedures';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
/** One change on its way: sent once without a confirmation, so a refusal costs none, then again with one. */
type Change = {
  change: 'link' | 'unlink';
  method: MethodName;
  clientRequestId: string;
  extra: Record<string, unknown>;
  saved: string;
};
type Off = { code: 'vendor.sms' | 'idp.social'; action: string };
// hand-declared-ok: svc-identity's sign-in methods and provider link answers have no browser-safe schema in packages/contracts yet

/**
 * Ways to sign in, in Security (I-account-lifecycle-07): the password, a code by email, passkeys, wallets, a phone
 * number and social accounts. A wallet is linked by its own signature over a message the service wrote. Texted codes
 * and social sign-in need outside providers that are switched off, and the card says so with the code. The last way
 * in cannot be removed. Every change confirms with a 6-digit code or a passkey, asked only once nothing else refuses it.
 */
export function SigninMethods({ revision = 0, onChanged }: { revision?: number; onChanged?: () => void } = {}) {
  const { t, languageFor } = copy.useCopy();
  const offWords = serviceOffCopy.useCopy().t;
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [editing, setEditing] = useState<'password' | 'phone' | null>(null);
  /** The number a link code was just texted to, while its code is awaited. */
  const [texted, setTexted] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Change | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Refusal | null>(null);
  const [off, setOff] = useState<Off | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);
  const form = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { resource, reload } = useResource(
    (signal) => (userId ? api.call(IDENTITY_SIGNIN_METHODS, {}, { signal }) : Promise.resolve({ ok: true as const, data: null })),
    `signin-methods:${userId}:${revision}`,
  );

  const clear = () => (setFailure(null), setOff(null), setProblem(null), setNote(null));
  const send = (change: Change, stepUpApprovalId?: string) =>
    change.change === 'link'
      ? api.call(IDENTITY_LINK_SIGNIN_METHOD, {
          method: change.method,
          clientRequestId: change.clientRequestId,
          ...(stepUpApprovalId ? { stepUpApprovalId } : {}),
          ...change.extra,
        })
      : api.call(IDENTITY_UNLINK_SIGNIN_METHOD, {
          method: change.method,
          clientRequestId: change.clientRequestId,
          ...(stepUpApprovalId ? { stepUpApprovalId } : {}),
          ...change.extra,
        });

  function answered(change: Change, answer: ApiResult<unknown>) {
    if (!mounted.current) return;
    if (answer.ok) {
      setWaiting(null);
      setEditing(null);
      setTexted(null);
      setNote(change.saved);
      reload();
      onChanged?.();
      return;
    }
    if (answer.code === 'identity.step_up_required') return setWaiting(change);
    setWaiting(null);
    if (answer.code === 'vendor.sms') return setOff({ code: 'vendor.sms', action: t('textedCodes') });
    if (answer.code === 'idp.social') return setOff({ code: 'idp.social', action: t('socialSignIn') });
    setFailure(answer);
  }

  async function attempt(change: Change) {
    if (busy) return;
    clear();
    setBusy(true);
    try {
      answered(change, await send(change));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function confirm(how: 'code' | 'passkey', element: HTMLFormElement) {
    const change = waiting;
    if (!change || busy) return;
    const field = element.elements.namedItem('code');
    const code = field instanceof HTMLInputElement ? field.value.trim() : '';
    if (how === 'code' && !/^\d{6}$/.test(code)) return setProblem(t('invalidCode'));
    clear();
    setBusy(true);
    try {
      const method: StepUpMethod = how === 'code' ? { totpCode: code } : { passkey: true };
      const approval = await confirmWithStepUp(api, methodStepUp(change.change, change.method, change.clientRequestId), method);
      answered(change, approval.ok ? await send(change, approval.data.stepUpApprovalId) : approval);
    } finally {
      if (field instanceof HTMLInputElement) field.value = '';
      if (mounted.current) setBusy(false);
    }
  }

  /** Text a link code to `phone`: nothing is linked, and no confirmation is asked, until the code comes back. */
  async function textCode(phone: string) {
    if (busy) return;
    clear();
    setBusy(true);
    try {
      const answer = await api.call(IDENTITY_LINK_SIGNIN_METHOD, { method: 'sms_code', clientRequestId: crypto.randomUUID(), phone });
      if (!mounted.current) return;
      if (answer.ok) {
        setTexted(phone);
        return setNote(t('phoneSent', { phone }));
      }
      if (answer.code === 'vendor.sms') return setOff({ code: 'vendor.sms', action: t('textedCodes') });
      setFailure(answer);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function linkWallet() {
    if (busy) return;
    clear();
    setBusy(true);
    try {
      const signed = await signWithBrowserWallet((address, chainId) =>
        api.call(IDENTITY_WALLET_LINK_CHALLENGE, { address, chainId, origin: location.origin }),
      );
      if (!mounted.current) return;
      if (signed.status === 'none') return setProblem(t('noWallet'));
      if (signed.status === 'rejected') return setProblem(t('walletRejected'));
      if (signed.status === 'failed') return setProblem(t('walletFailed'));
      if (signed.status === 'refused') return setFailure(signed.result);
      const { address, flowId, message, signature } = signed.answer;
      const change: Change = {
        change: 'link',
        method: walletMethod(address),
        clientRequestId: crypto.randomUUID(),
        extra: { wallet: { flowId, message, signature } },
        saved: t('walletSaved', { address: shortAddress(address) }),
      };
      answered(change, await send(change));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function linkSocial() {
    if (busy) return;
    clear();
    setBusy(true);
    try {
      const answer = await api.call(IDENTITY_LINK_PROVIDER_START, { provider: 'social' });
      if (!mounted.current) return;
      const target = answer.ok ? new URL(answer.data.authorizationUrl) : null;
      if (target?.protocol === 'https:') return location.assign(target.href);
      if (!answer.ok && answer.code === 'idp.social') return setOff({ code: 'idp.social', action: t('socialSignIn') });
      if (!answer.ok) setFailure(answer);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const change = (kind: Change['change'], method: MethodName, extra: Record<string, unknown> = {}, saved = t('saved')): Change => ({
    change: kind,
    method,
    clientRequestId: crypto.randomUUID(),
    extra,
    saved,
  });

  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  const methods = resource.data;
  if (!methods) return null;
  const last = waysIn(methods) <= 1;

  return (
    <section
      data-testid="security__signin-methods"

      aria-label={t('title')}
      lang={languageFor('title')}
    >
      <h2>{t('title')}</h2>
      <p>{t('body')}</p>
      {note && (
        <p className="lt-hint" role="status">
          {note}
        </p>
      )}
      {problem && (
        <p className="lt-hint" role="alert">
          {problem}
        </p>
      )}
      {off && (
        <ServiceOffNotice
          code={off.code}
          sentence={offWords('sentence', { action: off.action, dependency: offWords(off.code) })}
          role="status"
        />
      )}
      {failure && <Failure result={failure} />}
      {waiting && (
        <form
          ref={form}

          aria-label={t('confirmTitle')}
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void confirm('code', event.currentTarget);
          }}
        >
          <h3>{t('confirmTitle')}</h3>
          <p>{waiting.change === 'link' ? t('confirmLink') : t('confirmUnlink')}</p>
          <Field
            label={t('codeField')}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            disabled={busy}
            data-security-sensitive="true"
          />
          <div className="lt-actions">
            <Button tone="primary" type="submit" disabled={busy}>
              {busy ? t('working') : t('save')}
            </Button>
            <Button tone="secondary" disabled={busy} onClick={() => form.current && void confirm('passkey', form.current)}>
              {t('savePasskey')}
            </Button>
            <Button tone="quiet" disabled={busy} onClick={() => (setWaiting(null), setProblem(null))}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      <ul data-testid="security__rows">
        <li data-testid="security__row" aria-label={t('password')}>
          <div>
            <strong>{t('password')}</strong> <span className="lt-hint">{methods.password ? t('passwordOn') : t('passwordOff')}</span>
          </div>
          {methods.password ? (
            <Button tone="secondary" disabled={busy} onClick={() => void attempt(change('unlink', 'password'))}>
              {t('stopPassword')}
            </Button>
          ) : editing === 'password' ? (
            <form
              noValidate
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const password = String(new FormData(event.currentTarget).get('password') ?? '');
                void attempt(change('link', 'password', { password }));
              }}
            >
              <Field label={t('newPassword')} name="password" type="password" autoComplete="new-password" disabled={busy} />
              <div className="lt-actions">
                <Button tone="primary" type="submit" disabled={busy}>
                  {t('setPassword')}
                </Button>
                <Button tone="quiet" disabled={busy} onClick={() => setEditing(null)}>
                  {t('cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <Button tone="secondary" disabled={busy} onClick={() => (clear(), setEditing('password'))}>
              {t('setPassword')}
            </Button>
          )}
        </li>
        <li data-testid="security__row" aria-label={t('emailCode')}>
          <div>
            <strong>{t('emailCode')}</strong>{' '}
            <span className="lt-hint">
              {methods.emailCode.on
                ? t(methods.emailCode.proved ? 'emailCodeOn' : 'emailCodeOnUnproved', { address: methods.emailCode.address ?? '' })
                : methods.emailCode.proved
                  ? t('emailCodeOff')
                  : t('emailCodeUnproved')}
            </span>
          </div>
          {methods.emailCode.on ? (
            <Button tone="secondary" disabled={busy} onClick={() => void attempt(change('unlink', 'email_code'))}>
              {t('turnOff')}
            </Button>
          ) : (
            <Button tone="secondary" disabled={busy} onClick={() => void attempt(change('link', 'email_code'))}>
              {t('turnOn')}
            </Button>
          )}
        </li>
        <li data-testid="security__row" aria-label={t('passkeys')}>
          <div>
            <strong>{t('passkeys')}</strong>{' '}
            <span className="lt-hint">{methods.passkeys > 0 ? t('passkeyCount', { count: methods.passkeys }) : t('noPasskeys')}</span>
          </div>
        </li>
        <li data-testid="security__row" aria-label={t('wallets')}>
          <div>
            <strong>{t('wallets')}</strong>
            {methods.wallets.length === 0 && <span className="lt-hint"> {t('noWallets')}</span>}
            {methods.wallets.length > 0 && (
              <ul>
                {methods.wallets.map((wallet) => (
                  <li key={wallet.address}>
                    <span lang="zxx" data-testid="security__ref" className="lt-ref" title={wallet.address}>
                      {shortAddress(wallet.address)}
                    </span>{' '}
                    <span className="lt-hint">{t('walletLinked', { time: stamp(wallet.linkedAt, timeZone) })}</span>{' '}
                    <Button
                      tone="secondary"
                      disabled={busy}
                      aria-label={t('removeWallet', { address: shortAddress(wallet.address) })}
                      onClick={() => void attempt(change('unlink', walletMethod(wallet.address)))}
                    >
                      {t('remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button tone="secondary" disabled={busy} onClick={() => void linkWallet()}>
            {t('linkWallet')}
          </Button>
        </li>
        <li data-testid="security__row" aria-label={t('phone')}>
          <div>
            <strong>{t('phone')}</strong>{' '}
            {methods.phone ? (
              <>
                <span lang="zxx" data-testid="security__ref" className="lt-ref">
                  {methods.phone}
                </span>{' '}
                <span className="lt-hint">{t('phoneLinked')}</span>
              </>
            ) : (
              <span className="lt-hint">{t('noPhone')}</span>
            )}
          </div>
          {methods.phone ? (
            <Button
              tone="secondary"
              disabled={busy}
              aria-label={t('removePhone', { phone: methods.phone })}
              onClick={() => void attempt(change('unlink', 'sms_code'))}
            >
              {t('remove')}
            </Button>
          ) : editing === 'phone' && texted ? (
            <form
              noValidate
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const code = String(new FormData(event.currentTarget).get('phoneCode') ?? '').trim();
                if (!/^\d{6}$/.test(code)) return setProblem(t('phoneCodeInvalid'));
                void attempt(change('link', 'sms_code', { phone: texted, code }, t('phoneSaved', { phone: texted })));
              }}
            >
              <Field
                label={t('phoneCodeField')}
                name="phoneCode"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                disabled={busy}
                data-security-sensitive="true"
              />
              <div className="lt-actions">
                <Button tone="primary" type="submit" disabled={busy}>
                  {t('confirmPhone')}
                </Button>
                <Button tone="secondary" disabled={busy} onClick={() => void textCode(texted)}>
                  {t('resendCode')}
                </Button>
                <Button tone="quiet" disabled={busy} onClick={() => (setEditing(null), setTexted(null), setWaiting(null))}>
                  {t('cancel')}
                </Button>
              </div>
            </form>
          ) : editing === 'phone' ? (
            <form
              noValidate
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const phone = cleanPhone(String(new FormData(event.currentTarget).get('phone') ?? ''));
                if (!phone) return setProblem(t('phoneInvalid'));
                void textCode(phone);
              }}
            >
              <Field label={t('phoneField')} name="phone" type="tel" autoComplete="tel" disabled={busy} />
              <div className="lt-actions">
                <Button tone="primary" type="submit" disabled={busy}>
                  {t('sendCode')}
                </Button>
                <Button tone="quiet" disabled={busy} onClick={() => setEditing(null)}>
                  {t('cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <Button tone="secondary" disabled={busy} onClick={() => (clear(), setTexted(null), setEditing('phone'))}>
              {t('linkPhone')}
            </Button>
          )}
        </li>
        <li data-testid="security__row" aria-label={t('social')}>
          <div>
            <strong>{t('social')}</strong>
            {methods.providers.length === 0 && <span className="lt-hint"> {t('noSocial')}</span>}
            {methods.providers.length > 0 && (
              <ul>
                {methods.providers.map((provider) => (
                  <li key={provider}>
                    <span lang="zxx" data-testid="security__ref" className="lt-ref">
                      {provider}
                    </span>{' '}
                    <Button
                      tone="secondary"
                      disabled={busy}
                      aria-label={t('removeSocial', { provider })}
                      onClick={() => void attempt(change('unlink', `social:${provider}`))}
                    >
                      {t('remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button tone="secondary" disabled={busy} onClick={() => void linkSocial()}>
            {t('linkSocial')}
          </Button>
        </li>
      </ul>
      {last && <p className="lt-hint">{t('lastOne')}</p>}
      <div className="lt-actions">
        <Button tone="secondary" onClick={reload}>
          {t('refresh')}
        </Button>
      </div>
    </section>
  );
}
