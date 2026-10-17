import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiClient, ApiResult } from '../../shared/api';
import { Button, Dialog, EmptyState, Failure, Loading } from '../../shared/ui';
import { identitySessionCopy as copy } from './identity-session-copy';
import {
  finishRevoke,
  readRevoke,
  revokeResponse,
  saveRevoke,
  sessionIdFromToken,
  sessionRevokeKey,
  sessionsFor,
  splitSessions,
  type IdentitySeat,
  type RevokeMarker,
  type StoredRevoke,
} from './identity-session-guards';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import './identity-session.css';
export type { PrivateSessionSource } from './identity-session-guards';
type Review = { owner: string; seat: IdentitySeat; limit: number; client: ApiClient };
type Response = { original: Review; marker?: RevokeMarker; answer: ApiResult<{ userId: string; sessionId: string; revoked: boolean }> };
type Problem = 'changed' | 'seatChanged' | 'storage' | 'another' | 'locks';
export function IdentitySessions() {
  const { api, userId, session } = useSession();
  const { t, Copy, languageFor, requestedLocale } = copy.useCopy();
  const { timeZone } = usePreferences();
  const [limit, setLimit] = useState(50);
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'listSessions', { userId, limit }, sessionsFor(userId, limit), { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `identity-seats:${userId}:${limit}`,
  );
  const thisDevice = sessionIdFromToken(session?.accessToken);
  const [showOlder, setShowOlder] = useState(false);
  const seats = resource.status === 'ready' && resource.data ? resource.data.sessions : null;
  // "Older than 24 hours" is measured when the list arrives, so a row never jumps sections while it is being read.
  const split = useMemo(() => (seats ? splitSessions(seats, thisDevice, Date.now()) : null), [seats, thisDevice]);
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
  function references(owner: string, seatId: string) {
    return (
      <dl className="identity-sessions__context">
        <div>
          <dt>
            <Copy k="owner" />
          </dt>
          <dd lang="zxx">{owner}</dd>
        </div>
        <div>
          <dt>
            <Copy k="original" />
          </dt>
          <dd lang="zxx">{seatId}</dd>
        </div>
      </dl>
    );
  }
  const result = response?.original.owner === userId ? response : null;
  const knownGuard =
    result && result.marker?.requestId === journal.marker?.requestId && (result.answer.ok || result.answer.reason !== 'uncertain');
  return (
    <section className="stack identity-sessions" aria-label={t('title')} lang={languageFor('title')}>
      <h3>
        <Copy k="title" />
      </h3>
      <p className="muted">
        <Copy k="scope" />
      </p>
      {journal.marker && (
        <section className="stack identity-sessions__unknown" aria-label={t(knownGuard ? 'guardRetained' : 'unknown')}>
          <h3>
            <Copy k={busy ? 'sending' : knownGuard ? 'guardRetained' : 'unknown'} />
          </h3>
          <p>
            <Copy k={knownGuard ? 'guardBody' : 'unknownBody'} />
          </p>
          {references(journal.marker.owner, journal.marker.seat.id)}
          <p className="muted">
            <Copy k="lookup" />
          </p>
          <a className="text-link identity-sessions__support" href="/support">
            <Copy k="support" />
          </a>
        </section>
      )}
      {(problem || journal.failed) && (
        <p role="status" className="notice">
          <Copy k={journal.failed ? 'storage' : problem!} />
        </p>
      )}
      {resource.status === 'loading' ? (
        <Loading />
      ) : resource.status === 'failed' ? (
        <div lang="und">
          <Failure result={resource.failure} retry={reload} />
        </div>
      ) : !resource.data || resource.data.sessions.length === 0 ? (
        <EmptyState title={<Copy k="empty" />}>
          <Copy k="emptyBody" />
        </EmptyState>
      ) : (
        <>
          <ul className="identity-sessions__rows" aria-label={t('table')}>
            {(split ? (showOlder ? [...split.recent, ...split.older] : split.recent) : resource.data.sessions).map((seat) => {
              const mine = thisDevice !== null && seat.id.toLowerCase() === thisDevice;
              const started = stamp(seat.createdAt, timeZone);
              return (
                <li className="identity-sessions__row" key={seat.id} data-session-id={seat.id} data-this-device={mine ? 'true' : undefined}>
                  <div>
                    <time dateTime={seat.createdAt} lang={requestedLocale}>
                      {t('createdLabel', { time: started })}
                    </time>
                    {mine ? (
                      <span className="identity-sessions__mine">
                        <Copy k="thisDevice" />
                      </span>
                    ) : null}
                  </div>
                  {/* Signing out the session this browser uses would end this visit: Sign out below does that on purpose. */}
                  {mine ? null : (
                    <Button
                      variant="secondary"
                      disabled={blocked}
                      aria-label={t('reviewSeat', { time: started })}
                      onClick={() => open(seat)}
                    >
                      <Copy k="reviewAction" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {split && split.older.length > 0 ? (
            <Button variant="ghost" aria-expanded={showOlder} onClick={() => setShowOlder((value) => !value)}>
              {showOlder ? <Copy k="hideOlder" /> : <Copy k="showOlder" params={{ count: split.older.length }} />}
            </Button>
          ) : null}
        </>
      )}
      <p className="muted">
        <Copy k="window" params={{ limit }} />
      </p>
      {journal.marker && (
        <p className="muted">
          <Copy k="readOnly" />
        </p>
      )}
      <div className="actions">
        <Button variant="secondary" disabled={busy} onClick={reload}>
          <Copy k="refresh" />
        </Button>
        {limit < 200 ? (
          <Button variant="ghost" disabled={busy} onClick={() => setLimit((value) => Math.min(200, value + 50))}>
            <Copy k="more" />
          </Button>
        ) : (
          <p className="muted">
            <Copy k="maximumBoundary" />
          </p>
        )}
      </div>
      {result &&
        (result.answer.ok ? (
          <section className="stack notice" aria-label={t('receipt')}>
            <h3>
              <Copy k="receipt" />
            </h3>
            <p role="status">
              <Copy k={result.answer.data.revoked ? 'revoked' : 'unchanged'} />
            </p>
            {references(result.original.owner, result.original.seat.id)}
            {!result.answer.data.revoked && (
              <p>
                <Copy k="falseBoundary" />
              </p>
            )}
          </section>
        ) : (
          <div lang="und">
            <Failure result={result.answer} />
          </div>
        ))}
      {review && review.owner === userId && (
        <Dialog
          title={<Copy k="review" />}
          onClose={() => {
            if (!busy) {
              originalReview.current = null;
              setReview(null);
            }
          }}
        >
          <div className="stack">
            <p>
              <Copy k="reviewBody" />
            </p>
            <p className="muted">
              <Copy k="scope" />
            </p>
            <p>
              <Copy k="startedAt" params={{ time: stamp(review.seat.createdAt, timeZone) }} />
            </p>
            <Button variant="danger" disabled={blocked} onClick={() => void revoke()}>
              <Copy k="confirm" />
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
