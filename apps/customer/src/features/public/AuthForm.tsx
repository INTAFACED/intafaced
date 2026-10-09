import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button, Field, Failure } from '../../shared/ui';
import { authoredRefusal, type ApiClient, type ApiResult } from '../../shared/api';
import { useSession, sessionSchema, type Session } from '../session/session';
import { signInWithPasskey } from '../session/webauthn';
import { useLocation, navigate } from '../../app/location';
import { safeReturnTo, findRoom, roomTitle } from '../../app/navigation';
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
  generation: number;
  destination: string;
  invite?: string;
  target: string;
};
type Problem = 'changed' | 'storage' | 'locks' | 'another' | 'cleared' | 'retained';
export function AuthForm({ register }: { register: boolean }) {
  const { t: p, languageFor: publicLanguageFor } = publicCopy.useCopy();
  const { t, Copy, requestedLocale, languageFor } = publicAuthCopy.useCopy();
  const { api, commit, userId } = useSession();
  const context = useLocation();
  const invitation = z.string().uuid().safeParse(new URLSearchParams(location.search).get('invite'));
  const inviteToken = invitation.success ? invitation.data : undefined;
  let requested = new URLSearchParams(location.search).get('redirect');
  if (!requested && location.pathname.startsWith('/login/returnUrl/')) {
    try {
      requested = decodeURIComponent(location.pathname.slice('/login/returnUrl/'.length));
    } catch {
      requested = null;
    }
  }
  const destination = safeReturnTo(requested);
  const signInParams = new URLSearchParams({ redirect: destination });
  if (inviteToken) signInParams.set('invite', inviteToken);
  const freshSignInHref = `/login?${signInParams}`;
  const [pending, setPending] = useState(false),
    [result, setResult] = useState<ApiResult<Session> | null>(null);
  const [identifier, setIdentifier] = useState(''),
    [password, setPassword] = useState(''),
    [handle, setHandle] = useState(''),
    [totp, setTotp] = useState(''),
    [region, setRegion] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null),
    [journal, setJournal] = useState(readAuth);
  const [selectedRef, setSelectedRef] = useState<string | null>(journal.records.at(-1)?.localRef ?? null);
  const [activeRecord, setActiveRecord] = useState<string | null>(null);
  const mounted = useRef(true),
    running = useRef(false),
    abort = useRef<AbortController | null>(null);
  const current = useRef({ api, owner: userId, context, register, generation: 0 });
  if (
    current.current.api !== api ||
    current.current.owner !== userId ||
    current.current.context !== context ||
    current.current.register !== register
  )
    current.current = { api, owner: userId, context, register, generation: current.current.generation + 1 };
  function same(original: Original) {
    return (
      mounted.current &&
      current.current.api === original.api &&
      current.current.owner === original.owner &&
      current.current.context === original.context &&
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
  useEffect(() => {
    mounted.current = true;
    const changed = (event: StorageEvent) => {
      if (event.key === publicAuthKey || event.key === null) sync();
    };
    window.addEventListener('storage', changed);
    return () => {
      mounted.current = false;
      abort.current?.abort();
      window.removeEventListener('storage', changed);
    };
  }, []);
  useEffect(() => {
    abort.current?.abort();
    setIdentifier('');
    setHandle('');
    setRegion('');
    setPassword('');
    setTotp('');
    setResult(null);
    setActiveRecord(null);
    if (running.current) setProblem('changed');
  }, [api, userId, context, register]);
  async function run(kind: 'register' | 'password' | 'options') {
    if (running.current || pending || !api.canWrite()) return;
    if (!identifier.trim() || (kind !== 'options' && !password)) return;
    const original: Original = {
      api,
      owner: userId,
      context,
      generation: current.current.generation,
      destination,
      invite: inviteToken,
      target: inviteToken ? 'invite' : findRoom(destination.split('?')[0] ?? '/money')!.path,
    };
    // Private inputs are captured in this invocation only. No request body enters the browser journal.
    const input =
      kind === 'register'
        ? { handle: handle.trim(), email: identifier.trim(), password, ...(region ? { region: region.toUpperCase() } : {}) }
        : { identifier: identifier.trim(), password, ...(totp ? { totpCode: totp } : {}) };
    const identifierForPasskey = identifier.trim();
    const controller = new AbortController();
    abort.current = controller;
    running.current = true;
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
      if (answer.ok || knownAuthRefusal(saved.kind, answer)) {
        if (!finishAuth(saved) && same(original)) setProblem('retained');
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
              if (options.ok && stage.record) {
                settle(stage.record, options);
                stage.record = null;
                if (same(original)) setActiveRecord(null);
              }
            },
            beforeVerify: () => save('passkey'),
          });
        } else
          answer = await original.api.mutate('identity', kind === 'register' ? 'auth.register' : 'auth.login', input, sessionSchema, {
            signal: controller.signal,
          });
        if (answer.ok && !validAuthSession(answer.data)) answer = authoredRefusal('uncertain', { key: 'unverifiedWrite' });
        if (stage.record) settle(stage.record, answer);
        if (!same(original)) {
          if (mounted.current) setProblem('changed');
          return;
        }
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
      sync();
      if (same(original)) {
        setPassword('');
        setTotp('');
        setProblem('storage');
      }
    } finally {
      running.current = false;
      if (mounted.current) setPending(false);
      if (mounted.current) setActiveRecord(null);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
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
          <span>{inviteToken ? t('invitation') : roomTitle(findRoom(destination.split('?')[0] ?? '/money')!, requestedLocale)}</span>
        </div>
        <form className="form-stack" onSubmit={submit}>
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
              onChange={(event) => setHandle(event.target.value)}
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
            onChange={(event) => setIdentifier(event.target.value)}
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
            onChange={(event) => setPassword(event.target.value)}
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
              onChange={(event) => setRegion(event.target.value)}
            />
          ) : (
            <Field
              label={p('Two-factor or recovery code (if enabled)')}
              name="totp"
              autoComplete="one-time-code"
              disabled={pending}
              data-public-auth-sensitive="true"
              value={totp}
              onChange={(event) => setTotp(event.target.value)}
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
                <a className="text-link" href={inviteToken ? `/login?invite=${encodeURIComponent(inviteToken)}` : '/login'}>
                  {p('Sign in')}
                </a>
              </>
            ) : (
              <>
                {p('Need an account?')}{' '}
                <a className="text-link" href={inviteToken ? `/register?invite=${encodeURIComponent(inviteToken)}` : '/register'}>
                  {p('Create one')}
                </a>
              </>
            )}
          </p>
          {!register && (
            <a className="text-link public-auth-help" href="/findPwd">
              {p('Recover account access')}
            </a>
          )}
        </form>
      </div>
    </section>
  );
}
