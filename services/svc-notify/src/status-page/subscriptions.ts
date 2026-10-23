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

export class StatusSubscriptionError extends Error {
  constructor(readonly code: StatusSubscriptionErrorCode) {
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
  settleDelivery(key: string, status: DeliveryStatus, refusalCode: string | null, at: Date): Promise<void>;
  deliveries(subscriberId: string): Promise<readonly Delivery[]>;
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
    const link = `${this.deps.mailer.origin}/status/confirm?token=${encodeURIComponent(
      this.token('confirm', subscriber.id, subscriber.revision, at.getTime() + this.ttlMs()!),
    )}`;
    // One confirmation per request (the rate limit bounds them), so asking again after a link expired sends a fresh one.
    await this.deliverEmail(subscriber, `confirm.r${subscriber.revision}.${at.getTime()}`, {
      subject: 'Confirm your status updates',
      text: `Open this link to start getting status updates: ${link}\nNothing is sent to you until you do. If you did not ask for this, ignore this message.`,
    });
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
      const token = encodeURIComponent(this.manageToken(subscriber));
      await this.deliverEmail(subscriber, notice.id, {
        subject: `Status update: ${notice.title}`,
        text: `${notice.title}\n\n${notice.body}\n\nChoose what you get: ${this.deps.mailer.origin}/status/manage?token=${token}\nStop these updates: ${this.deps.mailer.origin}/status/unsubscribe?token=${token}`,
      });
      if (subscriber.webhookUrl) await this.deliverWebhook(subscriber, notice);
    }
  }

  private async deliverEmail(subscriber: Subscriber, event: string, mail: { subject: string; text: string }): Promise<MailOutcome | null> {
    const key = `${event}:${subscriber.id}:email`;
    const at = this.now();
    const row = await this.deps.store.claimDelivery({ key, subscriberId: subscriber.id, event, channel: 'email' }, at);
    if (row.status === 'accepted' || row.status === 'refused') return null;
    const outcome = await this.deps.mailer.send({ to: subscriber.email, ...mail, key });
    if (outcome.status === 'accepted') await this.deps.store.settleDelivery(key, 'accepted', null, this.now());
    // No sender is not a refusal of this message: it waits, pending, with the code that says why.
    else if (outcome.status === 'refused')
      await this.deps.store.settleDelivery(key, outcome.code === 'vendor.email' ? 'pending' : 'refused', outcome.code, this.now());
    else await this.deps.store.settleDelivery(key, 'failed', null, this.now());
    return outcome;
  }

  private async deliverWebhook(subscriber: Subscriber, notice: Pick<NoticeWire, 'id' | 'kind' | 'title' | 'body'>): Promise<void> {
    const key = `${notice.id}:${subscriber.id}:webhook`;
    const row = await this.deps.store.claimDelivery({ key, subscriberId: subscriber.id, event: notice.id, channel: 'webhook' }, this.now());
    if (row.status === 'accepted' || row.status === 'refused') return;
    // The address is checked again at send time: a name can resolve somewhere else since it was stored.
    if ((await webhookTargetProblem(subscriber.webhookUrl!, this.resolve)) !== null) {
      await this.deps.store.settleDelivery(key, 'refused', 'status.webhook_target_refused', this.now());
      return;
    }
    try {
      const res = await this.post(
        subscriber.webhookUrl!,
        JSON.stringify({ id: notice.id, kind: notice.kind, title: notice.title, body: notice.body }),
        { 'content-type': 'application/json', 'idempotency-key': key },
        this.deps.webhookTimeoutMs,
      );
      await this.deps.store.settleDelivery(key, res.ok ? 'accepted' : 'failed', null, this.now());
    } catch {
      await this.deps.store.settleDelivery(key, 'failed', null, this.now());
    }
  }
}

export class MemorySubscriptionStore implements SubscriptionStore {
  private readonly rows = new Map<string, Subscriber>();
  private readonly requests: { email: string; at: number }[] = [];
  private readonly used = new Set<string>();
  readonly sent = new Map<string, Delivery>();

  async subscribe(email: string, componentIds: readonly string[] | null): Promise<Subscriber> {
    const existing = [...this.rows.values()].find((row) => row.email === email);
    let next: Subscriber;
    if (!existing) next = { id: randomUUID(), email, state: 'unconfirmed', componentIds, webhookUrl: null, revision: 1 };
    else if (existing.state === 'unsubscribed')
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
  async settleDelivery(key: string, status: DeliveryStatus, refusalCode: string | null) {
    const row = this.sent.get(key)!;
    if (row.status === 'accepted' || row.status === 'refused') return;
    this.sent.set(key, { ...row, status, refusalCode, attempts: row.attempts + 1 });
  }
  async deliveries(subscriberId: string) {
    return [...this.sent.values()].filter((row) => row.subscriberId === subscriberId);
  }
  async active() {
    return [...this.rows.values()].filter((row) => row.state === 'active');
  }
}
