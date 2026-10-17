import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { ChannelDeliveryError, type NotificationChannel, type OutboundMessage } from '../channels/channel.js';
import { InAppChannel, UnconfiguredChannel } from '../channels/gateway.js';
import { ChannelRegistry } from '../channels/registry.js';
import { MemoryDeliveryStore, MemoryTargetStore } from '../channel-store.js';
import { NotifyService } from '../notify-service.js';
import { NotificationDispatcher } from '../dispatch.js';
import { createNotifyRouter } from '../router.js';
import { MemoryNotifyStore } from '../store.js';
import { MemoryMuteStore } from './mute.js';
import {
  type DigestSummary,
  type HoldStore,
  AccountPrefs,
  MemoryCommandLog,
  MemoryDigestPrefStore,
  MemoryHoldStore,
  MemoryTopicPrefStore,
} from './account.js';
import { planOutOfApp } from './gate.js';
import { quietReleaseUtc } from './quiet-hours.js';

/**
 * Seams: notify.topicPrefs / setTopicPref / digestPrefs / setDigest, and the
 * dispatch decision those choices change. Expected instants are civil-time
 * literals checked against the platform zone database, not recomputed here.
 */

const SECRET = 'notify-prefs-acceptance-edge-secret-value';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-notify' });

function principal(userId: string, scopes: string[]): Principal {
  return {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed(userId: string) {
  const raw = encodePrincipal(principal(userId, ['notify:read', 'notify:write']));
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: `req-${userId}`,
  });
}

class SpyChannel implements NotificationChannel {
  readonly unavailableReason = null;
  readonly sent: OutboundMessage[] = [];
  constructor(readonly channel: 'email' | 'push' | 'sms') {}
  async deliver(message: OutboundMessage) {
    this.sent.push(message);
    return { reference: `ref-${this.sent.length}` };
  }
}

class RetryOnceEmail extends SpyChannel {
  private failuresLeft: number;
  constructor(failures: number) {
    super('email');
    this.failuresLeft = failures;
  }
  override async deliver(message: OutboundMessage) {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new ChannelDeliveryError('email', 'gateway timeout', { retryable: true, status: 503 });
    }
    return super.deliver(message);
  }
}

function registry(email: SpyChannel): ChannelRegistry {
  return new ChannelRegistry([
    new InAppChannel(),
    email,
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]);
}

function harness(startIso: string, email: SpyChannel = new SpyChannel('email')) {
  let now = new Date(startIso);
  const spy = email;
  const channels = registry(spy);
  const store = new MemoryNotifyStore();
  const targets = new MemoryTargetStore();
  const deliveries = new MemoryDeliveryStore();
  const holds = new MemoryHoldStore();
  const account = new AccountPrefs(new MemoryTopicPrefStore(), new MemoryDigestPrefStore(), new MemoryCommandLog(), () =>
    channels.status(),
  );
  const dispatcher = new NotificationDispatcher(channels, targets, deliveries, {
    maxAttempts: 3,
    outOfAppEnabled: true,
    mutePrefsOf: (userId) => new MemoryMuteStore().get(userId),
    planOutOfApp: planOutOfApp({ account, holds, now: () => now }),
    loadNotification: (userId, notificationId) => store.findById(userId, notificationId),
  });
  const notify = new NotifyService(
    store,
    { fanoutEnabled: true, verifyTtlMinutes: 15, verifyCodePepper: 'notify-prefs-pepper' },
    { targets, deliveries, channels, dispatcher, account, holds },
  );
  const router = createNotifyRouter(notify);
  return {
    notify,
    spy,
    holds,
    dispatcher,
    targets,
    setNow(iso: string) {
      now = new Date(iso);
    },
    caller: router.createCaller(signed(USER)),
    other: router.createCaller(signed(OTHER)),
  };
}

type ReleaseFn = (
  holds: HoldStore,
  dispatcher: {
    releaseHeld(userId: string, notificationId: string, channel: 'email' | 'push' | 'sms'): Promise<{ status: string; retryable: boolean }>;
  },
  now: Date,
) => Promise<readonly DigestSummary[]>;

function isMissingModule(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  return code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(err.message);
}

/** Pre-fix `releaseDue` records a summary and does not send. The delivery assertions fail on that path. */
async function releaseFor(h: ReturnType<typeof harness>, userId: string, now: Date): Promise<DigestSummary | null> {
  let releaseDueHolds: ReleaseFn | undefined;
  try {
    const mod = (await import('./release.js')) as { releaseDueHolds?: ReleaseFn };
    releaseDueHolds = mod.releaseDueHolds;
  } catch (err) {
    if (!isMissingModule(err)) throw err;
  }
  if (releaseDueHolds && typeof h.dispatcher.releaseHeld === 'function') {
    const summaries = await releaseDueHolds(h.holds, h.dispatcher, now);
    return summaries.find((row) => row.userId === userId) ?? null;
  }
  const legacy = h.holds as unknown as {
    releaseDue(userId: string, now: Date): Promise<DigestSummary | null>;
  };
  return legacy.releaseDue(userId, now);
}

async function confirmEmail(h: ReturnType<typeof harness>) {
  await h.targets.upsert({
    userId: USER,
    channel: 'email',
    address: 'owner@example.com',
    locale: 'en',
    verifyTokenHash: 'ab'.repeat(32),
    verifyExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
  });
  await h.targets.markVerified(USER, 'email', 'ab'.repeat(32), new Date('2026-01-01T00:00:00.000Z'));
}

describe('topic choices', () => {
  it('mutes a normal notice on that channel, still delivers a critical one, and hides another account', async () => {
    const h = harness('2026-04-01T12:00:00.000Z');
    await confirmEmail(h);

    const before = await h.caller.notify.topicPrefs();
    expect(before).toHaveLength(24);
    const tradeEmail = before.find((row) => row.topic === 'trade' && row.channel === 'email');
    expect(tradeEmail).toEqual({ topic: 'trade', channel: 'email', enabled: true, configured: true });
    expect(before.find((row) => row.topic === 'trade' && row.channel === 'push')).toMatchObject({ enabled: true, configured: false });
    expect(before.find((row) => row.topic === 'trade' && row.channel === 'inapp')).toEqual({
      topic: 'trade',
      channel: 'inapp',
      enabled: true,
      configured: true,
    });

    const muted = await h.caller.notify.setTopicPref({
      topic: 'trade',
      channel: 'email',
      enabled: false,
      clientRequestId: 'topic-mute-1',
    });
    expect(muted.find((row) => row.topic === 'trade' && row.channel === 'email')?.enabled).toBe(false);

    const replay = await h.caller.notify.setTopicPref({
      topic: 'trade',
      channel: 'email',
      enabled: true,
      clientRequestId: 'topic-mute-1',
    });
    expect(replay.find((row) => row.topic === 'trade' && row.channel === 'email')?.enabled).toBe(false);
    expect(await h.caller.notify.topicPrefs()).toEqual(replay);

    const other = await h.other.notify.topicPrefs();
    expect(other.find((row) => row.topic === 'trade' && row.channel === 'email')?.enabled).toBe(true);

    const normal = await h.notify.create({
      userId: USER,
      kind: 'trade.fill',
      titleKey: 'notify.trade.fill.title',
      bodyKey: 'notify.trade.fill.body',
      severity: 'info',
      sourceSubject: 'intafaced.trade.fill.settled',
      sourceIdempotencyKey: 'fill-topic-mute',
    });
    expect(normal.dispatch?.outcomes.find((row) => row.channel === 'email')).toMatchObject({
      status: 'refused',
      code: 'channel.muted',
    });
    expect(h.spy.sent).toHaveLength(0);

    const critical = await h.notify.create({
      userId: USER,
      kind: 'trade.position.liquidated',
      titleKey: 'notify.trade.position.liquidated.title',
      bodyKey: 'notify.trade.position.liquidated.body',
      severity: 'critical',
      sourceSubject: 'intafaced.trade.position.liquidated',
      sourceIdempotencyKey: 'liq-topic-critical',
    });
    expect(critical.dispatch?.outcomes.find((row) => row.channel === 'email')).toMatchObject({ status: 'accepted' });
    expect(h.spy.sent).toHaveLength(1);
  });

  it('refuses an unknown topic and an unknown channel', async () => {
    const h = harness('2026-04-01T12:00:00.000Z');
    await expect(
      h.caller.notify.setTopicPref({ topic: 'billing', channel: 'email', enabled: false, clientRequestId: 'bad-topic' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'notify.topic_unknown' });
    await expect(
      h.caller.notify.setTopicPref({ topic: 'trade', channel: 'fax', enabled: false, clientRequestId: 'bad-channel' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'notify.topic_channel_unknown' });
    await expect(
      h.caller.notify.setTopicPref({ topic: 'trade', channel: 'inapp', enabled: false, clientRequestId: 'bad-inapp' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'notify.topic_channel_not_preferable' });
    expect((await h.caller.notify.topicPrefs()).every((row) => row.enabled)).toBe(true);
  });
});

describe('quiet hours and summaries', () => {
  it('holds across midnight and releases once at 06:00Z', async () => {
    const window = { start: '22:00', end: '06:00', timeZone: 'Atlantic/Reykjavik' };
    const during = new Date('2026-01-15T23:15:00.000Z');
    const release = new Date('2026-01-16T06:00:00.000Z');
    expect(quietReleaseUtc(during, window)?.toISOString()).toBe('2026-01-16T06:00:00.000Z');
    expect(quietReleaseUtc(new Date('2026-01-15T21:00:00.000Z'), window)).toBeNull();
    expect(quietReleaseUtc(release, window)).toBeNull();

    const h = harness(during.toISOString());
    await confirmEmail(h);
    await h.caller.notify.setDigest({ mode: 'immediate', quietHours: window, clientRequestId: 'quiet-midnight' });
    expect(await h.caller.notify.digestPrefs()).toEqual({ mode: 'immediate', quietHours: window });

    const held = await h.notify.create({
      userId: USER,
      kind: 'p2p.escrow.released',
      titleKey: 'notify.p2p.escrow.released.title',
      bodyKey: 'notify.p2p.escrow.released.body',
      severity: 'info',
      sourceSubject: 'intafaced.p2p.escrow.released',
      sourceIdempotencyKey: 'quiet-midnight-notice',
    });
    expect(h.spy.sent).toHaveLength(0);
    expect(held.dispatch?.outcomes.find((row) => row.channel === 'email')?.status).toBe('held');
    expect(await releaseFor(h, USER, new Date('2026-01-16T05:59:59.000Z'))).toBeNull();
    const summary = await releaseFor(h, USER, release);
    expect(summary?.noticeIds).toEqual([held.notification!.id]);
    expect(h.spy.sent).toHaveLength(1);
    expect(h.spy.sent[0]?.notificationId).toBe(held.notification!.id);
    expect(await releaseFor(h, USER, new Date('2026-01-16T07:00:00.000Z'))).toBeNull();
    expect(h.spy.sent).toHaveLength(1);
  });

  it('delivers a daily action notice once at the next UTC midnight', async () => {
    const during = new Date('2026-01-15T23:15:00.000Z');
    const midnight = new Date('2026-01-16T00:00:00.000Z');
    const h = harness(during.toISOString());
    await confirmEmail(h);
    await h.caller.notify.setDigest({ mode: 'daily', clientRequestId: 'daily-action' });
    expect(await h.caller.notify.digestPrefs()).toEqual({ mode: 'daily', quietHours: null });

    const held = await h.notify.create({
      userId: USER,
      kind: 'identity.kyc.approved',
      titleKey: 'notify.identity.kyc.approved.title',
      bodyKey: 'notify.identity.kyc.approved.body',
      severity: 'action',
      sourceSubject: 'intafaced.identity.kyc.approved',
      sourceIdempotencyKey: 'daily-action-notice',
    });
    expect(held.dispatch?.outcomes.find((row) => row.channel === 'email')?.status).toBe('held');
    expect(h.spy.sent).toHaveLength(0);
    expect(await releaseFor(h, USER, new Date('2026-01-15T23:59:59.000Z'))).toBeNull();
    const summary = await releaseFor(h, USER, midnight);
    expect(summary?.noticeIds).toEqual([held.notification!.id]);
    expect(h.spy.sent).toHaveLength(1);
    expect(h.spy.sent[0]?.notificationId).toBe(held.notification!.id);
    expect(await releaseFor(h, USER, new Date('2026-01-16T01:00:00.000Z'))).toBeNull();
    expect(h.spy.sent).toHaveLength(1);
  });

  it('leaves the hold due when the release send is retryable, then delivers it once', async () => {
    const during = new Date('2026-01-15T23:15:00.000Z');
    const midnight = new Date('2026-01-16T00:00:00.000Z');
    const h = harness(during.toISOString(), new RetryOnceEmail(1));
    await confirmEmail(h);
    await h.caller.notify.setDigest({ mode: 'daily', clientRequestId: 'daily-retry' });

    const held = await h.notify.create({
      userId: USER,
      kind: 'identity.kyc.approved',
      titleKey: 'notify.identity.kyc.approved.title',
      bodyKey: 'notify.identity.kyc.approved.body',
      severity: 'action',
      sourceSubject: 'intafaced.identity.kyc.approved',
      sourceIdempotencyKey: 'daily-retry-notice',
    });
    expect(held.dispatch?.outcomes.find((row) => row.channel === 'email')?.status).toBe('held');
    expect(await releaseFor(h, USER, midnight)).toBeNull();
    expect(h.spy.sent).toHaveLength(0);
    const summary = await releaseFor(h, USER, new Date('2026-01-16T00:01:00.000Z'));
    expect(summary?.noticeIds).toEqual([held.notification!.id]);
    expect(h.spy.sent).toHaveLength(1);
    expect(h.spy.sent[0]?.notificationId).toBe(held.notification!.id);
    expect(await releaseFor(h, USER, new Date('2026-01-16T00:02:00.000Z'))).toBeNull();
    expect(h.spy.sent).toHaveLength(1);
  });

  it('holds across the March 2026 New York spring-forward and releases at 08:00Z', async () => {
    const window = { start: '01:00', end: '04:00', timeZone: 'America/New_York' };
    const during = new Date('2026-03-08T06:30:00.000Z');
    expect(quietReleaseUtc(during, window)?.toISOString()).toBe('2026-03-08T08:00:00.000Z');

    const h = harness(during.toISOString());
    await confirmEmail(h);
    await h.caller.notify.setDigest({ mode: 'immediate', quietHours: window, clientRequestId: 'quiet-spring' });

    const critical = await h.notify.create({
      userId: USER,
      kind: 'bank.margin_call',
      titleKey: 'notify.bank.margin_call.title',
      bodyKey: 'notify.bank.margin_call.body',
      severity: 'critical',
      sourceSubject: 'intafaced.bank.margin_call.created',
      sourceIdempotencyKey: 'quiet-critical',
    });
    expect(critical.dispatch?.outcomes.find((row) => row.channel === 'email')?.status).toBe('accepted');
    expect(h.spy.sent).toHaveLength(1);

    const held = await h.notify.create({
      userId: USER,
      kind: 'bank.margin_call',
      titleKey: 'notify.bank.margin_call.title',
      bodyKey: 'notify.bank.margin_call.body',
      severity: 'info',
      sourceSubject: 'intafaced.bank.margin_call.created',
      sourceIdempotencyKey: 'quiet-info',
    });
    expect(h.spy.sent).toHaveLength(1);
    expect(await releaseFor(h, USER, new Date('2026-03-08T07:59:59.000Z'))).toBeNull();
    const summary = await releaseFor(h, USER, new Date('2026-03-08T08:00:00.000Z'));
    expect(summary?.noticeIds).toEqual([held.notification!.id]);
    expect(await releaseFor(h, USER, new Date('2026-03-08T09:00:00.000Z'))).toBeNull();
  });

  it('holds across the November 2026 New York fall-back and releases at 08:00Z', async () => {
    const window = { start: '00:30', end: '03:00', timeZone: 'America/New_York' };
    const during = new Date('2026-11-01T05:30:00.000Z');
    expect(quietReleaseUtc(during, window)?.toISOString()).toBe('2026-11-01T08:00:00.000Z');

    const h = harness(during.toISOString());
    await confirmEmail(h);
    await h.caller.notify.setDigest({ mode: 'hourly', quietHours: window, clientRequestId: 'quiet-fall' });
    const held = await h.notify.create({
      userId: USER,
      kind: 'identity.kyc.approved',
      titleKey: 'notify.identity.kyc.approved.title',
      bodyKey: 'notify.identity.kyc.approved.body',
      severity: 'action',
      sourceSubject: 'intafaced.identity.kyc.approved',
      sourceIdempotencyKey: 'quiet-fall-notice',
    });
    expect(h.spy.sent).toHaveLength(0);
    const summary = await releaseFor(h, USER, new Date('2026-11-01T08:00:00.000Z'));
    expect(summary?.noticeIds).toEqual([held.notification!.id]);
    expect(h.spy.sent).toHaveLength(1);
    expect(h.spy.sent[0]?.notificationId).toBe(held.notification!.id);
    expect(await releaseFor(h, USER, new Date('2026-11-01T08:00:00.000Z'))).toBeNull();
    expect(h.spy.sent).toHaveLength(1);
  });

  it('refuses an unknown time zone and keeps quiet hours unset', async () => {
    const h = harness('2026-04-01T12:00:00.000Z');
    await expect(
      h.caller.notify.setDigest({
        mode: 'daily',
        quietHours: { start: '22:00', end: '06:00', timeZone: 'Not/AZone' },
        clientRequestId: 'bad-zone',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'notify.quiet_zone_invalid' });
    await expect(
      h.caller.notify.setDigest({
        mode: 'weekly',
        clientRequestId: 'bad-mode',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'notify.digest_mode_unknown' });
    expect(await h.caller.notify.digestPrefs()).toEqual({ mode: 'immediate', quietHours: null });
  });
});
