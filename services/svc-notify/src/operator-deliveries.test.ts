import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryNotifyStore } from './store.js';
import { MemoryDeliveryStore, MemoryTargetStore } from './channel-store.js';
import { NotifyService } from './notify-service.js';
import { NotificationDispatcher } from './dispatch.js';
import { ChannelRegistry } from './channels/registry.js';
import { InAppChannel, UnconfiguredChannel } from './channels/gateway.js';
import { MemoryMuteStore } from './preferences/mute.js';
import { createNotifyRouter } from './router.js';
import { providerHealth } from './provider-health.js';

/**
 * Operator delivery outcomes — product path (not a mocked NotifyService).
 *
 * Done-bar: in-app accepted is readable; email without a gateway is
 * `channel.not_configured` (never fake sent / never `delivered`); callers
 * without `admin:read` are refused. Scope stays `admin:read` (existing operator
 * scope) — `notify:ops` would require packages/auth, which this slice does not
 * touch. Digest helpers stay unwired.
 */

const SECRET = 'a-notify-operator-deliveries-test-secret-long';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-notify' });

function principal(scopes: string[]): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed(scopes: string[]) {
  const raw = encodePrincipal(principal(scopes));
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-op',
  });
}

const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

function productHarness() {
  const store = new MemoryNotifyStore();
  const targets = new MemoryTargetStore();
  const deliveries = new MemoryDeliveryStore();
  const muteStore = new MemoryMuteStore();
  const channels = new ChannelRegistry([
    new InAppChannel(),
    new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']),
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]);
  const dispatcher = new NotificationDispatcher(channels, targets, deliveries, {
    maxAttempts: 3,
    outOfAppEnabled: true,
    mutePrefsOf: (userId) => muteStore.get(userId),
  });
  const notify = new NotifyService(
    store,
    { fanoutEnabled: true, verifyTtlMinutes: 15 },
    { targets, deliveries, channels, dispatcher, muteStore },
  );
  return { notify, targets, deliveries };
}

async function confirmEmail(targets: MemoryTargetStore) {
  await targets.upsert({
    userId: USER,
    channel: 'email',
    address: 'ops-view@example.com',
    locale: 'en',
    verifyTokenHash: 'x'.repeat(64),
    verifyExpiresAt: new Date(Date.now() + 60_000),
  });
  await targets.markVerified(USER, 'email', 'x'.repeat(64), new Date());
}

describe('operator delivery outcomes (ops.notifications residual)', () => {
  it('MemoryDeliveryStore.listRecent is newest-first and capped', async () => {
    const n1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const n2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    let nowMs = Date.parse('2026-08-12T12:00:00.000Z');
    const s = new MemoryDeliveryStore({ now: () => new Date(nowMs) });
    const c1 = await s.claim(n1, 'email', 3);
    expect(c1.claimed).toBe(true);
    if (!c1.claimed) throw new Error('expected claim');
    await s.settle({
      id: c1.id,
      attempt: 1,
      status: 'refused',
      refusalCode: 'channel.not_configured',
      attempted: false,
    });
    nowMs = Date.parse('2026-08-12T13:00:00.000Z');
    const c2 = await s.claim(n2, 'inapp', 3);
    expect(c2.claimed).toBe(true);
    if (!c2.claimed) throw new Error('expected claim');
    await s.settle({ id: c2.id, attempt: 1, status: 'accepted', attempted: true });

    const recent = await s.listRecent(10);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.notificationId).toBe(n2);
    expect(recent[0]!.status).toBe('accepted');
    expect(recent[1]!.status).toBe('refused');
    expect(await s.listRecent(1)).toHaveLength(1);
  });

  it('configured in-app is accepted; email without gateway is channel.not_configured — never delivered', async () => {
    const { notify, targets } = productHarness();
    await confirmEmail(targets);
    const created = await notify.create({
      userId: USER,
      kind: 'bank.margin_call',
      titleKey: 'notify.bank.margin_call.title',
      bodyKey: 'notify.bank.margin_call.body',
      severity: 'critical',
      sourceSubject: 'intafaced.bank.margin_call.created',
      sourceIdempotencyKey: 'margin-op-outcomes-1',
    });
    expect(created.inserted).toBe(true);

    const rows = await notify.operatorDeliveryOutcomes(50);
    const inapp = rows.find((r) => r.channel === 'inapp');
    const email = rows.find((r) => r.channel === 'email');

    expect(inapp).toMatchObject({ status: 'accepted', refusalCode: null });
    expect(inapp?.acceptedAt).toBeInstanceOf(Date);
    expect(email).toMatchObject({ status: 'refused', refusalCode: 'channel.not_configured' });
    expect(email?.acceptedAt).toBeNull();
    expect(email?.attemptedAt).toBeNull();
    expect(rows.every((r) => r.status !== ('delivered' as typeof r.status))).toBe(true);

    const caller = createNotifyRouter(notify).createCaller(signed(['admin:read']));
    const wired = await caller.notify.ops.deliveries({ limit: 50 });
    expect(wired.some((r) => r.channel === 'inapp' && r.status === 'accepted')).toBe(true);
    expect(wired.some((r) => r.channel === 'email' && r.status === 'refused' && r.refusalCode === 'channel.not_configured')).toBe(true);
    for (const row of wired) {
      expect(row).not.toHaveProperty('address');
      expect(row).not.toHaveProperty('detail');
      expect(row).not.toHaveProperty('userId');
      expect(row.status).not.toBe('delivered');
    }

    const alias = await caller.notify.operatorDeliveries({ limit: 50 });
    expect(alias).toEqual(wired);
  });

  it('admin:read can call notify.ops.deliveries; notify:read and anonymous cannot', async () => {
    const { notify } = productHarness();
    await notify.create({
      userId: USER,
      kind: 'trade.fill',
      titleKey: 'notify.trade.fill.title',
      bodyKey: 'notify.trade.fill.body',
      sourceSubject: 'intafaced.trade.fill.settled',
      sourceIdempotencyKey: 'fill-op-outcomes-auth',
    });

    const router = createNotifyRouter(notify);
    const asAdmin = await router.createCaller(signed(['admin:read'])).notify.ops.deliveries({ limit: 10 });
    expect(asAdmin.length).toBeGreaterThan(0);

    await expect(router.createCaller(signed(['notify:read'])).notify.ops.deliveries()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(router.createCaller(anonymous()).notify.ops.deliveries()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('admin omit of limit is PRECONDITION_FAILED — never invents 50', async () => {
    const { notify } = productHarness();
    await expect(notify.operatorDeliveryOutcomes()).rejects.toMatchObject({
      code: 'notify.operator_deliveries_limit_unset',
    });

    const caller = createNotifyRouter(notify).createCaller(signed(['admin:read']));
    await expect(caller.notify.ops.deliveries()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.operator_deliveries_limit_unset',
    });
    await expect(caller.notify.operatorDeliveries({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.operator_deliveries_limit_unset',
    });
    await expect(caller.notify.ops.deliveries({ limit: 50 })).resolves.toEqual([]);
  });

  it('filters by status and aggregates every row, and refuses a session without admin:read', async () => {
    const { notify, deliveries } = productHarness();
    const email = await deliveries.claim('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'email', 3);
    if (!email.claimed) throw new Error('expected claim');
    await deliveries.settle({ id: email.id, attempt: 1, status: 'refused', refusalCode: 'channel.not_configured', attempted: false });
    const inbox = await deliveries.claim('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'inapp', 3);
    if (!inbox.claimed) throw new Error('expected claim');
    await deliveries.settle({ id: inbox.id, attempt: 1, status: 'accepted', attempted: true });

    const caller = createNotifyRouter(notify).createCaller(signed(['admin:read']));
    const refused = await caller.notify.operatorDeliveries({ limit: 20, status: 'refused' });
    expect(refused).toHaveLength(1);
    expect(refused[0]!.status).toBe('refused');

    const totals = await caller.notify.operatorDeliveryAggregates();
    expect(totals.total).toBe(2);
    expect(totals.byStatus).toMatchObject({ accepted: 1, refused: 1, pending: 0 });
    expect(totals.byChannel).toMatchObject({ email: 1, inapp: 1 });

    await expect(
      createNotifyRouter(notify)
        .createCaller(signed(['notify:read']))
        .notify.operatorDeliveryAggregates(),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const health = await caller.notify.operatorProviderHealth();
    expect(health.delivered).toMatchObject({ observed: false, code: 'notify.delivered_unobserved' });
    expect(health.email.configured).toBe(false);
    expect(health.email.code).toBe('notify.email_gateway_unconfigured');
    expect(health.push.code).toBe('notify.push_gateway_unconfigured');
    expect(
      providerHealth({ NOTIFY_EMAIL_GATEWAY_URL: 'https://mail.example', NOTIFY_EMAIL_GATEWAY_TOKEN: 'x'.repeat(16) }).email,
    ).toMatchObject({
      configured: true,
      probed: false,
      code: 'notify.provider_probe_unconfigured',
    });
  });
});
