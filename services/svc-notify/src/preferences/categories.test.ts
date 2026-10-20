import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { NotificationChannel, OutboundMessage } from '../channels/channel.js';
import { InAppChannel, UnconfiguredChannel } from '../channels/gateway.js';
import { ChannelRegistry } from '../channels/registry.js';
import { MemoryDeliveryStore, MemoryTargetStore } from '../channel-store.js';
import { NotifyService } from '../notify-service.js';
import { NotificationDispatcher } from '../dispatch.js';
import { createNotifyRouter } from '../router.js';
import { MemoryNotifyStore } from '../store.js';
import { MemoryMuteStore } from './mute.js';
import { AccountPrefs, MemoryCommandLog, MemoryDigestPrefStore, MemoryHoldStore, MemoryTopicPrefStore } from './account.js';
import { CategoryPrefs, MemoryCategoryPrefStore, categoryFromKind } from './categories.js';
import { planOutOfApp } from './gate.js';

const SECRET = 'notify-category-prefs-edge-secret-value';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-notify' });

function signed(userId: string) {
  const principal = {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['notify:read', 'notify:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
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

function harness() {
  const email = new SpyChannel('email');
  const channels = new ChannelRegistry([
    new InAppChannel(),
    email,
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]);
  const store = new MemoryNotifyStore();
  const targets = new MemoryTargetStore();
  const deliveries = new MemoryDeliveryStore();
  const holds = new MemoryHoldStore();
  const commands = new MemoryCommandLog();
  const account = new AccountPrefs(new MemoryTopicPrefStore(), new MemoryDigestPrefStore(), commands, () => channels.status());
  const categoryStore = new MemoryCategoryPrefStore();
  const categories = new CategoryPrefs(categoryStore, commands, () => channels.status());
  const dispatcher = new NotificationDispatcher(channels, targets, deliveries, {
    maxAttempts: 3,
    outOfAppEnabled: true,
    mutePrefsOf: (userId) => new MemoryMuteStore().get(userId),
    planOutOfApp: planOutOfApp({ account, holds, now: () => new Date('2026-04-01T12:00:00.000Z'), categories }),
    loadNotification: (userId, notificationId) => store.findById(userId, notificationId),
  });
  const notify = new NotifyService(
    store,
    { fanoutEnabled: true, verifyTtlMinutes: 15, verifyCodePepper: 'notify-category-pepper' },
    { targets, deliveries, channels, dispatcher, account, categories, holds },
  );
  const router = createNotifyRouter(notify);
  return {
    notify,
    email,
    targets,
    categoryStore,
    caller: router.createCaller(signed(USER)),
    other: router.createCaller(signed(OTHER)),
  };
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

const promo = (key: string) => ({
  userId: USER,
  kind: 'promo.campaign',
  titleKey: 'notify.promo.title',
  bodyKey: 'notify.promo.body',
  severity: 'info' as const,
  sourceSubject: 'intafaced.promo.test',
  sourceIdempotencyKey: key,
});

const identity = (key: string) => ({
  userId: USER,
  kind: 'identity.kyc.approved',
  titleKey: 'notify.identity.kyc.approved.title',
  bodyKey: 'notify.identity.kyc.approved.body',
  severity: 'info' as const,
  sourceSubject: 'intafaced.identity.kyc.approved',
  sourceIdempotencyKey: key,
});

describe('kind to category', () => {
  it('maps every sender prefix and leaves an unknown prefix without a category', () => {
    expect(categoryFromKind('identity.kyc.approved')).toBe('security');
    expect(categoryFromKind('notify.channel.verify')).toBe('security');
    expect(categoryFromKind('trade.fill')).toBe('orders');
    expect(categoryFromKind('bank.margin_call')).toBe('orders');
    expect(categoryFromKind('alert.price.crossed')).toBe('price_alerts');
    expect(categoryFromKind('promo.campaign')).toBe('promotions');
    expect(categoryFromKind('mystery.thing')).toBeNull();
  });
});

describe('category grid', () => {
  it('lists every category by channel, locks security and the inbox, and names the missing vendor', async () => {
    const h = harness();
    const rows = await h.caller.notify.categoryPrefs();
    expect(rows).toHaveLength(24);
    expect(rows.filter((row) => row.category === 'security').every((row) => row.locked && row.enabled)).toBe(true);
    expect(rows.filter((row) => row.channel === 'in_app').every((row) => row.locked && row.enabled)).toBe(true);
    expect(rows.find((row) => row.category === 'promotions' && row.channel === 'email')).toEqual({
      category: 'promotions',
      channel: 'email',
      enabled: true,
      locked: false,
      configured: true,
      notConnected: null,
    });
    expect(rows.find((row) => row.category === 'news' && row.channel === 'sms')).toMatchObject({
      configured: false,
      notConnected: 'vendor.sms',
    });
    expect(rows.find((row) => row.category === 'news' && row.channel === 'push')).toMatchObject({
      configured: false,
      notConnected: 'vendor.push',
    });
  });

  it('refuses an unknown category or channel and stores nothing', async () => {
    const h = harness();
    await expect(
      h.caller.notify.setCategoryPref({ category: 'billing', channel: 'email', enabled: false, clientRequestId: 'bad-cat' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'notify.category_unknown' });
    await expect(
      h.caller.notify.setCategoryPref({ category: 'news', channel: 'fax', enabled: false, clientRequestId: 'bad-ch' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'notify.category_channel_unknown' });
    expect((await h.caller.notify.categoryPrefs()).every((row) => row.enabled)).toBe(true);
  });
});

describe('send-time choice', () => {
  it('skips a promotion on a switched-off channel and still sends a security notice', async () => {
    const h = harness();
    await confirmEmail(h);
    const off = await h.caller.notify.setCategoryPref({
      category: 'promotions',
      channel: 'email',
      enabled: false,
      clientRequestId: 'promo-off',
    });
    expect(off.locked).toBe(false);
    expect(off.rows.find((row) => row.category === 'promotions' && row.channel === 'email')?.enabled).toBe(false);

    const promoted = await h.notify.create(promo('promo-1'));
    expect(promoted.dispatch?.outcomes.find((row) => row.channel === 'email')).toMatchObject({ status: 'refused', code: 'channel.muted' });
    expect(h.email.sent).toHaveLength(0);

    const secure = await h.notify.create(identity('kyc-1'));
    expect(secure.dispatch?.outcomes.find((row) => row.channel === 'email')).toMatchObject({ status: 'accepted' });
    expect(h.email.sent).toHaveLength(1);
  });

  it('reads the choice when sending, so a notice created after switching back on is sent', async () => {
    const h = harness();
    await confirmEmail(h);
    await h.caller.notify.setCategoryPref({ category: 'promotions', channel: 'email', enabled: false, clientRequestId: 'p-off' });
    await h.caller.notify.setCategoryPref({ category: 'promotions', channel: 'email', enabled: true, clientRequestId: 'p-on' });
    const sent = await h.notify.create(promo('promo-2'));
    expect(sent.dispatch?.outcomes.find((row) => row.channel === 'email')).toMatchObject({ status: 'accepted' });
  });

  it('keeps one account choice away from another account', async () => {
    const h = harness();
    await h.caller.notify.setCategoryPref({ category: 'news', channel: 'email', enabled: false, clientRequestId: 'news-off' });
    const other = await h.other.notify.categoryPrefs();
    expect(other.find((row) => row.category === 'news' && row.channel === 'email')?.enabled).toBe(true);
  });
});

describe('locked cells', () => {
  it('ignores an off write for security and for the inbox and says it is locked', async () => {
    const h = harness();
    const security = await h.caller.notify.setCategoryPref({
      category: 'security',
      channel: 'email',
      enabled: false,
      clientRequestId: 'sec-off',
    });
    expect(security.locked).toBe(true);
    expect(security.rows.find((row) => row.category === 'security' && row.channel === 'email')).toMatchObject({
      enabled: true,
      locked: true,
    });
    const inbox = await h.caller.notify.setCategoryPref({
      category: 'orders',
      channel: 'in_app',
      enabled: false,
      clientRequestId: 'inbox-off',
    });
    expect(inbox.locked).toBe(true);
    expect(inbox.rows.find((row) => row.category === 'orders' && row.channel === 'in_app')?.enabled).toBe(true);
    expect(h.categoryStore.history).toHaveLength(0);
  });

  it('sends a security notice even when a stored row says off', async () => {
    const h = harness();
    await confirmEmail(h);
    await h.categoryStore.set(USER, 'orders', 'email', false);
    const secure = await h.notify.create(identity('kyc-locked'));
    expect(secure.dispatch?.outcomes.find((row) => row.channel === 'email')).toMatchObject({ status: 'accepted' });
  });
});

describe('writes', () => {
  it('replays a client request to the first result', async () => {
    const h = harness();
    const first = await h.caller.notify.setCategoryPref({ category: 'news', channel: 'push', enabled: false, clientRequestId: 'same' });
    const replay = await h.caller.notify.setCategoryPref({ category: 'news', channel: 'push', enabled: true, clientRequestId: 'same' });
    expect(replay).toEqual(first);
    expect((await h.caller.notify.categoryPrefs()).find((row) => row.category === 'news' && row.channel === 'push')?.enabled).toBe(false);
  });

  it('keeps the last write per cell and records both writes in history', async () => {
    const h = harness();
    await h.caller.notify.setCategoryPref({ category: 'status', channel: 'email', enabled: false, clientRequestId: 'device-a' });
    await h.caller.notify.setCategoryPref({ category: 'status', channel: 'email', enabled: true, clientRequestId: 'device-b' });
    expect((await h.caller.notify.categoryPrefs()).find((row) => row.category === 'status' && row.channel === 'email')?.enabled).toBe(true);
    expect(h.categoryStore.history.map((row) => row.enabled)).toEqual([false, true]);
  });

  it('adds no history for a write that changes nothing', async () => {
    const h = harness();
    await h.caller.notify.setCategoryPref({ category: 'status', channel: 'sms', enabled: false, clientRequestId: 'a' });
    await h.caller.notify.setCategoryPref({ category: 'status', channel: 'sms', enabled: false, clientRequestId: 'b' });
    expect(h.categoryStore.history).toHaveLength(1);
  });
});
