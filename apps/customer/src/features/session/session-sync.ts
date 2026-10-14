import { z } from 'zod';
import { createApiClient, type ApiResult } from '../../shared/api';
import { sessionSchema, type Session } from './session-schema';

/**
 * Keeps a customer signed in across reloads, second tabs and pop-out windows.
 *
 * ── The model ───────────────────────────────────────────────────────────────
 * The refresh token is an HttpOnly cookie owned by the edge. This page can only ask the edge to use
 * it (`POST /api/identity/session/refresh`) and gets back a short-lived access token that it keeps
 * in memory. Every refresh ROTATES the cookie, and svc-identity treats a retired token shown again
 * as theft: it revokes every session of that person. So two tabs refreshing at the same moment would
 * sign everyone out. This file exists to make that impossible.
 *
 * ── Coordination, innermost first ───────────────────────────────────────────
 *  1. Single flight in a tab: simultaneous callers (React StrictMode's double effect, several 401s at
 *     once) share one request.
 *  2. A Web Lock across tabs: one refresh at a time per browser profile. The request is built after
 *     the lock is won, so it carries whatever cookie the previous holder's response just stored.
 *  3. A BroadcastChannel: the winner publishes the new session; a tab that waited for the lock finds
 *     it and adopts it instead of rotating again. This also matters on its own: rotation retires the
 *     old session, so the other tabs' old access tokens stop working and they MUST receive the new one.
 *
 * Messages carry an access token and travel only between same-origin pages of this browser profile,
 * the same audience that can already read this page's memory. No refresh token ever crosses them.
 *
 * `localStorage` holds one non-secret hint ("someone signed in here") so that a visitor who never
 * signed in is not made to wait for a refresh round trip. It grants nothing.
 */

export const SESSION_TRANSPORT_HEADERS = { 'x-session-transport': 'cookie' } as const;

const CHANNEL_NAME = 'intafaced.customer.session.v1';
const LOCK_NAME = 'intafaced.customer.session.refresh';
const HINT_KEY = 'intafaced.customer.session-hint.v1';
/** Set when a sign-out could not be confirmed at the edge: the cookie may still be live. Retried on the next load. */
const PENDING_LOGOUT_KEY = 'intafaced.customer.session-logout-pending.v1';
/** Fallback lock for browsers without Web Locks: a short lease in localStorage. */
const LEASE_KEY = 'intafaced.customer.session-refresh-lease.v1';
const LEASE_MS = 20_000;
/** How long a freshly opened tab waits for another tab to hand it a live session before it rotates the cookie itself. */
const PEER_WAIT_MS = 100;
/** A session this close to expiry is not worth adopting; the tab asks for a fresh one. */
const MIN_ADOPT_LIFETIME_MS = 60_000;

export type SessionMessage = { type: 'session'; session: Session } | { type: 'signed-out' };
type WireMessage = SessionMessage | { type: 'request' };
export type RefreshOutcome =
  | { kind: 'session'; session: Session; refreshed: boolean }
  /** The edge refused: no cookie, expired, revoked, or reuse detected. The cookie is gone. */
  | { kind: 'signed-out' }
  /** The edge or network failed. The cookie is untouched, so trying again later can work. */
  | { kind: 'unavailable' };

type LockLike = { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
type ChannelLike = {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
};

export interface SessionSyncEnvironment {
  fetch?: typeof fetch;
  /** `null` = no cross-tab lock available (old browsers): tabs then rely on the channel alone. */
  locks?: LockLike | null;
  channel?: ((name: string) => ChannelLike | null) | null;
  storage?: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  now?: () => number;
  /** How long a new tab waits for a peer's live session before rotating itself. */
  peerWaitMs?: number;
}

function browserLocks(): LockLike | null {
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { locks?: LockManager }).locks;
  return locks ? { request: (name, callback) => locks.request(name, callback) as Promise<never> } : null;
}
function browserChannel(name: string): ChannelLike | null {
  return typeof BroadcastChannel === 'undefined' ? null : (new BroadcastChannel(name) as unknown as ChannelLike);
}
function browserStorage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parseMessage(data: unknown): WireMessage | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as { type?: unknown; session?: unknown };
  if (message.type === 'request') return { type: 'request' };
  if (message.type === 'signed-out') return { type: 'signed-out' };
  if (message.type === 'session') {
    const session = sessionSchema.safeParse(message.session);
    return session.success ? { type: 'session', session: session.data } : null;
  }
  return null;
}

const logoutAnswer = z.object({ ok: z.literal(true) });

export function createSessionSync(environment: SessionSyncEnvironment = {}) {
  const now = environment.now ?? Date.now;
  const locks = environment.locks === undefined ? browserLocks() : environment.locks;
  const storage = environment.storage ?? browserStorage;
  const api = createApiClient(environment.fetch ? { fetch: environment.fetch } : {});
  const channel = (environment.channel === undefined ? browserChannel : environment.channel)?.(CHANNEL_NAME) ?? null;
  const listeners = new Set<(message: SessionMessage) => void>();
  /** The freshest session this tab knows of, its own or another tab's. */
  let latest: Session | null = null;
  let inflight: Promise<RefreshOutcome> | null = null;

  /** Resolvers of tabs waiting for a peer to answer "does anyone have a live session?". */
  const waiting = new Set<() => void>();
  if (channel) {
    channel.onmessage = (event) => {
      const message = parseMessage(event.data);
      if (!message) return;
      if (message.type === 'request') {
        // A new tab is asking: hand over a session that still has useful life instead of making it rotate the cookie.
        if (latest && Date.parse(latest.expiresAt) - now() > MIN_ADOPT_LIFETIME_MS)
          channel.postMessage({ type: 'session', session: latest });
        return;
      }
      latest = message.type === 'session' ? message.session : null;
      if (message.type === 'signed-out') setHint(false);
      if (message.type === 'session') for (const done of [...waiting]) done();
      for (const listener of [...listeners]) listener(message);
    };
  }

  function setHint(on: boolean) {
    try {
      const store = storage();
      if (on) store?.setItem(HINT_KEY, '1');
      else store?.removeItem(HINT_KEY);
    } catch {
      /* private window or blocked site data: the hint is only a convenience */
    }
  }
  /** True when a refresh is worth trying. Storage that cannot be read counts as "maybe". */
  function mightBeSignedIn(): boolean {
    try {
      const store = storage();
      return store ? store.getItem(HINT_KEY) === '1' || store.getItem(PENDING_LOGOUT_KEY) === '1' : true;
    } catch {
      return true;
    }
  }

  function pendingLogout(): boolean {
    try {
      return storage()?.getItem(PENDING_LOGOUT_KEY) === '1';
    } catch {
      return false;
    }
  }
  function setPendingLogout(on: boolean) {
    try {
      const store = storage();
      if (on) store?.setItem(PENDING_LOGOUT_KEY, '1');
      else store?.removeItem(PENDING_LOGOUT_KEY);
    } catch {
      /* nothing more can be done without storage */
    }
  }

  /**
   * Browsers without Web Locks: a lease in localStorage. Best effort (read, write, read back) but it
   * turns "two tabs refresh at once" into "one at a time" everywhere the lock is missing.
   */
  async function withLease<T>(work: () => Promise<T>): Promise<T> {
    const store = storage();
    if (!store) return work();
    const me = `${now()}-${Math.random().toString(36).slice(2)}`;
    const deadline = now() + LEASE_MS;
    for (;;) {
      let held: string | null = null;
      try {
        held = store.getItem(LEASE_KEY);
      } catch {
        return work();
      }
      const [, until] = held ? [held.slice(0, held.lastIndexOf('@')), Number(held.slice(held.lastIndexOf('@') + 1))] : ['', 0];
      if (!held || !(until > now())) {
        try {
          store.setItem(LEASE_KEY, `${me}@${now() + LEASE_MS}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (store.getItem(LEASE_KEY)?.startsWith(`${me}@`)) break;
        } catch {
          return work();
        }
      }
      if (now() > deadline) break; // never wait longer than the lease itself
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      return await work();
    } finally {
      try {
        if (store.getItem(LEASE_KEY)?.startsWith(`${me}@`)) store.removeItem(LEASE_KEY);
      } catch {
        /* the lease expires by itself */
      }
    }
  }

  /** Ask other tabs for a live session; resolves when one arrives or the wait is over. */
  function askPeers(): Promise<void> {
    if (!channel) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        waiting.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, environment.peerWaitMs ?? PEER_WAIT_MS);
      waiting.add(finish);
      channel.postMessage({ type: 'request' });
    });
  }

  function publish(session: Session) {
    latest = session;
    setPendingLogout(false);
    setHint(true);
    channel?.postMessage({ type: 'session', session });
  }
  function publishSignedOut() {
    latest = null;
    setHint(false);
    channel?.postMessage({ type: 'signed-out' });
  }
  function withLock<T>(work: () => Promise<T>): Promise<T> {
    return locks ? locks.request(LOCK_NAME, work) : withLease(work);
  }

  async function runRefresh(staleToken: string | undefined): Promise<RefreshOutcome> {
    return withLock(async () => {
      // Another tab may have refreshed while this one waited for the lock: use its answer, not a second rotation.
      const known = latest;
      if (known && known.accessToken !== staleToken && Date.parse(known.expiresAt) - now() > MIN_ADOPT_LIFETIME_MS) {
        return { kind: 'session', session: known, refreshed: false } as const;
      }
      const answer = await api.session('refresh', sessionSchema);
      if (answer.ok) {
        publish(answer.data);
        return { kind: 'session', session: answer.data, refreshed: true } as const;
      }
      // 401, or a 403 that names the session itself (`session.*` from the edge, `auth.*` from identity).
      // Region and network gates also answer 403 BEFORE the cookie is looked at: the cookie is still live then.
      if (answer.reason === 'unauthorized' || (answer.reason === 'forbidden' && /^(session|auth)\./.test(answer.code ?? ''))) {
        publishSignedOut();
        return { kind: 'signed-out' } as const;
      }
      return { kind: 'unavailable' } as const;
    });
  }

  return {
    /**
     * Ask for a fresh access token. `staleToken` is the one the caller holds and no longer trusts, so a
     * newer session from another tab is adopted instead of rotating the cookie again. Leave it out on load.
     */
    refresh(options: { staleToken?: string } = {}): Promise<RefreshOutcome> {
      inflight ??= (options.staleToken === undefined && !latest ? askPeers() : Promise.resolve())
        .then(() => runRefresh(options.staleToken))
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    /** A sign-in happened in this tab: tell the others. */
    announce(session: Session) {
      publish(session);
    },
    /**
     * Sign out everywhere in this browser: revoke at the edge, clear the cookie, tell the other tabs.
     * If the edge cannot confirm, the cookie may still be live: remember that and retry on the next load.
     */
    async logout(): Promise<ApiResult<{ ok: true }>> {
      publishSignedOut();
      setPendingLogout(true);
      // Under the lock so the request carries the cookie a refresh in another tab may have just rotated.
      const result = await withLock(() => api.session('logout', logoutAnswer));
      if (result.ok) setPendingLogout(false);
      return result;
    },
    /**
     * Page load. Finish a sign-out that could not be confirmed last time; otherwise turn the cookie into a session.
     */
    async restore(): Promise<RefreshOutcome> {
      if (pendingLogout()) {
        const result = await withLock(() => api.session('logout', logoutAnswer));
        if (result.ok) {
          setPendingLogout(false);
          return { kind: 'signed-out' };
        }
        return { kind: 'unavailable' };
      }
      return this.refresh();
    },
    mightBeSignedIn,
    subscribe(listener: (message: SessionMessage) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close() {
      if (channel) channel.onmessage = null;
      channel?.close();
      listeners.clear();
    },
  };
}
export type SessionSync = ReturnType<typeof createSessionSync>;

let shared: SessionSync | null = null;
/** The one coordinator for this page. */
export function getSessionSync(): SessionSync {
  shared ??= createSessionSync();
  return shared;
}
