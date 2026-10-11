/**
 * Unit card — registerTarget refuses unpublished verify TTL (never invent 15)
 *
 * 1. Promise: blank / omitted verifyTtlMinutes throws notify.verify_ttl_unset
 *    before a code is minted. Owner-explicit 15 still sends.
 * 2. Break: `?? 15` publishes a brute-force window nobody set.
 * 3. Done bar: unset throws NotifyVerifyTtlUnsetError; 15 is allowed
 * 4. Class N
 * 5. Paths: services/svc-notify/src/notify-service.ts
 */
import { describe, expect, it } from 'vitest';
import { MemoryNotifyStore } from './store.js';
import { MemoryDeliveryStore, MemoryTargetStore } from './channel-store.js';
import { NotifyService, NotifyVerifyTtlUnsetError, NOTIFY_VERIFY_TTL_UNSET, publishedVerifyTtlMinutes } from './notify-service.js';
import { NotificationDispatcher } from './dispatch.js';
import { ChannelRegistry } from './channels/registry.js';
import { InAppChannel, UnconfiguredChannel } from './channels/gateway.js';

function deps() {
  const store = new MemoryNotifyStore();
  const targets = new MemoryTargetStore();
  const deliveries = new MemoryDeliveryStore();
  const channels = new ChannelRegistry([
    new InAppChannel(),
    new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']),
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]);
  const dispatcher = new NotificationDispatcher(channels, targets, deliveries, { maxAttempts: 3, outOfAppEnabled: true });
  return { store, targets, deliveries, channels, dispatcher };
}

describe('publishedVerifyTtlMinutes', () => {
  it('refuses unset / blank / out of 1..120 — never 15', () => {
    expect(() => publishedVerifyTtlMinutes(undefined)).toThrow(NotifyVerifyTtlUnsetError);
    expect(() => publishedVerifyTtlMinutes(null)).toThrow(NotifyVerifyTtlUnsetError);
    expect(() => publishedVerifyTtlMinutes(0)).toThrow(NotifyVerifyTtlUnsetError);
    expect(() => publishedVerifyTtlMinutes(121)).toThrow(NotifyVerifyTtlUnsetError);
    expect(() => publishedVerifyTtlMinutes(15.5)).toThrow(NotifyVerifyTtlUnsetError);
    try {
      publishedVerifyTtlMinutes(undefined);
    } catch (err) {
      expect(err).toBeInstanceOf(NotifyVerifyTtlUnsetError);
      expect((err as NotifyVerifyTtlUnsetError).code).toBe(NOTIFY_VERIFY_TTL_UNSET);
    }
  });

  it('owner-explicit 15 is allowed', () => {
    expect(publishedVerifyTtlMinutes(15)).toBe(15);
  });
});

describe('registerTarget verify TTL refuse', () => {
  it('omitted verifyTtlMinutes throws before minting a code', async () => {
    const { store, ...channelDeps } = deps();
    const notify = new NotifyService(store, { fanoutEnabled: true }, channelDeps);
    await expect(notify.registerTarget({ userId: 'u1', channel: 'email', address: 'a@b.c', locale: 'en' })).rejects.toBeInstanceOf(
      NotifyVerifyTtlUnsetError,
    );
    expect(await channelDeps.targets.list('u1')).toEqual([]);
  });

  it('owner-explicit 15 still registers (channel may refuse not_configured)', async () => {
    const { store, ...channelDeps } = deps();
    const notify = new NotifyService(
      store,
      { fanoutEnabled: true, verifyTtlMinutes: 15, verifyCodePepper: 'test-verify-pepper' },
      channelDeps,
    );
    const outcome = await notify.registerTarget({
      userId: 'u1',
      channel: 'email',
      address: 'a@b.c',
      locale: 'en',
    });
    expect(outcome.status).toBe('refused');
    if (outcome.status === 'refused') expect(outcome.code).toBe('channel.not_configured');
    const [row] = await channelDeps.targets.list('u1');
    expect(row?.address).toBe('a@b.c');
    expect(row?.verifiedAt).toBeNull();
  });
});
