import { useEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { z } from 'zod';
import { useSession } from '../session/session';
import type { ApiClient, ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Dialog, Failure, Field, Loading, Page } from '../../shared/ui';
import { IdentitySessions } from './IdentitySessions';
import { ApiKeyRecords } from './ApiKeyRecords';
import { ChangePassword } from './ChangePassword';
import { Authenticator } from './Authenticator';
import { PasskeyNames } from './PasskeyNames';
import { SigninMethods } from './SigninMethods';
import { RecoveryKeys } from './RecoveryKeys';
import { AntiPhishing } from './AntiPhishing';
import { SecurityChecklist } from './SecurityChecklist';
import { Devices } from './Devices';
import { CloseAccount } from './CloseAccount';
import { FreezeAccount } from './FreezeAccount';
import { SecurityLock } from './SecurityLock';
import { MfaResetWaiting } from './MfaResetWaiting';
import { TrustedDevices } from './TrustedDevices';
import { securityCopy as copy } from './security-copy';
import { refusalCopy } from '../../data/refusals';
import {
  credentialId,
  familyBlocked,
  finishSecurity,
  isPreEffectRefusal,
  passkeysIn,
  prepareSecurity,
  readSecurity,
  saveSecurity,
  securityFamily,
  securityKey,
  securitySessionLock,
  setupResponse,
  stepUpKind,
  type Passkey,
  type SecurityJournal,
  type SecurityKind,
  type SecurityRecord,
} from './security-guards';
import { nativeRegistration, registrationFor, registrationPayload } from './security-webauthn';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import './security.css';
import { VerifyEmail } from './VerifyEmail';
import { WithdrawStepUp } from '../money/WithdrawStepUp';

type Problem = 'changed' | 'keyChanged' | 'setupChanged' | 'storage' | 'another' | 'locks' | 'unsupported' | 'cancelled' | 'ceremonyFailed';
type Original = {
  owner: string;
  client: ApiClient;
  kind: SecurityKind;
  credential?: Passkey;
  limit: number;
  requestId: string;
  /** The five-minute token from "Confirm it's you" (`auth.stepUp`), for this one change only. Never persisted. */
  bearer?: string;
};
type Setup = {
  original: Original;
  record: SecurityRecord;
  data: z.infer<typeof setupResponse>;
  confirmed: boolean;
  /** The confirmation's answer was lost: the authenticator may be on, so its recovery codes show, labelled as such. */
  outcomeUnknown?: boolean;
};
/** The recovery codes show once the authenticator is on, or may be on because the confirmation's answer was lost. */
const recoveryCodesShown = (setup: Setup): boolean => setup.confirmed || setup.outcomeUnknown === true;
type Response = {
  original: Original;
  record?: SecurityRecord;
  answer: ApiResult<unknown>;
  receipt?: 'registered' | 'removed' | 'notRemoved' | 'confirmationAccepted';
  guardRetained?: boolean;
  unconfirmed?: boolean;
};
const emptyJournal: SecurityJournal = { records: [], failed: false };

export function Security() {
  const { api, userId, clear } = useSession();
  const { t, Copy, languageFor, requestedLocale } = copy.useCopy();
  const { timeZone } = usePreferences();
  const [limit, setLimit] = useState(50),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState<Original | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null),
    [response, setResponse] = useState<Response | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null),
    [code, setCode] = useState(''),
    [showKey, setShowKey] = useState(false);
  const [seatVersion, setSeatVersion] = useState(0);
  const [activeStage, setActiveStage] = useState<{ intent: Original; record: SecurityRecord } | null>(null);
  const [stored, setStored] = useState<{ owner: string | null; value: SecurityJournal }>(() => ({
    owner: userId,
    value: userId ? readSecurity(userId) : emptyJournal,
  }));
  const mounted = useRef(true),
    running = useRef(false),
    original = useRef<Original | null>(null),
    controller = useRef<AbortController | null>(null);
  const setupHeading = useRef<HTMLHeadingElement | null>(null);
  const authenticatorHeading = useRef<HTMLHeadingElement | null>(null);
  const [codesKept, setCodesKept] = useState(false);
  // A new or cleared setup asks again whether its codes were kept.
  useEffect(() => setCodesKept(false), [setup]);
  const [stepUp, setStepUp] = useState<Response | null>(null);
  /** Counts passkeys added or removed here, so the passkey names below load again. */
  const [passkeyRevision, setPasskeyRevision] = useState(0);
  /** Counts sign-in methods changed on this page, so the checklist loads again. */
  const [methodsRevision, setMethodsRevision] = useState(0);
  const methodsChanged = () => setMethodsRevision((value) => value + 1);
  const setupFocus = useRef<{
    intent: Original;
    origin: Element | null;
    pending: boolean;
    moved: boolean;
    readyRequest?: string;
  } | null>(null);
  const current = useRef({ userId, api });
  const clientVersion = useRef({ api, value: 0 });
  if (clientVersion.current.api !== api) clientVersion.current = { api, value: clientVersion.current.value + 1 };
  current.current = { userId, api };
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'webauthn.list', { limit }, passkeysIn(limit), { signal })
        : Promise.resolve({ ok: true as const, data: [] }),
    `security-credentials:${userId}:${clientVersion.current.value}:${limit}`,
  );
  const passkeysChanged = () => {
    reload();
    setPasskeyRevision((value) => value + 1);
    methodsChanged();
  };
  useEffect(() => {
    mounted.current = true;
    const changed = (event: StorageEvent) => {
      if (userId && (event.key === securityKey(userId) || event.key === null)) setStored({ owner: userId, value: readSecurity(userId) });
    };
    window.addEventListener('storage', changed);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      window.removeEventListener('storage', changed);
    };
  }, [userId]);
  useEffect(() => {
    const movedFocus = (event: FocusEvent) => {
      const waiting = setupFocus.current;
      if (waiting?.pending && event.target !== waiting.origin && event.target !== document.body) waiting.moved = true;
    };
    const chosenElsewhere = () => {
      if (setupFocus.current?.pending) setupFocus.current.moved = true;
    };
    document.addEventListener('focusin', movedFocus);
    document.addEventListener('pointerdown', chosenElsewhere);
    return () => {
      setupFocus.current = null;
      document.removeEventListener('focusin', movedFocus);
      document.removeEventListener('pointerdown', chosenElsewhere);
    };
  }, []);
  useEffect(() => {
    setSetup(null);
    setCode('');
    setShowKey(false);
    setReview(null);
    setActiveStage(null);
    setStepUp(null);
    setupFocus.current = null;
    original.current = null;
    controller.current?.abort();
    if (userId) setStored({ owner: userId, value: readSecurity(userId) });
  }, [api, userId]);
  const journal = stored.owner === userId ? stored.value : userId ? readSecurity(userId) : emptyJournal;
  const same = (intent: Original) =>
    mounted.current &&
    current.current.userId === intent.owner &&
    current.current.api === intent.client &&
    intent.client.canWrite() &&
    original.current === intent;
  const sameActor = (intent: Original) =>
    mounted.current && current.current.userId === intent.owner && current.current.api === intent.client && intent.client.canWrite();
  function sync(owner: string) {
    if (mounted.current && current.current.userId === owner) setStored({ owner, value: readSecurity(owner) });
  }
  const visibleSetup =
    setup &&
    sameActor(setup.original) &&
    journal.records.some((row) => row.requestId === setup.record.requestId && row.state === 'prepared')
      ? setup
      : null;
  const codesShown = visibleSetup ? recoveryCodesShown(visibleSetup) : false;
  useEffect(() => {
    const waiting = setupFocus.current;
    if (!visibleSetup || waiting?.readyRequest !== visibleSetup.record.requestId || waiting.intent !== visibleSetup.original) return;
    setupFocus.current = null;
    if (!waiting.moved && same(visibleSetup.original)) setupHeading.current?.focus();
  }, [visibleSetup?.record.requestId, api, userId]);
  /** The call options for this change: its abort signal, and the step-up token when the person just confirmed it is them. */
  const sending = (intent: Original, signal?: AbortSignal) => ({
    ...(signal ? { signal } : {}),
    ...(intent.bearer ? { bearer: intent.bearer } : {}),
  });
  const blocked = (kind: SecurityKind) => !userId || busy || familyBlocked(journal, securityFamily(kind));
  function open(kind: SecurityKind, credential?: Passkey) {
    if (!userId || blocked(kind) || running.current || !api.canWrite()) return;
    const latest = readSecurity(userId);
    setStored({ owner: userId, value: latest });
    if (familyBlocked(latest, securityFamily(kind))) return;
    const intent: Original = {
      owner: userId,
      client: api,
      kind,
      credential: credential ? { ...credential } : undefined,
      limit,
      requestId: crypto.randomUUID(),
    };
    original.current = intent;
    setupFocus.current = kind === 'setup' ? { intent, origin: document.activeElement, pending: false, moved: false } : null;
    setReview(intent);
    setProblem(null);
    setResponse(null);
  }
  function makeRecord(intent: Original, kind = intent.kind, credential?: string, setupRequest?: string): SecurityRecord {
    return {
      owner: intent.owner,
      requestId: crypto.randomUUID(),
      kind,
      state: 'sent',
      createdAt: new Date().toISOString(),
      ...(credential ? { credential } : {}),
      ...(setupRequest ? { setupRequest } : {}),
    };
  }
  function save(intent: Original, record: SecurityRecord) {
    if (!same(intent)) return false;
    if (!saveSecurity(record)) {
      sync(intent.owner);
      setProblem('storage');
      return false;
    }
    sync(intent.owner);
    setActiveStage({ intent, record });
    return same(intent);
  }
  function known(intent: Original, record: SecurityRecord, answer: ApiResult<unknown>, receipt?: Response['receipt']) {
    if (!same(intent)) return false;
    let guardRetained = false;
    const unconfirmed = !answer.ok && !isPreEffectRefusal(record.kind, answer);
    if (!unconfirmed) guardRetained = !finishSecurity(record);
    sync(intent.owner);
    setResponse({ original: intent, record, answer, receipt, guardRetained, unconfirmed });
    if (guardRetained) setProblem('storage');
    return !guardRetained;
  }
  function settleOriginalRefusal(record: SecurityRecord, answer: ApiResult<unknown>) {
    // A source-verified original401 may already have cleared its original token. Only this exact
    // typed pre-effect refusal can remove its saved operation; generic401/other4xx cannot do so.
    if (isPreEffectRefusal(record.kind, answer)) finishSecurity(record);
  }
  async function coordinated(intent: Original, task: () => Promise<void>) {
    if (running.current || !same(intent)) {
      if (mounted.current) setProblem('changed');
      return;
    }
    running.current = true;
    setBusy(true);
    setReview(null);
    setProblem(null);
    setResponse(null);
    try {
      if (!navigator.locks) {
        setProblem('locks');
        return;
      }
      await navigator.locks.request(securitySessionLock(intent.owner), { ifAvailable: true }, async (lock) => {
        if (!same(intent)) return;
        if (!lock) {
          setProblem('another');
          return;
        }
        const latest = readSecurity(intent.owner);
        sync(intent.owner);
        if (familyBlocked(latest, securityFamily(intent.kind))) {
          if (latest.failed) setProblem('storage');
          return;
        }
        await task();
      });
    } catch {
      if (same(intent)) {
        sync(intent.owner);
        setProblem('storage');
      }
    } finally {
      running.current = false;
      if (setupFocus.current?.intent === intent && !setupFocus.current.readyRequest) setupFocus.current = null;
      if (mounted.current) {
        setBusy(false);
        setActiveStage(null);
      }
    }
  }
  async function addPasskey(intent: Original) {
    if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials?.create) {
      setProblem('unsupported');
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    const preparation = makeRecord(intent, 'options');
    if (!save(intent, preparation)) return;
    const options = await intent.client.mutate(
      'identity',
      'webauthn.registerOptions',
      {},
      registrationFor(intent.owner),
      sending(intent, abort.signal),
    );
    if (!same(intent)) {
      settleOriginalRefusal(preparation, options);
      return;
    }
    if (!known(intent, preparation, options)) return;
    if (!options.ok) return;
    let payload: ReturnType<typeof registrationPayload>;
    try {
      const credential = await navigator.credentials.create(nativeRegistration(options.data, abort.signal));
      if (!same(intent)) return;
      payload = registrationPayload(credential);
      if (!payload) {
        setProblem('ceremonyFailed');
        return;
      }
    } catch (error) {
      if (same(intent)) setProblem(error instanceof DOMException && error.name === 'NotAllowedError' ? 'cancelled' : 'ceremonyFailed');
      return;
    }
    const registration = makeRecord(intent, 'register', payload.rawId);
    if (!save(intent, registration)) return;
    const answer = await intent.client.mutate(
      'identity',
      'webauthn.registerVerify',
      payload,
      z.object({ credentialId }).refine((value) => value.credentialId === payload!.rawId),
      sending(intent, abort.signal),
    );
    if (!same(intent)) {
      settleOriginalRefusal(registration, answer);
      // The passkey is stored even if this page moved on; the lists and the checklist still follow it.
      if (answer.ok && mounted.current) passkeysChanged();
      return;
    }
    known(intent, registration, answer, answer.ok ? 'registered' : undefined);
    if (answer.ok) passkeysChanged();
  }
  async function removePasskey(intent: Original) {
    if (!intent.credential) return;
    const abort = new AbortController();
    controller.current = abort;
    const fresh = await intent.client.query('identity', 'webauthn.list', { limit: intent.limit }, passkeysIn(intent.limit), {
      signal: abort.signal,
    });
    if (!same(intent)) {
      if (mounted.current) setProblem('changed');
      return;
    }
    if (!fresh.ok) {
      setResponse({ original: intent, answer: fresh });
      return;
    }
    if (!fresh.data.some((row) => row.credentialId === intent.credential!.credentialId && row.createdAt === intent.credential!.createdAt)) {
      setProblem('keyChanged');
      passkeysChanged();
      return;
    }
    const record = makeRecord(intent, 'remove', intent.credential.credentialId);
    if (!save(intent, record)) return;
    const answer = await intent.client.mutate(
      'identity',
      'webauthn.remove',
      { credentialId: intent.credential.credentialId },
      z.object({ removed: z.boolean() }),
      sending(intent, abort.signal),
    );
    if (!same(intent)) {
      settleOriginalRefusal(record, answer);
      if (answer.ok && mounted.current) passkeysChanged();
      return;
    }
    known(intent, record, answer, answer.ok ? (answer.data.removed ? 'removed' : 'notRemoved') : undefined);
    if (answer.ok) passkeysChanged();
  }
  async function startSetup(intent: Original) {
    const record = makeRecord(intent, 'setup');
    if (!save(intent, record)) return;
    setSetup(null);
    setCode('');
    setShowKey(false);
    const answer = await intent.client.mutate('identity', 'totp.enrol', {}, setupResponse, sending(intent));
    if (!same(intent)) {
      settleOriginalRefusal(record, answer);
      return;
    }
    if (!answer.ok) {
      known(intent, record, answer);
      return;
    }
    if (!prepareSecurity(record)) {
      sync(intent.owner);
      setProblem('storage');
      return;
    }
    const prepared = { ...record, state: 'prepared' as const };
    sync(intent.owner);
    if (setupFocus.current?.intent === intent) setupFocus.current.readyRequest = prepared.requestId;
    // A setup started after "Confirm it is you" keeps that token for its own confirmation only: the factor gate checks
    // the confirmation too. It stays in memory with this setup and expires in five minutes.
    setSetup({ original: intent, record: prepared, data: answer.data, confirmed: false });
    setResponse(null);
  }
  async function confirmSetup(event: FormEvent) {
    event.preventDefault();
    const prepared = visibleSetup,
      entered = code;
    if (!prepared || prepared.confirmed || blocked('confirm') || !/^[0-9]{6}$/.test(entered)) return;
    const intent: Original = { ...prepared.original, kind: 'confirm', requestId: crypto.randomUUID() };
    original.current = intent;
    await coordinated(intent, async () => {
      const latest = readSecurity(intent.owner);
      if (latest.failed || !latest.records.some((row) => row.requestId === prepared.record.requestId && row.state === 'prepared')) {
        setSetup(null);
        setCode('');
        setShowKey(false);
        setProblem(latest.failed ? 'storage' : 'setupChanged');
        return;
      }
      const record = makeRecord(intent, 'confirm', undefined, prepared.record.requestId);
      if (!save(intent, record)) return;
      const answer = await intent.client.mutate(
        'identity',
        'totp.confirm',
        { secret: prepared.data.secret, code: entered },
        z.object({ ok: z.literal(true) }),
        // A wrong code is this form's answer, not the end of the sign-in.
        { ...sending(intent), keepSessionFor: ['auth.mfa_invalid'] },
      );
      if (!same(intent)) {
        settleOriginalRefusal(record, answer);
        // An uncertain answer may also mean it is on: the checklist re-reads either way.
        if ((answer.ok || answer.reason === 'uncertain') && mounted.current) methodsChanged();
        // The authenticator is on; while it is still this person on this client, the recovery codes must still show.
        if (answer.ok && sameActor(intent)) setSetup({ ...prepared, confirmed: true });
        else if (!answer.ok && answer.reason === 'uncertain' && sameActor(intent)) setSetup({ ...prepared, outcomeUnknown: true });
        return;
      }
      known(intent, record, answer, answer.ok ? 'confirmationAccepted' : undefined);
      setCode('');
      if (answer.ok) {
        setShowKey(false);
        setSetup({ ...prepared, confirmed: true });
        methodsChanged();
      } else if (answer.reason === 'uncertain') {
        // Identity may have turned the authenticator on before the answer was lost; these codes would be its only copy.
        setSetup({ ...prepared, outcomeUnknown: true });
        methodsChanged();
      }
    });
  }
  async function logoutAll(intent: Original) {
    const record = makeRecord(intent, 'logout');
    if (!save(intent, record)) return;
    // The owner lock excludes a held child write. Remount also cancels any old child review before dispatch.
    flushSync(() => setSeatVersion((value) => value + 1));
    if (!same(intent)) return;
    const answer = await intent.client.mutate(
      'identity',
      'auth.logoutAll',
      {},
      z.object({ revoked: z.number().int().safe().nonnegative() }),
    );
    if (!same(intent)) {
      settleOriginalRefusal(record, answer);
      return;
    }
    known(intent, record, answer);
    if (answer.ok) {
      setSetup(null);
      setCode('');
      setShowKey(false);
      clear();
    }
  }
  /** The person saved the recovery codes: the codes, the setup key and the setup's journal row leave for good. */
  function codesSaved() {
    const saved = visibleSetup;
    if (!saved || !recoveryCodesShown(saved) || !codesKept) return;
    if (finishSecurity(saved.record)) sync(saved.record.owner);
    setSetup(null);
    setShowKey(false);
    setCode('');
    setCodesKept(false);
    setResponse(null);
    authenticatorHeading.current?.focus();
  }
  function dispatch(intent: Original) {
    return intent.kind === 'options'
      ? addPasskey(intent)
      : intent.kind === 'remove'
        ? removePasskey(intent)
        : intent.kind === 'setup'
          ? startSetup(intent)
          : logoutAll(intent);
  }
  /**
   * Sends the change the factor gate refused once more, with the step-up token as that call's own bearer. The token is
   * never persisted; it stays in memory with this one intent (and a setup it starts, for that setup's confirmation), and
   * a later change asks again. The change's own answer
   * shows on the page, as any other answer does. A refused authenticator confirmation is not resent: its code has likely
   * expired, so that refusal offers signing in again instead.
   */
  async function afterStepUp(refused: Response, token: string): Promise<ApiResult<null>> {
    const kind = stepUpKind(refused.record?.kind);
    if (!kind || !userId || running.current || !sameActor(refused.original)) {
      return { ok: false, reason: 'invalid_response', message: t('stepUpChanged') };
    }
    setStepUp(null);
    const intent: Original = { ...refused.original, kind, requestId: crypto.randomUUID(), bearer: token };
    original.current = intent;
    await coordinated(intent, () => dispatch(intent));
    return { ok: true, data: null };
  }
  function confirmReview() {
    const intent = review;
    if (!intent) return;
    if (setupFocus.current?.intent === intent) setupFocus.current.pending = true;
    void coordinated(intent, () => dispatch(intent));
  }
  function references(owner: string, request?: string, credential?: string) {
    return (
      <dl className="security__context">
        <div>
          <dt>
            <Copy k="owner" />
          </dt>
          <dd lang="zxx">{owner}</dd>
        </div>
        {credential && (
          <div>
            <dt>
              <Copy k="credential" />
            </dt>
            <dd lang="zxx">{credential}</dd>
          </div>
        )}
        {request && (
          <div>
            <dt>
              <Copy k="request" />
            </dt>
            <dd lang="zxx">{request}</dd>
          </div>
        )}
      </dl>
    );
  }
  const kindLabel = (kind: SecurityKind) =>
    kind === 'remove' ? 'removeKind' : kind === 'confirm' ? 'confirmKind' : kind === 'logout' ? 'logoutKind' : kind;
  const currentResponse = response && sameActor(response.original) ? response : null;
  const secondFactor = refusalCopy('auth.mfa_required');
  const sessionBlocked = familyBlocked(journal, 'sessions');
  const uncertainty = journal.records.filter((row) => row.state === 'sent');
  return (
    <div lang={languageFor('title')} className="security">
      <Page title={<Copy k="title" />} description={<Copy k="description" />}>
        <VerifyEmail />
        <SecurityChecklist revision={methodsRevision} />
        <MfaResetWaiting />
        {uncertainty.map((record) => {
          const preparation = record.kind === 'options' || record.kind === 'setup';
          const retained = currentResponse?.guardRetained && currentResponse.record?.requestId === record.requestId;
          const sending =
            busy &&
            activeStage !== null &&
            sameActor(activeStage.intent) &&
            activeStage.record.owner === record.owner &&
            activeStage.record.requestId === record.requestId &&
            activeStage.record.kind === record.kind;
          const heading = sending ? 'sent' : retained ? 'guardRetained' : preparation ? 'preparationUnknown' : 'unknown';
          return (
            <section key={record.requestId} className="security__unknown stack" aria-label={t(heading)}>
              <h2>
                <Copy k={heading} />
              </h2>
              <p>
                <Copy k={kindLabel(record.kind)} />
              </p>
              <p>
                <Copy
                  k={
                    retained
                      ? 'guardBody'
                      : record.kind === 'options'
                        ? 'optionsBoundary'
                        : record.kind === 'setup'
                          ? 'setupBoundary'
                          : 'unknownBody'
                  }
                />
              </p>
              {references(record.owner, record.requestId, record.credential)}
              {!preparation && (
                <p className="muted">
                  <Copy k="lookup" />
                </p>
              )}
              <a href="/support" className="text-link security__support">
                <Copy k="support" />
              </a>
            </section>
          );
        })}
        {(problem || journal.failed) && (
          <p data-testid="notice" className="notice" role="status">
            <Copy k={journal.failed ? 'storage' : problem!} />
          </p>
        )}
        <div className="security__layout">
          <section data-testid="security__passkeys" className="security__passkeys security__card" aria-label={t('passkeys')}>
            <div className="section-heading">
              <h2>
                <Copy k="passkeys" />
              </h2>
              <Button variant="secondary" disabled={blocked('options')} onClick={() => open('options')}>
                <Copy k="add" />
              </Button>
            </div>
            {resource.status === 'ready' && resource.data.length >= limit && (
              <p className="muted">
                <Copy k="window" params={{ limit }} />
              </p>
            )}
            {resource.status === 'loading' ? (
              <Loading />
            ) : resource.status === 'failed' ? (
              <div lang="und">
                <Failure result={resource.failure} retry={reload} />
              </div>
            ) : resource.data.length === 0 ? (
              <div className="security__empty">
                <h3>
                  <Copy k="empty" />
                </h3>
                <p className="muted">
                  <Copy k="emptyBody" />
                </p>
              </div>
            ) : (
              <ul data-testid="security__rows" className="security__rows">
                {resource.data.map((key) => (
                  <li key={key.credentialId} data-testid="security__row" className="security__row">
                    <div>
                      <time dateTime={key.createdAt} lang={requestedLocale}>
                        {t('added', { time: stamp(key.createdAt, timeZone) })}
                      </time>
                      <span data-testid="security__ref" className="security__ref" lang="zxx">
                        {key.credentialId}
                      </span>
                      {key.transports && (
                        <span data-testid="security__ref" className="security__ref" lang="zxx">
                          {key.transports.join(', ')}
                        </span>
                      )}
                    </div>
                    <Button
                      variant="secondary"
                      disabled={blocked('remove')}
                      aria-label={t('reviewCredential', { id: key.credentialId })}
                      onClick={() => open('remove', key)}
                    >
                      <Copy k="reviewRemoval" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="actions">
              <Button variant="secondary" onClick={reload}>
                <Copy k="refresh" />
              </Button>
              {resource.status === 'ready' && resource.data.length >= limit ? (
                limit < 200 ? (
                  <Button variant="ghost" onClick={() => setLimit((value) => Math.min(200, value + 50))}>
                    <Copy k="expand" />
                  </Button>
                ) : (
                  <p className="muted">
                    <Copy k="maximum" />
                  </p>
                )
              ) : null}
            </div>
          </section>
          <section data-testid="security__authenticator" className="security__authenticator security__card" aria-label={t('authenticator')}>
            <h2 ref={authenticatorHeading} tabIndex={-1}>
              <Copy k="authenticator" />
            </h2>
            <p>
              <Copy k="authenticatorBody" />
            </p>
            <p className="security__announcement" role="status" aria-live="polite" aria-atomic="true">
              {visibleSetup && !codesShown ? <Copy k="setupReady" /> : null}
            </p>
            {visibleSetup ? (
              <div className="stack">
                <div className="security__setup-intro">
                  <h3 className="security__setup-heading" ref={setupHeading} tabIndex={-1}>
                    <Copy k="continue" />
                  </h3>
                  {!codesShown && (
                    <p className="security__setup-ready" aria-hidden="true">
                      <Copy k="setupReady" />
                    </p>
                  )}
                </div>
                {!codesShown && (
                  <>
                    <p>
                      <Copy k="setupBody" />
                    </p>
                    <Button variant="secondary" onClick={() => setShowKey((value) => !value)}>
                      <Copy k={showKey ? 'hideKey' : 'showKey'} />
                    </Button>
                    {showKey && (
                      <div data-security-sensitive="true">
                        <Field label={<Copy k="setupKey" />} lang="zxx" readOnly autoComplete="off" value={visibleSetup.data.secret} />
                        <details>
                          <summary>
                            <Copy k="uri" />
                          </summary>
                          <code data-testid="security__ref" className="security__ref" lang="zxx">
                            {visibleSetup.data.uri}
                          </code>
                        </details>
                      </div>
                    )}
                    <form className="stack" onSubmit={(event) => void confirmSetup(event)}>
                      <Field
                        label={<Copy k="code" />}
                        name="security-totp-confirm"
                        inputMode="numeric"
                        pattern="[0-9]{6}"
                        required
                        autoComplete="one-time-code"
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                        data-security-sensitive="true"
                      />
                      <Button type="submit" disabled={blocked('confirm')}>
                        <Copy k="confirm" />
                      </Button>
                    </form>
                  </>
                )}
                {visibleSetup.confirmed && (
                  <p data-testid="notice" className="notice" role="status">
                    <Copy k="confirmationAccepted" />
                  </p>
                )}
                {codesShown && (
                  // Shown once, after the authenticator works. "I saved them" drops the codes and the setup key from
                  // this page; nothing here is ever written to storage.
                  <div data-testid="security__recovery" className="security__recovery stack" data-security-sensitive="true">
                    <h3>
                      <Copy k="recoveryTitle" />
                    </h3>
                    {!visibleSetup.confirmed && (
                      <p data-testid="notice" className="notice" role="status">
                        <Copy k="recoveryUnknown" />
                      </p>
                    )}
                    <p>
                      <Copy k="recoveryOnce" />
                    </p>
                    <ul data-testid="recovery-codes" className="recovery-codes">
                      {visibleSetup.data.recoveryCodes.map((value) => (
                        <li key={value} lang="zxx">
                          {value}
                        </li>
                      ))}
                    </ul>
                    <label className="security__check">
                      <input type="checkbox" checked={codesKept} onChange={(event) => setCodesKept(event.target.checked)} />
                      <Copy k="recoveryCheck" />
                    </label>
                    <Button disabled={!codesKept} onClick={codesSaved}>
                      <Copy k="recoverySaved" />
                    </Button>
                  </div>
                )}
                <Button variant="secondary" disabled={blocked('setup')} onClick={() => open('setup')}>
                  <Copy k="newSetup" />
                </Button>
              </div>
            ) : (
              <Button disabled={blocked('setup')} onClick={() => open('setup')}>
                <Copy k="start" />
              </Button>
            )}
            <p className="muted">
              <Copy k="memory" />
            </p>
          </section>
          <Devices onChanged={() => setSeatVersion((value) => value + 1)} />
          <TrustedDevices onChanged={() => setSeatVersion((value) => value + 1)} />
          <PasskeyNames revision={passkeyRevision} />
          <SigninMethods revision={passkeyRevision} onChanged={methodsChanged} />
          <AntiPhishing />
          <Authenticator
            onChanged={(change) => {
              methodsChanged();
              // A replace ended the other sessions: the sessions list below reads them again.
              if (change?.sessionsEnded) setSeatVersion((value) => value + 1);
            }}
          />
          <ChangePassword onChanged={() => setSeatVersion((value) => value + 1)} />
          <RecoveryKeys />
          <SecurityLock />
          <FreezeAccount />
          <CloseAccount />
          <section data-testid="security__card" className="security__sessions security__card">
            {sessionBlocked && (
              <p className="muted">
                <Copy k="blockedSessions" />
              </p>
            )}
            <fieldset className="security__session-inspection" disabled={sessionBlocked}>
              <IdentitySessions key={`${userId}:${seatVersion}:${sessionBlocked ? 'readonly' : 'writable'}`} />
            </fieldset>
            {sessionBlocked && (
              <Button variant="secondary" onClick={() => setSeatVersion((value) => value + 1)}>
                <Copy k="inspectSessions" />
              </Button>
            )}
            <div className="security__global stack">
              <p className="muted">
                <Copy k="globalBody" />
              </p>
              <Button variant="secondary" disabled={blocked('logout')} onClick={() => open('logout')}>
                <Copy k="globalReview" />
              </Button>
            </div>
          </section>
        </div>
        {currentResponse &&
          (currentResponse.answer.ok ? (
            currentResponse.receipt && (
              <section data-testid="notice" className="notice stack" aria-label={t('receipt')}>
                <h2>
                  <Copy k="receipt" />
                </h2>
                <p role="status">
                  <Copy k={currentResponse.receipt} />
                </p>
                {references(currentResponse.original.owner, currentResponse.record?.requestId, currentResponse.record?.credential)}
              </section>
            )
          ) : (
            <div lang="und">
              {currentResponse.answer.code === 'auth.mfa_required' &&
              currentResponse.record &&
              isPreEffectRefusal(currentResponse.record.kind, currentResponse.answer) ? (
                // The factor gate refused before any change: this session has not passed a second factor. Confirming it is
                // them here sends the same change once more; signing in again with the code or a passkey also works.
                <div data-testid="failure" className="failure" role="status">
                  <h3>{secondFactor.title}</h3>
                  {stepUpKind(currentResponse.record?.kind) ? (
                    <p lang={languageFor('stepUpBody')}>{t('stepUpBody')}</p>
                  ) : (
                    <p>{secondFactor.body}</p>
                  )}
                  {stepUpKind(currentResponse.record?.kind) && (
                    <Button onClick={() => setStepUp(currentResponse)}>
                      <Copy k="stepUpConfirm" />
                    </Button>
                  )}
                  <a className="text-link" href={`${secondFactor.action?.href ?? '/login'}?redirect=${encodeURIComponent('/uc/safe')}`}>
                    {secondFactor.action?.label}
                  </a>
                </div>
              ) : (
                <Failure
                  result={currentResponse.unconfirmed ? { ...currentResponse.answer, reason: 'uncertain' } : currentResponse.answer}
                />
              )}
              {currentResponse.answer.code && (
                <p data-testid="security__ref" className="security__ref" lang="zxx">
                  {currentResponse.answer.code}
                </p>
              )}
            </div>
          ))}
        {stepUp && sameActor(stepUp.original) && (
          <WithdrawStepUp
            why={t('stepUpWhy')}
            run={(token) => afterStepUp(stepUp, token)}
            onDone={() => setStepUp(null)}
            onCancel={() => setStepUp(null)}
          />
        )}
        <ApiKeyRecords />
        {review && sameActor(review) && (
          <Dialog
            title={
              <Copy
                k={
                  review.kind === 'remove'
                    ? 'removeTitle'
                    : review.kind === 'setup'
                      ? 'startReview'
                      : review.kind === 'logout'
                        ? 'globalTitle'
                        : 'add'
                }
              />
            }
            onClose={() => {
              if (!busy) {
                original.current = null;
                setReview(null);
              }
            }}
          >
            <div className="stack">
              <p>
                <Copy
                  k={
                    review.kind === 'remove'
                      ? 'removeBody'
                      : review.kind === 'setup'
                        ? 'replacement'
                        : review.kind === 'logout'
                          ? 'globalConsequence'
                          : 'addBody'
                  }
                />
              </p>
              {references(review.owner, undefined, review.credential?.credentialId)}
              <Button
                variant={review.kind === 'remove' || review.kind === 'logout' ? 'danger' : 'primary'}
                disabled={blocked(review.kind)}
                onClick={confirmReview}
              >
                <Copy
                  k={review.kind === 'remove' ? 'remove' : review.kind === 'setup' ? 'start' : review.kind === 'logout' ? 'logout' : 'add'}
                />
              </Button>
            </div>
          </Dialog>
        )}
      </Page>
    </div>
  );
}
