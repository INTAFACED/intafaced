import { useEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { z } from 'zod';
import { useSession } from '../../features/session/session';
import type { ApiClient, ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
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
  type Passkey,
  type SecurityJournal,
  type SecurityKind,
  type SecurityRecord,
} from '../../features/account/security-guards';
import { nativeRegistration, registrationFor, registrationPayload } from '../../features/account/security-webauthn';

/*
 * The passkey, authenticator and sign-out-everywhere logic of the old Security view, moved here unchanged so the screen can be
 * redrawn without touching it: the note kept on this device for every sent action, the Web Lock that stops a second tab,
 * the exact-actor checks around every await, and "an unqualified failure stays unknown". Only the markup moved out (index.tsx).
 */
export type Problem =
  'changed' | 'keyChanged' | 'setupChanged' | 'storage' | 'another' | 'locks' | 'unsupported' | 'cancelled' | 'ceremonyFailed';
export type Original = { owner: string; client: ApiClient; kind: SecurityKind; credential?: Passkey; limit: number; requestId: string };
export type Setup = { original: Original; record: SecurityRecord; data: z.infer<typeof setupResponse>; confirmed: boolean };
export type Response = {
  original: Original;
  record?: SecurityRecord;
  answer: ApiResult<unknown>;
  receipt?: 'registered' | 'removed' | 'notRemoved' | 'confirmationAccepted';
  guardRetained?: boolean;
  unconfirmed?: boolean;
};
const emptyJournal: SecurityJournal = { records: [], failed: false };

export function useSecurityFlows() {
  const { api, userId, clear } = useSession();
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
  useEffect(() => {
    const waiting = setupFocus.current;
    if (!visibleSetup || waiting?.readyRequest !== visibleSetup.record.requestId || waiting.intent !== visibleSetup.original) return;
    setupFocus.current = null;
    if (!waiting.moved && same(visibleSetup.original)) setupHeading.current?.focus();
  }, [visibleSetup?.record.requestId, api, userId]);
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
    const options = await intent.client.mutate('identity', 'webauthn.registerOptions', {}, registrationFor(intent.owner), {
      signal: abort.signal,
    });
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
      { signal: abort.signal },
    );
    if (!same(intent)) {
      settleOriginalRefusal(registration, answer);
      return;
    }
    known(intent, registration, answer, answer.ok ? 'registered' : undefined);
    if (answer.ok) reload();
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
      reload();
      return;
    }
    const record = makeRecord(intent, 'remove', intent.credential.credentialId);
    if (!save(intent, record)) return;
    const answer = await intent.client.mutate(
      'identity',
      'webauthn.remove',
      { credentialId: intent.credential.credentialId },
      z.object({ removed: z.boolean() }),
      { signal: abort.signal },
    );
    if (!same(intent)) {
      settleOriginalRefusal(record, answer);
      return;
    }
    known(intent, record, answer, answer.ok ? (answer.data.removed ? 'removed' : 'notRemoved') : undefined);
    if (answer.ok) reload();
  }
  async function startSetup(intent: Original) {
    const record = makeRecord(intent, 'setup');
    if (!save(intent, record)) return;
    setSetup(null);
    setCode('');
    setShowKey(false);
    const answer = await intent.client.mutate('identity', 'totp.enrol', {}, setupResponse);
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
      );
      if (!same(intent)) {
        settleOriginalRefusal(record, answer);
        return;
      }
      known(intent, record, answer, answer.ok ? 'confirmationAccepted' : undefined);
      setCode('');
      if (answer.ok) {
        setShowKey(false);
        setSetup({ ...prepared, confirmed: true });
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
  function confirmReview() {
    const intent = review;
    if (!intent) return;
    if (setupFocus.current?.intent === intent) setupFocus.current.pending = true;
    void coordinated(intent, () =>
      intent.kind === 'options'
        ? addPasskey(intent)
        : intent.kind === 'remove'
          ? removePasskey(intent)
          : intent.kind === 'setup'
            ? startSetup(intent)
            : logoutAll(intent),
    );
  }
  const currentResponse = response && sameActor(response.original) ? response : null;
  const sessionBlocked = familyBlocked(journal, 'sessions');
  const uncertainty = journal.records.filter((row) => row.state === 'sent');
  return {
    api,
    userId,
    limit,
    setLimit,
    busy,
    review,
    problem,
    response,
    currentResponse,
    setup,
    visibleSetup,
    code,
    setCode,
    showKey,
    setShowKey,
    seatVersion,
    setSeatVersion,
    activeStage,
    journal,
    setupHeading,
    resource,
    reload,
    sessionBlocked,
    uncertainty,
    blocked,
    open,
    confirmSetup,
    confirmReview,
    sameActor,
    cancelReview: () => {
      if (!busy) {
        original.current = null;
        setReview(null);
      }
    },
  };
}
