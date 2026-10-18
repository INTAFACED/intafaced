import type { ApiResult } from '../../../shared/api';
import type { ChatMessage, ChatPage, ChatSent, Contacts } from '../schemas';

/**
 * Order chat and contacts, as the screens need them. Everything here is a plain function or a small store, so the
 * rules (no double-posting, how a refusal reads, when to poll) are tested without a browser.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────────────────────

export type ServiceFailure =
  | 'signIn'
  | 'notParty'
  | 'readOnly'
  | 'verify'
  | 'region'
  | 'textRequired'
  | 'attachment'
  | 'self'
  | 'conflict'
  | 'inProgress'
  | 'unconfirmed'
  | 'noService'
  | 'viewChanged'
  | 'generic';

/**
 * A refusal as one plain kind. The screen turns the kind into words; no service text and no code ever reaches the
 * customer. The codes are svc-p2p's own (router.ts) plus the gateway's jurisdiction answers.
 */
export function serviceFailureKind(failure: { reason: string; code?: string; status?: number }): ServiceFailure {
  switch (failure.code) {
    case 'p2p.trade_not_found':
    case 'p2p.not_a_party':
    case 'p2p.not_a_moderator':
      return 'notParty';
    case 'p2p.contact_self':
      return 'self';
    case 'p2p.chat_text_required':
      return 'textRequired';
    case 'p2p.chat_attachment_unwired':
      return 'attachment';
    case 'p2p.idempotency_conflict':
      return 'conflict';
    case 'p2p.idempotency_in_progress':
      return 'inProgress';
    case 'denied.kyc_required':
      return 'verify';
    case 'denied.region_blocked':
    case 'denied.region_unknown':
      return 'region';
    case 'pay.p2p_view_changed':
      return 'viewChanged';
    case 'pay.session_required':
      return 'signIn';
  }
  if (failure.reason === 'unauthorized') return 'signIn';
  if (failure.reason === 'forbidden') return 'readOnly';
  if (failure.reason === 'uncertain') return 'unconfirmed';
  if (failure.reason === 'unreachable' || failure.reason === 'not_supported') return 'noService';
  return 'generic';
}

/**
 * Whether a refused send proves nothing was stored. A named pre-write refusal or a plain request rejection counts.
 * A timeout, a 5xx, a dropped connection or "still being saved" may follow a stored message, so those are unconfirmed.
 */
export function sendRefusalIsDefinite(failure: { reason: string; code?: string; status?: number }): boolean {
  // `aborted` is the client declining to dispatch (account changed, view left); nothing left the browser.
  if (failure.reason === 'aborted') return true;
  if (failure.reason === 'uncertain' || failure.reason === 'unreachable') return false;
  if (failure.code === 'p2p.idempotency_in_progress') return false;
  if (failure.code === 'p2p.chat_text_required' || failure.code === 'p2p.chat_attachment_unwired') return true;
  return failure.status !== undefined && [400, 401, 403, 404, 409, 412, 422].includes(failure.status);
}

// ── Messages ────────────────────────────────────────────────────────────────────────────────────────────────────

export type SenderRole = 'you' | 'buyer' | 'seller' | 'moderator';

/** Who wrote a message, from the order's own parties. Anyone who is neither side is a moderator on a disputed order. */
export function senderRole(senderId: string, trade: { buyerId: string; sellerId: string }, viewer: string | null): SenderRole {
  if (viewer !== null && senderId === viewer) return 'you';
  if (senderId === trade.buyerId) return 'buyer';
  if (senderId === trade.sellerId) return 'seller';
  return 'moderator';
}

/** Add what the service returned, keeping oldest first and never listing a message twice. Returns how many were new. */
export function mergeMessages(
  existing: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): { messages: ChatMessage[]; added: number } {
  const known = new Set(existing.map((message) => message.id));
  const fresh = incoming.filter((message) => !known.has(message.id));
  if (fresh.length === 0) return { messages: existing as ChatMessage[], added: 0 };
  const messages = [...existing, ...fresh].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return { messages, added: fresh.length };
}

/**
 * The first message of the viewer's unread run. The service counts unread as the other side's messages newer than the
 * last read, so those are exactly the last `unread` messages from anyone but the viewer.
 */
export function firstUnreadId(messages: readonly ChatMessage[], viewer: string | null, unread: number): string | null {
  if (unread <= 0) return null;
  let left = unread;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.senderId === viewer) continue;
    left -= 1;
    if (left === 0) return message.id;
  }
  return null;
}

/** Clock time for today's messages, date and time for older ones. Always from the service's own timestamp. */
export function chatTime(iso: string, locale: string, now: number): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ── Polling ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const POLL_ACTIVE_MS = 5_000;
export const POLL_IDLE_MAX_MS = 30_000;
export const POLL_CLOSED_MS = 30_000;
export const POLL_ERROR_MAX_MS = 60_000;

/**
 * How long to wait before the next read. There is no push channel for order chat (svc-ws carries market and trade
 * data only), so the thread is read on a timer: quick while it is busy, slower each quiet round, slow after errors,
 * and not at all while the page is hidden (reading would mark messages read that nobody saw).
 */
export function pollDelay(input: { quietRounds: number; failures: number; closed: boolean }): number {
  if (input.failures > 0) return Math.min(POLL_ERROR_MAX_MS, POLL_ACTIVE_MS * 2 ** input.failures);
  if (input.closed) return POLL_CLOSED_MS;
  return Math.min(POLL_IDLE_MAX_MS, Math.round(POLL_ACTIVE_MS * 1.5 ** input.quietRounds));
}

// ── The conversation store ──────────────────────────────────────────────────────────────────────────────────────

export type PendingMessage = {
  clientId: string;
  text: string;
  /** `sending`: on its way. `failed`: refused, nothing stored. `unconfirmed`: the reply was lost, it may be stored. */
  status: 'sending' | 'failed' | 'unconfirmed';
  failure: ServiceFailure | null;
};

export type ChatState = {
  phase: 'loading' | 'ready' | 'failed';
  /** Why the first read failed. */
  loadFailure: ServiceFailure | null;
  /** Why the latest background read failed, while earlier messages are still shown. */
  refreshFailure: ServiceFailure | null;
  messages: ChatMessage[];
  pending: PendingMessage[];
  /** Unread count the service reported when the thread was opened, and the message the unread run starts at. */
  unreadAtOpen: number;
  firstUnread: string | null;
  /** Whether the service reported fan-out of the last message sent. `null` before any send. */
  lastNotified: boolean | null;
  /** Milliseconds until the next automatic read, or null when none is scheduled. */
  nextReadMs: number | null;
  /** Unread messages counted without reading (and so without marking) the thread, while it is out of view. */
  unreadBelow: number | null;
};

export type ChatPorts = {
  list: (page: { cursor: string | null; limit: number }, signal: AbortSignal) => Promise<ApiResult<ChatPage>>;
  send: (text: string, clientId: string) => Promise<ApiResult<ChatSent>>;
  /** The signed-in account id. */
  viewer: string | null;
  newId: () => string;
  closed: () => boolean;
  /** Whether the browser tab is showing. Nothing is read while it is not. */
  visible: () => boolean;
  /**
   * Whether the conversation itself is on screen. Reading the thread marks it read, so while it is out of view only
   * `unread` (which marks nothing) is asked. Absent means always in view.
   */
  inView?: () => boolean;
  unread?: (signal: AbortSignal) => Promise<ApiResult<{ unread: number }>>;
  timers?: { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
};

const PAGE = 100;
const MAX_PAGES_PER_READ = 20;
export const MAX_CHAT_TEXT = 2000;

export type ReadOutcome = 'ok' | 'failed' | 'stale';
/** A reply that no retry will change: the person has to act, so reading stops until they ask again. */
const FINAL_FAILURES: ReadonlySet<ServiceFailure> = new Set(['notParty', 'signIn', 'verify', 'region']);

export type TakeOutcome =
  { status: 'text'; text: string; clientId: string } | { status: 'sent' } | { status: 'unchecked'; kind: ServiceFailure };

export type SendOutcome = { ok: true } | { ok: false; kind: 'empty' | 'tooLong' | ServiceFailure };

export class ChatStore {
  private state: ChatState = {
    phase: 'loading',
    loadFailure: null,
    refreshFailure: null,
    messages: [],
    pending: [],
    unreadAtOpen: 0,
    firstUnread: null,
    lastNotified: null,
    nextReadMs: null,
    unreadBelow: null,
  };
  private listeners = new Set<() => void>();
  private cursor: string | null = null;
  private quiet = 0;
  private failures = 0;
  private timer: unknown = null;
  private running = false;
  private reading: Promise<ReadOutcome> | null = null;
  private opened = false;
  private controller = new AbortController();
  private readonly timers: NonNullable<ChatPorts['timers']>;

  constructor(private readonly ports: ChatPorts) {
    this.timers = ports.timers ?? {
      set: (run, ms) => setTimeout(run, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  getState = (): ChatState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(patch: Partial<ChatState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Read the thread now and keep reading on a timer until `stop`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    void this.read();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    this.controller.abort();
    this.reading = null;
  }

  /** The tab or the conversation came into or went out of view. Nothing is read while the tab is hidden. */
  visibilityChanged(): void {
    if (!this.running) return;
    if (this.ports.visible()) {
      this.quiet = 0;
      void this.read();
    } else {
      this.clearTimer();
      this.set({ nextReadMs: null });
    }
  }

  /** A person asked for a fresh read of the thread, which is on screen because they asked. */
  refresh(): Promise<ReadOutcome> {
    this.quiet = 0;
    return this.read(true);
  }

  private clearTimer() {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private schedule() {
    this.clearTimer();
    if (!this.running || !this.ports.visible()) {
      this.set({ nextReadMs: null });
      return;
    }
    const ms = pollDelay({ quietRounds: this.quiet, failures: this.failures, closed: this.ports.closed() });
    this.set({ nextReadMs: ms });
    this.timer = this.timers.set(() => void this.read(), ms);
  }

  /**
   * One read of everything after the newest message held. Reads never overlap; one asked for during another runs
   * after it, so its answer is never older than the request. Out of view, only the unread count is read.
   */
  private read(force = false): Promise<ReadOutcome> {
    if (!this.running) return Promise.resolve('stale');
    if (this.reading) return this.reading.then(() => this.read(force));
    this.clearTimer();
    const outOfView = !force && this.ports.inView !== undefined && !this.ports.inView() && this.ports.unread !== undefined;
    const run: Promise<ReadOutcome> = (outOfView ? this.peek() : this.readPages())
      .catch((): ReadOutcome => {
        this.failures += 1;
        if (this.state.phase === 'loading') this.set({ phase: 'failed', loadFailure: 'generic' });
        else this.set({ refreshFailure: 'generic' });
        this.schedule();
        return 'failed';
      })
      .finally(() => {
        if (this.reading === run) this.reading = null;
      });
    this.reading = run;
    return run;
  }

  /** Count unread messages without reading the thread, so nothing is marked read that nobody has seen. */
  private async peek(): Promise<ReadOutcome> {
    const signal = this.controller.signal;
    const result = await this.ports.unread!(signal);
    if (signal.aborted) return 'stale';
    if (!result.ok) {
      this.failures += 1;
      if (FINAL_FAILURES.has(serviceFailureKind(result))) {
        this.clearTimer();
        this.set({ nextReadMs: null });
      } else this.schedule();
      return 'failed';
    }
    this.failures = 0;
    this.quiet += 1;
    this.set({ unreadBelow: result.data.unread });
    this.schedule();
    return 'ok';
  }

  private async readPages(): Promise<ReadOutcome> {
    const signal = this.controller.signal;
    let gained = 0;
    let unread = 0;
    for (let page = 0; page < MAX_PAGES_PER_READ; page++) {
      const result = await this.ports.list({ cursor: this.cursor, limit: PAGE }, signal);
      if (signal.aborted) return 'stale';
      if (!result.ok) {
        if (result.reason === 'aborted') return 'stale';
        const kind = serviceFailureKind(result);
        if (kind === 'viewChanged') return 'stale';
        this.failures += 1;
        if (this.state.phase === 'loading') this.set({ phase: 'failed', loadFailure: kind });
        else this.set({ refreshFailure: kind });
        // A reply no retry can change is not asked for again on a timer; the person's "Try again" still works.
        if (FINAL_FAILURES.has(kind)) {
          this.clearTimer();
          this.set({ nextReadMs: null });
        } else this.schedule();
        return 'failed';
      }
      if (page === 0) unread = result.data.unread;
      const merged = mergeMessages(this.state.messages, result.data.messages);
      gained += merged.added;
      const last = result.data.messages.at(-1);
      if (last) this.cursor = last.id;
      this.state = { ...this.state, messages: merged.messages };
      if (result.data.nextCursor === null) break;
      this.cursor = result.data.nextCursor;
    }
    this.failures = 0;
    const patch: Partial<ChatState> = {
      phase: 'ready',
      loadFailure: null,
      refreshFailure: null,
      unreadBelow: null,
      messages: this.state.messages,
      pending: this.settle(this.state.pending, this.state.messages),
    };
    if (!this.opened) {
      this.opened = true;
      patch.unreadAtOpen = unread;
      patch.firstUnread = firstUnreadId(this.state.messages, this.ports.viewer, unread);
    }
    this.quiet = gained > 0 ? 0 : this.quiet + 1;
    this.set(patch);
    this.schedule();
    return 'ok';
  }

  /** A pending message the service now lists is no longer pending, however its own reply went. */
  private settle(pending: readonly PendingMessage[], messages: readonly ChatMessage[]): PendingMessage[] {
    const stored = new Set(messages.filter((message) => message.senderId === this.ports.viewer).map((message) => message.clientId));
    return pending.filter((item) => !stored.has(item.clientId));
  }

  private patchPending(clientId: string, patch: Partial<PendingMessage>) {
    this.set({ pending: this.state.pending.map((item) => (item.clientId === clientId ? { ...item, ...patch } : item)) });
  }

  /** Send a new message. The text is shown at once as sending, and is kept until the service has it. */
  send(text: string, reuseClientId?: string): Promise<SendOutcome> {
    const trimmed = text.trim();
    if (!trimmed) return Promise.resolve({ ok: false, kind: 'empty' });
    if (trimmed.length > MAX_CHAT_TEXT) return Promise.resolve({ ok: false, kind: 'tooLong' });
    // Text taken back from a message whose reply was lost keeps that message's id, so sending it unchanged cannot post
    // twice even if the service finished saving it after the check.
    const clientId = reuseClientId ?? this.ports.newId();
    this.set({ pending: [...this.state.pending, { clientId, text: trimmed, status: 'sending', failure: null }] });
    return this.dispatch(clientId);
  }

  private async dispatch(clientId: string): Promise<SendOutcome> {
    const item = this.state.pending.find((candidate) => candidate.clientId === clientId);
    if (!item) return { ok: true };
    this.patchPending(clientId, { status: 'sending', failure: null });
    // The reply is awaited even if the page leaves: the request is already out and the id keeps a repeat harmless.
    const result = await this.ports.send(item.text, clientId);
    if (result.ok) {
      const merged = mergeMessages(this.state.messages, [result.data]);
      this.quiet = 0;
      this.set({
        messages: merged.messages,
        pending: this.state.pending.filter((candidate) => candidate.clientId !== clientId),
        lastNotified: result.data.notify.delivered,
        refreshFailure: null,
      });
      if (this.running) this.schedule();
      return { ok: true };
    }
    const kind = serviceFailureKind(result);
    const status = sendRefusalIsDefinite(result) ? 'failed' : 'unconfirmed';
    // A reused id with different text can never succeed; the person's text gets a fresh id on the next try.
    if (kind === 'conflict') {
      this.set({
        pending: this.state.pending.map((candidate) =>
          candidate.clientId === clientId ? { ...candidate, clientId: this.ports.newId(), status: 'failed', failure: kind } : candidate,
        ),
      });
    } else this.patchPending(clientId, { status, failure: kind });
    return { ok: false, kind };
  }

  /**
   * Try a held message again. The thread is read first, because a lost reply may have stored it; only if that read
   * finished and the service still does not list the message is it sent again, under the same id.
   */
  async resend(clientId: string): Promise<SendOutcome> {
    const item = this.state.pending.find((candidate) => candidate.clientId === clientId);
    if (!item) return { ok: true };
    this.patchPending(clientId, { status: 'sending', failure: null });
    const outcome = await this.refresh();
    if (!this.state.pending.some((candidate) => candidate.clientId === clientId)) return { ok: true };
    if (outcome !== 'ok') {
      // Nothing was learned about whether it is stored, so it is not sent blind.
      const kind = outcome === 'failed' ? (this.state.refreshFailure ?? this.state.loadFailure ?? 'unconfirmed') : 'unconfirmed';
      this.patchPending(clientId, { status: 'unconfirmed', failure: kind });
      return { ok: false, kind };
    }
    return this.dispatch(clientId);
  }

  /**
   * Take a held message back, to edit it or drop it. A message whose reply was lost may already be stored, and
   * giving its text a new id would post it twice, so it is looked for first: found means it was sent, and only a read
   * that finished without it lets the text go.
   */
  async take(clientId: string): Promise<TakeOutcome> {
    const item = this.state.pending.find((candidate) => candidate.clientId === clientId);
    if (!item) return { status: 'sent' };
    if (item.status === 'failed') {
      this.set({ pending: this.state.pending.filter((candidate) => candidate.clientId !== clientId) });
      return { status: 'text', text: item.text, clientId };
    }
    this.patchPending(clientId, { status: 'sending', failure: null });
    const outcome = await this.refresh();
    const held = this.state.pending.find((candidate) => candidate.clientId === clientId);
    if (!held) return { status: 'sent' };
    if (outcome !== 'ok') {
      const kind = outcome === 'failed' ? (this.state.refreshFailure ?? this.state.loadFailure ?? 'unconfirmed') : 'unconfirmed';
      this.patchPending(clientId, { status: 'unconfirmed', failure: kind });
      return { status: 'unchecked', kind };
    }
    this.set({ pending: this.state.pending.filter((candidate) => candidate.clientId !== clientId) });
    return { status: 'text', text: held.text, clientId };
  }
}

// ── Unread counts for the order list ────────────────────────────────────────────────────────────────────────────

export type UnreadCount = { status: 'ready'; count: number } | { status: 'failed' };

/** Read one count per order, a few at a time, so a long list does not open a connection for every row at once. */
export async function readUnreadCounts(
  read: (tradeId: string, signal: AbortSignal) => Promise<ApiResult<{ unread: number }>>,
  tradeIds: readonly string[],
  signal: AbortSignal,
  onCount: (tradeId: string, count: UnreadCount) => void,
  concurrency = 4,
): Promise<void> {
  const queue = [...new Set(tradeIds)];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (signal.aborted) return;
      const result = await read(id, signal);
      if (signal.aborted) return;
      onCount(id, result.ok ? { status: 'ready', count: result.data.unread } : { status: 'failed' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

// ── Contacts ────────────────────────────────────────────────────────────────────────────────────────────────────

export type ContactChange = 'follow' | 'unfollow' | 'block' | 'unblock';

export type ContactStanding = { following: boolean; blocking: boolean };

/** Whether `peer` is followed or blocked in the lists the service returned. Account ids compare without case. */
export function contactStanding(contacts: Contacts, peer: string): ContactStanding {
  const wanted = peer.toLowerCase();
  return {
    following: contacts.following.some((value) => value.toLowerCase() === wanted),
    blocking: contacts.blocking.some((value) => value.toLowerCase() === wanted),
  };
}

/** `contacts` on a failure is the service's lists after any step that did succeed first. */
export type ContactOutcome = { ok: true; contacts: Contacts } | { ok: false; kind: ServiceFailure; contacts?: Contacts };

/**
 * One follow, unfollow, block or unblock. A change keeps its idempotency key until the service has answered, so asking
 * again after a lost reply repeats the same request instead of making a new one. The state shown afterwards is the
 * service's own lists, never a guess.
 */
export async function changeContact(
  api: { setContact: (change: ContactChange, peerId: string, key: string) => Promise<ApiResult<Contacts>> },
  keys: Map<string, string>,
  newId: () => string,
  change: ContactChange,
  peerId: string,
): Promise<ContactOutcome> {
  // Account ids are stored exactly as sent and matched exactly, so a differently cased id would block no one.
  const peer = peerId.toLowerCase();
  const slot = `${change}:${peer}`;
  const key = keys.get(slot) ?? `contact:${change}:${newId()}`;
  keys.set(slot, key);
  const result = await api.setContact(change, peer, key);
  if (result.ok) {
    keys.delete(slot);
    return { ok: true, contacts: result.data };
  }
  // A clear refusal means nothing changed, so the next try is a new request. Anything else keeps the key.
  if (sendRefusalIsDefinite(result) && result.code !== 'p2p.idempotency_in_progress') keys.delete(slot);
  return { ok: false, kind: serviceFailureKind(result) };
}

/**
 * Block, and stop following first when the person follows them. The service keeps follow and block as separate
 * lists and does not unfollow on a block, so this does it as its own change with its own key. If the unfollow goes
 * through and the block does not, the lists after the unfollow come back with the refusal.
 */
export async function blockAndUnfollow(
  api: { setContact: (change: ContactChange, peerId: string, key: string) => Promise<ApiResult<Contacts>> },
  keys: Map<string, string>,
  newId: () => string,
  peerId: string,
  following: boolean,
): Promise<ContactOutcome> {
  let after: Contacts | undefined;
  if (following) {
    const unfollowed = await changeContact(api, keys, newId, 'unfollow', peerId);
    if (!unfollowed.ok) return unfollowed;
    after = unfollowed.contacts;
  }
  const blocked = await changeContact(api, keys, newId, 'block', peerId);
  if (blocked.ok) return blocked;
  return after ? { ...blocked, contacts: after } : blocked;
}
