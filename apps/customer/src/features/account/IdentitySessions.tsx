import { useEffect, useRef, useState } from 'react';
import { useSession } from '../session';
import { useResource } from '../../shared/resource';
import type { ApiClient, ApiResult } from '../../shared/api';
import { Button, EmptyState } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { Failure, Loading } from './kit-parts';
import { identitySessionCopy as copy } from './identity-session-copy';
import {
  finishRevoke,
  readRevoke,
  revokeResponse,
  saveRevoke,
  sessionIdFromToken,
  sessionMoreControl,
  sessionRevokeKey,
  sessionsFor,
  splitSessions,
  VISIBLE_SESSIONS,
  type IdentitySeat,
  type RevokeMarker,
  type StoredRevoke,
} from './identity-session-guards';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { callAs } from '../../shared/api';
import { IDENTITY_LIST_SESSIONS } from '@intafaced/contracts/identity-list-sessions-procedures';
import { IDENTITY_REVOKE_SESSION } from '@intafaced/contracts/identity-revoke-session-procedures';
export type { PrivateSessionSource } from './identity-session-guards';
type Review = { owner: string; seat: IdentitySeat; limit: number; client: ApiClient };
type Response = { original: Review; marker?: RevokeMarker; answer: ApiResult<{ userId: string; sessionId: string; revoked: boolean }> };
type Problem = 'changed' | 'seatChanged' | 'storage' | 'another' | 'locks';
const PAGE = 50;
const MAX_LIMIT = 200;
export function IdentitySessions() {
  const { api, userId, session } = useSession();
  const { t, Copy, languageFor, requestedLocale } = copy.useCopy();
  const { timeZone } = usePreferences();
  const [limit, setLimit] = useState(PAGE);
  const thisDevice = sessionIdFromToken(session?.accessToken);
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? callAs(api, IDENTITY_LIST_SESSIONS, { userId, limit }, sessionsFor(userId, limit), { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    // A new session id (the sign-in renews about every 15 minutes) reloads the list, so "This device" never goes stale.
    `identity-seats:${userId}:${limit}:${thisDevice ?? ''}`,
  );
  const [showOlder, setShowOlder] = useState(false);
  const seats = resource.status === 'ready' && resource.data ? resource.data.sessions : null;
  // The newest five used within a day stay in view; the rest fold behind "Show N more". This device is always in view.
  // Worked out on every render, so a session crossing the one-day line folds without waiting for a new list.
  const split = seats ? splitSessions(seats, thisDevice, VISIBLE_SESSIONS, Date.now()) : null;
  const moreControl = seats
    ? sessionMoreControl({ hidden: split?.older.length ?? 0, expanded: showOlder, returned: seats.length, limit, maxLimit: MAX_LIMIT })
    : 'none';
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
        const fresh = await callAs(
          api,
          IDENTITY_LIST_SESSIONS,
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
        const answer = await callAs(
          api,
          IDENTITY_REVOKE_SESSION,
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
  /** The one place a raw id earns its place: what Support asks for when a sign-out result is unknown. */
  function supportReference(seatId: string) {
    return (
      <dl className="lt-kv">
        <div>
          <dt>
            <Copy k="supportReference" />
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
    <section data-testid="identity-sessions" aria-label={t('title')} lang={languageFor('title')}>
      <h3>
        <Copy k="title" />
      </h3>
      <p className="lt-hint">
        <Copy k="scope" />
      </p>
      {journal.marker && (
        <section aria-label={t(knownGuard ? 'guardRetained' : 'unknown')}>
          <h3>
            <Copy k={busy ? 'sending' : knownGuard ? 'guardRetained' : 'unknown'} />
          </h3>
          <p>
            <Copy k={knownGuard ? 'guardBody' : 'unknownBody'} />
          </p>
          {supportReference(journal.marker.seat.id)}
          <p className="lt-hint">
            <Copy k="lookup" />
          </p>
          <a className="lt-link" href="/support">
            <Copy k="support" />
          </a>
        </section>
      )}
      {(problem || journal.failed) && (
        <p role="status" className="lt-hint">
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
        <EmptyState title={t('empty')} body={t('emptyBody')} />
      ) : (
        <>
          <ul aria-label={t('table')}>
            {(split ? (showOlder ? [...split.recent, ...split.older] : split.recent) : resource.data.sessions).map((seat) => {
              const mine = thisDevice !== null && seat.id.toLowerCase() === thisDevice;
              const started = stamp(seat.lastUsedAt ?? seat.createdAt, timeZone);
              return (
                <li key={seat.id} data-session-id={seat.id} data-this-device={mine ? 'true' : undefined}>
                  <div>
                    <time dateTime={seat.lastUsedAt ?? seat.createdAt} lang={requestedLocale}>
                      {t('createdLabel', { time: started })}
                    </time>
                    {mine ? (
                      <span>
                        <Copy k="thisDevice" />
                      </span>
                    ) : null}
                  </div>
                  {/* Signing out the session this browser uses would end this visit: Sign out below does that on purpose. */}
                  {mine ? null : (
                    <Button tone="secondary" disabled={blocked} aria-label={t('reviewSeat', { time: started })} onClick={() => open(seat)}>
                      <Copy k="reviewAction" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {/* One control. It first unfolds the rows already loaded, then asks the server for the next page. */}
          {moreControl === 'unfold' && split ? (
            <Button tone="quiet" aria-expanded={false} onClick={() => setShowOlder(true)}>
              <Copy k="showOlder" params={{ count: split.older.length }} />
            </Button>
          ) : moreControl === 'fetch' ? (
            <Button tone="quiet" disabled={busy} onClick={() => setLimit((value) => Math.min(MAX_LIMIT, value + PAGE))}>
              <Copy k="more" params={{ count: Math.min(PAGE, MAX_LIMIT - limit) }} />
            </Button>
          ) : moreControl === 'fold' ? (
            <Button tone="quiet" aria-expanded onClick={() => setShowOlder(false)}>
              <Copy k="hideOlder" />
            </Button>
          ) : null}
        </>
      )}
      <p className="lt-hint">
        <Copy k="window" params={{ limit }} />
      </p>
      {journal.marker && (
        <p className="lt-hint">
          <Copy k="readOnly" />
        </p>
      )}
      {limit >= MAX_LIMIT && seats && seats.length >= limit ? (
        <p className="lt-hint">
          <Copy k="maximumBoundary" />
        </p>
      ) : null}
      <div className="lt-actions">
        <Button tone="secondary" disabled={busy} onClick={reload}>
          <Copy k="refresh" />
        </Button>
      </div>
      {result &&
        (result.answer.ok ? (
          <section className="lt-hint" aria-label={t('receipt')}>
            <h3>
              <Copy k="receipt" />
            </h3>
            <p role="status">
              <Copy k={result.answer.data.revoked ? 'revoked' : 'unchanged'} />
            </p>
            <p>
              <Copy k="startedAt" params={{ time: stamp(result.original.seat.createdAt, timeZone) }} />
            </p>
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
        <Sheet
          open
          title={t('review')}
          onClose={() => {
            if (!busy) {
              originalReview.current = null;
              setReview(null);
            }
          }}
        >
          <div>
            <p>
              <Copy k="reviewBody" />
            </p>
            <p className="lt-hint">
              <Copy k="scope" />
            </p>
            <p>
              <Copy k="startedAt" params={{ time: stamp(review.seat.createdAt, timeZone) }} />
            </p>
            <Button tone="primary" disabled={blocked} onClick={() => void revoke()}>
              <Copy k="confirm" />
            </Button>
          </div>
        </Sheet>
      )}
    </section>
  );
}
