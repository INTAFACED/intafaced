import { z } from 'zod';
import { createApiClient, type ApiResult } from '../../shared/api';

/**
 * What the page holds about a sign-in. There is no refresh token here, on purpose: the server keeps it in the HttpOnly
 * `ifc_rt` cookie, which page script cannot read. zod drops unknown keys, so a `refreshToken` in any JSON reply is
 * discarded at parse time and never reaches memory, storage or a log line.
 */
export const sessionSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  userId: z.string().uuid(),
});
export type Session = z.infer<typeof sessionSchema>;

/** One lock name for every tab of this origin, so two tabs never rotate the same cookie at once. */
export const REFRESH_LOCK = 'ifc-session-refresh';

export type RefreshOutcome =
  /** The cookie was valid: a new access token, held in memory by the caller. */
  | { kind: 'session'; session: Session }
  /** The server said the cookie is not a live session (401 `auth.session_invalid`/`session_reused`, or 403). */
  | { kind: 'signed_out'; code?: string }
  /** No answer we can trust (offline, 5xx, unreadable reply). The cookie is untouched; this is not a sign-out. */
  | { kind: 'unavailable' };

export type LockManagerLike = { request: <T>(name: string, callback: () => Promise<T>) => Promise<T> };

export function mapRefreshResult(result: ApiResult<Session>): RefreshOutcome {
  if (result.ok)
    return Number.isFinite(Date.parse(result.data.expiresAt)) ? { kind: 'session', session: result.data } : { kind: 'unavailable' };
  if (result.reason === 'unauthorized' || result.reason === 'forbidden')
    return { kind: 'signed_out', ...(result.code ? { code: result.code } : {}) };
  return { kind: 'unavailable' };
}

function browserLocks(): LockManagerLike | undefined {
  try {
    return typeof navigator !== 'undefined' && navigator.locks ? (navigator.locks as unknown as LockManagerLike) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refresh the access token from the cookie alone: no body token, credentials included.
 * - One flight at a time inside the tab (callers share the promise).
 * - Across tabs, a Web Lock serialises the flights. Where Web Locks is missing, only the in-tab flight remains and the
 *   server's reuse grace window covers two tabs refreshing together.
 */
export function createSessionRefresher(options: { fetch?: typeof fetch; locks?: LockManagerLike | null } = {}) {
  const api = createApiClient({ credentials: 'include', ...(options.fetch ? { fetch: options.fetch } : {}) });
  let flight: Promise<RefreshOutcome> | null = null;
  async function once(): Promise<RefreshOutcome> {
    return mapRefreshResult(await api.mutate('identity', 'auth.refresh', {}, sessionSchema));
  }
  async function locked(): Promise<RefreshOutcome> {
    const locks = options.locks === undefined ? browserLocks() : (options.locks ?? undefined);
    if (!locks) return once();
    let started = false;
    try {
      return await locks.request(REFRESH_LOCK, async () => {
        started = true;
        return once();
      });
    } catch {
      // The lock could not be taken (blocked or opaque origin): refresh without it. Once the callback has run, never run twice.
      return started ? { kind: 'unavailable' } : once();
    }
  }
  return {
    refresh(): Promise<RefreshOutcome> {
      if (!flight) {
        const started: Promise<RefreshOutcome> = locked().finally(() => {
          if (flight === started) flight = null;
        });
        flight = started;
      }
      return flight;
    },
    /** Resolves once no refresh is in flight. Logout waits for this so a late Set-Cookie cannot undo the cookie clear. */
    async idle(): Promise<void> {
      if (flight) await flight.catch(() => undefined);
    },
  };
}
export type SessionRefresher = ReturnType<typeof createSessionRefresher>;

/** Ask the server to end this browser's session. The cookie rides along (credentials included) and the reply clears it. */
export function requestLogout(options: { fetch?: typeof fetch } = {}) {
  return createApiClient({ credentials: 'include', ...(options.fetch ? { fetch: options.fetch } : {}) }).mutate(
    'identity',
    'auth.logout',
    {},
    z.object({ ok: z.literal(true) }),
  );
}

export type SessionState = { session: Session | null; restoring: boolean };

/** Refresh this long before the access token expires. */
const REFRESH_LEAD_MS = 30_000;
/** After an answer we cannot trust (offline, 5xx), try again this soon. The cookie is still there. */
const RETRY_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The sign-in, held in memory only: the access token lives in this closure and nowhere else (no storage, no cookie the
 * page can read). Framework-free so it can be tested without a browser; `SessionProvider` is a thin binding.
 * - `start()` runs the boot refresh once and arms the silent refresh. While it runs, `restoring` is true and a private room
 *   must not paint. A commit or clear during the boot refresh wins: a late answer never replaces what the user just did.
 * - The silent refresh shares the boot refresh's single flight (and Web Lock), and only applies if the session it was
 *   started for is still the current one.
 */
export function createSessionController(
  options: {
    refresher?: SessionRefresher;
    logout?: () => Promise<ApiResult<{ ok: true }>>;
    now?: () => number;
  } = {},
) {
  const refresher = options.refresher ?? createSessionRefresher();
  const logoutRequest = options.logout ?? (() => requestLogout());
  const now = options.now ?? Date.now;
  let state: SessionState = { session: null, restoring: true };
  let epoch = 0;
  let active = false;
  let boot: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  function set(next: SessionState) {
    state = next;
    for (const listener of [...listeners]) listener();
  }
  function disarm() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function arm(retry = false) {
    disarm();
    const session = state.session;
    if (!active || !session) return;
    const deadline = Date.parse(session.expiresAt);
    if (!Number.isFinite(deadline)) {
      clear();
      return;
    }
    const delay = retry ? RETRY_MS : Math.max(0, Math.min(MAX_TIMER_MS, deadline - now() - REFRESH_LEAD_MS));
    timer = setTimeout(() => void silent(session), delay);
  }
  async function silent(forSession: Session) {
    timer = undefined;
    const started = epoch;
    const outcome = await refresher.refresh();
    if (epoch !== started || state.session?.accessToken !== forSession.accessToken) return;
    if (outcome.kind === 'session') commit(outcome.session);
    else if (outcome.kind === 'signed_out') clear();
    else arm(true);
  }
  function commit(value: Session) {
    const validated = sessionSchema.parse(value);
    epoch += 1;
    set({ session: validated, restoring: false });
    arm();
  }
  function clear() {
    epoch += 1;
    disarm();
    set({ session: null, restoring: false });
  }
  async function bootRefresh() {
    const started = epoch;
    const outcome = await refresher.refresh();
    if (epoch !== started || state.session) return;
    if (outcome.kind === 'session') commit(outcome.session);
    else set({ session: null, restoring: false });
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    commit,
    clear,
    /** Idempotent: the boot refresh runs once however often this is called (React StrictMode mounts twice). */
    start(): Promise<void> {
      active = true;
      boot ??= bootRefresh();
      arm();
      return boot;
    },
    stop() {
      active = false;
      disarm();
    },
    async logout(): Promise<ApiResult<{ ok: true }>> {
      const previous = state.session;
      clear();
      if (!previous) return { ok: true, data: { ok: true } };
      // A refresh already in flight would set a fresh cookie after the logout cleared it.
      await refresher.idle();
      return logoutRequest();
    },
  };
}
export type SessionController = ReturnType<typeof createSessionController>;
