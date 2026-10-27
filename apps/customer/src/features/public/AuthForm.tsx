import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { BrandIris } from '@intafaced/ui';
import { SocialSignIn } from './SocialSignIn';
import { CodeSignIn } from './CodeSignIn';
import { DeviceApproval } from './DeviceApproval';
import { RecoveryCodeUsed, signInAnswerSchema, type SignInAnswer } from './RecoveryCodeUsed';
import { recoveryCodeCopy } from './recovery-code-copy';
import { MfaReset } from './MfaReset';
import { mfaResetCopy } from './mfa-reset-copy';
import { supportRecoveryCopy } from './support-recovery-copy';
import { Button, Field, Failure } from '../../shared/ui';
import { authoredRefusal, type ApiClient, type ApiResult, type SecondStep } from '../../shared/api';
import { uiCopy } from '../../shared/ui-copy';
import { LanguageMenu } from '../../shared/LanguageMenu';
import { useAccountViewStatus } from '../account/ViewSync';
import { savePreferences } from '../../shared/preferences';
import { passwordIssue } from '../../shared/password';
import { useSession, sessionSchema, type Session } from '../session/session';
import { signAssertion, signInWithPasskey } from '../session/webauthn';
import { findBrowserWallet, signWithBrowserWallet, walletChallengeSchema } from '../session/browser-wallet';
import type { Eip1193Provider } from '../protocol/wallet/eip1193';
import { useLocation, navigate } from '../../app/location';
import { findRoom, roomTitle } from '../../app/navigation';
import { publicAuthContext, publicAuthHref } from './auth-context';
import { publicCopy } from './public-copy';
import { publicAuthCopy } from './public-auth-copy';
import {
  readAuth,
  saveAuth,
  finishAuth,
  validAuthSession,
  knownAuthRefusal,
  publicAuthKey,
  publicAuthLock,
  type AuthKind,
  type AuthRecord,
} from './public-auth-guards';
import './public-auth.css';

type Original = {
  api: ApiClient;
  owner: string | null;
  context: string;
  url: string;
  generation: number;
  destination: string;
  invite?: string;
  target: string;
};
type SecondStepOptions = NonNullable<SecondStep['passkey']>;
type Problem = 'changed' | 'storage' | 'locks' | 'another' | 'cleared' | 'retained' | 'passwordShape';
export function AuthForm({ register }: { register: boolean }) {
  const { t: p, languageFor: publicLanguageFor } = publicCopy.useCopy();
  const { t, Copy, requestedLocale, languageFor } = publicAuthCopy.useCopy();
  const { Copy: SharedCopy } = uiCopy.useCopy();
  const { t: r, languageFor: recoveryLanguageFor } = recoveryCodeCopy.useCopy();
  const { t: m, languageFor: resetLanguageFor } = mfaResetCopy.useCopy();
  const recovery = supportRecoveryCopy.useCopy();
  const { api, commit, userId, restoring } = useSession();
  const accountStatus = useAccountViewStatus();
  const context = useLocation();
  const authContext = publicAuthContext(location.pathname, location.search);
  const { destination, invite: inviteToken } = authContext;
  const freshSignInHref = publicAuthHref(authContext, '/login', true);
  const [pending, setPending] = useState(false),
    [result, setResult] = useState<ApiResult<Session> | null>(null);
  const [identifier, setIdentifier] = useState(''),
    [password, setPassword] = useState(''),
    [handle, setHandle] = useState(''),
    [totp, setTotp] = useState(''),
    [region, setRegion] = useState('');
  const [missingPasskeyIdentifier, setMissingPasskeyIdentifier] = useState(false);
  // The passkey asked for after the password did not answer (cancelled or unavailable); the challenge stays usable.
  const [passkeyStopped, setPasskeyStopped] = useState(false);
  // The second step's code field takes a recovery code (I-signin-sessions-12); after a sign-in that spent one, how many are left.
  const [recoveryCode, setRecoveryCode] = useState(false);
  // "I lost my authenticator": the locked-out reset replaces the form (I-signin-sessions-12, J-identity-05 #2).
  const [lostAuthenticator, setLostAuthenticator] = useState(false);
  // Kept with the address it was shown on, so moving to another address never carries it, or its destination, along.
  const [recoveryUsed, setRecoveryUsed] = useState<{ left: number; next: string; url: string } | null>(null);
  // The browser wallet did not sign (none answered, declined, or failed); nothing was sent that signs in.
  const [walletStopped, setWalletStopped] = useState<'none' | 'rejected' | 'failed' | null>(null);
  const [firstFactor, setFirstFactor] = useState<'password' | 'wallet'>('password');
  const [problem, setProblem] = useState<Problem | null>(null),
    [journal, setJournal] = useState(readAuth);
  const [selectedRef, setSelectedRef] = useState<string | null>(journal.records.at(-1)?.localRef ?? null);
  const [activeRecord, setActiveRecord] = useState<string | null>(null);
  const mounted = useRef(true),
    running = useRef<Original | null>(null),
    abort = useRef<AbortController | null>(null);
  const form = useRef<HTMLFormElement | null>(null);
  const [, invalidateNavigation] = useState(0);
  const url = location.href;
  const current = useRef({ api, owner: userId, context, register, url, generation: 0 });
  if (
    current.current.api !== api ||
    current.current.owner !== userId ||
    current.current.context !== context ||
    current.current.register !== register ||
    current.current.url !== url
  )
    current.current = { api, owner: userId, context, register, url, generation: current.current.generation + 1 };
  const renderedContext = current.current;
  function sameRender() {
    return mounted.current && current.current === renderedContext && location.href === renderedContext.url && api.canWrite();
  }
  function same(original: Original) {
    return (
      mounted.current &&
      current.current.api === original.api &&
      current.current.owner === original.owner &&
      current.current.context === original.context &&
      current.current.url === original.url &&
      location.href === original.url &&
      current.current.generation === original.generation &&
      original.api.canWrite()
    );
  }
  function sync() {
    if (mounted.current) {
      const read = readAuth();
      setJournal(read);
      setSelectedRef((selected) =>
        read.failed || read.records.some((record) => record.localRef === selected) ? selected : (read.records.at(-1)?.localRef ?? null),
      );
    }
  }
  function clearInputs() {
    form.current?.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      input.value = '';
    });
  }
  function discardPrivate() {
    const interrupted = running.current !== null;
    abort.current?.abort();
    abort.current = null;
    running.current = null;
    clearInputs();
    setIdentifier('');
    setMissingPasskeyIdentifier(false);
    setHandle('');
    setRegion('');
    setPassword('');
    setTotp('');
    setRecoveryCode(false);
    setLostAuthenticator(false);
    setPending(false);
    setResult(null);
    setActiveRecord(null);
    setProblem(interrupted ? 'changed' : null);
    sync();
  }
  useLayoutEffect(() => {
    mounted.current = true;
    const departed = () => {
      const previous = current.current;
      if (previous.url === location.href) return;
      // Observe each departure before React can batch an A→B→A route into A.
      current.current = {
        ...previous,
        url: location.href,
        context: location.pathname + location.search,
        generation: previous.generation + 1,
      };
      discardPrivate();
      invalidateNavigation((value) => value + 1);
    };
    window.addEventListener('popstate', departed);
    window.addEventListener('hashchange', departed);
    return () => {
      mounted.current = false;
      window.removeEventListener('popstate', departed);
      window.removeEventListener('hashchange', departed);
      abort.current?.abort();
      abort.current = null;
      running.current = null;
      clearInputs();
    };
  }, []);
  useLayoutEffect(() => {
    discardPrivate();
  }, [renderedContext]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === publicAuthKey || event.key === null) sync();
    };
    window.addEventListener('storage', changed);
    return () => {
      window.removeEventListener('storage', changed);
    };
  }, []);
  /**
   * `secondStep` is the passkey after the password (I-signin-sessions-10): the service answered the password with a
   * single-use challenge for this account's sign-in passkeys, the browser signs it, and the answer opens the session.
   */
  async function run(
    kind: 'register' | 'password' | 'options' | 'secondStep' | 'wallet',
    secondStepOptions?: SecondStepOptions,
    wallet?: Eip1193Provider,
  ) {
    // Until the boot refresh answers, a cookie sign-in may still land and change the account under this form.
    if (!sameRender() || (running.current && same(running.current)) || pending || restoring) return;
    let identifierForRequest = identifier.trim();
    if (kind === 'secondStep' && !secondStepOptions) return;
    if (kind === 'options' && !identifierForRequest) {
      const input = form.current?.elements.namedItem('identifier');
      // Some autofill tools change the DOM without an input event. Capture it now:
      // setState alone would leave this invocation using the previous blank value.
      if (input instanceof HTMLInputElement && input.value.trim()) {
        identifierForRequest = input.value.trim();
        setIdentifier(input.value);
      } else {
        setResult(null);
        setMissingPasskeyIdentifier(true);
        if (input instanceof HTMLInputElement) input.focus();
        return;
      }
    }
    if (kind !== 'secondStep' && kind !== 'wallet' && !identifierForRequest) return;
    if ((kind === 'register' || kind === 'password') && !password) return;
    // The service refuses a password it cannot hash (too long, one character repeated). Say so here instead of sending it and showing an uncertain answer.
    if (kind === 'register') {
      const issue = passwordIssue(password, password);
      if (issue === 'tooLong' || issue === 'repeated') {
        setProblem('passwordShape');
        return;
      }
    }
    setMissingPasskeyIdentifier(false);
    const original: Original = {
      api,
      owner: userId,
      context,
      url: renderedContext.url,
      generation: renderedContext.generation,
      destination,
      invite: inviteToken,
      target: inviteToken ? 'invite' : findRoom(destination.split(/[?#]/)[0] ?? '/money')!.path,
    };
    // Private inputs are captured in this invocation only. No request body enters the browser journal.
    const input =
      kind === 'register'
        ? { handle: handle.trim(), email: identifierForRequest, password, ...(region ? { region: region.toUpperCase() } : {}) }
        : { identifier: identifierForRequest, password, ...(totp ? { totpCode: totp } : {}) };
    const identifierForPasskey = identifierForRequest;
    const controller = new AbortController();
    abort.current = controller;
    running.current = original;
    const previous = result;
    setPending(true);
    setProblem(null);
    setResult(null);
    setPasskeyStopped(false);
    setWalletStopped(null);
    if (kind === 'wallet' || kind === 'password') setFirstFactor(kind);
    const stage = { record: null as AuthRecord | null };
    const save = (kind: AuthKind) => {
      if (!same(original)) return false;
      const candidate: AuthRecord = {
        localRef: crypto.randomUUID(),
        kind,
        createdAt: new Date().toISOString(),
        target: original.target,
      };
      if (!saveAuth(candidate)) {
        if (same(original)) setProblem('storage');
        sync();
        return false;
      }
      stage.record = candidate;
      setActiveRecord(candidate.localRef);
      sync();
      return same(original);
    };
    const settle = (saved: AuthRecord, answer: ApiResult<unknown>) => {
      if (!same(original)) return;
      if (answer.ok || knownAuthRefusal(saved.kind, answer)) {
        const retained = !finishAuth(saved);
        if (!same(original)) return;
        if (retained) setProblem('retained');
        sync();
      }
    };
    try {
      if (!navigator.locks) {
        setProblem('locks');
        return;
      }
      await navigator.locks.request(publicAuthLock, { ifAvailable: true }, async (lock) => {
        if (!same(original)) return;
        if (!lock) {
          setProblem('another');
          return;
        }
        if (kind !== 'options' && kind !== 'secondStep' && kind !== 'wallet' && !save(kind)) return;
        let answer: ApiResult<SignInAnswer>;
        if (kind === 'secondStep') {
          // The passkey answers first; a cancelled or unavailable passkey sends nothing and keeps the challenge usable.
          const assertion = await signAssertion(secondStepOptions!, controller.signal);
          if (!same(original)) return;
          if (!assertion.ok) {
            setResult(previous);
            setPasskeyStopped(true);
            return;
          }
          if (!save('secondStep')) return;
          answer = await original.api.mutate('identity', 'auth.loginSecondStepPasskey', { credential: assertion.data }, sessionSchema, {
            signal: controller.signal,
          });
        } else if (kind === 'wallet') {
          // The wallet signs the service's message first; a declined or failed signature sends nothing that signs in.
          const signed = await signWithBrowserWallet(
            (address, chainId) =>
              original.api.mutate(
                'identity',
                'auth.walletChallenge',
                { address, chainId, origin: location.origin },
                walletChallengeSchema,
                {
                  signal: controller.signal,
                },
              ),
            wallet,
          );
          if (!same(original)) return;
          if (signed.status !== 'signed') {
            if (signed.status === 'refused') setResult(signed.result);
            else setWalletStopped(signed.status);
            return;
          }
          if (!save('wallet')) return;
          const { flowId, message, signature } = signed.answer;
          answer = await original.api.mutate(
            'identity',
            'auth.walletSignIn',
            { flowId, message, signature, ...(totp ? { totpCode: totp } : {}) },
            signInAnswerSchema,
            { signal: controller.signal },
          );
        } else if (kind === 'options') {
          answer = await signInWithPasskey(original.api, identifierForPasskey, {
            signal: controller.signal,
            current: () => same(original),
            beforeOptions: () => save('options'),
            optionsReceived: (options) => {
              if (!same(original)) return;
              if (options.ok && stage.record) {
                settle(stage.record, options);
                if (!same(original)) return;
                stage.record = null;
                if (same(original)) setActiveRecord(null);
              }
            },
            beforeVerify: () => save('passkey'),
          });
        } else {
          if (!same(original)) return;
          answer = await original.api.mutate(
            'identity',
            kind === 'register' ? 'auth.register' : 'auth.login',
            input,
            kind === 'register' ? sessionSchema : signInAnswerSchema,
            { signal: controller.signal },
          );
        }
        if (!same(original)) return;
        if (answer.ok && !validAuthSession(answer.data)) answer = authoredRefusal('uncertain', { key: 'unverifiedWrite' });
        if (stage.record) settle(stage.record, answer);
        if (!same(original)) return;
        setPassword('');
        setTotp('');
        if (answer.ok) {
          const { recoveryCodesLeft, ...session } = answer.data;
          const next = original.invite ? `/invite?token=${encodeURIComponent(original.invite)}` : original.destination;
          if (recoveryCodesLeft === undefined) {
            commit(session);
            navigate(next, true);
          } else {
            // A spent recovery code is said before the person moves on: the code is gone and this many are left. This
            // attempt is over before the session lands, so the sign-in that follows it is not read as an interruption.
            running.current = null;
            abort.current = null;
            commit(session);
            setRecoveryUsed({ left: recoveryCodesLeft, next, url: original.url });
          }
        } else {
          setResult(stage.record && !knownAuthRefusal(stage.record.kind, answer) ? { ...answer, reason: 'uncertain' } : answer);
          if (stage.record && !knownAuthRefusal(stage.record.kind, answer)) setProblem('cleared');
        }
      });
    } catch {
      if (same(original)) {
        sync();
        setPassword('');
        setTotp('');
        setProblem('storage');
      }
    } finally {
      if (running.current === original) running.current = null;
      if (abort.current === controller) abort.current = null;
      if (same(original)) {
        setPending(false);
        setActiveRecord(null);
      }
    }
  }
  /** A wallet in this browser signs in by its signature; with none, the button keeps its provider notice. */
  async function walletSignIn(): Promise<boolean> {
    const wallet = await findBrowserWallet();
    if (!wallet) return false;
    void run('wallet', undefined, wallet);
    return true;
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!sameRender()) return;
    void run(register ? 'register' : 'password');
  }
  const selected = journal.records.find((record) => record.localRef === selectedRef);
  // Every factor passed on a browser this account has not trusted yet (I-signin-sessions-07): the approval step.
  const waitingDevice =
    result && !result.ok && result.reason !== 'uncertain' && result.code === 'auth.device_authorisation_required'
      ? result.deviceAuthorisation
      : undefined;
  // The second step's own words, only for a definite answer on this page.
  const definite = result && !result.ok && result.reason !== 'uncertain' ? result : null;
  const passkeyOptions = definite?.code === 'auth.mfa_required' ? (definite.secondStep?.passkey ?? null) : null;
  const passwordStep = definite
    ? definite.code === 'auth.mfa_required'
      ? passkeyOptions
        ? definite.secondStep?.totp
          ? ('needCodeOrPasskey' as const)
          : ('needPasskey' as const)
        : ('needCode' as const)
      : definite.code === 'auth.mfa_invalid'
        ? ('codeMismatch' as const)
        : definite.code === 'auth.webauthn_invalid'
          ? ('passkeyMismatch' as const)
          : definite.code === 'auth.second_step_expired'
            ? ('secondStepExpired' as const)
            : null
    : null;
  // After a wallet signature the same steps name the wallet, not a password (I-account-lifecycle-07).
  const walletWords = {
    needCode: 'walletNeedCode',
    needPasskey: 'walletNeedPasskey',
    needCodeOrPasskey: 'walletNeedCodeOrPasskey',
    codeMismatch: 'walletCodeMismatch',
    passkeyMismatch: 'walletPasskeyMismatch',
    secondStepExpired: 'walletSecondStepExpired',
  } as const;
  const walletWordsStopped = { none: 'walletNone', rejected: 'walletRejected', failed: 'walletFailed' } as const;
  const secondStep = passwordStep && firstFactor === 'wallet' ? walletWords[passwordStep] : passwordStep;
  const stoppedWords = firstFactor === 'wallet' ? 'walletPasskeyStepStopped' : 'passkeyStepStopped';
  const spentCode = recoveryUsed && recoveryUsed.url === location.href ? recoveryUsed : null;
  // A second step a code answers: the authenticator app's, or one of the recovery codes saved with it.
  const codeStep = passwordStep === 'needCode' || passwordStep === 'needCodeOrPasskey' || passwordStep === 'codeMismatch';
  return (
    <section data-testid="auth-layout" className="auth-layout" lang={publicLanguageFor('SIGN IN')}>
      <div className="auth-story">
        {/* The sign-in moment: the mark opens once (the header beside it carries the lockup with the name). */}
        <BrandIris size={64} mode="open" className="auth-story-mark" />
        <p className="eyebrow">{p('YOUR ACCOUNT, CONNECTED')}</p>
        <p className="auth-story-title">
          {register ? (
            <>
              {p('Make your')}
              <br />
              {p('next move.')}
            </>
          ) : (
            <>
              {p('Welcome')}
              <br />
              <span>{p('back.')}</span>
            </>
          )}
        </p>
        <p>
          {p('Money, trading and payments.')}
          <br />
          {p('One place to keep perspective.')}
        </p>
        <div className="auth-story-line" />
      </div>
      <div data-testid="auth-form" className="auth-form">
        <LanguageMenu
          className="public-auth-language"
          keptIn={userId ? (accountStatus === 'not-saved' ? 'not-saved' : 'account') : 'browser'}
          onSelect={(language) => savePreferences({ language })}
        />
        {journal.records.length > 0 && (
          <div className="public-auth-history">
            <p>
              {journal.records.length === 1 ? (
                <Copy k="historySingle" />
              ) : (
                <Copy k="historyWindow" params={{ total: journal.records.length }} />
              )}
            </p>
            <label>
              <Copy k="historySelect" />
              <select
                aria-label={t('historySelect')}
                lang={languageFor('historySelect')}
                value={selectedRef ?? ''}
                onChange={(event) => setSelectedRef(event.target.value)}
              >
                {journal.records
                  .slice()
                  .reverse()
                  .map((record) => (
                    <option key={record.localRef} value={record.localRef} lang="zxx">
                      {record.localRef}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        )}
        {(selected ? [selected] : []).map((record) => (
          <section
            key={record.localRef}
            data-testid="public-auth-unknown"
            className="public-auth-unknown"
            aria-label={t(
              pending && activeRecord === record.localRef
                ? record.kind === 'register'
                  ? 'registerPending'
                  : 'pending'
                : record.kind === 'register'
                  ? 'registerUnknown'
                  : record.kind === 'options'
                    ? 'optionsUnknown'
                    : 'signInUnknown',
            )}
          >
            <h2>
              <Copy
                k={
                  pending && activeRecord === record.localRef
                    ? record.kind === 'register'
                      ? 'registerPending'
                      : 'pending'
                    : record.kind === 'register'
                      ? 'registerUnknown'
                      : record.kind === 'options'
                        ? 'optionsUnknown'
                        : 'signInUnknown'
                }
              />
            </h2>
            <p>
              <Copy
                k={
                  pending && activeRecord === record.localRef
                    ? 'pendingBody'
                    : record.kind === 'register'
                      ? 'registerMeaning'
                      : record.kind === 'options'
                        ? 'optionsMeaning'
                        : 'signInMeaning'
                }
              />
            </p>
            <p className="muted">
              <Copy k="original" /> · <Copy k={record.kind} />
            </p>
            <small>
              <Copy k="browserRef" /> · <span lang="zxx">{record.localRef}</span>
            </small>
            <p className="muted">
              <Copy k="after" /> ·{' '}
              {record.target === 'invite' ? <Copy k="invitation" /> : roomTitle(findRoom(record.target)!, requestedLocale)}
            </p>
            <p className="muted">
              <Copy k={register ? 'separateRegister' : 'separate'} />
            </p>
            {register && (
              <a className="public-auth-help" href={freshSignInHref}>
                <Copy k="freshSignIn" /> ↗
              </a>
            )}
            <a className="public-auth-help" href="/help">
              <Copy k="help" /> ↗
            </a>
          </section>
        ))}
        {(journal.failed || (problem && !(problem === 'cleared' && register))) && (
          <p className="notice public-auth-feedback" role="status">
            <Copy k={journal.failed ? 'storage' : problem!} />
          </p>
        )}
        <p role="status" aria-live="polite">
          {pending && activeRecord ? <Copy k="pending" /> : null}
        </p>
        {spentCode ? (
          <RecoveryCodeUsed
            left={spentCode.left}
            onContinue={() => navigate(spentCode.next, true)}
            onSecurity={() => navigate('/uc/safe', true)}
          />
        ) : (
          <>
            <p className="eyebrow">{register ? p('GET STARTED') : p('SIGN IN')}</p>
            <h1>{register ? p('Create your account') : p('Sign in to your account')}</h1>
            <div data-testid="public-auth-context" className="public-auth-context">
              <Copy k="after" />
              <span>{inviteToken ? t('invitation') : roomTitle(findRoom(destination.split(/[?#]/)[0] ?? '/money')!, requestedLocale)}</span>
            </div>
          </>
        )}
        {spentCode ? null : lostAuthenticator ? (
          <MfaReset identifier={identifier} onBack={() => setLostAuthenticator(false)} />
        ) : waitingDevice ? (
          <DeviceApproval
            waiting={waitingDevice}
            onSignedIn={() => {
              const next = inviteToken ? `/invite?token=${encodeURIComponent(inviteToken)}` : destination;
              // The second step spent a recovery code before this browser was approved: say so now.
              if (waitingDevice.recoveryCodesLeft === undefined) navigate(next, true);
              else setRecoveryUsed({ left: waitingDevice.recoveryCodesLeft, next, url: location.href });
            }}
            onCancel={() => setResult(null)}
          />
        ) : (
          <>
            <form ref={form} className="form-stack" onSubmit={submit}>
              {!register && (
                <p className="public-auth-method">
                  <Copy k="method" />
                </p>
              )}
              {register && (
                <Field
                  label={p('Handle')}
                  name="handle"
                  autoComplete="username"
                  required
                  minLength={3}
                  maxLength={32}
                  pattern="[a-zA-Z0-9_]+"
                  disabled={pending}
                  data-public-auth-sensitive="true"
                  value={handle}
                  onChange={(event) => sameRender() && setHandle(event.target.value)}
                />
              )}
              <Field
                label={register ? p('Email') : p('Email or handle')}
                name="identifier"
                type={register ? 'email' : 'text'}
                autoComplete={register ? 'email' : 'username'}
                required
                disabled={pending}
                data-public-auth-sensitive="true"
                value={identifier}
                error={missingPasskeyIdentifier ? <SharedCopy k="passkeyIdentifier" /> : undefined}
                onChange={(event) => {
                  if (!sameRender()) return;
                  setIdentifier(event.target.value);
                  setMissingPasskeyIdentifier(false);
                }}
              />
              <Field
                label={p('Password')}
                name="password"
                type="password"
                autoComplete={register ? 'new-password' : 'current-password'}
                required
                minLength={register ? 12 : 1}
                maxLength={200}
                hint={register ? p('At least 12 characters.') : undefined}
                disabled={pending}
                data-public-auth-sensitive="true"
                value={password}
                onChange={(event) => sameRender() && setPassword(event.target.value)}
              />
              {register ? (
                <Field
                  label={p('Country code (optional)')}
                  name="region"
                  maxLength={2}
                  minLength={2}
                  placeholder={p('ISO two-letter code')}
                  disabled={pending}
                  data-public-auth-sensitive="true"
                  value={region}
                  onChange={(event) => sameRender() && setRegion(event.target.value)}
                />
              ) : (
                <Field
                  label={recoveryCode ? r('field') : p('Two-factor or recovery code (if enabled)')}
                  hint={recoveryCode ? r('fieldHint') : undefined}
                  name="totp"
                  autoComplete={recoveryCode ? 'off' : 'one-time-code'}
                  disabled={pending}
                  data-public-auth-sensitive="true"
                  value={totp}
                  onChange={(event) => sameRender() && setTotp(event.target.value)}
                />
              )}
              <Button type="submit" disabled={pending || restoring}>
                {pending ? p('Connecting…') : register ? p('Create account') : p('Sign in')}
              </Button>
              {!register && (
                <Button variant="secondary" disabled={pending || restoring} onClick={() => void run('options')}>
                  {p('Use a passkey')}
                </Button>
              )}
              {result && !result.ok && (
                <div lang="und">
                  {result.code === 'auth.too_many_attempts' && result.reason !== 'uncertain' ? (
                    // The per-account pause: say how long, from the service's own Retry-After.
                    <p data-testid="failure" className="failure" role="alert" lang={languageFor('locked')}>
                      {result.retryAfterSeconds
                        ? t('locked', { minutes: Math.max(1, Math.ceil(result.retryAfterSeconds / 60)) })
                        : t('lockedPlain')}
                    </p>
                  ) : secondStep ? (
                    // The second step, on the page that asks for it. A wrong code and a used one read the same.
                    <div data-testid="failure" className="failure" role="alert">
                      <p lang={languageFor(secondStep)}>{t(secondStep)}</p>
                      {codeStep && (
                        <Button
                          variant="secondary"
                          disabled={pending}
                          lang={recoveryLanguageFor(recoveryCode ? 'useApp' : 'useCode')}
                          onClick={() => {
                            setRecoveryCode(!recoveryCode);
                            form.current?.querySelector<HTMLInputElement>('input[name=totp]')?.focus();
                          }}
                        >
                          {r(recoveryCode ? 'useApp' : 'useCode')}
                        </Button>
                      )}
                      {codeStep && (
                        <Button
                          variant="ghost"
                          disabled={pending}
                          lang={resetLanguageFor('lost')}
                          onClick={() => setLostAuthenticator(true)}
                        >
                          {m('lost')}
                        </Button>
                      )}
                      {passkeyOptions && (
                        <Button variant="secondary" disabled={pending} onClick={() => void run('secondStep', passkeyOptions)}>
                          {t('usePasskeyStep')}
                        </Button>
                      )}
                      {passkeyOptions && passkeyStopped && <p lang={languageFor(stoppedWords)}>{t(stoppedWords)}</p>}
                    </div>
                  ) : result.code === 'auth.account_frozen' && result.reason !== 'uncertain' && result.accountState ? (
                    // Sent only after the password verified: name the state and the one way forward.
                    <div data-testid="failure" className="failure" role="alert">
                      <p lang={languageFor(result.accountState)}>{t(result.accountState)}</p>
                      <a className="text-link" href="/help" lang={languageFor('stateHelp')}>
                        {t('stateHelp')}
                      </a>
                    </div>
                  ) : (
                    <Failure result={result} />
                  )}
                  {result.code && <small lang="zxx">{result.code}</small>}
                </div>
              )}
              <p data-testid="public-auth-form-links" className="muted public-auth-form-links">
                {register ? (
                  <>
                    {p('Already have an account?')}{' '}
                    <a className="text-link" href={publicAuthHref(authContext, '/login')}>
                      {p('Sign in')}
                    </a>
                  </>
                ) : (
                  <>
                    {p('Need an account?')}{' '}
                    <a className="text-link" href={publicAuthHref(authContext, '/register')}>
                      {p('Create one')}
                    </a>
                  </>
                )}
              </p>
              {!register && (
                <a className="text-link public-auth-help" href={publicAuthHref(authContext, '/findPwd')}>
                  {p('Recover account access')}
                </a>
              )}
              {!register && (
                <a className="text-link public-auth-help" href="/cannot-sign-in">
                  {recovery.t('link')}
                </a>
              )}
            </form>
            {!register && <CodeSignIn />}
            {!register && walletStopped && (
              <p data-testid="failure" className="failure" role="alert" lang={languageFor(walletWordsStopped[walletStopped])}>
                {t(walletWordsStopped[walletStopped])}
              </p>
            )}
            {!register && <SocialSignIn onWallet={walletSignIn} />}
          </>
        )}
      </div>
    </section>
  );
}
