import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../features/session/session';
import type { ApiClient } from '../../shared/api';
import { useResource } from '../../shared/resource';
import {
  finishVerification,
  readVerification,
  saveVerification,
  verificationBlocked,
  verificationKey,
  verificationLock,
  verificationReply,
  verificationRefused,
  verificationStatus,
  type RequestedTier,
  type VerificationJournal,
  type VerificationOriginal,
  type VerificationRecord,
} from '../../features/account/verification-guards';

/*
 * The request logic of the old Verification view, moved here unchanged so the screen can be redrawn without touching it:
 * the pending-request note on this device, the Web Lock that stops a second tab sending, the exact-actor checks before and
 * after every await, and "an unqualified failure stays unknown". Only the markup moved out (see index.tsx).
 */
export type Original = {
  owner: string;
  client: ApiClient;
  token: string;
  tier: RequestedTier;
  country: string;
  mount: object;
  path: string;
};
export type Known = {
  original: Original;
  local: VerificationOriginal;
  row?: VerificationRecord;
  refused: boolean;
  retained: boolean;
  finalized?: boolean;
};
export type Problem = 'storage' | 'locks' | 'another' | 'changed' | 'invalidCountry';
const emptyJournal: VerificationJournal = { records: [], failed: false };
const levelOrder = ['none', 'basic', 'full', 'institutional'] as const;

export function useVerification() {
  const { api, userId, session } = useSession();
  const [limit, setLimit] = useState(50),
    [tier, setTier] = useState<RequestedTier>('basic'),
    [country, setCountry] = useState('');
  const [review, setReview] = useState<Original | null>(null),
    [active, setActive] = useState<Original | null>(null),
    [known, setKnown] = useState<Known[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null),
    [selected, setSelected] = useState<VerificationRecord | null>(null);
  const [stored, setStored] = useState<{ owner: string | null; value: VerificationJournal }>(() => ({
    owner: userId,
    value: userId ? readVerification(userId) : emptyJournal,
  }));
  const mounted = useRef(true),
    mount = useRef({}),
    original = useRef<Original | null>(null),
    running = useRef<Original | null>(null);
  const abort = useRef<AbortController | null>(null);
  const current = useRef({ api, userId, token: session?.accessToken });
  current.current = { api, userId, token: session?.accessToken };
  const privateContext = useRef({ api, userId });
  const privateVisible = privateContext.current.api === api && privateContext.current.userId === userId;
  const clientVersion = useRef({ api, value: 0 });
  if (clientVersion.current.api !== api) clientVersion.current = { api, value: clientVersion.current.value + 1 };
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'kyc.status', { limit }, verificationStatus(userId, limit), { signal })
        : Promise.resolve({ ok: true as const, data: { tier: 'none' as const, records: [] } }),
    `verification:${userId}:${clientVersion.current.value}:${limit}`,
  );
  // Only levels above the current one are worth asking for; the first of them is the default.
  const heldLevel = resource.status === 'ready' ? resource.data.tier : 'none';
  const offeredTiers = levelOrder.slice(levelOrder.indexOf(heldLevel) + 1) as RequestedTier[];
  const chosenTier = offeredTiers.includes(tier) ? tier : (offeredTiers[0] ?? tier);
  useEffect(() => {
    mounted.current = true;
    const changed = (event: StorageEvent) => {
      if (userId && (event.key === verificationKey(userId) || event.key === null))
        setStored({ owner: userId, value: readVerification(userId) });
    };
    window.addEventListener('storage', changed);
    return () => {
      mounted.current = false;
      abort.current?.abort();
      window.removeEventListener('storage', changed);
    };
  }, [userId]);
  useEffect(() => {
    privateContext.current = { api, userId };
    original.current = null;
    abort.current?.abort();
    setReview(null);
    setActive(null);
    setKnown([]);
    setSelected(null);
    setCountry('');
    setTier('basic');
    setProblem(null);
    setLimit(50);
    setStored({ owner: userId, value: userId ? readVerification(userId) : emptyJournal });
  }, [api, userId]);
  const sameActor = (intent: Original) =>
    mounted.current &&
    intent.mount === mount.current &&
    current.current.userId === intent.owner &&
    current.current.api === intent.client &&
    current.current.token === intent.token &&
    location.pathname === intent.path &&
    intent.client.canWrite();
  const same = (intent: Original) => sameActor(intent) && original.current === intent;
  const journal = stored.owner === userId ? stored.value : userId ? readVerification(userId) : emptyJournal;
  const busy = Boolean(active && sameActor(active));
  const blocked = !userId || busy || !api.canWrite() || verificationBlocked(journal);
  const visibleKnown = known.filter((receipt) => sameActor(receipt.original));
  function sync(owner: string) {
    if (mounted.current && current.current.userId === owner) setStored({ owner, value: readVerification(owner) });
  }
  function open() {
    if (blocked || !userId || !session || (running.current && sameActor(running.current))) return;
    const latest = readVerification(userId);
    setStored({ owner: userId, value: latest });
    if (verificationBlocked(latest)) {
      if (latest.failed) setProblem('storage');
      return;
    }
    const normalized = country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(normalized)) {
      setProblem('invalidCountry');
      return;
    }
    const intent: Original = {
      owner: userId,
      client: api,
      token: session.accessToken,
      tier: chosenTier,
      country: normalized,
      mount: mount.current,
      path: location.pathname,
    };
    original.current = intent;
    setReview(intent);
    setProblem(null);
  }
  function close() {
    if (!busy) {
      original.current = null;
      setReview(null);
    }
  }
  async function dispatch(intent: Original) {
    if (!same(intent) || (running.current && sameActor(running.current))) return;
    running.current = intent;
    setActive(intent);
    setReview(null);
    setProblem(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      if (!navigator.locks) {
        if (same(intent)) setProblem('locks');
        return;
      }
      await navigator.locks.request(verificationLock(intent.owner), { ifAvailable: true }, async (lock) => {
        if (!same(intent)) return;
        if (!lock) {
          setProblem('another');
          return;
        }
        const latest = readVerification(intent.owner);
        sync(intent.owner);
        if (verificationBlocked(latest)) {
          if (latest.failed) setProblem('storage');
          return;
        }
        // Current-status reads are independent. The API accepts static reviewed terms;
        // lock acquisition is the awaited boundary before this fresh actor check.
        if (!same(intent)) return;
        const local: VerificationOriginal = {
          owner: intent.owner,
          kind: 'submit',
          requestId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        };
        if (!saveVerification(local)) {
          sync(intent.owner);
          if (same(intent)) setProblem('storage');
          return;
        }
        sync(intent.owner);
        if (!same(intent)) return;
        const answer = await intent.client.mutate(
          'identity',
          'kyc.submit',
          { tier: intent.tier, jurisdiction: intent.country },
          verificationReply(intent.owner, intent.tier),
          { signal: controller.signal },
        );
        if (!same(intent)) return;
        if (answer.ok || verificationRefused(answer)) {
          const retained = !finishVerification(local);
          setKnown((previous) => [
            ...previous,
            { original: intent, local, ...(answer.ok ? { row: { ...answer.data } } : {}), refused: !answer.ok, retained },
          ]);
        }
        // Every unqualified failure remains unknown. No current list match releases it.
        sync(intent.owner);
      });
    } catch {
      if (same(intent)) setProblem('storage');
    } finally {
      if (running.current === intent) running.current = null;
      if (same(intent)) {
        original.current = null;
        setActive(null);
      }
    }
  }
  async function finalize(receipt: Known) {
    if (!sameActor(receipt.original) || busy || !receipt.retained) return;
    if (!navigator.locks) {
      setProblem('locks');
      return;
    }
    try {
      await navigator.locks.request(verificationLock(receipt.local.owner), { ifAvailable: true }, (lock) => {
        if (!sameActor(receipt.original)) return;
        if (!lock) {
          setProblem('another');
          return;
        }
        if (finishVerification(receipt.local)) {
          setKnown((previous) => previous.map((entry) => (entry === receipt ? { ...entry, retained: false, finalized: true } : entry)));
          setProblem(null);
        } else setProblem('storage');
        sync(receipt.local.owner);
      });
    } catch {
      if (sameActor(receipt.original)) setProblem('storage');
    }
  }

  return {
    userId,
    resource,
    reload,
    limit,
    setLimit,
    heldLevel,
    offeredTiers,
    chosenTier,
    setTier,
    country,
    setCountry,
    review,
    known: visibleKnown,
    problem,
    journal,
    privateVisible,
    busy,
    blocked,
    selected,
    setSelected,
    open,
    close,
    dispatch,
    finalize,
    same,
  };
}
