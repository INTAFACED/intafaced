import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { ServiceOffNotice } from '../../shared/service-off';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { shortAddress } from '../protocol/wallet/eip1193';
import { signWithBrowserWallet, walletChallengeSchema } from '../session/browser-wallet';
import { signinMethodsCopy as copy } from './signin-methods-copy';
import { cleanPhone, methodStepUp, signinMethods, walletMethod, waysIn, type MethodName } from './signin-methods';
import { confirmWithStepUp, type StepUpMethod } from './security-step-up';

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
const started = z.object({ provider: z.string(), authorizationUrl: z.string().url(), expiresAt: z.string() });

/**
 * Ways to sign in, in Security (I-account-lifecycle-07): the password, a code by email, passkeys, wallets, a phone
 * number and social accounts. A wallet is linked by its own signature over a message the service wrote. Texted codes
 * and social sign-in need outside providers that are switched off, and the card says so with the code. The last way
 * in cannot be removed. Every change confirms with a 6-digit code or a passkey, asked only once nothing else refuses it.
 */
export function SigninMethods({ revision = 0, onChanged }: { revision?: number; onChanged?: () => void } = {}) {
  const { t, languageFor } = copy.useCopy();
  const { api, userId } = useSession();
  const { timeZone } = usePreferences();
  const [editing, setEditing] = useState<'password' | 'phone' | null>(null);
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
    (signal) =>
      userId ? api.query('identity', 'signinMethods', {}, signinMethods, { signal }) : Promise.resolve({ ok: true as const, data: null }),
    `signin-methods:${userId}:${revision}`,
  );

  const clear = () => (setFailure(null), setOff(null), setProblem(null), setNote(null));
  const send = (change: Change, stepUpApprovalId?: string) =>
    api.mutate(
      'identity',
      change.change === 'link' ? 'linkSigninMethod' : 'unlinkSigninMethod',
      {
        method: change.method,
        clientRequestId: change.clientRequestId,
        ...(stepUpApprovalId ? { stepUpApprovalId } : {}),
        ...change.extra,
      },
      signinMethods,
    );

  function answered(change: Change, answer: ApiResult<unknown>) {
    if (!mounted.current) return;
    if (answer.ok) {
      setWaiting(null);
      setEditing(null);
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

  async function linkWallet() {
    if (busy) return;
    clear();
    setBusy(true);
    try {
      const signed = await signWithBrowserWallet((address, chainId) =>
        api.mutate('identity', 'walletLinkChallenge', { address, chainId, origin: location.origin }, walletChallengeSchema),
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
      const answer = await api.mutate('identity', 'linkProviderStart', { provider: 'social' }, started);
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
      className="security__signin-methods security__card"
      aria-label={t('title')}
      lang={languageFor('title')}
    >
      <h2>{t('title')}</h2>
      <p>{t('body')}</p>
      {note && (
        <p className="notice" role="status">
          {note}
        </p>
      )}
      {problem && (
        <p className="error-text" role="alert">
          {problem}
        </p>
      )}
      {off && <ServiceOffNotice code={off.code} action={off.action} role="status" />}
      {failure && <Failure result={failure} />}
      {waiting && (
        <form
          ref={form}
          className="stack security__confirm"
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
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? t('working') : t('save')}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => form.current && void confirm('passkey', form.current)}>
              {t('savePasskey')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => (setWaiting(null), setProblem(null))}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      <ul data-testid="security__rows" className="security__rows">
        <li data-testid="security__row" className="security__row security__row--method" aria-label={t('password')}>
          <div>
            <strong>{t('password')}</strong> <span className="muted">{methods.password ? t('passwordOn') : t('passwordOff')}</span>
          </div>
          {methods.password ? (
            <Button variant="secondary" disabled={busy} onClick={() => void attempt(change('unlink', 'password'))}>
              {t('stopPassword')}
            </Button>
          ) : editing === 'password' ? (
            <form
              className="stack"
              noValidate
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const password = String(new FormData(event.currentTarget).get('password') ?? '');
                void attempt(change('link', 'password', { password }));
              }}
            >
              <Field label={t('newPassword')} name="password" type="password" autoComplete="new-password" disabled={busy} />
              <div className="row">
                <Button type="submit" disabled={busy}>
                  {t('setPassword')}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                  {t('cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={() => (clear(), setEditing('password'))}>
              {t('setPassword')}
            </Button>
          )}
        </li>
        <li data-testid="security__row" className="security__row security__row--method" aria-label={t('emailCode')}>
          <div>
            <strong>{t('emailCode')}</strong>{' '}
            <span className="muted">
              {methods.emailCode.on
                ? t(methods.emailCode.proved ? 'emailCodeOn' : 'emailCodeOnUnproved', { address: methods.emailCode.address ?? '' })
                : methods.emailCode.proved
                  ? t('emailCodeOff')
                  : t('emailCodeUnproved')}
            </span>
          </div>
          {methods.emailCode.on ? (
            <Button variant="secondary" disabled={busy} onClick={() => void attempt(change('unlink', 'email_code'))}>
              {t('turnOff')}
            </Button>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={() => void attempt(change('link', 'email_code'))}>
              {t('turnOn')}
            </Button>
          )}
        </li>
        <li data-testid="security__row" className="security__row security__row--method" aria-label={t('passkeys')}>
          <div>
            <strong>{t('passkeys')}</strong>{' '}
            <span className="muted">{methods.passkeys > 0 ? t('passkeyCount', { count: methods.passkeys }) : t('noPasskeys')}</span>
          </div>
        </li>
        <li data-testid="security__row" className="security__row security__row--method" aria-label={t('wallets')}>
          <div>
            <strong>{t('wallets')}</strong>
            {methods.wallets.length === 0 && <span className="muted"> {t('noWallets')}</span>}
            {methods.wallets.length > 0 && (
              <ul className="security__wallets">
                {methods.wallets.map((wallet) => (
                  <li key={wallet.address}>
                    <span lang="zxx" data-testid="security__ref" className="security__ref" title={wallet.address}>
                      {shortAddress(wallet.address)}
                    </span>{' '}
                    <span className="muted">{t('walletLinked', { time: stamp(wallet.linkedAt, timeZone) })}</span>{' '}
                    <Button
                      variant="secondary"
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
          <Button variant="secondary" disabled={busy} onClick={() => void linkWallet()}>
            {t('linkWallet')}
          </Button>
        </li>
        <li data-testid="security__row" className="security__row security__row--method" aria-label={t('phone')}>
          <div>
            <strong>{t('phone')}</strong> <span className="muted">{t('noPhone')}</span>
          </div>
          {editing === 'phone' ? (
            <form
              className="stack"
              noValidate
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                const phone = cleanPhone(String(new FormData(event.currentTarget).get('phone') ?? ''));
                if (!phone) return setProblem(t('phoneInvalid'));
                void attempt(change('link', 'sms_code', { phone }));
              }}
            >
              <Field label={t('phoneField')} name="phone" type="tel" autoComplete="tel" disabled={busy} />
              <div className="row">
                <Button type="submit" disabled={busy}>
                  {t('sendCode')}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                  {t('cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={() => (clear(), setEditing('phone'))}>
              {t('linkPhone')}
            </Button>
          )}
        </li>
        <li data-testid="security__row" className="security__row security__row--method" aria-label={t('social')}>
          <div>
            <strong>{t('social')}</strong>
            {methods.providers.length === 0 && <span className="muted"> {t('noSocial')}</span>}
            {methods.providers.length > 0 && (
              <ul className="security__wallets">
                {methods.providers.map((provider) => (
                  <li key={provider}>
                    <span lang="zxx" data-testid="security__ref" className="security__ref">
                      {provider}
                    </span>{' '}
                    <Button
                      variant="secondary"
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
          <Button variant="secondary" disabled={busy} onClick={() => void linkSocial()}>
            {t('linkSocial')}
          </Button>
        </li>
      </ul>
      {last && <p className="muted">{t('lastOne')}</p>}
      <div className="actions">
        <Button variant="secondary" onClick={reload}>
          {t('refresh')}
        </Button>
      </div>
    </section>
  );
}
