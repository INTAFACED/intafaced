import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Field, Failure } from '../../shared/ui';
import { authoredRefusal, type ApiClient, type ApiResult } from '../../shared/api';
import { uiCopy } from '../../shared/ui-copy';
import { useSession, sessionSchema, type Session } from '../session/session';
import { signInWithPasskey } from '../session/webauthn';
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
type Problem = 'changed' | 'storage' | 'locks' | 'another' | 'cleared' | 'retained';
export function AuthForm({ register }: { register: boolean }) {
  const { t: p, languageFor: publicLanguageFor } = publicCopy.useCopy();
  const { t, Copy, requestedLocale, languageFor } = publicAuthCopy.useCopy();
  const { Copy: SharedCopy } = uiCopy.useCopy();
  const { api, commit, userId } = useSession();
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
  async function run(kind: 'register' | 'password' | 'options') {
    if (!sameRender() || (running.current && same(running.current)) || pending) return;
    let identifierForRequest = identifier.trim();
    if (kind === 'options' && !identifierForRequest) {
      const input = form.current?.elements.namedItem('identifier');
      // Some autofill tools change the DOM without an input event. Capture it now:
      // setState alone would leave this invocation using the previous blank value.
      if (input instanceof HTMLInputElement && input.value.trim()) {
        identifierForRequest = input.value.trim();
        setIdentifier(input.value);
      } else {
        setMissingPasskeyIdentifier(true);
        if (input instanceof HTMLInputElement) input.focus();
        return;
      }
    }
    if (!identifierForRequest) return;
    if (kind !== 'options' && !password) return;
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
    setPending(true);
    setProblem(null);
    setResult(null);
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
        if (kind !== 'options' && !save(kind)) return;
        let answer: ApiResult<Session>;
        if (kind === 'options') {
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
          answer = await original.api.mutate('identity', kind === 'register' ? 'auth.register' : 'auth.login', input, sessionSchema, {
            signal: controller.signal,
          });
        }
        if (!same(original)) return;
        if (answer.ok && !validAuthSession(answer.data)) answer = authoredRefusal('uncertain', { key: 'unverifiedWrite' });
        if (stage.record) settle(stage.record, answer);
        if (!same(original)) return;
        setPassword('');
        setTotp('');
        if (answer.ok) {
          commit(answer.data);
          navigate(original.invite ? `/invite?token=${encodeURIComponent(original.invite)}` : original.destination, true);
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
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!sameRender()) return;
    void run(register ? 'register' : 'password');
  }
  const selected = journal.records.find((record) => record.localRef === selectedRef);
  return (
    <section className="auth-layout" lang={publicLanguageFor('SIGN IN')}>
      <div className="auth-story">
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
      <div className="auth-form">
        {journal.records.length > 0 && (
          <div className="public-auth-history">
            <p>
              <Copy k="historyWindow" params={{ total: journal.records.length }} />
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
            className="public-auth-unknown"
            aria-label={t(
              pending && activeRecord === record.localRef
                ? 'pending'
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
                    ? 'pending'
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
        <p className="eyebrow">{register ? p('GET STARTED') : p('SIGN IN')}</p>
        <h1>{register ? p('Create your account') : p('Sign in to your account')}</h1>
        <div className="public-auth-context">
          <Copy k="after" />
          <span>{inviteToken ? t('invitation') : roomTitle(findRoom(destination.split(/[?#]/)[0] ?? '/money')!, requestedLocale)}</span>
        </div>
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
              label={p('Two-factor or recovery code (if enabled)')}
              name="totp"
              autoComplete="one-time-code"
              disabled={pending}
              data-public-auth-sensitive="true"
              value={totp}
              onChange={(event) => sameRender() && setTotp(event.target.value)}
            />
          )}
          <Button type="submit" disabled={pending}>
            {pending ? p('Connecting…') : register ? p('Create account') : p('Sign in')}
          </Button>
          {!register && (
            <Button variant="secondary" disabled={pending} onClick={() => void run('options')}>
              {p('Use a passkey')}
            </Button>
          )}
          {result && !result.ok && (
            <div lang="und">
              <Failure result={result} />
              {result.code && <small lang="zxx">{result.code}</small>}
            </div>
          )}
          <p className="muted public-auth-form-links">
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
        </form>
      </div>
    </section>
  );
}
