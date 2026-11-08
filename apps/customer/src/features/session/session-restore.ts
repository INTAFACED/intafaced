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
  /**
   * Set while this tab acts as one of the person's own sub-accounts (`auth.subAccountSession`). The refresh cookie stays
   * the main account's: a refresh answers for the main account, and the controller asks for the sub-account again.
   */
  subAccountId: z.string().guid().optional(),
  subAccountLabel: z.string().optional(),
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

/**
 * Why a refresh ended the session, when the server said so. Shown to the person; never guessed. `subaccount_ended`: the
 * tab acted as a sub-account and is back on the main account, because the sub-account could not be confirmed again.
 */
export type SessionNotice = 'reused' | 'frozen' | 'idle' | 'subaccount_ended';
export function noticeFor(code: string | undefined): SessionNotice | null {
  if (code === 'auth.session_reused') return 'reused';
  if (code === 'auth.account_frozen') return 'frozen';
  return code === 'auth.session_idle' ? 'idle' : null;
}

/**
 * When the person last used this browser and when its sign-in was last refreshed (I-signin-sessions-06), held in memory
 * and shared by its tabs over the session channel, never stored. A refresh the timer makes with no use since the one
 * before tells identity so (`idle: true`), and the idle sign-out keeps counting: an open tab nobody touches is a device
 * left unused. Before the first refresh or the first use is known, a refresh counts as use, as it always did.
 */
/** Calls `onUse` for a key, a click or a touch, at most once every few seconds; returns the way to stop listening. */
export function watchUse(onUse: (at: number) => void, now: () => number = Date.now): () => void {
  const target = globalThis.window;
  if (!target?.addEventListener) return () => undefined;
  let last = 0;
  const used = () => {
    const at = now();
    if (at - last < 5_000) return;
    last = at;
    onUse(at);
  };
  const events = ['pointerdown', 'keydown', 'touchstart'] as const;
  for (const name of events) target.addEventListener(name, used, { capture: true, passive: true });
  used();
  return () => {
    for (const name of events) target.removeEventListener(name, used, { capture: true });
  };
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
  const attempt = async (idle: boolean) =>
    mapRefreshResult(await api.mutate('identity', 'auth.refresh', idle ? { idle: true } : {}, sessionSchema));
  async function once(idle: boolean): Promise<RefreshOutcome> {
    const first = await attempt(idle);
    if (first.kind !== 'unavailable') return first;
    if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return attempt(idle);
  }
  async function locked(idle: () => boolean): Promise<RefreshOutcome> {
    const locks = options.locks === undefined ? browserLocks() : (options.locks ?? undefined);
    if (!locks) return once(idle());
    let started = false;
    try {
      return await locks.request(REFRESH_LOCK, async () => {
        started = true;
        // Read under the lock: another tab may have refreshed (and been used) while this one waited.
        return once(idle());
      });
    } catch {
      // The lock could not be taken (blocked or opaque origin): refresh without it. Once the callback has run, never run twice.
      return started ? { kind: 'unavailable' } : once(idle());
    }
  }
  return {
    /** `unused`: says whether this browser saw no use since its last refresh (read when the refresh is sent). */
    refresh(options: { unused?: () => boolean } = {}): Promise<RefreshOutcome> {
      if (!flight) {
        const idle = () => options.unused?.() === true;
        const started: Promise<RefreshOutcome> = locked(idle).finally(() => {
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

const subAccountSessionReply = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  userId: z.string().guid(),
  subAccountId: z.string().guid(),
  label: z.string(),
});

/** `auth.subAccountSession` on the main account's token: a token for this tab only, never stored or shared. */
export async function requestSubAccountSession(
  main: Session,
  subAccountId: string,
  options: { fetch?: typeof fetch } = {},
): Promise<ApiResult<Session>> {
  const api = createApiClient({ token: () => main.accessToken, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const result = await api.mutate('identity', 'auth.subAccountSession', { subAccountId }, subAccountSessionReply);
  if (!result.ok) return result;
  const { label, ...rest } = result.data;
  return { ok: true, data: { ...rest, subAccountLabel: label } };
}

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
  /**
   * True while a tab acting as a sub-account is confirming it again (after a refresh rotated the session) and has no
   * answer yet. The tab never acts as the main account meanwhile: requests on the old token are refused, not re-sent.
   */
  subAccountWaiting?: boolean;
};

export type ChannelLike = {
  postMessage: (message: unknown) => void;
  close: () => void;
  onmessage: ((event: { data: unknown }) => void) | null;
};
const channelMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('logout') }),
  z.object({ type: z.literal('session'), session: sessionSchema }),
  z.object({ type: z.literal('used'), at: z.number().finite() }),
]);
function browserChannel(): ChannelLike | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : (new BroadcastChannel(SESSION_CHANNEL) as unknown as ChannelLike);
  } catch {
    return null;
  }
}

/**
 * Which sub-account this tab acts as, so a reload keeps acting as it: the user and sub-account ids only, in this tab's
 * sessionStorage, never a token. At boot the controller asks identity for it again on the main-account token, and only
 * when the cookie still answers for the same user.
 */
export type TabChoice = { userId: string; subAccountId: string };
export type TabMemory = { read: () => TabChoice | null; write: (choice: TabChoice | null) => void };
const TAB_SUBACCOUNT_KEY = 'ifc-subaccount';
const tabChoice = z.object({ userId: z.string().guid(), subAccountId: z.string().guid() }).strict();
function browserTabMemory(): TabMemory {
  return {
    read() {
      try {
        const value = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(TAB_SUBACCOUNT_KEY);
        const parsed = value ? tabChoice.safeParse(JSON.parse(value)) : null;
        return parsed?.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    write(choice) {
      try {
        if (typeof sessionStorage === 'undefined') return;
        if (choice) sessionStorage.setItem(TAB_SUBACCOUNT_KEY, JSON.stringify(choice));
        else if (sessionStorage.getItem(TAB_SUBACCOUNT_KEY) !== null) sessionStorage.removeItem(TAB_SUBACCOUNT_KEY);
      } catch {
        // Storage blocked: the tab still acts as the sub-account until it reloads.
      }
    },
  };
}

/**
 * Only identity's own refusal ends a sub-account: a 403, or a typed `auth.*` code (revoked, frozen, not owned, session
 * gone). Anything else (no answer, unreadable, a 404 or 5xx in a deploy) says nothing about it: ask again later.
 */
function refusedByIdentity(result: ApiResult<unknown>): boolean {
  if (result.ok) return false;
  return result.reason === 'forbidden' || (typeof result.code === 'string' && result.code.startsWith('auth.'));
}

/** Refresh this long before the access token expires. */
const REFRESH_LEAD_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;
/**
 * The least time between two silent refreshes. A device whose clock runs ahead of the server's sees every fresh token as
 * already due, and without this floor would refresh again at once, without end, until identity rate-limits the person
 * and every read fails "Too many requests" (J-bank-16 #1, run 42191788272). The server judges a token by its own clock,
 * so a token refreshed a minute ago is still good there.
 */
const MIN_REFRESH_GAP_MS = 60_000;

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
    /** Ask for a sub-account token on the given main-account session (`auth.subAccountSession`). */
    enterSubAccount?: (main: Session, subAccountId: string) => Promise<ApiResult<Session>>;
    tabMemory?: TabMemory;
  } = {},
) {
  const memory = options.tabMemory ?? browserTabMemory();
  const askSubAccount = options.enterSubAccount ?? requestSubAccountSession;
  const refresher = options.refresher ?? createSessionRefresher();
  const logoutRequest = options.logout ?? (() => requestLogout());
  const now = options.now ?? Date.now;
  const openChannel = options.openChannel ?? browserChannel;
  let state: SessionState = { session: null, restoring: true, restoreFailed: false, notice: null };
  let epoch = 0;
  let active = false;
  let stopWatchingUse: (() => void) | null = null;
  let usedAt: number | null = null;
  let refreshedAt: number | null = null;
  const unused = () => usedAt !== null && refreshedAt !== null && usedAt <= refreshedAt;
  function used(at: number) {
    usedAt = Math.max(usedAt ?? 0, at);
    tell({ type: 'used', at });
  }
  let failures = 0;
  /** When the last silent refresh was asked for, by this tab's clock: the next one waits at least MIN_REFRESH_GAP_MS. */
  let lastSilentAt = Number.NEGATIVE_INFINITY;
  let boot: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let channel: ChannelLike | null = null;
  const listeners = new Set<() => void>();
  /** The sub-account this tab means to act as, and the newest main-account token it has seen (the one to ask on). */
  let wanted: TabChoice | null = null;
  let latestMain: Session | null = null;
  let reentry: Promise<ApiResult<Session>> | null = null;
  let reentryTimer: ReturnType<typeof setTimeout> | undefined;
  let reentryFailures = 0;

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
    const due = Math.max(0, Math.min(MAX_TIMER_MS, deadline - now() - REFRESH_LEAD_MS));
    const delay = retryDelay ?? Math.max(due, lastSilentAt + MIN_REFRESH_GAP_MS - now());
    timer = setTimeout(() => void silent(session), delay);
  }
  async function silent(forSession: Session) {
    timer = undefined;
    lastSilentAt = now();
    const started = epoch;
    const outcome = await refresher.refresh({ unused });
    if (outcome.kind === 'session') refreshedAt = now();
    if (epoch !== started || state.session?.accessToken !== forSession.accessToken) return;
    if (outcome.kind === 'session') {
      // Other tabs on the main account take the rotated main token; this tab keeps acting as its sub-account when it was.
      tell({ type: 'session', session: outcome.session });
      if (forSession.subAccountId && wanted) {
        latestMain = outcome.session;
        await reenter('keep');
      } else commit(outcome.session);
    } else if (outcome.kind === 'signed_out') signOut(noticeFor(outcome.code));
    else {
      // 'unavailable' and 'refused' alike: keep the session; a mid-session 400/404 is likelier a deploy than a sign-out.
      // The refresher already retried once inside the server's grace window. From here the pauses grow.
      arm(Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** failures));
      failures += 1;
    }
  }
  /** The tab memory is written only when identity confirms the sub-account (in adopt), and cleared here. */
  function want(choice: TabChoice | null) {
    wanted = choice;
    if (!choice) {
      memory.write(null);
      if (reentryTimer !== undefined) clearTimeout(reentryTimer);
      reentryTimer = undefined;
      reentryFailures = 0;
    }
  }
  /**
   * Ask identity for the wanted sub-account on the newest main-account token, one request at a time (a second caller
   * shares the flight). A refresh rotates the session and revokes the old session id, so every new main token needs a
   * new sub-account token: if a newer main token arrives meanwhile, the answer is dropped and the question asked again.
   * - `enter`: the person pressed Use. A refusal or no answer changes nothing and is returned.
   * - `keep`: the tab already acts as the sub-account. A refusal puts it back on the main account with a notice; no
   *   answer keeps it waiting (never acting as main) and asks again with growing pauses.
   * - `boot`: a reload. A refusal lands on the main account with a notice; no answer is a boot outage (Retry).
   * A main token the server no longer accepts is refreshed from the cookie once, then the question is asked again.
   */
  function reenter(mode: 'enter' | 'keep' | 'boot'): Promise<ApiResult<Session>> {
    if (reentry) return reentry;
    const run = (async (): Promise<ApiResult<Session>> => {
      const superseded: ApiResult<Session> = {
        ok: false,
        reason: 'aborted',
        message: 'This tab’s sign-in changed while switching. Nothing was switched; try again.',
      };
      let refreshed = false;
      for (;;) {
        const target = wanted;
        const main = latestMain;
        if (!target || !main || target.userId !== main.userId) return superseded;
        if (mode === 'keep' && !state.subAccountWaiting) set({ ...state, subAccountWaiting: true });
        let answer: ApiResult<Session>;
        try {
          answer = await askSubAccount(main, target.subAccountId);
        } catch {
          answer = { ok: false, reason: 'invalid_response', message: 'The sub-account answer could not be read.' };
        }
        if (wanted !== target) return superseded;
        if (latestMain !== main) continue;
        if (answer.ok) {
          const sub = sessionSchema.safeParse(answer.data);
          if (sub.success && sub.data.subAccountId === target.subAccountId && sub.data.userId === main.userId) {
            reentryFailures = 0;
            adopt(sub.data);
            return { ok: true, data: sub.data };
          }
          answer = { ok: false, reason: 'invalid_response', message: 'The sub-account answer could not be read.' };
        }
        if (answer.reason === 'unauthorized' && !refreshed) {
          refreshed = true;
          const outcome = await refresher.refresh();
          if (wanted !== target) return superseded;
          if (outcome.kind === 'session') {
            tell({ type: 'session', session: outcome.session });
            latestMain = outcome.session;
            // Pressing Use from the main account: this tab takes the fresh main token too.
            if (mode === 'enter') adopt(outcome.session);
            continue;
          }
          if (outcome.kind === 'signed_out') {
            signOut(noticeFor(outcome.code));
            return answer;
          }
          answer = { ok: false, reason: 'unreachable', message: 'The main account could not be reached.' };
        }
        if (mode === 'enter') {
          want(null);
          return answer;
        }
        if (refusedByIdentity(answer)) {
          want(null);
          adopt(main, 'subaccount_ended');
          return answer;
        }
        if (mode === 'boot') {
          set({ session: null, restoring: false, restoreFailed: true, notice: null });
          return answer;
        }
        if (reentryTimer !== undefined) clearTimeout(reentryTimer);
        const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** reentryFailures);
        reentryFailures += 1;
        reentryTimer = setTimeout(() => {
          reentryTimer = undefined;
          if (active) void reenter('keep');
        }, delay);
        return answer;
      }
    })().finally(() => {
      if (reentry === run) reentry = null;
    });
    reentry = run;
    return run;
  }
  function adopt(value: Session, notice: SessionNotice | null = null) {
    if (!value.subAccountId) latestMain = value;
    else if (wanted) memory.write(wanted);
    epoch += 1;
    failures = 0;
    set({ session: value, restoring: false, restoreFailed: false, notice });
    arm();
  }
  /**
   * A session handed in from outside (a sign-in, a harness). It wins over anything in flight: a main-account session
   * forgets the tab's sub-account choice, and a sub-account session becomes the choice, so a refresh keeps it.
   */
  function commit(value: Session) {
    const session = sessionSchema.parse(value);
    want(session.subAccountId ? { userId: session.userId, subAccountId: session.subAccountId } : null);
    adopt(session);
  }
  function signOut(notice: SessionNotice | null) {
    want(null);
    latestMain = null;
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
    if (message.data.type === 'used') {
      usedAt = Math.max(usedAt ?? 0, Math.min(message.data.at, now()));
      return;
    }
    // Another tab refreshed: this browser's sign-in was refreshed now.
    if (message.data.type === 'session') refreshedAt = now();
    const current = state.session;
    if (!current) return;
    if (message.data.type === 'logout') {
      signOut(null);
      return;
    }
    const rotated = message.data.session;
    const known = latestMain ?? current;
    // No sub-account token is ever shared, and a tab never adopts a different user's session or an older token.
    if (rotated.subAccountId || rotated.userId !== current.userId) return;
    if (Date.parse(rotated.expiresAt) <= Date.parse(known.expiresAt)) return;
    if (current.subAccountId && wanted) {
      // Another tab's refresh revoked the session this tab's sub-account token stands on: ask again on the new token.
      latestMain = rotated;
      void reenter('keep');
    } else if (!current.subAccountId) adopt(rotated);
  }
  async function bootRefresh() {
    // Already signed in (a harness or a sign-in that beat the boot): nothing to restore, and no cookie rotation to spend.
    if (state.session) return;
    const started = epoch;
    const outcome = await refresher.refresh();
    if (outcome.kind === 'session') refreshedAt = now();
    if (epoch !== started || state.session) return;
    if (outcome.kind === 'session') {
      const remembered = memory.read();
      // A reload of a tab that acted as a sub-account: ask for it again on the main token before the rooms paint.
      if (remembered && remembered.userId === outcome.session.userId) {
        wanted = remembered;
        latestMain = outcome.session;
        await reenter('boot');
      } else {
        if (remembered) want(null);
        commit(outcome.session);
      }
    } else if (outcome.kind === 'signed_out') signOut(noticeFor(outcome.code));
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
    /**
     * A request on this token came back 401. A tab acting as a sub-account asks for it again (its session may have just
     * been rotated); any other tab is signed out, as before. While it is already asking, or waiting to ask again, a 401
     * starts nothing new: the pauses keep growing.
     */
    unauthorized(requestToken: string | undefined) {
      if (!requestToken || state.session?.accessToken !== requestToken) return;
      if (!state.session.subAccountId || !wanted) clear();
      else if (!reentry && reentryTimer === undefined) void reenter('keep');
    },
    /** Idempotent: the boot refresh runs once however often this is called (React StrictMode mounts twice). */
    start(): Promise<void> {
      active = true;
      stopWatchingUse ??= watchUse(used, now);
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
      stopWatchingUse?.();
      stopWatchingUse = null;
      disarm();
      if (reentryTimer !== undefined) clearTimeout(reentryTimer);
      reentryTimer = undefined;
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
    /** Act as one of the person's own sub-accounts in this tab. Only from the main account; a refusal changes nothing. */
    async enterSubAccount(subAccountId: string): Promise<ApiResult<Session>> {
      const current = state.session;
      if (!current || current.subAccountId || wanted) {
        return { ok: false, reason: 'forbidden', message: 'Switch back to the main account first.', code: 'auth.sub_account_denied' };
      }
      // An earlier question (for a sub-account just left) is still on its way back: never share its answer.
      if (reentry) return { ok: false, reason: 'aborted', message: 'The previous switch is still finishing. Try again.' };
      want({ userId: current.userId, subAccountId });
      latestMain = current;
      return reenter('enter');
    },
    /**
     * Back to the main account: a refresh from the cookie, which always answers for the main account. If it gets no
     * answer the tab stays as it is (still the sub-account) and says so.
     */
    async leaveSubAccount(): Promise<RefreshOutcome> {
      const outcome = await refresher.refresh();
      const current = state.session;
      // Signed out meanwhile: a late answer never brings the session back.
      if (!current) return outcome;
      if (outcome.kind === 'session' && outcome.session.userId === current.userId) {
        tell({ type: 'session', session: outcome.session });
        want(null);
        adopt(sessionSchema.parse(outcome.session));
      } else if (outcome.kind === 'signed_out') signOut(noticeFor(outcome.code));
      return outcome;
    },
  };
}
export type SessionController = ReturnType<typeof createSessionController>;
