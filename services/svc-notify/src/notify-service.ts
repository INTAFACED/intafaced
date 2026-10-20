import { createHmac, randomInt } from 'node:crypto';
import type { InsertNotificationInput, ListQuery, ListResult, Notification, NotifyStore } from './store.js';
import { OwnedRecentCursorError, type ChannelTarget, type DeliveryRecord, type DeliveryStore, type TargetStore } from './channel-store.js';
import type { DispatchReport, NotificationDispatcher } from './dispatch.js';
import type { ChannelRegistry, ChannelStatus } from './channels/registry.js';
import { ChannelRefusal, type OutOfAppChannel, type RefusalCode } from './channels/channel.js';
import { normaliseLocale, renderVerification } from './channels/render.js';
import { withNotifySpan } from './tracing.js';
import type { ChannelMutePrefs, MuteStore, MuteableChannel } from './preferences/mute.js';
import type { AccountPrefs, HoldStore } from './preferences/account.js';
import {
  RecentDeliveriesError,
  clampRecentDeliveriesLimit,
  decodeRecentCursor,
  encodeRecentCursor,
  recentDeliveryWire,
} from './preferences/recent.js';
import type { NoticeBoard } from './notices/board.js';
import type { ChannelSettings } from './ops-config/channel-settings.js';
import type { MessageTemplates } from './ops-config/templates.js';
import { TargetRateLimiter, type TargetRateLimiterPort } from './target-rate-limit.js';

/** Insert plus delivery scope. `outOfApp: false` is inbox-only (agentActionCompleted). */
export type CreateNotificationInput = InsertNotificationInput & {
  readonly outOfApp?: boolean;
};

/**
 * svc-notify — event-driven fan-out (ops.notifications).
 *
 * Holds no balances. Inserts are driven by the bus; the inbox row is written
 * first and always, and out-of-app channels are attempted afterwards, against
 * addresses the user confirmed.
 *
 * The invariant this class exists to protect: **the inbox row is the
 * notification; a channel's delivery is a separate, separately recorded fact.**
 * An email that bounced does not un-notify the user in-app, and an in-app row
 * never claims an email went out.
 */

export interface CreateResult {
  /** True only when THIS call wrote the row. False on a redelivery. */
  inserted: boolean;
  /** The row this call wrote. Null on a redelivery — the row already existed. */
  notification: Notification | null;
  /**
   * What happened on each channel. Present even on a redelivery: a crash between
   * the insert and the send is only recoverable if redelivery still fans out.
   */
  dispatch: DispatchReport | null;
}

export type RegisterOutcome =
  | { status: 'sent'; channel: OutOfAppChannel; expiresAt: Date }
  | { status: 'refused'; channel: OutOfAppChannel; code: RefusalCode; expiresAt: Date }
  | { status: 'failed'; channel: OutOfAppChannel; detail: string; expiresAt: Date };

/**
 * Verify outcomes. `refused` is rate-limit (named code); `rejected` is wrong /
 * expired / spent code — one answer on purpose so existence is not leaked.
 */
export type VerifyOutcome = { status: 'verified' } | { status: 'rejected' } | { status: 'refused'; code: RefusalCode };

export interface NotifyServiceOptions {
  readonly fanoutEnabled: boolean;
  /** Minutes a confirmation code stays valid. Unset refuses — never invent 15. Inbox-only callers omit. */
  readonly verifyTtlMinutes?: number;
  /**
   * HMAC key for address-confirmation codes. Unset refuses — never invent a pepper.
   * Inbox-only callers omit.
   */
  readonly verifyCodePepper?: string;
  /**
   * Optional rate limiter for register/verify. Production always wires one;
   * tests may inject a tight window or omit (a default limiter is created).
   */
  readonly targetRateLimiter?: TargetRateLimiterPort;
}

export const NOTIFY_VERIFY_TTL_UNSET = 'notify.verify_ttl_unset' as const;

export const NOTIFY_ANNOUNCEMENT_UNSET = 'notify.announcement_unset' as const;

/** Public announcement content unpublished. Empty stays empty. */
export class NotifyAnnouncementUnsetError extends Error {
  readonly code = NOTIFY_ANNOUNCEMENT_UNSET;
  readonly missingPiece = 'content' as const;
  readonly slot = null;

  constructor() {
    super('A public announcement is refused. The missing piece is content.');
    this.name = 'NotifyAnnouncementUnsetError';
  }
}

/** No announcement is published here. Caller text is not content. */
export function readPublicAnnouncement(): never {
  throw new NotifyAnnouncementUnsetError();
}

export const NOTIFY_LIST_LIMIT_UNSET = 'notify.list_limit_unset' as const;

/** `notify.list` page size unpublished. Blank is not 20. */
export class NotifyListLimitUnsetError extends Error {
  readonly code = NOTIFY_LIST_LIMIT_UNSET;
  constructor() {
    super(NOTIFY_LIST_LIMIT_UNSET);
    this.name = 'NotifyListLimitUnsetError';
  }
}

/** Owner-published `notify.list` page size. Blank / non-finite / <1 refuses. Never invent 20. */
export function assertNotifyListLimit(limit: number | null | undefined): number {
  if (limit === undefined || limit === null || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new NotifyListLimitUnsetError();
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new NotifyListLimitUnsetError();
  }
  return Math.min(100, n);
}

export const NOTIFY_OPERATOR_DELIVERIES_LIMIT_UNSET = 'notify.operator_deliveries_limit_unset' as const;

/** Operator deliveries page size unpublished. Blank is not 50. */
export class NotifyOperatorDeliveriesLimitUnsetError extends Error {
  readonly code = NOTIFY_OPERATOR_DELIVERIES_LIMIT_UNSET;
  constructor() {
    super(NOTIFY_OPERATOR_DELIVERIES_LIMIT_UNSET);
    this.name = 'NotifyOperatorDeliveriesLimitUnsetError';
  }
}

/** Owner-published operator-deliveries page size. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertOperatorDeliveriesLimit(limit: number | null | undefined): number {
  if (limit === undefined || limit === null || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new NotifyOperatorDeliveriesLimitUnsetError();
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new NotifyOperatorDeliveriesLimitUnsetError();
  }
  return Math.min(200, n);
}

/** Owner `NOTIFY_VERIFY_TTL_MINUTES` unpublished. Blank env is not 15. */
export class NotifyVerifyTtlUnsetError extends Error {
  readonly code = NOTIFY_VERIFY_TTL_UNSET;
  constructor() {
    super('NOTIFY_VERIFY_TTL_MINUTES is unset. Blank refuses — never 15. Owner must set an integer 1..120 (15 is allowed if explicit).');
    this.name = 'NotifyVerifyTtlUnsetError';
  }
}

/** Blank / non-integer / out of 1..120 refuses. Never invent 15. */
export function publishedVerifyTtlMinutes(minutes: number | null | undefined): number {
  if (minutes == null || !Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
    throw new NotifyVerifyTtlUnsetError();
  }
  return minutes;
}

export const NOTIFY_VERIFY_CODE_PEPPER_UNSET = 'notify.verify_code_pepper_unset' as const;

/** Owner `NOTIFY_VERIFY_CODE_PEPPER` unpublished. Blank is not a pepper. */
export class NotifyVerifyCodePepperUnsetError extends Error {
  readonly code = NOTIFY_VERIFY_CODE_PEPPER_UNSET;
  constructor() {
    super('NOTIFY_VERIFY_CODE_PEPPER is unset. Blank refuses — no default pepper.');
    this.name = 'NotifyVerifyCodePepperUnsetError';
  }
}

/** Blank / missing pepper refuses. Never invent a pepper. */
export function publishedVerifyCodePepper(pepper: string | null | undefined): string {
  if (typeof pepper !== 'string' || pepper.trim() === '') {
    throw new NotifyVerifyCodePepperUnsetError();
  }
  return pepper;
}

export interface NotifyServiceDeps {
  readonly targets: TargetStore;
  readonly deliveries: DeliveryStore;
  readonly channels: ChannelRegistry;
  readonly dispatcher: NotificationDispatcher;
  /** Mute prefs store — Postgres in prod, memory in unit harnesses. */
  readonly muteStore?: MuteStore;
  readonly account?: AccountPrefs;
  readonly holds?: HoldStore;
  readonly notices?: NoticeBoard;
  readonly channelSettings?: ChannelSettings;
  readonly templates?: MessageTemplates;
}

/** Stored as HMAC-SHA256 keyed by the owner pepper. A bare digest of the six-digit code is reversible. */
function hashCode(code: string, pepper: string): string {
  return createHmac('sha256', publishedVerifyCodePepper(pepper)).update(code).digest('hex');
}

/** Six digits from a CSPRNG — not `Math.random`, which is predictable. */
function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export class NotifyService {
  private readonly targetRateLimiter: TargetRateLimiterPort;

  constructor(
    private readonly store: NotifyStore,
    private readonly options: NotifyServiceOptions = { fanoutEnabled: true },
    private readonly deps?: NotifyServiceDeps,
  ) {
    // Always on: unlimited verify/register is the hole, not an opt-in feature.
    this.targetRateLimiter = options.targetRateLimiter ?? new TargetRateLimiter();
  }

  get fanoutEnabled(): boolean {
    return this.options.fanoutEnabled;
  }

  /**
   * Idempotent insert, then fan out.
   *
   * When fan-out is killed, returns inserted:false without writing — consumers
   * still ack the bus message.
   */
  async create(input: CreateNotificationInput): Promise<CreateResult> {
    return withNotifySpan('notify.create', { op: 'create', kind: input.kind, sourceSubject: input.sourceSubject }, async (span) => {
      if (!this.options.fanoutEnabled) {
        span.setAttribute('intafaced.notify.fanout_enabled', false);
        return { inserted: false, notification: null, dispatch: null };
      }
      span.setAttribute('intafaced.notify.fanout_enabled', true);

      const { outOfApp = true, ...rowInput } = input;
      const result = await this.store.insert(rowInput);
      span.setAttribute('intafaced.notify.inserted', result.inserted);
      span.setAttribute('intafaced.notify.out_of_app', outOfApp);

      if (!this.deps) return { inserted: result.inserted, notification: result.notification, dispatch: null };

      // On a redelivery the insert is a no-op, so recover the row the FIRST
      // delivery wrote. Without this, a process that died after the insert and
      // before the send would never send: the retry would find nothing to fan
      // out and ack anyway. The delivery table stops the recovered row being
      // sent twice.
      const row = result.notification ?? (await this.store.findBySource(input.userId, input.sourceSubject, input.sourceIdempotencyKey));
      if (!row) return { inserted: result.inserted, notification: result.notification, dispatch: null };

      const dispatch = await this.deps.dispatcher.dispatch(row, { outOfApp });
      return { inserted: result.inserted, notification: result.notification, dispatch };
    });
  }

  list(query: ListQuery): Promise<ListResult> {
    return withNotifySpan('notify.list', { op: 'list' }, async (span) => {
      span.setAttribute('intafaced.notify.unread_only', query.unreadOnly);
      span.setAttribute('intafaced.notify.limit', query.limit);
      const result = await this.store.list(query);
      span.setAttribute('intafaced.notify.item_count', result.items.length);
      return result;
    });
  }

  unreadCount(userId: string): Promise<number> {
    return withNotifySpan('notify.unreadCount', { op: 'unreadCount' }, async (span) => {
      const count = await this.store.unreadCount(userId);
      span.setAttribute('intafaced.notify.unread_count', count);
      return count;
    });
  }

  /**
   * Mark specific notifications read. Always scoped to `userId` — foreign ids
   * are silently ignored (self-only; never leaks existence).
   */
  markRead(userId: string, ids: readonly string[]): Promise<number> {
    return withNotifySpan('notify.markRead', { op: 'markRead' }, async (span) => {
      span.setAttribute('intafaced.notify.id_count', ids.length);
      const marked = await this.store.markRead(userId, ids);
      span.setAttribute('intafaced.notify.marked', marked);
      return marked;
    });
  }

  markAllRead(userId: string): Promise<number> {
    return withNotifySpan('notify.markAllRead', { op: 'markAllRead' }, async (span) => {
      const marked = await this.store.markAllRead(userId);
      span.setAttribute('intafaced.notify.marked', marked);
      return marked;
    });
  }

  // ── channels ──────────────────────────────────────────────────────────────

  /**
   * Configured vs unprobed vs not wired.
   *
   * Exposed to the user on purpose. Someone who registered a phone number is
   * entitled to know SMS is not wired rather than wondering why nothing arrives,
   * and an operator gets the same answer from `/ready` without reading code.
   * URL+token is `configured` + `channel.unprobed`, never `available`.
   */
  channelStatus(): readonly ChannelStatus[] {
    return this.deps?.channels.status() ?? [];
  }

  listTargets(userId: string): Promise<ChannelTarget[]> {
    return withNotifySpan('notify.listTargets', { op: 'listTargets' }, async () => (this.deps ? this.deps.targets.list(userId) : []));
  }

  /**
   * Register an address and send its confirmation code THROUGH THE CHANNEL
   * BEING REGISTERED.
   *
   * That is the design rather than a convenience: proving the address belongs to
   * this user and proving the channel actually works are the same test. If the
   * gateway has no credentials the address is still recorded and the refusal
   * code is returned — the address simply stays unconfirmed and nothing will
   * ever be sent to it. There is no path here that reports success without a
   * transport having accepted something.
   */
  async registerTarget(input: { userId: string; channel: OutOfAppChannel; address: string; locale: string }): Promise<RegisterOutcome> {
    return withNotifySpan('notify.registerTarget', { op: 'registerTarget' }, async (span) => {
      span.setAttribute('intafaced.notify.channel', input.channel);
      if (!this.deps) throw new Error('svc-notify was constructed without channel dependencies');

      const ttlMinutes = publishedVerifyTtlMinutes(this.options.verifyTtlMinutes);
      const pepper = publishedVerifyCodePepper(this.options.verifyCodePepper);
      const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

      // Rate limit BEFORE upsert/send so a flood neither rotates the code nor
      // bills the gateway. Named code — not a silent drop.
      if (!(await this.targetRateLimiter.tryTake(input.userId, input.channel, 'register'))) {
        span.setAttribute('intafaced.notify.rate_limited', true);
        return {
          status: 'refused',
          channel: input.channel,
          code: 'channel.register_rate_limited',
          expiresAt,
        };
      }

      const locale = normaliseLocale(input.locale);
      const code = newCode();

      await this.deps.targets.upsert({
        userId: input.userId,
        channel: input.channel,
        address: input.address,
        locale,
        verifyTokenHash: hashCode(code, pepper),
        verifyExpiresAt: expiresAt,
      });

      const copy = renderVerification(locale, code, ttlMinutes);
      const adapter = this.deps.channels.get(input.channel);

      try {
        await adapter.deliver({
          // Deliberately NOT an inbox row: a code readable by anyone already
          // holding the session would defeat the point of confirming a new
          // address.
          notificationId: `verify:${input.userId}:${input.channel}`,
          userId: input.userId,
          channel: input.channel,
          kind: 'notify.channel.verify',
          severity: 'action',
          titleKey: 'notify.channel.verify.title',
          bodyKey: 'notify.channel.verify.body',
          title: copy.title,
          body: copy.body,
          href: null,
          locale,
          address: input.address,
          idempotencyKey: `verify:${input.userId}:${input.channel}:${expiresAt.getTime()}`,
        });
        span.setAttribute('intafaced.notify.verify_sent', true);
        return { status: 'sent', channel: input.channel, expiresAt };
      } catch (err) {
        span.setAttribute('intafaced.notify.verify_sent', false);
        if (err instanceof ChannelRefusal) return { status: 'refused', channel: input.channel, code: err.code, expiresAt };
        return { status: 'failed', channel: input.channel, detail: err instanceof Error ? err.message : String(err), expiresAt };
      }
    });
  }

  /**
   * Confirm an address. Wrong, expired and already-spent codes are all
   * `rejected`. Rate limit is `refused` with a named code so a client can tell
   * "try later" from "wrong code" without learning whether a code exists.
   */
  async verifyTarget(userId: string, channel: OutOfAppChannel, code: string): Promise<VerifyOutcome> {
    return withNotifySpan('notify.verifyTarget', { op: 'verifyTarget' }, async (span) => {
      span.setAttribute('intafaced.notify.channel', channel);
      if (!this.deps) return { status: 'rejected' };

      const pepper = publishedVerifyCodePepper(this.options.verifyCodePepper);
      if (!(await this.targetRateLimiter.tryTake(userId, channel, 'verify'))) {
        span.setAttribute('intafaced.notify.rate_limited', true);
        return { status: 'refused', code: 'channel.verify_rate_limited' };
      }

      const verified = await this.deps.targets.markVerified(userId, channel, hashCode(code, pepper), new Date());
      span.setAttribute('intafaced.notify.verified', verified);
      return verified ? { status: 'verified' } : { status: 'rejected' };
    });
  }

  removeTarget(userId: string, channel: OutOfAppChannel): Promise<boolean> {
    return withNotifySpan('notify.removeTarget', { op: 'removeTarget' }, async () =>
      this.deps ? this.deps.targets.remove(userId, channel) : false,
    );
  }

  /**
   * What happened to one of the caller's own notifications, per channel.
   *
   * Scoped by loading the notification under the caller's id FIRST, so a
   * delivery record is only ever returned for a row the caller owns. An id
   * belonging to somebody else returns an empty list rather than an error that
   * would confirm it exists.
   */
  async deliveriesFor(userId: string, notificationId: string): Promise<DeliveryRecord[]> {
    return withNotifySpan('notify.deliveries', { op: 'deliveries' }, async () => {
      if (!this.deps) return [];
      const own = await this.store.findById(userId, notificationId);
      if (!own) return [];
      return this.deps.deliveries.listForNotification(notificationId);
    });
  }

  /**
   * Operator delivery-outcomes view — D26-P1-O5 residual after #1701.
   *
   * Cross-user, newest-first. Router gates with `admin:read`. Does not invent
   * delivered status: `accepted` is gateway acceptance, not end-device proof.
   * Page size is owner-published — omit is not 50.
   */
  async operatorDeliveryOutcomes(limit?: number, status?: DeliveryRecord['status']): Promise<DeliveryRecord[]> {
    const cap = assertOperatorDeliveriesLimit(limit);
    return withNotifySpan('notify.operatorDeliveries', { op: 'operatorDeliveries' }, async () => {
      if (!this.deps) return [];
      return this.deps.deliveries.listRecent(cap, status);
    });
  }

  /**
   * Counts of every delivery row. Refuses when the store is unwired rather than
   * returning a zero that could be read as "nothing was sent".
   */
  async operatorDeliveryAggregates(): Promise<{
    asOf: string;
    total: number;
    byStatus: Record<DeliveryRecord['status'], number>;
    byChannel: Record<string, number>;
  }> {
    if (!this.deps) {
      throw new Error('notify.delivery_store_unconfigured: delivery rows are not wired, so no aggregate is returned');
    }
    const counts = await this.deps.deliveries.aggregate();
    return { asOf: new Date().toISOString(), ...counts };
  }

  // ── Preferences (mute) ─────────────────────────────────────────────────────

  async getMutePrefs(userId: string): Promise<ChannelMutePrefs> {
    if (!this.deps?.muteStore) return { muted: new Set() };
    return this.deps.muteStore.get(userId);
  }

  async setChannelMute(userId: string, channel: MuteableChannel, muted: boolean): Promise<ChannelMutePrefs> {
    const store = this.deps?.muteStore;
    if (!store) {
      // Process without mute store still applies pure toggle ephemerally? Refuse — no sink.
      throw new Error('Mute preferences store is not configured');
    }
    return store.setMuted(userId, channel, muted);
  }

  async listMutePrefs(userId: string): Promise<{ channel: MuteableChannel; muted: boolean }[]> {
    const prefs = await this.getMutePrefs(userId);
    return (['email', 'push', 'sms'] as const).map((channel) => ({
      channel,
      muted: prefs.muted.has(channel),
    }));
  }

  get account(): AccountPrefs | null {
    return this.deps?.account ?? null;
  }

  get holds(): HoldStore | null {
    return this.deps?.holds ?? null;
  }

  get notices(): NoticeBoard | null {
    return this.deps?.notices ?? null;
  }

  get channelSettings(): ChannelSettings | null {
    return this.deps?.channelSettings ?? null;
  }

  get templates(): MessageTemplates | null {
    return this.deps?.templates ?? null;
  }

  /**
   * The caller's finished deliveries, newest first.
   * Limit above {@link RECENT_DELIVERIES_LIMIT_MAX} is clamped. Pending rows
   * are not on the page. Counts are for this page only.
   */
  async recentDeliveries(userId: string, limit: number, cursor: string | null) {
    const cap = clampRecentDeliveriesLimit(limit);
    const empty = { rows: [], counts: { sent: 0, refused: 0, failed: 0 }, nextCursor: null as string | null };
    if (!this.deps) return empty;
    const beforeId = cursor ? decodeRecentCursor(cursor) : null;
    let fetched;
    try {
      fetched = await this.deps.deliveries.listOwnedRecent({
        userId,
        limit: cap + 1,
        beforeId,
        belongsTo: async (notificationId) => (await this.store.findById(userId, notificationId)) !== null,
      });
    } catch (err) {
      if (err instanceof OwnedRecentCursorError) throw new RecentDeliveriesError('notify.recent_deliveries_cursor_invalid');
      throw err;
    }
    const page = fetched.slice(0, cap);
    const rows = page.flatMap((row) => {
      const wire = recentDeliveryWire(row);
      return wire ? [wire] : [];
    });
    const last = page[page.length - 1];
    return {
      rows,
      counts: {
        sent: rows.filter((row) => row.outcome === 'sent').length,
        refused: rows.filter((row) => row.outcome === 'refused').length,
        failed: rows.filter((row) => row.outcome === 'failed').length,
      },
      nextCursor: fetched.length > cap && last ? encodeRecentCursor(last) : null,
    };
  }
}
