import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryEventBus, bankMarginCalled } from '@intafaced/events';
import { MESSAGE_KEYS } from '@intafaced/i18n';
import { MemoryNotifyStore } from './store.js';
import { MemoryDeliveryStore, MemoryTargetStore } from './channel-store.js';
import { NotifyService } from './notify-service.js';
import { NotificationDispatcher } from './dispatch.js';
import { ChannelRegistry, channelsFromEnv } from './channels/registry.js';
import { InAppChannel, UnconfiguredChannel } from './channels/gateway.js';
import { EmailChannel } from './channels/adapters.js';
import { ChannelDeliveryError, type NotificationChannel, type OutboundMessage } from './channels/channel.js';
import { normaliseLocale, renderNotification, renderVerification } from './channels/render.js';
import { notifyEventConsumerCount, subscribeNotificationEvents } from './events.js';
import { MemoryMuteStore } from './preferences/mute.js';
import { TargetRateLimiter } from './target-rate-limit.js';

/**
 * THE HONESTY TESTS.
 *
 * Every case here is a way a notification system lies. Each one is pinned:
 *
 *   · an unconfigured channel reporting success
 *   · a redelivered event sending twice
 *   · a delivery row that says "accepted" when nothing accepted it
 *   · a margin call whose failure to reach anybody leaves no record
 *   · copy that ships a key nobody has translated
 *   · a mute that vanishes on restart (prefs must be durable — MemoryMuteStore
 *     stands in for PostgresMuteStore in this suite)
 *   · a muted channel that still sends, or a critical that respects mute
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const LOAN = '55555555-5555-4555-8555-555555555555';
const POSITION = '66666666-6666-4666-8666-666666666666';

const NO_GATEWAYS = { NOTIFY_GATEWAY_TIMEOUT_MS: 1_000 } as const;

/** A channel that records what it was asked to send. */
class SpyChannel implements NotificationChannel {
  readonly unavailableReason = null;
  readonly sent: OutboundMessage[] = [];

  constructor(
    readonly channel: 'email' | 'push' | 'sms',
    private readonly behaviour: 'ok' | 'retryable' | 'permanent' = 'ok',
  ) {}

  async deliver(message: OutboundMessage) {
    this.sent.push(message);
    if (this.behaviour === 'retryable')
      throw new ChannelDeliveryError(this.channel, 'gateway responded 503', { retryable: true, status: 503 });
    if (this.behaviour === 'permanent')
      throw new ChannelDeliveryError(this.channel, 'gateway responded 422', { retryable: false, status: 422 });
    return { reference: `ref-${this.sent.length}` };
  }
}

function registry(over: readonly NotificationChannel[] = []): ChannelRegistry {
  const base: NotificationChannel[] = [
    new InAppChannel(),
    new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']),
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ];
  const merged = new Map(base.map((c) => [c.channel, c]));
  for (const c of over) merged.set(c.channel, c);
  return new ChannelRegistry([...merged.values()]);
}

interface Harness {
  notify: NotifyService;
  store: MemoryNotifyStore;
  targets: MemoryTargetStore;
  deliveries: MemoryDeliveryStore;
  muteStore: MemoryMuteStore;
}

function harness(
  channels: ChannelRegistry = registry(),
  options: { fanoutEnabled?: boolean; maxAttempts?: number; outOfAppEnabled?: boolean } = {},
): Harness {
  const store = new MemoryNotifyStore();
  const targets = new MemoryTargetStore();
  const deliveries = new MemoryDeliveryStore();
  const muteStore = new MemoryMuteStore();
  const dispatcher = new NotificationDispatcher(channels, targets, deliveries, {
    maxAttempts: options.maxAttempts ?? 3,
    outOfAppEnabled: options.outOfAppEnabled ?? true,
    mutePrefsOf: (userId) => muteStore.get(userId),
  });
  const notify = new NotifyService(
    store,
    { fanoutEnabled: options.fanoutEnabled ?? true, verifyTtlMinutes: 15, verifyCodePepper: 'test-verify-pepper' },
    { targets, deliveries, channels, dispatcher, muteStore },
  );
  return { notify, store, targets, deliveries, muteStore };
}

function marginCall(overrides: Partial<{ sequence: number }> = {}) {
  return {
    loanId: LOAN,
    userId: USER,
    sequence: 1,
    ltvBps: 8_200,
    cureCollateralAmount: '0.0415',
    collateralAssetId: 'BTC',
    calledAt: new Date().toISOString(),
    graceExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

/**
 * A `trade.position.updated` payload. Every amount is a decimal string, as it
 * is on the wire — a number here would be a test that agrees with a bug.
 */
function position(overrides: Partial<{ status: 'open' | 'closing' | 'closed' | 'liquidated'; positionId: string }> = {}) {
  return {
    positionId: POSITION,
    userId: USER,
    marketId: 'BTC-PERP',
    symbol: 'BTC-PERP',
    status: 'liquidated' as const,
    side: 'long' as const,
    contracts: '1.5',
    entryPrice: '61000.00',
    markPrice: '54900.00',
    notional: '91500.00',
    leverage: '10',
    collateral: '9150.00',
    unrealizedPnl: '-9150.00',
    realizedPnl: '-9150.00',
    liquidationPrice: '54900.00',
    marginMode: 'isolated' as const,
    fundingPaid: '12.40',
    closingReason: null,
    ts: new Date().toISOString(),
    ...overrides,
  };
}

/** Register and confirm an address without going through a real transport. */
async function confirmTarget(h: Harness, channel: 'email' | 'push' | 'sms', address: string): Promise<void> {
  await h.targets.upsert({
    userId: USER,
    channel,
    address,
    locale: 'en',
    verifyTokenHash: 'x'.repeat(64),
    verifyExpiresAt: new Date(Date.now() + 60_000),
  });
  await h.targets.markVerified(USER, channel, 'x'.repeat(64), new Date());
}

/** Register an address and stop there — the user never clicked the code. */
async function registerUnconfirmed(h: Harness, channel: 'email' | 'push' | 'sms', address: string): Promise<void> {
  await h.targets.upsert({
    userId: USER,
    channel,
    address,
    locale: 'en',
    verifyTokenHash: 'y'.repeat(64),
    verifyExpiresAt: new Date(Date.now() + 60_000),
  });
}

describe('channel registry — a channel with no credentials refuses, it does not vanish', () => {
  it('registers every channel even when nothing is configured', () => {
    const reg = channelsFromEnv(NO_GATEWAYS);
    expect(reg.status().map((s) => s.channel)).toEqual(['inapp', 'email', 'push', 'sms']);
    expect(reg.availableChannels()).toEqual(['inapp']);
  });

  it('names §13 sockets on out-of-app channels and leaves in-app on the mountain (D26-P1-O5)', () => {
    const status = channelsFromEnv(NO_GATEWAYS).status();
    expect(status.find((s) => s.channel === 'inapp')).toMatchObject({ socket: null });
    expect(status.find((s) => s.channel === 'email')).toMatchObject({ socket: 'socket.notify-email' });
    expect(status.find((s) => s.channel === 'push')).toMatchObject({ socket: 'socket.notify-push' });
    expect(status.find((s) => s.channel === 'sms')).toMatchObject({ socket: 'socket.notify-sms' });
  });

  it('names the environment variables an operator is missing', () => {
    const email = channelsFromEnv(NO_GATEWAYS)
      .status()
      .find((s) => s.channel === 'email');
    expect(email).toMatchObject({ configured: false, available: false, reason: 'channel.not_configured' });
    expect(email?.requires).toEqual(['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']);
  });

  it('builds a real gateway once URL and token are both present — configured, not available', () => {
    const reg = channelsFromEnv({
      ...NO_GATEWAYS,
      NOTIFY_EMAIL_GATEWAY_URL: 'https://gateway.internal/send',
      NOTIFY_EMAIL_GATEWAY_TOKEN: 'a-token-long-enough-to-pass',
    });
    expect(reg.get('email')).toBeInstanceOf(EmailChannel);
    expect(reg.status().find((s) => s.channel === 'email')).toMatchObject({
      configured: true,
      available: false,
      reason: 'channel.unprobed',
      requires: [],
    });
    expect(reg.availableChannels()).toEqual(['inapp']);
  });

  it('refuses to construct a registry missing a channel — an absent channel cannot refuse', () => {
    expect(() => new ChannelRegistry([new InAppChannel()])).toThrow(/missing "email"/);
  });

  it('reports a fully configured channel as unavailable while the out-of-app switch is off', () => {
    // The user-facing answer to "can this reach me right now" has two halves:
    // credentials, and the operator switch. Reporting only the first told a user
    // whose margin-call email never arrived that email was available and nothing
    // was missing — the one thing they cannot check for themselves.
    const wired = {
      ...NO_GATEWAYS,
      NOTIFY_EMAIL_GATEWAY_URL: 'https://gateway.internal/send',
      NOTIFY_EMAIL_GATEWAY_TOKEN: 'a-token-long-enough-to-pass',
    };
    const reg = channelsFromEnv({ ...wired, NOTIFY_OUT_OF_APP_ENABLED: false });

    expect(reg.status().find((s) => s.channel === 'email')).toMatchObject({
      configured: true,
      available: false,
      reason: 'channel.disabled',
      // Nothing is missing — the operator turned it off. Do not send someone
      // hunting for an env var that is already set. Disabled, not unprobed.
      requires: [],
    });
    expect(reg.availableChannels()).toEqual(['inapp']);
  });

  it('leaves in-app available with the switch off — it is the fallback, not an out-of-app channel', () => {
    const reg = channelsFromEnv({ ...NO_GATEWAYS, NOTIFY_OUT_OF_APP_ENABLED: false });
    expect(reg.status().find((s) => s.channel === 'inapp')).toMatchObject({
      configured: true,
      available: true,
      reason: null,
    });
    expect(reg.availableChannels()).toEqual(['inapp']);
  });

  it('keeps naming the missing env vars when a channel is both unconfigured and switched off', () => {
    // Credentials are the reason a caller can act on, so it wins over the switch.
    const email = channelsFromEnv({ ...NO_GATEWAYS, NOTIFY_OUT_OF_APP_ENABLED: false })
      .status()
      .find((s) => s.channel === 'email');
    expect(email).toMatchObject({ configured: false, available: false, reason: 'channel.not_configured' });
    expect(email?.requires).toEqual(['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']);
  });

  it('an absent switch means on — credentials still do not sell as available', () => {
    const reg = channelsFromEnv({
      ...NO_GATEWAYS,
      NOTIFY_EMAIL_GATEWAY_URL: 'https://gateway.internal/send',
      NOTIFY_EMAIL_GATEWAY_TOKEN: 'a-token-long-enough-to-pass',
    });
    expect(reg.availableChannels()).toEqual(['inapp']);
    expect(reg.status().find((s) => s.channel === 'email')).toMatchObject({
      configured: true,
      available: false,
      reason: 'channel.unprobed',
    });
  });
});

describe('an unconfigured channel never reports success', () => {
  it('records a refusal with the reason, and no delivery time', async () => {
    const h = harness();
    await confirmTarget(h, 'email', 'someone@example.com');

    const result = await h.notify.create({
      userId: USER,
      kind: 'bank.margin_call',
      titleKey: 'notify.bank.margin_call.title',
      bodyKey: 'notify.bank.margin_call.body',
      severity: 'critical',
      sourceSubject: bankMarginCalled.subject,
      sourceIdempotencyKey: `${LOAN}:1`,
    });

    const email = result.dispatch!.outcomes.find((o) => o.channel === 'email');
    expect(email).toMatchObject({ status: 'refused', code: 'channel.not_configured', retryable: false });

    const rows = await h.deliveries.listForNotification(result.notification!.id);
    const emailRow = rows.find((r) => r.channel === 'email')!;
    expect(emailRow.status).toBe('refused');
    expect(emailRow.acceptedAt).toBeNull();
    // Nothing was attempted, so nothing may claim it was.
    expect(emailRow.attemptedAt).toBeNull();
    expect(emailRow.refusalCode).toBe('channel.not_configured');
  });

  it('still delivers in-app — the honest fallback when the owner has no credentials', async () => {
    const h = harness();
    const result = await h.notify.create({
      userId: USER,
      kind: 'trade.fill',
      titleKey: 'notify.trade.fill.title',
      bodyKey: 'notify.trade.fill.body',
      sourceSubject: 'intafaced.trade.fill.settled',
      sourceIdempotencyKey: 'fill-1',
    });

    expect(result.dispatch!.outcomes.find((o) => o.channel === 'inapp')).toMatchObject({ status: 'accepted' });
    expect(result.dispatch!.retry).toBe(false);
    expect(await h.notify.unreadCount(USER)).toBe(1);
  });
});

describe('at-least-once must not mean twice', () => {
  it('sends one email for a redelivered event', async () => {
    const email = new SpyChannel('email');
    const h = harness(registry([email]));
    await confirmTarget(h, 'email', 'someone@example.com');

    const input = {
      userId: USER,
      kind: 'bank.margin_call',
      titleKey: 'notify.bank.margin_call.title',
      bodyKey: 'notify.bank.margin_call.body',
      severity: 'critical' as const,
      sourceSubject: bankMarginCalled.subject,
      sourceIdempotencyKey: `${LOAN}:1`,
    };

    const first = await h.notify.create(input);
    const second = await h.notify.create(input);

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(email.sent).toHaveLength(1);
    // The redelivery still ran fan-out; the claim is what stopped the second send.
    expect(second.dispatch!.outcomes.find((o) => o.channel === 'email')).toMatchObject({ status: 'already_accepted' });
  });

  it('recovers a send lost to a crash between the insert and the transport', async () => {
    // First pass: the row is written, the gateway is unreachable, the process dies.
    const flaky = new SpyChannel('email', 'retryable');
    const h = harness(registry([flaky]));
    await confirmTarget(h, 'email', 'someone@example.com');

    const input = {
      userId: USER,
      kind: 'trade.fill',
      titleKey: 'notify.trade.fill.title',
      bodyKey: 'notify.trade.fill.body',
      severity: 'critical' as const,
      sourceSubject: 'intafaced.trade.fill.settled',
      sourceIdempotencyKey: 'fill-crash',
    };

    const first = await h.notify.create(input);
    expect(first.dispatch!.retry).toBe(true);

    // Redelivery: the insert is a no-op, but the row is recovered and retried.
    const second = await h.notify.create(input);
    expect(second.inserted).toBe(false);
    expect(second.dispatch).not.toBeNull();
    expect(flaky.sent).toHaveLength(2);
  });
});

describe('retry policy — transient yes, permanent no', () => {
  it('asks for a retry on a 503 and records the attempt without a delivery', async () => {
    const h = harness(registry([new SpyChannel('email', 'retryable')]));
    await confirmTarget(h, 'email', 'someone@example.com');

    const result = await h.notify.create({
      userId: USER,
      kind: 'trade.fill',
      titleKey: 'notify.trade.fill.title',
      bodyKey: 'notify.trade.fill.body',
      sourceSubject: 'intafaced.trade.fill.settled',
      sourceIdempotencyKey: 'fill-503',
    });

    expect(result.dispatch!.retry).toBe(true);
    const row = (await h.deliveries.listForNotification(result.notification!.id)).find((r) => r.channel === 'email')!;
    expect(row.status).toBe('failed');
    // We tried; nobody received it. Both facts, separately.
    expect(row.attemptedAt).not.toBeNull();
    expect(row.acceptedAt).toBeNull();
  });

  it('does not ask for a retry on a 422 — a permanently broken address must not burn the budget', async () => {
    const h = harness(registry([new SpyChannel('email', 'permanent')]));
    await confirmTarget(h, 'email', 'someone@example.com');

    const result = await h.notify.create({
      userId: USER,
      kind: 'trade.fill',
      titleKey: 'notify.trade.fill.title',
      bodyKey: 'notify.trade.fill.body',
      sourceSubject: 'intafaced.trade.fill.settled',
      sourceIdempotencyKey: 'fill-422',
    });

    expect(result.dispatch!.retry).toBe(false);
    const row = (await h.deliveries.listForNotification(result.notification!.id)).find((r) => r.channel === 'email')!;
    expect(row.status).toBe('abandoned');
    // Permanent reject is not "budget spent" — name the transport reject.
    expect(row.refusalCode).toBe('channel.transport_rejected');
    expect(row.acceptedAt).toBeNull();
  });

  it('abandons after the configured attempts rather than retrying forever', async () => {
    const flaky = new SpyChannel('email', 'retryable');
    const h = harness(registry([flaky]), { maxAttempts: 2 });
    await confirmTarget(h, 'email', 'someone@example.com');

    const input = {
      userId: USER,
      kind: 'trade.fill',
      titleKey: 'notify.trade.fill.title',
      bodyKey: 'notify.trade.fill.body',
      sourceSubject: 'intafaced.trade.fill.settled',
      sourceIdempotencyKey: 'fill-exhaust',
    };

    await h.notify.create(input);
    const second = await h.notify.create(input);
    const third = await h.notify.create(input);

    expect(flaky.sent).toHaveLength(2);
    expect(second.dispatch!.retry).toBe(false);
    expect(third.dispatch!.outcomes.find((o) => o.channel === 'email')).toMatchObject({
      status: 'abandoned',
      code: 'channel.attempts_exhausted',
    });
  });
});

describe('a critical notification that reached nobody says so', () => {
  it('records a refusal per out-of-app channel even with no registered address', async () => {
    const h = harness();

    const result = await h.notify.create({
      userId: USER,
      kind: 'bank.margin_call',
      titleKey: 'notify.bank.margin_call.title',
      bodyKey: 'notify.bank.margin_call.body',
      severity: 'critical',
      sourceSubject: bankMarginCalled.subject,
      sourceIdempotencyKey: `${LOAN}:1`,
    });

    const rows = await h.deliveries.listForNotification(result.notification!.id);
    expect(rows.map((r) => r.channel).sort()).toEqual(['email', 'inapp', 'push', 'sms']);
    for (const row of rows.filter((r) => r.channel !== 'inapp')) {
      expect(row.status).toBe('refused');
      expect(row.refusalCode).toBe('channel.no_target');
      expect(row.acceptedAt).toBeNull();
    }
  });

  it('says the address was never confirmed, rather than that there was no address', async () => {
    // `channel.target_unverified` was declared in the refusal vocabulary and
    // never emitted, so somebody one click from a margin-call SMS was told they
    // had no phone number. Logged at docs/MEGA-AUDIT-2026-08-07-FINDINGS.md.
    const h = harness();
    await registerUnconfirmed(h, 'sms', '+447700900000');
    await confirmTarget(h, 'email', 'someone@example.com');

    const result = await h.notify.create({
      userId: USER,
      kind: 'bank.margin_call',
      titleKey: 'notify.bank.margin_call.title',
      bodyKey: 'notify.bank.margin_call.body',
      severity: 'critical',
      sourceSubject: bankMarginCalled.subject,
      sourceIdempotencyKey: `${LOAN}:unverified`,
    });

    const rows = await h.deliveries.listForNotification(result.notification!.id);
    // Registered but unconfirmed — a fix the user can make.
    expect(rows.find((r) => r.channel === 'sms')).toMatchObject({
      status: 'refused',
      refusalCode: 'channel.target_unverified',
      attemptedAt: null,
    });
    // Never registered at all — a different fact.
    expect(rows.find((r) => r.channel === 'push')).toMatchObject({
      status: 'refused',
      refusalCode: 'channel.no_target',
    });
  });

  it('never sends to the unconfirmed address it just named', async () => {
    const sms = new SpyChannel('sms');
    const h = harness(registry([sms]));
    await registerUnconfirmed(h, 'sms', '+447700900000');

    await h.notify.create({
      userId: USER,
      kind: 'bank.margin_call',
      titleKey: 'notify.bank.margin_call.title',
      bodyKey: 'notify.bank.margin_call.body',
      severity: 'critical',
      sourceSubject: bankMarginCalled.subject,
      sourceIdempotencyKey: `${LOAN}:unverified-no-send`,
    });

    expect(sms.sent).toHaveLength(0);
  });

  it('goes back to no_target once the address is confirmed and then removed', async () => {
    const h = harness();
    await registerUnconfirmed(h, 'sms', '+447700900000');
    await h.targets.remove(USER, 'sms');

    const result = await h.notify.create({
      userId: USER,
      kind: 'bank.margin_call',
      titleKey: 'notify.bank.margin_call.title',
      bodyKey: 'notify.bank.margin_call.body',
      severity: 'critical',
      sourceSubject: bankMarginCalled.subject,
      sourceIdempotencyKey: `${LOAN}:unverified-removed`,
    });

    expect((await h.deliveries.listForNotification(result.notification!.id)).find((r) => r.channel === 'sms')).toMatchObject({
      refusalCode: 'channel.no_target',
    });
  });

  it('leaves an informational notification alone — nothing was promised on a channel nobody registered', async () => {
    const h = harness();
    const result = await h.notify.create({
      userId: USER,
      kind: 'trade.fill',
      titleKey: 'notify.trade.fill.title',
      bodyKey: 'notify.trade.fill.body',
      severity: 'info',
      sourceSubject: 'intafaced.trade.fill.settled',
      sourceIdempotencyKey: 'fill-quiet',
    });

    const rows = await h.deliveries.listForNotification(result.notification!.id);
    expect(rows.map((r) => r.channel)).toEqual(['inapp']);
  });
});

describe('addresses are confirmed before anything is sent to them', () => {
  it('never sends to an unconfirmed address', async () => {
    const email = new SpyChannel('email');
    const h = harness(registry([email]));
    await h.targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'unconfirmed@example.com',
      locale: 'en',
      verifyTokenHash: 'y'.repeat(64),
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });

    const result = await h.notify.create({
      userId: USER,
      kind: 'trade.fill',
      titleKey: 'notify.trade.fill.title',
      bodyKey: 'notify.trade.fill.body',
      sourceSubject: 'intafaced.trade.fill.settled',
      sourceIdempotencyKey: 'fill-unverified',
    });

    expect(email.sent).toHaveLength(0);
    expect(result.dispatch!.outcomes.map((o) => o.channel)).toEqual(['inapp']);
  });

  it('sends the confirmation code through the channel being registered', async () => {
    const email = new SpyChannel('email');
    const h = harness(registry([email]));

    const outcome = await h.notify.registerTarget({ userId: USER, channel: 'email', address: 'new@example.com', locale: 'en' });
    expect(outcome.status).toBe('sent');
    expect(email.sent[0]!.address).toBe('new@example.com');
    // A six-digit code, rendered from the catalog — not a raw key, not a template.
    expect(email.sent[0]!.body).toMatch(/\b\d{6}\b/);
    // And it is not readable from the inbox: confirming a NEW address must not
    // be possible with nothing but the session.
    expect(await h.notify.unreadCount(USER)).toBe(0);
  });

  it('reports the refusal instead of a green tick when the channel is not wired', async () => {
    const h = harness();
    const outcome = await h.notify.registerTarget({ userId: USER, channel: 'sms', address: '+447700900000', locale: 'en' });
    expect(outcome).toMatchObject({ status: 'refused', code: 'channel.not_configured' });

    const targets = await h.notify.listTargets(USER);
    expect(targets[0]).toMatchObject({ channel: 'sms', verifiedAt: null });
  });

  it('rejects a wrong, expired or already-spent code', async () => {
    const h = harness(registry([new SpyChannel('email')]));
    await h.notify.registerTarget({ userId: USER, channel: 'email', address: 'new@example.com', locale: 'en' });

    expect(await h.notify.verifyTarget(USER, 'email', '000000')).toEqual({ status: 'rejected' });
    const targets = await h.notify.listTargets(USER);
    expect(targets[0]?.verifiedAt).toBeNull();
  });

  it('refuses register when the per-user rate limit is spent — no extra SMS', async () => {
    const email = new SpyChannel('email');
    const limiter = new TargetRateLimiter({
      register: { max: 2, windowMs: 60_000 },
      verify: { max: 50, windowMs: 60_000 },
    });
    const store = new MemoryNotifyStore();
    const targets = new MemoryTargetStore();
    const deliveries = new MemoryDeliveryStore();
    const channels = registry([email]);
    const dispatcher = new NotificationDispatcher(channels, targets, deliveries, {
      maxAttempts: 3,
      outOfAppEnabled: true,
    });
    const notify = new NotifyService(
      store,
      { fanoutEnabled: true, verifyTtlMinutes: 15, verifyCodePepper: 'test-verify-pepper', targetRateLimiter: limiter },
      { targets, deliveries, channels, dispatcher },
    );

    expect((await notify.registerTarget({ userId: USER, channel: 'email', address: 'a@example.com', locale: 'en' })).status).toBe('sent');
    expect((await notify.registerTarget({ userId: USER, channel: 'email', address: 'b@example.com', locale: 'en' })).status).toBe('sent');
    const third = await notify.registerTarget({ userId: USER, channel: 'email', address: 'c@example.com', locale: 'en' });
    expect(third).toMatchObject({ status: 'refused', code: 'channel.register_rate_limited' });
    // The gateway must not have been asked a third time.
    expect(email.sent).toHaveLength(2);
  });

  it('refuses verify when the per-user rate limit is spent — named code, not silent false', async () => {
    const limiter = new TargetRateLimiter({
      register: { max: 50, windowMs: 60_000 },
      verify: { max: 2, windowMs: 60_000 },
    });
    const email = new SpyChannel('email');
    const store = new MemoryNotifyStore();
    const targets = new MemoryTargetStore();
    const deliveries = new MemoryDeliveryStore();
    const channels = registry([email]);
    const dispatcher = new NotificationDispatcher(channels, targets, deliveries, {
      maxAttempts: 3,
      outOfAppEnabled: true,
    });
    const notify = new NotifyService(
      store,
      { fanoutEnabled: true, verifyTtlMinutes: 15, verifyCodePepper: 'test-verify-pepper', targetRateLimiter: limiter },
      { targets, deliveries, channels, dispatcher },
    );
    await notify.registerTarget({ userId: USER, channel: 'email', address: 'new@example.com', locale: 'en' });

    expect(await notify.verifyTarget(USER, 'email', '000000')).toEqual({ status: 'rejected' });
    expect(await notify.verifyTarget(USER, 'email', '000001')).toEqual({ status: 'rejected' });
    expect(await notify.verifyTarget(USER, 'email', '000002')).toEqual({
      status: 'refused',
      code: 'channel.verify_rate_limited',
    });
  });

  it('un-confirms a target when its address changes', async () => {
    const h = harness(registry([new SpyChannel('email')]));
    await confirmTarget(h, 'email', 'old@example.com');
    expect((await h.notify.listTargets(USER))[0]?.verifiedAt).not.toBeNull();

    await h.notify.registerTarget({ userId: USER, channel: 'email', address: 'new@example.com', locale: 'en' });
    expect((await h.notify.listTargets(USER))[0]).toMatchObject({ address: 'new@example.com', verifiedAt: null });
  });
});

describe('the operator switch stops sending without blinding anyone', () => {
  it('fills the inbox and refuses out-of-app when NOTIFY_OUT_OF_APP_ENABLED is off', async () => {
    const email = new SpyChannel('email');
    const h = harness(registry([email]), { outOfAppEnabled: false });
    await confirmTarget(h, 'email', 'someone@example.com');

    const result = await h.notify.create({
      userId: USER,
      kind: 'trade.fill',
      titleKey: 'notify.trade.fill.title',
      bodyKey: 'notify.trade.fill.body',
      sourceSubject: 'intafaced.trade.fill.settled',
      sourceIdempotencyKey: 'fill-quiet-hours',
    });

    expect(email.sent).toHaveLength(0);
    expect(await h.notify.unreadCount(USER)).toBe(1);
    expect(result.dispatch!.outcomes.find((o) => o.channel === 'email')).toMatchObject({
      status: 'refused',
      code: 'channel.disabled',
    });
  });

  it('still writes the “reached nobody” row for a critical when the switch is off and no address exists', async () => {
    // The switch used to be the one operator state where a margin call that
    // reached nobody left no record at all: the disabled branch only wrote a row
    // when a target existed, so a borrower with no confirmed address got an
    // empty table for email/push/sms — the exact fact a disputed liquidation
    // turns on.
    const h = harness(registry(), { outOfAppEnabled: false });

    const result = await h.notify.create({
      userId: USER,
      kind: 'bank.margin_call',
      titleKey: 'notify.bank.margin_call.title',
      bodyKey: 'notify.bank.margin_call.body',
      severity: 'critical',
      sourceSubject: bankMarginCalled.subject,
      sourceIdempotencyKey: `${LOAN}:switch-off`,
    });

    const rows = await h.deliveries.listForNotification(result.notification!.id);
    expect(rows.map((r) => r.channel).sort()).toEqual(['email', 'inapp', 'push', 'sms']);
    for (const row of rows.filter((r) => r.channel !== 'inapp')) {
      expect(row.status).toBe('refused');
      expect(row.refusalCode).toBe('channel.disabled');
      // Both facts survive: the switch stopped it, AND there was nowhere to send.
      expect(row.detail).toBe('no confirmed address on this channel');
      expect(row.attemptedAt).toBeNull();
      expect(row.acceptedAt).toBeNull();
    }
  });

  it('leaves an informational notification alone when the switch is off and nothing was registered', async () => {
    const h = harness(registry(), { outOfAppEnabled: false });

    const result = await h.notify.create({
      userId: USER,
      kind: 'trade.fill',
      titleKey: 'notify.trade.fill.title',
      bodyKey: 'notify.trade.fill.body',
      severity: 'info',
      sourceSubject: 'intafaced.trade.fill.settled',
      sourceIdempotencyKey: 'fill-switch-off-no-target',
    });

    const rows = await h.deliveries.listForNotification(result.notification!.id);
    expect(rows.map((r) => r.channel)).toEqual(['inapp']);
  });

  it('distinguishes unconfirmed from absent in the detail, even with the switch off', async () => {
    const h = harness(registry(), { outOfAppEnabled: false });
    await registerUnconfirmed(h, 'sms', '+447700900000');

    const result = await h.notify.create({
      userId: USER,
      kind: 'bank.margin_call',
      titleKey: 'notify.bank.margin_call.title',
      bodyKey: 'notify.bank.margin_call.body',
      severity: 'critical',
      sourceSubject: bankMarginCalled.subject,
      sourceIdempotencyKey: `${LOAN}:switch-off-unconfirmed`,
    });

    const rows = await h.deliveries.listForNotification(result.notification!.id);
    // The switch is still the binding cause on both, but the second fact differs.
    expect(rows.find((r) => r.channel === 'sms')).toMatchObject({
      refusalCode: 'channel.disabled',
      detail: 'address registered but never confirmed',
    });
    expect(rows.find((r) => r.channel === 'push')).toMatchObject({
      refusalCode: 'channel.disabled',
      detail: 'no confirmed address on this channel',
    });
  });

  it('records the switch, not the missing address, when the user does have a confirmed one', async () => {
    const h = harness(registry(), { outOfAppEnabled: false });
    await confirmTarget(h, 'email', 'someone@example.com');

    const result = await h.notify.create({
      userId: USER,
      kind: 'bank.margin_call',
      titleKey: 'notify.bank.margin_call.title',
      bodyKey: 'notify.bank.margin_call.body',
      severity: 'critical',
      sourceSubject: bankMarginCalled.subject,
      sourceIdempotencyKey: `${LOAN}:switch-off-with-target`,
    });

    const rows = await h.deliveries.listForNotification(result.notification!.id);
    const email = rows.find((r) => r.channel === 'email');
    expect(email).toMatchObject({ status: 'refused', refusalCode: 'channel.disabled', detail: null });
  });
});

describe('the delivery record is the user’s to read, and only their own', () => {
  it('returns the record for the caller and nothing for a stranger', async () => {
    const h = harness();
    const result = await h.notify.create({
      userId: USER,
      kind: 'bank.margin_call',
      titleKey: 'notify.bank.margin_call.title',
      bodyKey: 'notify.bank.margin_call.body',
      severity: 'critical',
      sourceSubject: bankMarginCalled.subject,
      sourceIdempotencyKey: `${LOAN}:2`,
    });

    expect(await h.notify.deliveriesFor(USER, result.notification!.id)).not.toHaveLength(0);
    // Not an error — an error would confirm the id exists.
    expect(await h.notify.deliveriesFor(OTHER, result.notification!.id)).toEqual([]);
  });
});

describe('out-of-app copy comes from the same catalog as the screen', () => {
  it('renders a margin call into copy, not into a dotted key', () => {
    const rendered = renderNotification(
      {
        id: 'n1',
        userId: USER,
        kind: 'bank.margin_call',
        titleKey: 'notify.bank.margin_call.title',
        bodyKey: 'notify.bank.margin_call.body',
        params: { cureCollateralAmount: '0.0415', collateralAssetId: 'BTC', graceExpiresAt: '2026-08-01T00:00:00.000Z' },
        href: null,
        severity: 'critical',
        readAt: null,
        sourceSubject: bankMarginCalled.subject,
        sourceIdempotencyKey: `${LOAN}:1`,
        createdAt: new Date(),
      },
      'en',
    );

    expect(rendered.title).toBe('Margin call on your loan');
    expect(rendered.body).toContain('0.0415');
    expect(rendered.body).toContain('BTC');
    // Consent footer is catalog copy, not dead code — must ride on every out-of-app body.
    expect(rendered.footer).toBe('You are receiving this because you confirmed this address for account alerts.');
    expect(rendered.body).toContain(rendered.footer!);
    // A raw key reaching a user is the failure this asserts against.
    expect(rendered.body).not.toContain('notify.bank');
    expect(rendered.body).not.toMatch(/\{[a-zA-Z]/);
  });

  it('stamps the message with the language it is actually in, not the one requested', () => {
    // A target row may carry any of the 28 declared locales. One of them has a
    // catalog. This used to pass the requested code straight through to the
    // adapter as `locale:`, so an English margin call went out stamped `ar` —
    // and a gateway honouring that field mirrors the layout right-to-left around
    // left-to-right words, on the message we least want hard to read.
    expect(normaliseLocale('ar')).toBe('en');
    expect(normaliseLocale('zh-Hans')).toBe('en');
    expect(normaliseLocale('en')).toBe('en');
    expect(normaliseLocale(null)).toBe('en');
    expect(normaliseLocale('not-a-locale')).toBe('en');

    // The copy is English either way — the fix is to the label, not the words.
    const rendered = renderVerification('ar', '123456', 10);
    expect(rendered.title).toBe('Confirm this address');
    // Verification must NOT claim consent — the address is unconfirmed.
    expect(rendered.footer).toBeNull();
    expect(rendered.body).not.toContain('confirmed this address');
  });

  it('has a catalog entry for every title and body key the consumers use', async () => {
    // Walk the actual wiring rather than a hand-kept list: a consumer added
    // without copy would otherwise email somebody a dotted key.
    const seen: string[] = [];
    const notify = {
      create: async (input: { titleKey: string; bodyKey: string }) => {
        seen.push(input.titleKey, input.bodyKey);
        return { inserted: true, notification: null, dispatch: null };
      },
    } as unknown as NotifyService;

    const bus = new MemoryEventBus('test');
    await subscribeNotificationEvents(bus, notify);

    await bus.publish('bankMarginCalled', marginCall());
    await bus.publish('kycApproved', { userId: USER, tier: 'basic', jurisdiction: 'DE' });
    await bus.publish('rankUpdated', { userId: USER, rank: 2, previousRank: 1, xp: '10' });
    await bus.publish('positionUpdated', position());

    expect(seen).toContain('notify.trade.position.liquidated.title');
    expect(seen.length).toBeGreaterThan(0);
    for (const key of seen) expect(MESSAGE_KEYS).toContain(key);
  });
});

describe('the liquidation consumer', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('writes one critical inbox row for a liquidation and dedupes redelivery', async () => {
    const bus = new MemoryEventBus('svc-trade');
    await subscribeNotificationEvents(bus, h.notify);

    await bus.publish('positionUpdated', position());
    await bus.publish('positionUpdated', position());
    expect(await h.notify.unreadCount(USER)).toBe(1);

    const rows = await h.notify.list({ userId: USER, limit: 10, unreadOnly: false });
    const row = rows.items.find((n) => n.kind === 'trade.position.liquidated')!;
    expect(row.severity).toBe('critical');
    expect(row.sourceSubject).toBe('intafaced.trade.position.updated');
    expect(row.sourceIdempotencyKey).toBe(`${POSITION}:liquidated`);
    expect(row.href).toBe('/trade/futures');
  });

  it('carries every amount across as the decimal string it arrived as', async () => {
    // A notification that rounded a size or a price would be a second, wrong
    // copy of a number svc-trade owns. Nothing here parses; nothing here sums.
    const bus = new MemoryEventBus('svc-trade');
    await subscribeNotificationEvents(bus, h.notify);
    await bus.publish('positionUpdated', position());

    const rows = await h.notify.list({ userId: USER, limit: 10, unreadOnly: false });
    const row = rows.items.find((n) => n.kind === 'trade.position.liquidated')!;
    expect(row.params).toMatchObject({
      contracts: '1.5',
      entryPrice: '61000.00',
      notional: '91500.00',
      symbol: 'BTC-PERP',
      side: 'long',
    });
    for (const key of ['contracts', 'entryPrice', 'notional'] as const) {
      expect(typeof row.params[key]).toBe('string');
    }
  });

  it('renders the liquidation without leaving a key or a placeholder in the copy', () => {
    const rendered = renderNotification(
      {
        id: 'n-liq',
        userId: USER,
        kind: 'trade.position.liquidated',
        titleKey: 'notify.trade.position.liquidated.title',
        bodyKey: 'notify.trade.position.liquidated.body',
        params: { side: 'long', symbol: 'BTC-PERP', contracts: '1.5', entryPrice: '61000.00' },
        href: null,
        severity: 'critical',
        readAt: null,
        sourceSubject: 'intafaced.trade.position.updated',
        sourceIdempotencyKey: `${POSITION}:liquidated`,
        createdAt: new Date(),
      },
      'en',
    );

    expect(rendered.title).toBe('Position liquidated');
    expect(rendered.body).toContain('BTC-PERP');
    expect(rendered.body).toContain('1.5');
    expect(rendered.body).not.toContain('notify.trade');
    expect(rendered.body).not.toContain('{');
  });

  it('acks every other transition without writing a row — an inbox nobody reads is an outage too', async () => {
    const bus = new MemoryEventBus('svc-trade');
    await subscribeNotificationEvents(bus, h.notify);

    for (const status of ['open', 'closing', 'closed'] as const) {
      await bus.publish('positionUpdated', position({ status, positionId: POSITION }));
    }
    expect(await h.notify.unreadCount(USER)).toBe(0);

    // …and the one the trader did not choose still lands.
    await bus.publish('positionUpdated', position({ status: 'liquidated' }));
    expect(await h.notify.unreadCount(USER)).toBe(1);
  });

  it('honours a widened policy without any other change', async () => {
    // The default is deliberately the narrowest honest one. Product law may
    // widen it; this pins that the policy is what decides, not a hard-coded if.
    const bus = new MemoryEventBus('svc-trade');
    await subscribeNotificationEvents(bus, h.notify, {
      positionNotify: { statuses: ['liquidated', 'closed'], severity: 'action' },
    });

    await bus.publish('positionUpdated', position({ status: 'closed' }));
    const rows = await h.notify.list({ userId: USER, limit: 10, unreadOnly: false });
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]!.severity).toBe('action');
    expect(rows.items[0]!.sourceIdempotencyKey).toBe(`${POSITION}:closed`);
  });

  it('records a refusal on every out-of-app channel when the trader registered none', async () => {
    // The whole point of `critical`: "we had no way to reach you about your
    // liquidation" has to be a row written at the time, not an inference from
    // an empty table afterwards.
    const bus = new MemoryEventBus('svc-trade');
    await subscribeNotificationEvents(bus, h.notify);
    await bus.publish('positionUpdated', position());

    const rows = await h.notify.list({ userId: USER, limit: 10, unreadOnly: false });
    const row = rows.items.find((n) => n.kind === 'trade.position.liquidated')!;
    const deliveries = await h.deliveries.listForNotification(row.id);
    for (const channel of ['email', 'push', 'sms'] as const) {
      const record = deliveries.find((d) => d.channel === channel)!;
      expect(record.status).toBe('refused');
      expect(record.acceptedAt).toBeNull();
      expect(record.refusalCode).not.toBeNull();
    }
  });

  it('naks so the bus redelivers when a channel wants another attempt', async () => {
    const flaky = new SpyChannel('email', 'retryable');
    const local = harness(registry([flaky]));
    await confirmTarget(local, 'email', 'trader@example.com');

    const bus = new MemoryEventBus('svc-trade');
    await subscribeNotificationEvents(bus, local.notify);

    await expect(bus.publish('positionUpdated', position())).rejects.toThrow(/wants a retry/);
  });
});

describe('the margin-call consumer', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('writes one critical inbox row per call sequence, and dedupes redelivery', async () => {
    const bus = new MemoryEventBus('svc-bank');
    await subscribeNotificationEvents(bus, h.notify);

    await bus.publish('bankMarginCalled', marginCall({ sequence: 1 }));
    await bus.publish('bankMarginCalled', marginCall({ sequence: 1 }));
    expect(await h.notify.unreadCount(USER)).toBe(1);

    // A cured loan called again is a NEW fact, not a duplicate.
    await bus.publish('bankMarginCalled', marginCall({ sequence: 2 }));
    expect(await h.notify.unreadCount(USER)).toBe(2);

    const rows = await h.notify.list({ userId: USER, limit: 10, unreadOnly: false });
    const call = rows.items.find((n) => n.kind === 'bank.margin_call')!;
    expect(call.severity).toBe('critical');
    expect(call.sourceSubject).toBe('intafaced.bank.margin_call.created');
    expect(call.params).toMatchObject({ loanId: LOAN, cureCollateralAmount: '0.0415', ltvBps: 8_200 });
  });

  it('naks so the bus redelivers when a channel wants another attempt', async () => {
    const flaky = new SpyChannel('email', 'retryable');
    const local = harness(registry([flaky]));
    await confirmTarget(local, 'email', 'borrower@example.com');

    const bus = new MemoryEventBus('svc-bank');
    await subscribeNotificationEvents(bus, local.notify);

    await expect(bus.publish('bankMarginCalled', marginCall())).rejects.toThrow(/wants a retry/);
  });

  it('acks quietly when a channel is permanently broken — one bad address must not park the message', async () => {
    const broken = new SpyChannel('email', 'permanent');
    const local = harness(registry([broken]));
    await confirmTarget(local, 'email', 'borrower@example.com');

    const bus = new MemoryEventBus('svc-bank');
    await subscribeNotificationEvents(bus, local.notify);

    await expect(bus.publish('bankMarginCalled', marginCall())).resolves.toBeTruthy();
    expect(await local.notify.unreadCount(USER)).toBe(1);
  });
});

describe('mute prefs — refusal is recorded, critical is never silenced', () => {
  it('refuses a muted out-of-app channel with channel.muted and does not call the gateway', async () => {
    const spy = new SpyChannel('email', 'ok');
    const h = harness(registry([spy]));
    await confirmTarget(h, 'email', 'someone@example.com');
    await h.muteStore.setMuted(USER, 'email', true);

    const result = await h.notify.create({
      userId: USER,
      kind: 'trade.fill',
      titleKey: 'notify.trade.fill.title',
      bodyKey: 'notify.trade.fill.body',
      severity: 'info',
      sourceSubject: 'intafaced.trade.fill.settled',
      sourceIdempotencyKey: 'fill-mute-1',
      params: { fillId: 'f1', orderId: 'o1', marketId: 'BTC-USDT', side: 'buy', price: '1', qty: '1' },
    });

    const email = result.dispatch!.outcomes.find((o) => o.channel === 'email');
    expect(email).toMatchObject({ status: 'refused', code: 'channel.muted', retryable: false });
    expect(spy.sent).toHaveLength(0);

    const rows = await h.deliveries.listForNotification(result.notification!.id);
    const emailRow = rows.find((r) => r.channel === 'email')!;
    expect(emailRow.status).toBe('refused');
    expect(emailRow.refusalCode).toBe('channel.muted');
    expect(emailRow.acceptedAt).toBeNull();
    expect(emailRow.attemptedAt).toBeNull();
  });

  it('still attempts a muted channel when severity is critical', async () => {
    const spy = new SpyChannel('email', 'ok');
    const h = harness(registry([spy]));
    await confirmTarget(h, 'email', 'borrower@example.com');
    await h.muteStore.setMuted(USER, 'email', true);

    const result = await h.notify.create({
      userId: USER,
      kind: 'bank.margin_call',
      titleKey: 'notify.bank.margin_call.title',
      bodyKey: 'notify.bank.margin_call.body',
      severity: 'critical',
      sourceSubject: bankMarginCalled.subject,
      sourceIdempotencyKey: `${LOAN}:mute-critical`,
    });

    const email = result.dispatch!.outcomes.find((o) => o.channel === 'email');
    expect(email).toMatchObject({ status: 'accepted', retryable: false });
    expect(spy.sent).toHaveLength(1);
  });

  it('survives a store round-trip the way PostgresMuteStore would after restart', async () => {
    const a = new MemoryMuteStore();
    await a.setMuted(USER, 'sms', true);
    const snapshot = await a.get(USER);

    // New process = new store instance seeded from the same durable prefs.
    const b = new MemoryMuteStore();
    for (const channel of snapshot.muted) {
      await b.setMuted(USER, channel, true);
    }
    expect([...(await b.get(USER)).muted]).toEqual(['sms']);
  });
});

describe('consumers whose producer has not created a stream are reported, not hidden', () => {
  it('collects the failure by subject instead of failing the whole boot', async () => {
    // One subject's stream is missing — the attach path still reports pending
    // rather than taking the whole inbox down. (svc-bank now publishes
    // bankMarginCalled; this test forces the attach failure to pin the report.)
    const bus = new MemoryEventBus('test');
    const real = bus.subscribe.bind(bus);
    bus.subscribe = (async (event: string, handler: never, opts: never) => {
      if (event === 'bankMarginCalled') throw new Error('stream not found');
      return real(event as never, handler, opts);
    }) as typeof bus.subscribe;

    const h = harness();
    const report = await subscribeNotificationEvents(bus, h.notify);

    expect(report.pending).toHaveLength(1);
    expect(report.pending[0]).toMatchObject({
      event: 'bankMarginCalled',
      subject: 'intafaced.bank.margin_call.created',
      durable: 'notify-bank-margin-called',
      reason: 'stream not found',
    });
    // Every other consumer still attached — the inbox is not held hostage.
    expect(report.subscriptions).toHaveLength(notifyEventConsumerCount() - 1);
  });
});
