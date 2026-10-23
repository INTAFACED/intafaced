/**
 * Status subscriptions (SP-status-04): subscribe by email with a proof of work, confirm by a signed link, choose
 * components and a webhook, and leave by the signed link in every message. Published notices fan out to active
 * subscribers.
 *
 * Every send writes its delivery row first, keyed `<event>:<subscriber>:<channel>`, so a retry or a second fan-out of the
 * same notice reuses the row and never sends twice once a transport accepted it. With no email sender the row stays
 * pending with `vendor.email`. Nothing is sent to an unconfirmed address except its confirmation.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  statusChallengeMet,
  statusChallengeText,
  type StatusChallenge,
  type StatusSubscribeInput,
  type StatusSubscribeResult,
  type StatusSubscriberState,
  type StatusSubscription,
  type StatusSubscriptionErrorCode,
  type StatusSubscriptionPolicy,
  type StatusSubscriptionUpdateInput,
} from '@intafaced/contracts';
import type { NoticeWire } from '../notices/board.js';
import type { StatusPageBook } from './book.js';
import type { MailOutcome, StatusMailer } from './mailer.js';
import { pinnedPost, systemResolver, webhookTargetProblem, type Resolver, type WebhookPost } from './webhook.js';

const HOUR_MS = 3_600_000;
/** How long one sender holds a delivery row before another fan-out may try it: longer than any send waits. */
const DELIVERY_LEASE_MS = 120_000;
/** Storage bounds of one founder import, not owner values. */
export const STATUS_IMPORT_MAX = 500;
const EVENT_ROWS_MAX = 500;
export const STATUS_IMPORT_SOURCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

/** The contract's codes, plus the founder desk's own: a malformed import, and a resend of a notice that is not published. */
export type StatusSubscriptionCode = StatusSubscriptionErrorCode | 'status.import_invalid' | 'status.notice_unknown';

export class StatusSubscriptionError extends Error {
  constructor(readonly code: StatusSubscriptionCode) {
    super(code);
    this.name = 'StatusSubscriptionError';
  }
}

export type Subscriber = {
  readonly id: string;
  readonly email: string;
  readonly state: StatusSubscriberState;
  readonly componentIds: readonly string[] | null;
  readonly webhookUrl: string | null;
  /** Moves when the address subscribes again after leaving, so its new confirmation is a new message. */
  readonly revision: number;
  /** The founder import that added it; null for an address that subscribed on /status. */
  readonly source: string | null;
};

/** One subscriber as the founders' desk lists it, with how its deliveries stand. */
export type SubscriberSummary = Pick<Subscriber, 'id' | 'email' | 'state' | 'componentIds' | 'source'> & {
  readonly webhook: boolean;
  readonly createdAt: string;
  readonly deliveries: Readonly<Record<DeliveryStatus, number>>;
};

/** What a founder import did, address by address, after duplicates were folded into one. */
export type StatusImportResult = {
  readonly received: number;
  /** Distinct valid addresses: a duplicate in the list, in any letter case, is one. */
  readonly distinct: number;
  readonly added: number;
  readonly alreadyKnown: number;
  /** Not addresses, in the order given. */
  readonly invalid: readonly string[];
  /** Over the per-address hourly limit: stored, but no confirmation was sent this time. */
  readonly limited: number;
};

export type DeliveryStatus = 'pending' | 'accepted' | 'failed' | 'refused';
export type Delivery = {
  readonly key: string;
  readonly subscriberId: string;
  readonly event: string;
  readonly channel: 'email' | 'webhook';
  readonly status: DeliveryStatus;
  readonly refusalCode: string | null;
  readonly attempts: number;
};

export interface SubscriptionStore {
  /**
   * The subscribe step, atomically per address: a new or departed address becomes unconfirmed (a departed one at the next
   * revision) with these components; an unconfirmed one takes the new components; an active one is left as it is.
   */
  subscribe(email: string, componentIds: readonly string[] | null, at: Date): Promise<Subscriber>;
  byId(id: string): Promise<Subscriber | null>;
  byEmail(email: string): Promise<Subscriber | null>;
  /** Moves the state and settings of one subscriber; returns the stored row. */
  update(id: string, change: Partial<Pick<Subscriber, 'state' | 'componentIds' | 'webhookUrl'>>, at: Date): Promise<Subscriber>;
  /** Counts this address's subscribe requests since `since`, then records this one. */
  countAndRecordRequest(email: string, since: Date, at: Date): Promise<number>;
  /** False when the challenge was already used. */
  useChallenge(tokenHash: string, at: Date, expiredBefore: Date): Promise<boolean>;
  /** Writes the row if it is not there; returns the stored row either way. */
  claimDelivery(row: Pick<Delivery, 'key' | 'subscriberId' | 'event' | 'channel'>, at: Date): Promise<Delivery>;
  /**
   * Takes an unsettled row for one send until `until`: false when it is settled or another sender holds it. Settling
   * the row lets it go.
   */
  takeDelivery(key: string, at: Date, until: Date): Promise<boolean>;
  /** Records a send's result. With `lease`, only while that lease is still the row's: a sender that lost it records nothing. */
  settleDelivery(key: string, status: DeliveryStatus, refusalCode: string | null, at: Date, lease?: Date): Promise<void>;
  deliveries(subscriberId: string): Promise<readonly Delivery[]>;
  /** The rows of one event, each with its subscriber's address, ordered by address then channel. */
  eventDeliveries(event: string, limit: number): Promise<readonly (Delivery & { readonly email: string })[]>;
  /** The rows of one event still to be sent (pending or failed), each with its subscriber. */
  unsettledDeliveries(event: string): Promise<readonly Delivery[]>;
  /** Subscribers newest first, in one state or all, with their delivery counts. */
  list(state: StatusSubscriberState | null, limit: number): Promise<readonly SubscriberSummary[]>;
  /** An imported address: added as unconfirmed with its source when unknown; a known address is left as it is. */
  importSubscriber(email: string, source: string, at: Date): Promise<{ readonly subscriber: Subscriber; readonly added: boolean }>;
  /** Active subscribers, for a fan-out. */
  active(): Promise<readonly Subscriber[]>;
}

export type SubscriptionDeps = {
  readonly store: SubscriptionStore;
  readonly page: StatusPageBook;
  readonly mailer: StatusMailer;
  /** HMAC key for links and challenges. Blank: subscribing refuses (`status.challenge_unset`), no link can be made. */
  readonly secret: string | null;
  /** Minutes a challenge and a confirmation link stay valid (NOTIFY_VERIFY_TTL_MINUTES). Blank: subscribing refuses. */
  readonly linkTtlMinutes: number | null;
  readonly webhookTimeoutMs: number;
  readonly resolve?: Resolver;
  /** How a webhook is called; the default resolves once and connects only to the checked address. */
  readonly post?: WebhookPost;
  readonly now?: () => Date;
};

type Purpose = 'confirm' | 'manage' | 'challenge';

const b64 = (buf: Buffer) => buf.toString('base64url');
const maskEmail = (email: string) => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
};

export class StatusSubscriptions {
  private readonly now: () => Date;
  private readonly resolve: Resolver;
  private readonly post: WebhookPost;

  constructor(private readonly deps: SubscriptionDeps) {
    this.now = deps.now ?? (() => new Date());
    this.resolve = deps.resolve ?? systemResolver;
    this.post = deps.post ?? pinnedPost(this.resolve);
  }

  private sign(body: string): string {
    return b64(createHmac('sha256', this.deps.secret!).update(`status:${body}`).digest());
  }

  private token(purpose: Purpose, id: string, revision: number, expiresMs: number): string {
    const body = `${purpose}.${id}.${revision}.${expiresMs}`;
    return `${body}.${this.sign(body)}`;
  }

  /** The parts of a token this service signed for `purpose` that has not expired, else null. */
  private read(token: string, purpose: Purpose): { id: string; revision: number } | null {
    if (!this.deps.secret) return null;
    const parts = token.split('.');
    if (parts.length !== 5 || parts[0] !== purpose) return null;
    const body = parts.slice(0, 4).join('.');
    const given = Buffer.from(parts[4]!, 'base64url');
    const want = Buffer.from(this.sign(body), 'base64url');
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    const expires = Number(parts[3]);
    if (!Number.isSafeInteger(expires) || (expires !== 0 && expires < this.now().getTime())) return null;
    return { id: parts[1]!, revision: Number(parts[2]) };
  }

  private ttlMs(): number | null {
    return this.deps.linkTtlMinutes === null ? null : this.deps.linkTtlMinutes * 60_000;
  }

  /** How each channel leaves this deployment: the founders' desk names the code of a channel with no sender. */
  channels(): { email: { sender: StatusMailer['kind']; notConnected: 'vendor.email' | null }; sms: 'vendor.sms'; push: 'vendor.push' } {
    return {
      email: { sender: this.deps.mailer.kind, notConnected: this.deps.mailer.notConnected },
      sms: 'vendor.sms',
      push: 'vendor.push',
    };
  }

  async list(input: { state: StatusSubscriberState | null; limit: number }): Promise<readonly SubscriberSummary[]> {
    return this.deps.store.list(input.state, Math.min(Math.max(1, input.limit), 200));
  }

  /** One event's rows, at most `EVENT_ROWS_MAX`; `more` says the event has rows beyond them. */
  async eventDeliveries(event: string): Promise<{ rows: readonly (Delivery & { readonly email: string })[]; more: boolean }> {
    const rows = await this.deps.store.eventDeliveries(event, EVENT_ROWS_MAX + 1);
    return { rows: rows.slice(0, EVENT_ROWS_MAX), more: rows.length > EVENT_ROWS_MAX };
  }

  /**
   * Founders add addresses from another list. Each new one is unconfirmed until its own link is opened and gets one
   * confirmation; a known address is left as it is, so importing the same list again sends nothing. A blank proof of
   * work or rate limit refuses the import (`status.challenge_unset`, `status.rate_limit_unset`), as it refuses subscribing.
   */
  async importSubscribers(input: { source: string; emails: readonly string[] }): Promise<StatusImportResult> {
    if (!STATUS_IMPORT_SOURCE_PATTERN.test(input.source) || input.emails.length === 0 || input.emails.length > STATUS_IMPORT_MAX)
      throw new StatusSubscriptionError('status.import_invalid');
    const definition = await this.deps.page.definition();
    // Both safeguards blank-refuse an import as they refuse subscribing on /status.
    if (definition.challengeBits === null || !this.deps.secret || this.ttlMs() === null)
      throw new StatusSubscriptionError('status.challenge_unset');
    if (definition.subscribeRatePerHour === null) throw new StatusSubscriptionError('status.rate_limit_unset');
    const invalid: string[] = [];
    const distinct = new Set<string>();
    for (const raw of input.emails) {
      const email = raw.trim().toLowerCase();
      if (email.length > 254 || !EMAIL_PATTERN.test(email)) invalid.push(raw);
      else distinct.add(email);
    }
    let added = 0;
    let limited = 0;
    for (const email of distinct) {
      const at = this.now();
      const stored = await this.deps.store.importSubscriber(email, input.source, at);
      // A known address is left as it is: no confirmation it did not ask for, and its hourly budget untouched.
      if (!stored.added) continue;
      added += 1;
      const recent = await this.deps.store.countAndRecordRequest(email, new Date(at.getTime() - HOUR_MS), at);
      if (recent >= definition.subscribeRatePerHour) {
        limited += 1;
        continue;
      }
      await this.sendConfirmation(stored.subscriber, `import.${input.source}.r${stored.subscriber.revision}`, at);
    }
    return { received: input.emails.length, distinct: distinct.size, added, alreadyKnown: distinct.size - added, invalid, limited };
  }

  private async sendConfirmation(subscriber: Subscriber, event: string, at: Date): Promise<void> {
    const link = `${this.deps.mailer.origin}/status/confirm?token=${encodeURIComponent(
      this.token('confirm', subscriber.id, subscriber.revision, at.getTime() + this.ttlMs()!),
    )}`;
    await this.deliverEmail(subscriber, event, {
      subject: 'Confirm your status updates',
      text: `Open this link to start getting status updates: ${link}\nNothing is sent to you until you do. If you did not ask for this, ignore this message.`,
    });
  }

  async policy(): Promise<StatusSubscriptionPolicy> {
    const definition = await this.deps.page.definition();
    return {
      email: this.deps.mailer.notConnected,
      sms: 'vendor.sms',
      push: 'vendor.push',
      challengeBits: this.deps.secret && this.ttlMs() ? definition.challengeBits : null,
      rateLimitSet: definition.subscribeRatePerHour !== null,
    };
  }

  async challenge(): Promise<StatusChallenge> {
    const { challengeBits } = await this.deps.page.definition();
    const ttl = this.ttlMs();
    if (challengeBits === null || !this.deps.secret || ttl === null) throw new StatusSubscriptionError('status.challenge_unset');
    return { token: this.token('challenge', b64(randomBytes(12)), challengeBits, this.now().getTime() + ttl), bits: challengeBits };
  }

  async subscribe(raw: StatusSubscribeInput): Promise<StatusSubscribeResult> {
    const input = { ...raw, email: raw.email.trim().toLowerCase() };
    const at = this.now();
    const definition = await this.deps.page.definition();
    if (definition.challengeBits === null || !this.deps.secret || this.ttlMs() === null)
      throw new StatusSubscriptionError('status.challenge_unset');
    if (definition.subscribeRatePerHour === null) throw new StatusSubscriptionError('status.rate_limit_unset');
    // The challenge first: a request that fails it stores nothing, not even a rate-limit count.
    const challenge = this.read(input.challenge.token, 'challenge');
    if (!challenge || challenge.revision < definition.challengeBits) throw new StatusSubscriptionError('status.challenge_failed');
    const digest = createHash('sha256').update(statusChallengeText(input.challenge.token, input.challenge.nonce)).digest();
    if (!statusChallengeMet(digest, challenge.revision)) throw new StatusSubscriptionError('status.challenge_failed');
    const known = new Set(definition.components.map((c) => c.id));
    if (input.componentIds?.some((id) => !known.has(id))) throw new StatusSubscriptionError('status.component_unknown');
    const spent = createHash('sha256').update(input.challenge.token).digest('hex');
    if (!(await this.deps.store.useChallenge(spent, at, new Date(at.getTime() - this.ttlMs()!))))
      throw new StatusSubscriptionError('status.challenge_failed');
    const recent = await this.deps.store.countAndRecordRequest(input.email, new Date(at.getTime() - HOUR_MS), at);
    if (recent >= definition.subscribeRatePerHour) throw new StatusSubscriptionError('status.rate_limited');
    const subscriber = await this.deps.store.subscribe(input.email, input.componentIds ? [...new Set(input.componentIds)] : null, at);
    // The answer depends only on whether a sender is connected, never on the address, so the form cannot look one up.
    const answer: StatusSubscribeResult = this.deps.mailer.notConnected
      ? { state: 'confirmation_pending', notConnected: this.deps.mailer.notConnected }
      : { state: 'confirmation_sent', notConnected: null };
    if (subscriber.state === 'active') return answer;
    // One confirmation per request (the rate limit bounds them), so asking again after a link expired sends a fresh one.
    await this.sendConfirmation(subscriber, `confirm.r${subscriber.revision}.${at.getTime()}`, at);
    return answer;
  }

  /** Opening the link again is the same answer: one active subscriber. */
  async confirm(token: string): Promise<StatusSubscription & { manageToken: string }> {
    const link = this.read(token, 'confirm');
    const subscriber = link ? await this.deps.store.byId(link.id) : null;
    if (!link || !subscriber || subscriber.revision !== link.revision || subscriber.state === 'unsubscribed')
      throw new StatusSubscriptionError('status.subscription_link_invalid');
    const stored =
      subscriber.state === 'active' ? subscriber : await this.deps.store.update(subscriber.id, { state: 'active' }, this.now());
    return { ...this.view(stored), manageToken: this.manageToken(stored) };
  }

  /** The link in every message after confirmation: it never expires, so an old message can still be used to leave. */
  manageToken(subscriber: Pick<Subscriber, 'id' | 'revision'>): string {
    // Tied to the revision: leaving and subscribing again voids every link from the earlier subscription.
    return this.token('manage', subscriber.id, subscriber.revision, 0);
  }

  private async managed(token: string): Promise<Subscriber> {
    const link = this.read(token, 'manage');
    const subscriber = link ? await this.deps.store.byId(link.id) : null;
    if (!link || !subscriber || subscriber.revision !== link.revision)
      throw new StatusSubscriptionError('status.subscription_link_invalid');
    return subscriber;
  }

  async subscription(token: string): Promise<StatusSubscription> {
    return this.view(await this.managed(token));
  }

  async updateSubscription(input: StatusSubscriptionUpdateInput): Promise<StatusSubscription> {
    const subscriber = await this.managed(input.token);
    if (subscriber.state !== 'active') throw new StatusSubscriptionError('status.subscriber_unknown');
    const known = new Set((await this.deps.page.definition()).components.map((c) => c.id));
    if (input.componentIds?.some((id) => !known.has(id))) throw new StatusSubscriptionError('status.component_unknown');
    if (input.webhookUrl !== null && (await webhookTargetProblem(input.webhookUrl, this.resolve)) !== null)
      throw new StatusSubscriptionError('status.webhook_target_refused');
    const stored = await this.deps.store.update(
      subscriber.id,
      { componentIds: input.componentIds ? [...new Set(input.componentIds)] : null, webhookUrl: input.webhookUrl },
      this.now(),
    );
    return this.view(stored);
  }

  async unsubscribe(token: string): Promise<StatusSubscription> {
    const subscriber = await this.managed(token);
    const stored =
      subscriber.state === 'unsubscribed' ? subscriber : await this.deps.store.update(subscriber.id, { state: 'unsubscribed' }, this.now());
    return this.view(stored);
  }

  private view(subscriber: Subscriber): StatusSubscription {
    return {
      state: subscriber.state,
      email: maskEmail(subscriber.email),
      componentIds: subscriber.componentIds ? [...subscriber.componentIds] : null,
      webhookUrl: subscriber.webhookUrl,
    };
  }

  /** Founders: the record for one address, or null. */
  async find(email: string): Promise<(StatusSubscription & { deliveries: readonly Delivery[] }) | null> {
    const subscriber = await this.deps.store.byEmail(email.trim().toLowerCase());
    if (!subscriber) return null;
    return { ...this.view(subscriber), email: subscriber.email, deliveries: await this.deps.store.deliveries(subscriber.id) };
  }

  /**
   * A published notice to every active subscriber it concerns: one whose choice is every component, or names a component
   * the notice names; a notice naming no component goes to all. Email always, the webhook when one is set.
   */
  async fanOut(notice: Pick<NoticeWire, 'id' | 'kind' | 'title' | 'body'> & { components: readonly string[] }): Promise<void> {
    if (notice.kind === 'changelog') return;
    for (const subscriber of await this.deps.store.active()) {
      const chosen = subscriber.componentIds;
      if (chosen !== null && notice.components.length > 0 && !notice.components.some((c) => chosen.includes(c))) continue;
      await this.deliverEmail(subscriber, notice.id, this.updateMail(subscriber, notice));
      if (subscriber.webhookUrl) await this.deliverWebhook(subscriber, notice);
    }
  }

  /**
   * A maintenance reminder (SP-status-03): one email per active subscriber the window concerns, keyed by the window and
   * the offset, so a reminder sent again after a crash reaches no one twice.
   */
  async remind(
    notice: Pick<NoticeWire, 'id' | 'title'> & { startsAt: Date | null; components: readonly string[] },
    offsetMinutes: number,
  ): Promise<void> {
    const event = `${notice.id}:reminder:${offsetMinutes}`;
    for (const subscriber of await this.deps.store.active()) {
      const chosen = subscriber.componentIds;
      if (chosen !== null && notice.components.length > 0 && !notice.components.some((c) => chosen.includes(c))) continue;
      const token = encodeURIComponent(this.manageToken(subscriber));
      await this.deliverEmail(subscriber, event, {
        subject: `Scheduled maintenance: ${notice.title}`,
        text: `${notice.title}\n\nScheduled to start at ${notice.startsAt?.toISOString() ?? 'a time not set'} (UTC).\n\nChoose what you get: ${this.deps.mailer.origin}/status/manage?token=${token}\nStop these updates: ${this.deps.mailer.origin}/status/unsubscribe?token=${token}`,
      });
    }
  }

  private updateMail(subscriber: Subscriber, notice: Pick<NoticeWire, 'title' | 'body'>): { subject: string; text: string } {
    const token = encodeURIComponent(this.manageToken(subscriber));
    return {
      subject: `Status update: ${notice.title}`,
      text: `${notice.title}\n\n${notice.body}\n\nChoose what you get: ${this.deps.mailer.origin}/status/manage?token=${token}\nStop these updates: ${this.deps.mailer.origin}/status/unsubscribe?token=${token}`,
    };
  }

  /**
   * A founder's "send again" for one published notice: only its rows still pending or failed are tried once more, for
   * subscribers still active. No row is made for anyone the notice did not reach when it was published.
   */
  async retry(notice: Pick<NoticeWire, 'id' | 'kind' | 'title' | 'body'>): Promise<void> {
    for (const row of await this.deps.store.unsettledDeliveries(notice.id)) {
      const subscriber = await this.deps.store.byId(row.subscriberId);
      if (!subscriber || subscriber.state !== 'active') continue;
      if (row.channel === 'email') await this.deliverEmail(subscriber, notice.id, this.updateMail(subscriber, notice));
      else if (subscriber.webhookUrl) await this.deliverWebhook(subscriber, notice);
    }
  }

  private async deliverEmail(subscriber: Subscriber, event: string, mail: { subject: string; text: string }): Promise<MailOutcome | null> {
    const key = `${event}:${subscriber.id}:email`;
    const at = this.now();
    const row = await this.deps.store.claimDelivery({ key, subscriberId: subscriber.id, event, channel: 'email' }, at);
    if (row.status === 'accepted' || row.status === 'refused') return null;
    // Another fan-out of the same event is sending this row now: it settles it.
    const lease = new Date(at.getTime() + DELIVERY_LEASE_MS);
    if (!(await this.deps.store.takeDelivery(key, at, lease))) return null;
    let outcome: MailOutcome;
    try {
      outcome = await this.deps.mailer.send({ to: subscriber.email, ...mail, key });
    } catch {
      // A transport that throws is a failed send of this row, never a stop for the subscribers after it.
      outcome = { status: 'failed' };
    }
    if (outcome.status === 'accepted') await this.deps.store.settleDelivery(key, 'accepted', null, this.now(), lease);
    // No sender is not a refusal of this message: it waits, pending, with the code that says why.
    else if (outcome.status === 'refused')
      await this.deps.store.settleDelivery(key, outcome.code === 'vendor.email' ? 'pending' : 'refused', outcome.code, this.now(), lease);
    else await this.deps.store.settleDelivery(key, 'failed', null, this.now(), lease);
    return outcome;
  }

  private async deliverWebhook(subscriber: Subscriber, notice: Pick<NoticeWire, 'id' | 'kind' | 'title' | 'body'>): Promise<void> {
    const key = `${notice.id}:${subscriber.id}:webhook`;
    const at = this.now();
    const row = await this.deps.store.claimDelivery({ key, subscriberId: subscriber.id, event: notice.id, channel: 'webhook' }, at);
    if (row.status === 'accepted' || row.status === 'refused') return;
    const lease = new Date(at.getTime() + DELIVERY_LEASE_MS);
    if (!(await this.deps.store.takeDelivery(key, at, lease))) return;
    // The address is checked again at send time: a name can resolve somewhere else since it was stored.
    if ((await webhookTargetProblem(subscriber.webhookUrl!, this.resolve)) !== null) {
      await this.deps.store.settleDelivery(key, 'refused', 'status.webhook_target_refused', this.now(), lease);
      return;
    }
    try {
      const res = await this.post(
        subscriber.webhookUrl!,
        JSON.stringify({ id: notice.id, kind: notice.kind, title: notice.title, body: notice.body }),
        { 'content-type': 'application/json', 'idempotency-key': key },
        this.deps.webhookTimeoutMs,
      );
      await this.deps.store.settleDelivery(key, res.ok ? 'accepted' : 'failed', null, this.now(), lease);
    } catch {
      await this.deps.store.settleDelivery(key, 'failed', null, this.now(), lease);
    }
  }
}

export class MemorySubscriptionStore implements SubscriptionStore {
  private readonly rows = new Map<string, Subscriber>();
  private readonly created = new Map<string, Date>();
  private readonly leases = new Map<string, number>();
  private readonly requests: { email: string; at: number }[] = [];
  private readonly used = new Set<string>();
  readonly sent = new Map<string, Delivery>();

  async subscribe(email: string, componentIds: readonly string[] | null): Promise<Subscriber> {
    const existing = [...this.rows.values()].find((row) => row.email === email);
    let next: Subscriber;
    if (!existing) {
      next = { id: randomUUID(), email, state: 'unconfirmed', componentIds, webhookUrl: null, revision: 1, source: null };
      this.created.set(next.id, new Date());
    } else if (existing.state === 'unsubscribed')
      next = { ...existing, state: 'unconfirmed', componentIds, webhookUrl: null, revision: existing.revision + 1 };
    else if (existing.state === 'unconfirmed') next = { ...existing, componentIds };
    else next = existing;
    this.rows.set(next.id, next);
    return next;
  }
  async byId(id: string) {
    return this.rows.get(id) ?? null;
  }
  async byEmail(email: string) {
    return [...this.rows.values()].find((row) => row.email === email) ?? null;
  }
  async update(id: string, change: Partial<Pick<Subscriber, 'state' | 'componentIds' | 'webhookUrl'>>) {
    const next = { ...this.rows.get(id)!, ...change };
    this.rows.set(id, next);
    return next;
  }
  async countAndRecordRequest(email: string, since: Date, at: Date) {
    const count = this.requests.filter((r) => r.email === email && r.at >= since.getTime()).length;
    this.requests.push({ email, at: at.getTime() });
    for (let i = this.requests.length - 1; i >= 0; i -= 1) if (this.requests[i]!.at < since.getTime()) this.requests.splice(i, 1);
    return count;
  }
  async useChallenge(tokenHash: string) {
    if (this.used.has(tokenHash)) return false;
    this.used.add(tokenHash);
    return true;
  }
  async claimDelivery(row: Pick<Delivery, 'key' | 'subscriberId' | 'event' | 'channel'>) {
    const existing = this.sent.get(row.key);
    if (existing) return existing;
    const fresh: Delivery = { ...row, status: 'pending', refusalCode: null, attempts: 0 };
    this.sent.set(row.key, fresh);
    return fresh;
  }
  async takeDelivery(key: string, at: Date, until: Date) {
    const row = this.sent.get(key);
    if (!row || row.status === 'accepted' || row.status === 'refused') return false;
    if ((this.leases.get(key) ?? 0) > at.getTime()) return false;
    this.leases.set(key, until.getTime());
    return true;
  }
  async settleDelivery(key: string, status: DeliveryStatus, refusalCode: string | null, _at?: Date, lease?: Date) {
    const row = this.sent.get(key)!;
    if (lease !== undefined && this.leases.get(key) !== lease.getTime()) return;
    this.leases.delete(key);
    if (row.status === 'accepted' || row.status === 'refused') return;
    this.sent.set(key, { ...row, status, refusalCode, attempts: row.attempts + 1 });
  }
  async deliveries(subscriberId: string) {
    return [...this.sent.values()].filter((row) => row.subscriberId === subscriberId);
  }
  async active() {
    return [...this.rows.values()].filter((row) => row.state === 'active');
  }
  async unsettledDeliveries(event: string) {
    return [...this.sent.values()].filter((row) => row.event === event && (row.status === 'pending' || row.status === 'failed'));
  }
  async eventDeliveries(event: string, limit: number) {
    return [...this.sent.values()]
      .filter((row) => row.event === event)
      .map((row) => ({ ...row, email: this.rows.get(row.subscriberId)!.email }))
      .sort((a, b) => a.email.localeCompare(b.email) || a.channel.localeCompare(b.channel))
      .slice(0, limit);
  }
  async list(state: StatusSubscriberState | null, limit: number) {
    return [...this.rows.values()]
      .filter((row) => state === null || row.state === state)
      .sort((a, b) => this.created.get(b.id)!.getTime() - this.created.get(a.id)!.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((row): SubscriberSummary => {
        const deliveries = { pending: 0, accepted: 0, failed: 0, refused: 0 };
        for (const d of this.sent.values()) if (d.subscriberId === row.id) deliveries[d.status] += 1;
        return {
          id: row.id,
          email: row.email,
          state: row.state,
          componentIds: row.componentIds,
          source: row.source,
          webhook: row.webhookUrl !== null,
          createdAt: this.created.get(row.id)!.toISOString(),
          deliveries,
        };
      });
  }
  async importSubscriber(email: string, source: string, at: Date) {
    const existing = await this.byEmail(email);
    if (existing) return { subscriber: existing, added: false };
    const subscriber: Subscriber = {
      id: randomUUID(),
      email,
      state: 'unconfirmed',
      componentIds: null,
      webhookUrl: null,
      revision: 1,
      source,
    };
    this.rows.set(subscriber.id, subscriber);
    this.created.set(subscriber.id, at);
    return { subscriber, added: true };
  }
}
