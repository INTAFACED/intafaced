import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../features/session/session';
import { useResource } from '../../shared/resource';
import type { ApiClient, ApiResult } from '../../shared/api';
import {
  finishRevoke,
  readRevoke,
  revokeResponse,
  saveRevoke,
  sessionRevokeKey,
  sessionsFor,
  type IdentitySeat,
  type RevokeMarker,
  type StoredRevoke,
} from '../../features/account/identity-session-guards';

/*
 * The session list and sign-out-one-session logic of the old IdentitySessions view, moved here unchanged: the note kept on this
 * device while a sign-out is in flight, the Web Lock, and the fresh re-read that proves the session is still the one reviewed.
 * Only the markup moved out (SessionsCard.tsx).
 */
export type Review = { owner: string; seat: IdentitySeat; limit: number; client: ApiClient };
export type Response = {
  original: Review;
  marker?: RevokeMarker;
  answer: ApiResult<{ userId: string; sessionId: string; revoked: boolean }>;
};
export type Problem = 'changed' | 'seatChanged' | 'storage' | 'another' | 'locks';

export function useSessions() {
  const { api, userId } = useSession();
  const [limit, setLimit] = useState(50);
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'listSessions', { userId, limit }, sessionsFor(userId, limit), { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `identity-seats:${userId}:${limit}`,
  );
  const [review, setReview] = useState<Review | null>(null),
    [busy, setBusy] = useState(false),
    [response, setResponse] = useState<Response | null>(null),
    [problem, setProblem] = useState<Problem | null>(null);
  const [stored, setStored] = useState<{ owner: string | null; value: StoredRevoke }>(() => ({
    owner: userId,
    value: userId ? readRevoke(userId) : { marker: null, failed: false },
  }));
  const current = useRef({ userId, api }),
    originalReview = useRef<Review | null>(null),
    mounted = useRef(true),
    running = useRef(false),
    controller = useRef<AbortController | null>(null);
  current.current = { userId, api };
  useEffect(() => {
    mounted.current = true;
    const changed = (event: StorageEvent) => {
      if (userId && (event.key === sessionRevokeKey(userId) || event.key === null)) setStored({ owner: userId, value: readRevoke(userId) });
    };
    window.addEventListener('storage', changed);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      window.removeEventListener('storage', changed);
    };
  }, [userId]);
  const journal = stored.owner === userId ? stored.value : userId ? readRevoke(userId) : { marker: null, failed: false };
  const blocked = busy || journal.failed || journal.marker !== null;
  const sameContext = (original: Review) =>
    mounted.current &&
    current.current.userId === original.owner &&
    current.current.api === original.client &&
    api === original.client &&
    api.canWrite() &&
    originalReview.current === original;
  function updateJournal(owner: string) {
    if (mounted.current && current.current.userId === owner) setStored({ owner, value: readRevoke(owner) });
  }
  function open(seat: IdentitySeat) {
    if (!userId || blocked || running.current || !api.canWrite()) return;
    const latest = readRevoke(userId);
    setStored({ owner: userId, value: latest });
    if (latest.failed || latest.marker) return;
    const original = { owner: userId, seat: { ...seat }, limit, client: api };
    originalReview.current = original;
    setProblem(null);
    setResponse(null);
    setReview(original);
  }
  async function revoke() {
    const original = review;
    if (!original || blocked || running.current) return;
    if (!sameContext(original)) {
      setReview(null);
      setProblem('changed');
      return;
    }
    running.current = true;
    setBusy(true);
    setReview(null);
    setProblem(null);
    setResponse(null);
    try {
      if (!navigator.locks) {
        if (sameContext(original)) setProblem('locks');
        return;
      }
      await navigator.locks.request('customer-session-revoke:' + original.owner, { ifAvailable: true }, async (lock) => {
        if (!sameContext(original)) return;
        if (!lock) {
          setProblem('another');
          return;
        }
        const latest = readRevoke(original.owner);
        setStored({ owner: original.owner, value: latest });
        if (latest.failed || latest.marker) {
          if (latest.failed) setProblem('storage');
          return;
        }
        const abort = new AbortController();
        controller.current = abort;
        const fresh = await api.query(
          'identity',
          'listSessions',
          { userId: original.owner, limit: original.limit },
          sessionsFor(original.owner, original.limit),
          { signal: abort.signal },
        );
        if (!sameContext(original)) {
          if (mounted.current && current.current.userId === original.owner) setProblem('changed');
          return;
        }
        if (!fresh.ok) {
          setResponse({ original, answer: fresh });
          return;
        }
        if (!fresh.data.sessions.some((seat) => seat.id === original.seat.id && seat.createdAt === original.seat.createdAt)) {
          setProblem('seatChanged');
          reload();
          return;
        }
        const marker: RevokeMarker = {
          owner: original.owner,
          seat: original.seat,
          requestId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        };
        if (!sameContext(original)) return;
        if (!saveRevoke(marker)) {
          updateJournal(original.owner);
          setProblem('storage');
          return;
        }
        updateJournal(original.owner);
        if (!sameContext(original)) return;
        const answer = await api.mutate(
          'identity',
          'revokeSession',
          { userId: original.owner, sessionId: original.seat.id },
          revokeResponse.refine((value) => value.userId === original.owner && value.sessionId === original.seat.id),
          { signal: abort.signal },
        );
        if (!sameContext(original)) return;
        if (answer.ok || answer.reason !== 'uncertain') {
          if (!finishRevoke(marker)) setProblem('storage');
          updateJournal(original.owner);
        }
        setResponse({ original, marker, answer });
        if (answer.ok) reload();
      });
    } catch {
      if (sameContext(original)) {
        updateJournal(original.owner);
        setProblem('storage');
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const result = response?.original.owner === userId ? response : null;
  const knownGuard =
    result && result.marker?.requestId === journal.marker?.requestId && (result.answer.ok || result.answer.reason !== 'uncertain');
  return {
    userId,
    limit,
    setLimit,
    resource,
    reload,
    review,
    busy,
    journal,
    blocked,
    problem,
    result,
    knownGuard,
    open,
    revoke,
    cancelReview: () => {
      if (!busy) {
        originalReview.current = null;
        setReview(null);
      }
    },
  };
}
