import { describe, expect, it } from 'vitest';
import { InAppChannel, UnconfiguredChannel } from './channels/gateway.js';
import { ChannelRegistry } from './channels/registry.js';
import { ChannelDeliveryError, type NotificationChannel, type OutboundMessage } from './channels/channel.js';
import { MemoryDeliveryStore, MemoryTargetStore } from './channel-store.js';
import { NotificationDispatcher } from './dispatch.js';
import { MemoryNotifyStore, type Notification } from './store.js';
import { NotifyService } from './notify-service.js';
import { MemoryRecipientHealthStore, RecipientHealthError, maskAddress, type RecipientHealthStore } from './recipient-health.js';

const USER = 'user-1';
const ADDRESS = 'ada@example.com';

/** An email gateway that answers whatever the test tells it to. */
class ScriptedEmail implements NotificationChannel {
  readonly channel = 'email' as const;
  readonly unavailableReason = null;
  mode: 'ok' | 'reject' | 'transient' = 'reject';
  sent: OutboundMessage[] = [];
  async deliver(message: OutboundMessage) {
    this.sent.push(message);
    if (this.mode === 'ok') return { reference: `ref-${this.sent.length}` };
    throw new ChannelDeliveryError('email', 'mailbox does not exist', {
      retryable: this.mode === 'transient',
      status: this.mode === 'reject' ? 422 : 503,
    });
  }
}

let counter = 0;
function note(overrides: Partial<Notification> = {}): Notification {
  counter += 1;
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  return {
    id,
    userId: USER,
    kind: 'trade.fill',
    severity: 'info',
    titleKey: 'notify.trade.fill.title',
    bodyKey: 'notify.trade.fill.body',
    params: { side: 'buy', qty: '1', marketId: 'BTC-USDT', price: '1' },
    href: null,
    readAt: null,
    sourceSubject: 'intafaced.trade.fill.settled',
    sourceIdempotencyKey: `k-${counter}`,
    createdAt: new Date(),
    ...overrides,
  } as Notification;
}

async function harness(threshold: number | null) {
  const email = new ScriptedEmail();
  const registry = new ChannelRegistry([
    new InAppChannel(),
    email,
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]);
  const targets = new MemoryTargetStore();
  const deliveries = new MemoryDeliveryStore();
  await targets.upsert({
    userId: USER,
    channel: 'email',
    address: ADDRESS,
    locale: 'en',
    verifyTokenHash: 'h',
    verifyExpiresAt: new Date(Date.now() + 60_000),
  });
  await targets.markVerified(USER, 'email', 'h', new Date());
  const health = new MemoryRecipientHealthStore(() => targets.all());
  const dispatcher = new NotificationDispatcher(registry, targets, deliveries, {
    maxAttempts: 3,
    outOfAppEnabled: true,
    recipientHealth: {
      quarantineOf: async (userId, channel, address) => (threshold === null ? null : health.quarantineOf(userId, channel, address)),
      record: async (input) => {
        await health.record({ ...input, code: input.code ?? undefined, threshold, now: new Date() });
      },
    },
  });
  const service = new NotifyService(
    new MemoryNotifyStore(),
    { fanoutEnabled: true },
    {
      targets,
      deliveries,
      channels: registry,
      dispatcher,
      recipientHealth: health,
      quarantineThreshold: threshold,
    },
  );
  return { email, targets, health, dispatcher, service };
}

const emailOutcome = (r: Awaited<ReturnType<NotificationDispatcher['dispatch']>>) => r.outcomes.find((o) => o.channel === 'email');

describe('recipient quarantine', () => {
  it('quarantines at the owner threshold and skips the next non-critical send with the stored reason', async () => {
    const { email, dispatcher, health } = await harness(2);

    expect(emailOutcome(await dispatcher.dispatch(note()))).toMatchObject({ status: 'abandoned', code: 'channel.transport_rejected' });
    expect(await health.quarantineOf(USER, 'email', ADDRESS)).toBeNull();
    expect(emailOutcome(await dispatcher.dispatch(note()))).toMatchObject({ status: 'abandoned' });
    expect(await health.quarantineOf(USER, 'email', ADDRESS)).toMatchObject({
      reason: 'consecutive_failures:2:channel.transport_rejected',
    });

    const sentBefore = email.sent.length;
    const third = emailOutcome(await dispatcher.dispatch(note()));
    expect(third).toMatchObject({
      status: 'refused',
      code: 'channel.recipient_quarantined',
      detail: 'consecutive_failures:2:channel.transport_rejected',
    });
    expect(email.sent.length).toBe(sentBefore);
  });

  it('still attempts a critical message to a quarantined address', async () => {
    const { email, dispatcher } = await harness(1);
    await dispatcher.dispatch(note());
    const sentBefore = email.sent.length;
    email.mode = 'ok';
    const critical = emailOutcome(await dispatcher.dispatch(note({ severity: 'critical' })));
    expect(critical).toMatchObject({ status: 'accepted' });
    expect(email.sent.length).toBe(sentBefore + 1);
  });

  it('attempts the next send after a release with a reason, and a replay is a no-op', async () => {
    const { email, dispatcher, service, health } = await harness(1);
    await dispatcher.dispatch(note());
    expect(await health.quarantineOf(USER, 'email', ADDRESS)).not.toBeNull();

    const first = await service.operatorReleaseRecipient('op-1', {
      userId: USER,
      channel: 'email',
      reason: 'mailbox fixed',
      reasonId: 'rel-1',
    });
    expect(first).toEqual({ released: true, replayed: false });
    expect(
      await service.operatorReleaseRecipient('op-1', { userId: USER, channel: 'email', reason: 'mailbox fixed', reasonId: 'rel-1' }),
    ).toEqual({
      released: true,
      replayed: true,
    });

    email.mode = 'ok';
    const sentBefore = email.sent.length;
    expect(emailOutcome(await dispatcher.dispatch(note()))).toMatchObject({ status: 'accepted' });
    expect(email.sent.length).toBe(sentBefore + 1);
  });

  it('quarantines nobody while the threshold is unset, and the list says so', async () => {
    const { dispatcher, service } = await harness(null);
    for (let i = 0; i < 4; i += 1) expect(emailOutcome(await dispatcher.dispatch(note()))).toMatchObject({ status: 'abandoned' });
    const quarantined = await service.operatorRecipients('quarantined', 50);
    expect(quarantined.items).toEqual([]);
    expect(quarantined).toMatchObject({ threshold: null, thresholdCode: 'notify.quarantine_threshold_unset' });
    const active = await service.operatorRecipients('active', 50);
    expect(active.items.map((r) => r.state)).toEqual(['active']);
  });

  it('does not count a failure that will be retried, and a success resets the count', async () => {
    const { email, dispatcher, health } = await harness(2);
    email.mode = 'transient';
    expect(emailOutcome(await dispatcher.dispatch(note()))).toMatchObject({ status: 'failed', retryable: true });
    expect(await health.quarantineOf(USER, 'email', ADDRESS)).toBeNull();

    email.mode = 'reject';
    await dispatcher.dispatch(note());
    email.mode = 'ok';
    await dispatcher.dispatch(note());
    email.mode = 'reject';
    await dispatcher.dispatch(note());
    // reject, ok, reject: never two in a row.
    expect(await health.quarantineOf(USER, 'email', ADDRESS)).toBeNull();
  });

  it('redelivering the same notification does not count the same failure again', async () => {
    const { dispatcher, health } = await harness(3);
    const same = note();
    for (let i = 0; i < 4; i += 1) await dispatcher.dispatch(same);
    expect(await health.quarantineOf(USER, 'email', ADDRESS)).toBeNull();
    const rows = await health.list('active', 10);
    expect(rows[0]).toMatchObject({ consecutiveFailures: 1 });
  });

  it('treats an address as not quarantined when the health store cannot answer', async () => {
    const email = new ScriptedEmail();
    email.mode = 'ok';
    const registry = new ChannelRegistry([
      new InAppChannel(),
      email,
      new UnconfiguredChannel('push', ['A', 'B']),
      new UnconfiguredChannel('sms', ['A', 'B']),
    ]);
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: ADDRESS,
      locale: 'en',
      verifyTokenHash: 'h',
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });
    await targets.markVerified(USER, 'email', 'h', new Date());
    const dispatcher = new NotificationDispatcher(registry, targets, new MemoryDeliveryStore(), {
      maxAttempts: 3,
      outOfAppEnabled: true,
      recipientHealth: {
        quarantineOf: async () => {
          throw new Error('db down');
        },
        record: async () => undefined,
      },
    });
    expect(emailOutcome(await dispatcher.dispatch(note()))).toMatchObject({ status: 'accepted' });
  });

  it('a changed address starts clean', async () => {
    const { dispatcher, health } = await harness(1);
    await dispatcher.dispatch(note());
    expect(await health.quarantineOf(USER, 'email', ADDRESS)).not.toBeNull();
    expect(await health.quarantineOf(USER, 'email', 'new@example.com')).toBeNull();
  });

  it('lists recipients by state with masked addresses', async () => {
    const { dispatcher, service, targets } = await harness(1);
    await targets.upsert({
      userId: 'user-2',
      channel: 'email',
      address: 'bob@example.com',
      locale: 'en',
      verifyTokenHash: 'x',
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });
    await dispatcher.dispatch(note());
    const q = await service.operatorRecipients('quarantined', 50);
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toMatchObject({ userId: USER, address: 'a***@example.com', state: 'quarantined', consecutiveFailures: 1 });
    expect(JSON.stringify(q)).not.toContain(ADDRESS);
    const u = await service.operatorRecipients('unconfirmed', 50);
    expect(u.items.map((r) => r.userId)).toEqual(['user-2']);
  });

  it('refuses a release with no reason, an unknown recipient, and one that is not quarantined', async () => {
    const { dispatcher, service } = await harness(2);
    await expect(
      service.operatorReleaseRecipient('op', { userId: USER, channel: 'email', reason: ' ', reasonId: 'r' }),
    ).rejects.toMatchObject({
      code: 'notify.release_reason_required',
    });
    await expect(
      service.operatorReleaseRecipient('op', { userId: 'nobody', channel: 'email', reason: 'because', reasonId: 'r' }),
    ).rejects.toMatchObject({
      code: 'notify.recipient_unknown',
    });
    await dispatcher.dispatch(note());
    await expect(
      service.operatorReleaseRecipient('op', { userId: USER, channel: 'email', reason: 'because', reasonId: 'r2' }),
    ).rejects.toBeInstanceOf(RecipientHealthError);
    await expect(
      service.operatorReleaseRecipient('op', { userId: USER, channel: 'email', reason: 'because', reasonId: 'r2' }),
    ).rejects.toMatchObject({
      code: 'notify.recipient_not_quarantined',
    });
  });

  it('masks addresses', () => {
    expect(maskAddress('ada@example.com')).toBe('a***@example.com');
    expect(maskAddress('+447700900000')).toBe('+44***0000');
    expect(maskAddress('abc')).toBe('***');
  });

  it('a health write that throws does not change the delivery outcome', async () => {
    const email = new ScriptedEmail();
    email.mode = 'ok';
    const registry = new ChannelRegistry([
      new InAppChannel(),
      email,
      new UnconfiguredChannel('push', ['A', 'B']),
      new UnconfiguredChannel('sms', ['A', 'B']),
    ]);
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: ADDRESS,
      locale: 'en',
      verifyTokenHash: 'h',
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });
    await targets.markVerified(USER, 'email', 'h', new Date());
    const dispatcher = new NotificationDispatcher(registry, targets, new MemoryDeliveryStore(), {
      maxAttempts: 3,
      outOfAppEnabled: true,
      recipientHealth: {
        quarantineOf: async () => null,
        record: async () => {
          throw new Error('db down');
        },
      },
    });
    expect(emailOutcome(await dispatcher.dispatch(note()))).toMatchObject({ status: 'accepted' });
  });
});
