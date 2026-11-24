// volt-room: /login
// volt-room: /login/returnUrl/:returnUrl
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Field, Logo } from '@intafaced/ui/lit';
import { FlowTemplate, SelectField } from '@intafaced/ui/lit/templates';
import { SocialSignIn } from './SocialSignIn';
import { CodeSignIn } from './CodeSignIn';
import { TesterBuild } from './TesterBuild';
import { DeviceApproval } from './DeviceApproval';
import { RecoveryCodeUsed, signInAnswerSchema, type SignInAnswer } from './RecoveryCodeUsed';
import { FrozenByYou } from './FrozenByYou';
import { ClosedAppeal } from './ClosedAppeal';
import { accountStatusSchema, type AccountRestriction } from '@intafaced/contracts/identity-account-status';
import { recoveryCodeCopy } from './recovery-code-copy';
import { MfaReset } from './MfaReset';
import { mfaResetCopy } from './mfa-reset-copy';
import { supportRecoveryCopy } from './support-recovery-copy';
import { authoredRefusal, type ApiClient, type ApiResult, type SecondStep } from '../../shared/api';
import { FailureNote } from '../../shared/failure-note';
import { uiCopy } from '../../shared/ui-copy';
import { LanguageMenu } from '../../shared/LanguageMenu';
import { selfFreezeCopy, useAccountViewStatus } from '../account';
import { savePreferences } from '../../shared/preferences';
import { passwordIssue } from '../../shared/password';
import {
  findBrowserWallet,
  sessionSchema,
  signAssertion,
  signInWithPasskey,
  signWithBrowserWallet,
  useSession,
  walletChallengeSchema,
  type Session,
} from '../session';
import type { Eip1193Provider } from '../protocol';
import { useLocation, navigate } from '../../app/location';
import { findRoom, roomTitle } from '../../app/navigation';
import { publicAuthContext, publicAuthHref } from './auth-context';
import { publicCopy } from './public-copy';
import { publicAuthCopy } from './public-auth-copy';
import { fetchSignInChallenge, solveSignInChallenge } from './signin-challenge';
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
import { IDENTITY_AUTH_LOGIN, IDENTITY_AUTH_REGISTER } from '@intafaced/contracts/identity-auth-procedures';

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
  const { t: sharedT } = uiCopy.useCopy();
  const { t: r, languageFor: recoveryLanguageFor } = recoveryCodeCopy.useCopy();
  const { t: m, languageFor: resetLanguageFor } = mfaResetCopy.useCopy();
  const freezeCopy = selfFreezeCopy.useCopy();
  const recovery = supportRecoveryCopy.useCopy();
  const { api, commit, userId, restoring } = useSession();
  const accountStatus = useAccountViewStatus();
  const context = useLocation();
  const authContext = publicAuthContext(location.pathname, location.search);
  const { destination, invite: inviteToken } = authContext;
  const freshSignInHref = publicAuthHref(authContext, '/login', true);
  const [pending, setPending] = useState(false),
    [result, setResult] = useState<ApiResult<Session> | null>(null);
  // Tries so far while this browser solves a sign-in challenge (I-signin-sessions-30); null when none is running.
  const [challengeTries, setChallengeTries] = useState<number | null>(null);
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
  // After a password sign-in: where it was headed, until account status says whether the owner froze the account
  // (J-identity-11 #3); then their own freeze, shown on the address it was read on.
  const [landing, setLanding] = useState<{ next: string; url: string } | null>(null);
  const [frozenByYou, setFrozenByYou] = useState<{ freeze: AccountRestriction; next: string; url: string } | null>(null);
  // The browser wallet did not sign (none answered, declined, or failed); nothing was sent that signs in.
  const [walletStopped, setWalletStopped] = useState<'none' | 'rejected' | 'failed' | null>(null);
  const [firstFactor, setFirstFactor] = useState<'password' | 'wallet'>('password');
  const [problem, setProblem] = useState<Problem | null>(null),
    [journal, setJournal] = useState(readAuth);
  const [selectedRef, setSelectedRef] = useState<string | null>(journal.records.at(-1)?.localRef ?? null);
  const [activeRecord, setActiveRecord] = useState<string | null>(null);
  const mounted = useRef(true),
    running = useRef<Original | null>(null),
    abort = useRef<AbortController | null>(null),
    // The details of a password sign-in identity answered "closed", kept only until the person asks to appeal the
    // closure (J-identity-14 #3) or anything else happens: a new attempt, leaving, or the form being cleared.
    closedProof = useRef<{ identifier: string; password: string } | null>(null);
  const form = useRef<HTMLFormElement | null>(null);
  const [, invalidateNavigation] = useState(0);
  const url = location.href;
  const current = useRef({ api, owner: userId, context, register, url, restoring, generation: 0 });
  if (
    current.current.api !== api ||
    current.current.owner !== userId ||
    current.current.context !== context ||
    current.current.register !== register ||
    current.current.url !== url ||
    current.current.restoring !== restoring
  )
    current.current = { api, owner: userId, context, register, url, restoring, generation: current.current.generation + 1 };
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
    closedProof.current = null;
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
  const discardedFor = useRef(renderedContext);
  useLayoutEffect(() => {
    const previous = discardedFor.current;
    discardedFor.current = renderedContext;
    // The boot refresh answering (its session, and so `api`, land in the same update) is not a change of person: nothing
    // could run while it was out (run() waits for it), and what was typed meanwhile is the person's own. Wiping it left
    // Sign in to submit an empty form (J-more-catalogue-09 #7, Real-app journeys run 1138, #7113). Any other change still
    // drops everything private.
    const restoreAnswered =
      previous !== renderedContext &&
      previous.restoring &&
      !renderedContext.restoring &&
      previous.context === renderedContext.context &&
      previous.register === renderedContext.register &&
      previous.url === renderedContext.url;
    if (!restoreAnswered) discardPrivate();
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
  // Once the new session is in place: an account its owner froze lands on that freeze, named with its lift path; any
  // other answer, a failed read included, goes where the sign-in was headed (identity still refuses what the freeze stops).
  // A sign-in whose session has gone, or a person who has moved on while it was read, drops the landing instead.
  useEffect(() => {
    if (!landing) return;
    if (!userId) {
      setLanding(null);
      return;
    }
    const controller = new AbortController();
    void api.query('identity', 'accountStatus.mine', undefined, accountStatusSchema, { signal: controller.signal }).then((status) => {
      if (controller.signal.aborted) return;
      if (location.href !== landing.url) {
        setLanding(null);
        return;
      }
      const freeze = status.ok ? status.data.restrictions.find((restriction) => restriction.kind === 'self_freeze') : undefined;
      setLanding(null);
      if (freeze) setFrozenByYou({ freeze, next: landing.next, url: landing.url });
      else navigate(landing.next, true);
    });
    return () => controller.abort();
  }, [landing, userId, api]);
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
    closedProof.current = null;
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
    const registerInput = {
      handle: handle.trim(),
      email: identifierForRequest,
      password,
      ...(region ? { region: region.toUpperCase() } : {}),
    };
    const loginInput = { identifier: identifierForRequest, password, ...(totp ? { totpCode: totp } : {}) };
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
          answer =
            kind === 'register'
              ? await original.api.call(IDENTITY_AUTH_REGISTER, registerInput, { signal: controller.signal })
              : await original.api.call(IDENTITY_AUTH_LOGIN, loginInput, { signal: controller.signal });
          // Too many failed sign-ins came from this address: solve the service's challenge here, then send once more.
          if (kind !== 'register' && !answer.ok && answer.code === 'auth.challenge_required') {
            setChallengeTries(0);
            try {
              const challenge = await fetchSignInChallenge(original.api, controller.signal);
              if (!same(original)) return;
              if (!challenge.ok) answer = challenge;
              else {
                const proof = await solveSignInChallenge(challenge.data, controller.signal, (tries) => {
                  if (same(original)) setChallengeTries(tries);
                });
                if (!same(original)) return;
                answer = await original.api.call(
                  IDENTITY_AUTH_LOGIN,
                  { ...loginInput, challenge: proof },
                  {
                    signal: controller.signal,
                  },
                );
              }
            } finally {
              setChallengeTries(null);
            }
          }
        }
        if (!same(original)) return;
        if (answer.ok && !validAuthSession(answer.data)) answer = authoredRefusal('uncertain', { key: 'unverifiedWrite' });
        if (stage.record) settle(stage.record, answer);
        if (!same(original)) return;
        closedProof.current =
          kind === 'password' && !answer.ok && answer.code === 'auth.account_frozen' && answer.accountState === 'closed'
            ? { identifier: identifierForRequest, password }
            : null;
        setPassword('');
        setTotp('');
        if (answer.ok) {
          const { recoveryCodesLeft, ...session } = answer.data;
          const next = original.invite ? `/invite?token=${encodeURIComponent(original.invite)}` : original.destination;
          if (recoveryCodesLeft === undefined) {
            // A new account has no freeze; a sign-in first asks account status whether its owner froze it. That read
            // happens after this attempt is over, so the session landing is not read as an interruption.
            running.current = null;
            abort.current = null;
            commit(session);
            if (kind === 'register') navigate(next, true);
            else setLanding({ next, url: original.url });
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
  const ownFreeze = frozenByYou && frozenByYou.url === location.href ? frozenByYou : null;
  // A second step a code answers: the authenticator app's, or one of the recovery codes saved with it.
  const codeStep = passwordStep === 'needCode' || passwordStep === 'needCodeOrPasskey' || passwordStep === 'codeMismatch';
  const roomTitleText = ownFreeze
    ? freezeCopy.t('frozenTitle')
    : spentCode
      ? r('title')
      : register
        ? p('Create your account')
        : p('Sign in to your account');
  const roomTitleLang = ownFreeze
    ? freezeCopy.languageFor('frozenTitle')
    : spentCode
      ? recoveryLanguageFor('title')
      : publicLanguageFor('SIGN IN');
  return (
    <FlowTemplate
      title={roomTitleText}
      titleLang={roomTitleLang}
      description={ownFreeze || spentCode ? undefined : register ? p('GET STARTED') : p('SIGN IN')}
      state={{ kind: 'ready' }}
      step={
        <div className="lt-stack" data-testid="auth-form" lang={publicLanguageFor('SIGN IN')}>
          {journal.records.length > 0 && (
            <div className="lt-stack">
              <p className="lt-muted">
                {journal.records.length === 1 ? (
                  <Copy k="historySingle" />
                ) : (
                  <Copy k="historyWindow" params={{ total: journal.records.length }} />
                )}
              </p>
              <SelectField
                label={<Copy k="historySelect" />}
                aria-label={t('historySelect')}
                lang={languageFor('historySelect')}
                value={selectedRef ?? ''}
                onChange={setSelectedRef}
                options={journal.records
                  .slice()
                  .reverse()
                  .map((record) => ({ value: record.localRef, label: record.localRef, lang: 'zxx' }))}
              />
            </div>
          )}
          {(selected ? [selected] : []).map((record) => (
            <section
              key={record.localRef}
              className="lt-note lt-stack"
              data-testid="public-auth-unknown"
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
              <p className="lt-muted">
                <Copy k="original" /> · <Copy k={record.kind} />
              </p>
              <small className="lt-hint">
                <Copy k="browserRef" /> · <span lang="zxx">{record.localRef}</span>
              </small>
              <p className="lt-muted">
                <Copy k="after" /> ·{' '}
                {record.target === 'invite' ? <Copy k="invitation" /> : roomTitle(findRoom(record.target)!, requestedLocale)}
              </p>
              <p className="lt-muted">
                <Copy k={register ? 'separateRegister' : 'separate'} />
              </p>
              {register && (
                <a className="lt-link" href={freshSignInHref}>
                  <Copy k="freshSignIn" />
                </a>
              )}
              <a className="lt-link" href="/help">
                <Copy k="help" />
              </a>
            </section>
          ))}
          {(journal.failed || (problem && !(problem === 'cleared' && register))) && (
            <p className="lt-note" data-testid="public-auth-feedback" role="status">
              <Copy k={journal.failed ? 'storage' : problem!} />
            </p>
          )}
          <p role="status" aria-live="polite">
            {(pending && activeRecord) || landing ? <Copy k="pending" /> : null}
          </p>
          {challengeTries !== null && (
            <p role="status" aria-live="polite" data-testid="signin-challenge">
              {challengeTries === 0 ? t('challengeStarting') : t('challenging', { tries: challengeTries })}
            </p>
          )}
          {ownFreeze ? (
            <FrozenByYou
              heading="none"
              freeze={ownFreeze.freeze}
              onContinue={() => navigate(ownFreeze.next, true)}
              onSecurity={() => navigate('/uc/safe', true)}
            />
          ) : spentCode ? (
            <RecoveryCodeUsed
              heading="none"
              left={spentCode.left}
              onContinue={() => {
                // Past the spent code, a sign-in still asks whether its owner froze the account.
                setRecoveryUsed(null);
                if (register) navigate(spentCode.next, true);
                else setLanding({ next: spentCode.next, url: location.href });
              }}
              onSecurity={() => navigate('/uc/safe', true)}
            />
          ) : (
            <div className="lt-note lt-stack-tight" data-testid="public-auth-context">
              <Copy k="after" />
              <span>{inviteToken ? t('invitation') : roomTitle(findRoom(destination.split(/[?#]/)[0] ?? '/money')!, requestedLocale)}</span>
            </div>
          )}
          {spentCode || ownFreeze || landing ? null : lostAuthenticator ? (
            <MfaReset identifier={identifier} onBack={() => setLostAuthenticator(false)} />
          ) : waitingDevice ? (
            <DeviceApproval
              waiting={waitingDevice}
              onSignedIn={() => {
                const next = inviteToken ? `/invite?token=${encodeURIComponent(inviteToken)}` : destination;
                // The second step spent a recovery code before this browser was approved: say so now.
                if (waitingDevice.recoveryCodesLeft !== undefined)
                  setRecoveryUsed({ left: waitingDevice.recoveryCodesLeft, next, url: location.href });
                else if (register) navigate(next, true);
                else setLanding({ next, url: location.href });
              }}
              onCancel={() => setResult(null)}
            />
          ) : (
            <>
              <form ref={form} className="lt-stack" onSubmit={submit}>
                {!register && (
                  <p className="lt-muted">
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
                  aria-invalid={missingPasskeyIdentifier}
                  error={missingPasskeyIdentifier ? sharedT('passkeyIdentifier') : undefined}
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
                <div className="lt-actions">
                  <Button tone="primary" type="submit" disabled={pending || restoring}>
                    {pending ? p('Connecting…') : register ? p('Create account') : p('Sign in')}
                  </Button>
                  {!register && (
                    <Button tone="secondary" disabled={pending || restoring} onClick={() => void run('options')}>
                      {p('Use a passkey')}
                    </Button>
                  )}
                </div>
                {result && !result.ok && (
                  <div lang="und">
                    {result.code === 'auth.too_many_attempts' && result.reason !== 'uncertain' ? (
                      // The per-account pause: say how long, from the service's own Retry-After.
                      <p data-testid="failure" className="lt-refusal" role="alert" lang={languageFor('locked')}>
                        {result.retryAfterSeconds
                          ? t('locked', { minutes: Math.max(1, Math.ceil(result.retryAfterSeconds / 60)) })
                          : t('lockedPlain')}
                      </p>
                    ) : secondStep ? (
                      // The second step, on the page that asks for it. A wrong code and a used one read the same.
                      <div data-testid="failure" className="lt-refusal" role="alert">
                        <p className="lt-refusal-body" lang={languageFor(secondStep)}>
                          {t(secondStep)}
                        </p>
                        {codeStep && (
                          <Button
                            tone="secondary"
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
                            tone="quiet"
                            disabled={pending}
                            lang={resetLanguageFor('lost')}
                            onClick={() => setLostAuthenticator(true)}
                          >
                            {m('lost')}
                          </Button>
                        )}
                        {passkeyOptions && (
                          <Button tone="secondary" disabled={pending} onClick={() => void run('secondStep', passkeyOptions)}>
                            {t('usePasskeyStep')}
                          </Button>
                        )}
                        {passkeyOptions && passkeyStopped && <p lang={languageFor(stoppedWords)}>{t(stoppedWords)}</p>}
                      </div>
                    ) : result.code === 'auth.account_frozen' && result.reason !== 'uncertain' && result.accountState ? (
                      // Sent only after the password verified: name the state and the one way forward.
                      <div data-testid="failure" className="lt-refusal" role="alert">
                        <p className="lt-refusal-body" lang={languageFor(result.accountState)}>
                          {t(result.accountState)}
                        </p>
                        <a className="lt-link" href="/help" lang={languageFor('stateHelp')}>
                          {t('stateHelp')}
                        </a>
                        {result.accountState === 'frozen' && (
                          <a className="lt-link" href="/appeal" lang={languageFor('stateAppeal')}>
                            {t('stateAppeal')}
                          </a>
                        )}
                        {result.accountState === 'closed' && (
                          <ClosedAppeal
                            take={() => {
                              const proof = closedProof.current;
                              closedProof.current = null;
                              return proof;
                            }}
                          />
                        )}
                      </div>
                    ) : (
                      <FailureNote result={result} />
                    )}
                    {result.code && <small lang="zxx">{result.code}</small>}
                  </div>
                )}
                <p className="lt-muted" data-testid="auth-form-links">
                  {register ? (
                    <>
                      {p('Already have an account?')}{' '}
                      <a className="lt-link" href={publicAuthHref(authContext, '/login')}>
                        {p('Sign in')}
                      </a>
                    </>
                  ) : (
                    <>
                      {p('Need an account?')}{' '}
                      <a className="lt-link" href={publicAuthHref(authContext, '/register')}>
                        {p('Create one')}
                      </a>
                    </>
                  )}
                </p>
                {!register && (
                  <a className="lt-link" href={publicAuthHref(authContext, '/findPwd')}>
                    {p('Recover account access')}
                  </a>
                )}
                {!register && (
                  <a className="lt-link" href="/cannot-sign-in">
                    {recovery.t('link')}
                  </a>
                )}
              </form>
              {!register && <TesterBuild />}
              {!register && <CodeSignIn />}
              {!register && walletStopped && (
                <p data-testid="failure" className="lt-refusal" role="alert" lang={languageFor(walletWordsStopped[walletStopped])}>
                  {t(walletWordsStopped[walletStopped])}
                </p>
              )}
              {!register && <SocialSignIn onWallet={walletSignIn} />}
            </>
          )}
        </div>
      }
      summary={
        <div className="lt-stack" lang={publicLanguageFor('SIGN IN')}>
          <Logo variant="mark" size={48} lit />
          <p className="lt-hint">{p('YOUR ACCOUNT, CONNECTED')}</p>
          <p>
            <strong>
              {register ? (
                <>
                  {p('Make your')} {p('next move.')}
                </>
              ) : (
                <>
                  {p('Welcome')} {p('back.')}
                </>
              )}
            </strong>
          </p>
          <p className="lt-muted">
            {p('Money, trading and payments.')} {p('One place to keep perspective.')}
          </p>
          <LanguageMenu
            keptIn={userId ? (accountStatus === 'not-saved' ? 'not-saved' : 'account') : 'browser'}
            onSelect={(language) => savePreferences({ language })}
          />
        </div>
      }
    />
  );
}
