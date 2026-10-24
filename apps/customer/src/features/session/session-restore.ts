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
  userId: z.string().guid(),
});
export type Session = z.infer<typeof sessionSchema>;

/** One lock name for every tab of this origin, so two tabs never rotate the same cookie at once. */
export const REFRESH_LOCK = 'ifc-session-refresh';
/** Cross-tab announcements: a rotated access token for the same user, and logout. Memory to memory; nothing is stored. */
export const SESSION_CHANNEL = 'ifc-session';

/**
 * Refresh timing. The server accepts the just-rotated cookie again for REFRESH_REUSE_GRACE_SECONDS (default 10) and hands
 * back the successor it already minted. A reply lost after the server rotated is only recoverable inside that window, so:
 * the request gives up after 5 s (not the default 15 s), and ONE retry follows 1.5 s later (6.5 s after the first send).
 * Only after that do longer, exponentially growing pauses start, because a later retry can no longer be saved by the grace.
 */
export const REFRESH_TIMEOUT_MS = 5_000;
export const REFRESH_RETRY_MS = 1_500;
const BACKOFF_FIRST_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

/** Why a refresh ended the session, when the server said so. Shown to the person; never guessed. */
export type SessionNotice = 'reused' | 'frozen';
export function noticeFor(code: string | undefined): SessionNotice | null {
  return code === 'auth.session_reused' ? 'reused' : code === 'auth.account_frozen' ? 'frozen' : null;
}

export type RefreshOutcome =
  /** The cookie was valid: a new access token, held in memory by the caller. */
  | { kind: 'session'; session: Session }
  /** The server said the cookie is not a live session (401 `auth.session_invalid`/`session_reused`, or 403). */
  | { kind: 'signed_out'; code?: string }
  /**
   * A definite answer that is not about the cookie (400, 404, 501 …), e.g. an identity service older than the cookie
   * refresh. Retrying will not turn it into a session. At boot it means signed out; mid-session it is treated like an
   * outage (keep the session, back off), because a rolling deploy can answer this way for a moment.
   */
  | { kind: 'refused' }
  /** No answer we can trust (offline, 5xx, unreadable reply). The cookie is untouched; this is not a sign-out. */
  | { kind: 'unavailable' };

export type LockManagerLike = { request: <T>(name: string, callback: () => Promise<T>) => Promise<T> };

export function mapRefreshResult(result: ApiResult<Session>): RefreshOutcome {
  if (result.ok)
    return Number.isFinite(Date.parse(result.data.expiresAt)) ? { kind: 'session', session: result.data } : { kind: 'unavailable' };
  if (result.reason === 'unauthorized' || result.reason === 'forbidden')
    return { kind: 'signed_out', ...(result.code ? { code: result.code } : {}) };
  if (definiteRefusal(result)) return { kind: 'refused' };
  return { kind: 'unavailable' };
}

/** 4xx answers that mean "try again later" by HTTP meaning, so they stay an outage. */
const RETRYABLE_4XX = new Set([408, 409, 423, 425, 429]);

function definiteRefusal(result: Extract<ApiResult<Session>, { ok: false }>): boolean {
  if (result.reason === 'not_mounted' || result.reason === 'not_supported') return true;
  const status = result.status;
  return result.reason === 'error' && status !== undefined && status >= 400 && status < 500 && !RETRYABLE_4XX.has(status);
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
 * - A reply we cannot trust is retried once, inside the same flight and lock, 1.5 s later (see REFRESH_RETRY_MS).
 */
export function createSessionRefresher(
  options: { fetch?: typeof fetch; locks?: LockManagerLike | null; timeoutMs?: number; retryDelayMs?: number } = {},
) {
  const api = createApiClient({
    credentials: 'include',
    timeoutMs: options.timeoutMs ?? REFRESH_TIMEOUT_MS,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const retryDelayMs = options.retryDelayMs ?? REFRESH_RETRY_MS;
  let flight: Promise<RefreshOutcome> | null = null;
  const attempt = async () => mapRefreshResult(await api.mutate('identity', 'auth.refresh', {}, sessionSchema));
  async function once(): Promise<RefreshOutcome> {
    const first = await attempt();
    if (first.kind !== 'unavailable') return first;
    if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return attempt();
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

export type SessionState = {
  session: Session | null;
  /** True until the boot refresh has answered. A private room waits; a public room does not. */
  restoring: boolean;
  /** The boot refresh got no trustworthy answer (offline, outage). The cookie is untouched: offer Retry, not a sign-in. */
  restoreFailed: boolean;
  /** Set when the server ended the session on purpose (sign-in used elsewhere, account frozen). */
  notice: SessionNotice | null;
};

export type ChannelLike = {
  postMessage: (message: unknown) => void;
  close: () => void;
  onmessage: ((event: { data: unknown }) => void) | null;
};
const channelMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('logout') }),
  z.object({ type: z.literal('session'), session: sessionSchema }),
]);
function browserChannel(): ChannelLike | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : (new BroadcastChannel(SESSION_CHANNEL) as unknown as ChannelLike);
  } catch {
    return null;
  }
}

/** Refresh this long before the access token expires. */
const REFRESH_LEAD_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The sign-in, held in memory only: the access token lives in this closure and nowhere else (no storage, no cookie the
 * page can read). Framework-free so it can be tested without a browser; `SessionProvider` is a thin binding.
 * - `start()` runs the boot refresh once and arms the silent refresh. While it runs, `restoring` is true and a private room
 *   must not paint. A commit or clear during the boot refresh wins: a late answer never replaces what the user just did.
 * - The silent refresh shares the boot refresh's single flight (and Web Lock), and only applies if the session it was
 *   started for is still the current one.
 * - Tabs talk over a BroadcastChannel: logout signs the others out, and a rotated access token for the same user is shared
 *   so they do not each refresh. A tab never adopts a different user's session from the channel.
 */
export function createSessionController(
  options: {
    refresher?: SessionRefresher;
    logout?: () => Promise<ApiResult<{ ok: true }>>;
    now?: () => number;
    openChannel?: () => ChannelLike | null;
  } = {},
) {
  const refresher = options.refresher ?? createSessionRefresher();
  const logoutRequest = options.logout ?? (() => requestLogout());
  const now = options.now ?? Date.now;
  const openChannel = options.openChannel ?? browserChannel;
  let state: SessionState = { session: null, restoring: true, restoreFailed: false, notice: null };
  let epoch = 0;
  let active = false;
  let failures = 0;
  let boot: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let channel: ChannelLike | null = null;
  const listeners = new Set<() => void>();

  function set(next: SessionState) {
    state = next;
    for (const listener of [...listeners]) listener();
  }
  function tell(message: z.infer<typeof channelMessage>) {
    try {
      channel?.postMessage(message);
    } catch {
      // A closed channel only means other tabs find out at their next refresh.
    }
  }
  function disarm() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function arm(retryDelay?: number) {
    disarm();
    const session = state.session;
    if (!active || !session) return;
    const deadline = Date.parse(session.expiresAt);
    if (!Number.isFinite(deadline)) {
      signOut(null);
      return;
    }
    const delay = retryDelay ?? Math.max(0, Math.min(MAX_TIMER_MS, deadline - now() - REFRESH_LEAD_MS));
    timer = setTimeout(() => void silent(session), delay);
  }
  async function silent(forSession: Session) {
    timer = undefined;
    const started = epoch;
    const outcome = await refresher.refresh();
    if (epoch !== started || state.session?.accessToken !== forSession.accessToken) return;
    if (outcome.kind === 'session') {
      commit(outcome.session);
      tell({ type: 'session', session: outcome.session });
    } else if (outcome.kind === 'signed_out') signOut(noticeFor(outcome.code));
    else {
      // 'unavailable' and 'refused' alike: keep the session; a mid-session 400/404 is likelier a deploy than a sign-out.
      // The refresher already retried once inside the server's grace window. From here the pauses grow.
      arm(Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** failures));
      failures += 1;
    }
  }
  function adopt(value: Session) {
    epoch += 1;
    failures = 0;
    set({ session: value, restoring: false, restoreFailed: false, notice: null });
    arm();
  }
  function commit(value: Session) {
    adopt(sessionSchema.parse(value));
  }
  function signOut(notice: SessionNotice | null) {
    epoch += 1;
    failures = 0;
    disarm();
    set({ session: null, restoring: false, restoreFailed: false, notice });
  }
  function clear() {
    signOut(null);
  }
  function heard(data: unknown) {
    const message = channelMessage.safeParse(data);
    if (!message.success) return;
    const current = state.session;
    if (!current) return;
    if (message.data.type === 'logout') signOut(null);
    else if (message.data.session.userId === current.userId && Date.parse(message.data.session.expiresAt) > Date.parse(current.expiresAt))
      adopt(message.data.session);
  }
  async function bootRefresh() {
    // Already signed in (a harness or a sign-in that beat the boot): nothing to restore, and no cookie rotation to spend.
    if (state.session) return;
    const started = epoch;
    const outcome = await refresher.refresh();
    if (epoch !== started || state.session) return;
    if (outcome.kind === 'session') commit(outcome.session);
    else if (outcome.kind === 'signed_out') signOut(noticeFor(outcome.code));
    // A definite refusal at boot: retrying cannot help, so the visitor goes to sign-in rather than an endless Retry.
    else if (outcome.kind === 'refused') signOut(null);
    else set({ session: null, restoring: false, restoreFailed: true, notice: null });
  }
  async function serverLogout(): Promise<ApiResult<{ ok: true }>> {
    // A refresh already in flight would set a fresh cookie after the logout cleared it.
    await refresher.idle();
    return logoutRequest();
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
      if (!channel) {
        channel = openChannel();
        if (channel) channel.onmessage = (event) => heard(event.data);
      }
      boot ??= bootRefresh();
      arm();
      return boot;
    },
    stop() {
      active = false;
      disarm();
      if (channel) {
        channel.onmessage = null;
        channel.close();
        channel = null;
      }
    },
    /** After a boot outage: try the cookie again. */
    retryRestore(): Promise<void> {
      if (state.restoring || state.session) return boot ?? Promise.resolve();
      set({ session: null, restoring: true, restoreFailed: false, notice: null });
      boot = bootRefresh();
      return boot;
    },
    async logout(): Promise<ApiResult<{ ok: true }>> {
      const previous = state.session;
      clear();
      if (!previous) return { ok: true, data: { ok: true } };
      tell({ type: 'logout' });
      return serverLogout();
    },
    /** After a logout the server did not confirm: ask again. The cookie is still valid until this succeeds. */
    retryLogout: serverLogout,
  };
}
export type SessionController = ReturnType<typeof createSessionController>;
