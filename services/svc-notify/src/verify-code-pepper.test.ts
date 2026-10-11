/**
 * Unit card — confirmation-code hashes are HMAC-SHA256 keyed by an owner pepper (L1170)
 *
 * 1. Promise: the stored digest is HMAC-SHA256(pepper, code), not bare SHA-256(code).
 *    Blank / missing pepper throws notify.verify_code_pepper_unset. No default pepper.
 * 2. Break: a leaked verify_token_hash of a 6-digit code reverses over 1e6 guesses.
 * 3. Done bar: store matches the peppered HMAC; a bare hash and a different pepper
 *    do not verify; blank refuses before a hash is written.
 * 4. Class N
 * 5. Paths: services/svc-notify/src/notify-service.ts, env.ts, index.ts, README.md
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createNotifyRouter } from './router.js';
import { MemoryNotifyStore } from './store.js';
import { MemoryDeliveryStore, MemoryTargetStore, type UpsertTargetInput } from './channel-store.js';
import { NotifyService, type NotifyServiceOptions } from './notify-service.js';
import { NotificationDispatcher } from './dispatch.js';
import { ChannelRegistry } from './channels/registry.js';
import { InAppChannel, UnconfiguredChannel } from './channels/gateway.js';
import type { DeliveryReceipt, NotificationChannel, OutboundMessage } from './channels/channel.js';

/** Fixture only. Never a production pepper and never a sample in README or env. */
const PEPPER = 'test-verify-pepper';
const OTHER_PEPPER = 'other-verify-pepper';

const USER = '11111111-1111-4111-8111-111111111111';

const BASE = {
  DATABASE_URL: 'postgres://svc_notify:svc_notify@localhost:5432/intafaced_notify_test',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: 'e'.repeat(40),
  SERVICE_NAME: 'svc-notify',
};

class CapturingTargetStore extends MemoryTargetStore {
  hashes: string[] = [];

  override async upsert(input: UpsertTargetInput) {
    this.hashes.push(input.verifyTokenHash);
    return super.upsert(input);
  }
}

class RecordingChannel implements NotificationChannel {
  readonly channel = 'email' as const;
  readonly unavailableReason = null;
  readonly bodies: string[] = [];

  async deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
    this.bodies.push(message.body);
    return { reference: 'ref-1' };
  }
}

function codeFrom(body: string): string {
  const match = body.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error('confirmation body has no six-digit code');
  return match[1];
}

function make(targets: CapturingTargetStore, channel: RecordingChannel, extra: Record<string, unknown> = {}) {
  const store = new MemoryNotifyStore();
  const deliveries = new MemoryDeliveryStore();
  const channels = new ChannelRegistry([
    new InAppChannel(),
    channel,
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]);
  const dispatcher = new NotificationDispatcher(channels, targets, deliveries, { maxAttempts: 3, outOfAppEnabled: true });
  const notify = new NotifyService(store, { fanoutEnabled: true, verifyTtlMinutes: 15, ...extra } as NotifyServiceOptions, {
    targets,
    deliveries,
    channels,
    dispatcher,
  });
  return notify;
}

const registerInput = { userId: USER, channel: 'email' as const, address: 'a@b.c', locale: 'en' };

describe('verify-code pepper', () => {
  it('stores HMAC-SHA256 keyed by the pepper, not a bare SHA-256 of the code', async () => {
    const targets = new CapturingTargetStore();
    const channel = new RecordingChannel();
    const notify = make(targets, channel, { verifyCodePepper: PEPPER });

    const outcome = await notify.registerTarget(registerInput);
    expect(outcome.status).toBe('sent');

    const code = codeFrom(channel.bodies[0]!);
    const bare = createHash('sha256').update(code).digest('hex');
    const keyed = createHmac('sha256', PEPPER).update(code).digest('hex');
    expect(targets.hashes.at(-1)).not.toBe(bare);
    expect(targets.hashes.at(-1)).toBe(keyed);
    expect(await notify.verifyTarget(USER, 'email', code)).toEqual({ status: 'verified' });
  });

  it('does not verify a bare hash or a digest made with a different pepper', async () => {
    const targets = new CapturingTargetStore();
    const channel = new RecordingChannel();
    const issued = make(targets, channel, { verifyCodePepper: PEPPER });
    const outcome = await issued.registerTarget(registerInput);
    expect(outcome.status).toBe('sent');

    const code = codeFrom(channel.bodies[0]!);
    const other = make(targets, channel, { verifyCodePepper: OTHER_PEPPER });
    expect(await other.verifyTarget(USER, 'email', code)).toEqual({ status: 'rejected' });

    const bare = createHash('sha256').update(code).digest('hex');
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'a@b.c',
      locale: 'en',
      verifyTokenHash: bare,
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(await issued.verifyTarget(USER, 'email', code)).toEqual({ status: 'rejected' });
  });

  it('blank or missing pepper refuses the hash call and writes nothing', async () => {
    for (const extra of [{}, { verifyCodePepper: '' }, { verifyCodePepper: '   ' }]) {
      const targets = new CapturingTargetStore();
      const channel = new RecordingChannel();
      const notify = make(targets, channel, extra);
      await expect(notify.registerTarget(registerInput)).rejects.toMatchObject({ code: 'notify.verify_code_pepper_unset' });
      expect(targets.hashes).toEqual([]);
      expect(await targets.list(USER)).toEqual([]);
      await expect(notify.verifyTarget(USER, 'email', '000000')).rejects.toMatchObject({ code: 'notify.verify_code_pepper_unset' });
    }
  });

  it.each(['register', 'verify'] as const)('the mounted %s door names an unset pepper before storage or delivery', async (operation) => {
    const targets = new CapturingTargetStore();
    const channel = new RecordingChannel();
    const notify = make(targets, channel);
    const secret = 'notify-pepper-router-fixture-secret-long';
    const principal = {
      sub: USER,
      userId: USER,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes: ['notify:read', 'notify:write'],
      tier: 'none',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal;
    const raw = encodePrincipal(principal);
    const context = createEdgeContext({ secret, serviceName: 'svc-notify' })({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, secret, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'pepper-refusal',
    });
    const caller = createNotifyRouter(notify).createCaller(context);
    const result =
      operation === 'register'
        ? caller.notify.registerTarget({ channel: 'email', address: 'borrower@example.test', locale: 'en' })
        : caller.notify.verifyTarget({ channel: 'email', code: '000000' });
    await expect(result).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'notify.verify_code_pepper_unset' } });
    expect(targets.hashes).toEqual([]);
    expect(await targets.list(USER)).toEqual([]);
    expect(channel.bodies).toEqual([]);
  });

  it('NOTIFY_VERIFY_CODE_PEPPER is required in env, blank is unpublished, no default', async () => {
    const root = resolve(import.meta.dirname, '../../..');
    const envTs = readFileSync(resolve(root, 'services/svc-notify/src/env.ts'), 'utf8');
    const readme = readFileSync(resolve(root, 'services/svc-notify/README.md'), 'utf8');
    expect(envTs).toMatch(/NOTIFY_VERIFY_CODE_PEPPER:\s*blankAsAbsent\(z\.string\(\)\.min\(1\)\.optional\(\)\)/);
    expect(envTs).not.toMatch(/NOTIFY_VERIFY_CODE_PEPPER[\s\S]{0,180}\.default\(/);
    expect(envTs).not.toContain(PEPPER);
    expect(readme).toMatch(/`NOTIFY_VERIFY_CODE_PEPPER`[\s\S]{0,400}Required/);
    expect(readme).toMatch(/`NOTIFY_VERIFY_CODE_PEPPER`[\s\S]{0,400}Blank refuses `notify\.verify_code_pepper_unset`/);
    expect(readme).toMatch(/`NOTIFY_VERIFY_CODE_PEPPER`[\s\S]{0,400}no default/);
    expect(readme).not.toContain(PEPPER);

    Object.assign(process.env, BASE);
    const { envSchema } = await import('./env.js');
    const unset = envSchema.safeParse({ ...BASE });
    expect(unset.success).toBe(true);
    if (!unset.success) throw unset.error;
    expect(unset.data.NOTIFY_VERIFY_CODE_PEPPER).toBeUndefined();
    const blank = envSchema.safeParse({ ...BASE, NOTIFY_VERIFY_CODE_PEPPER: '' });
    expect(blank.success).toBe(true);
    if (!blank.success) throw blank.error;
    expect(blank.data.NOTIFY_VERIFY_CODE_PEPPER).toBeUndefined();
    const spaces = envSchema.safeParse({ ...BASE, NOTIFY_VERIFY_CODE_PEPPER: '   ' });
    expect(spaces.success).toBe(true);
    if (!spaces.success) throw spaces.error;
    expect(spaces.data.NOTIFY_VERIFY_CODE_PEPPER).toBeUndefined();
    const set = envSchema.safeParse({ ...BASE, NOTIFY_VERIFY_CODE_PEPPER: PEPPER });
    expect(set.success).toBe(true);
    if (!set.success) throw set.error;
    expect(set.data.NOTIFY_VERIFY_CODE_PEPPER).toBe(PEPPER);
  });

  it('wires the pepper into the hash call and does not keep a bare SHA-256 of the code', () => {
    const root = resolve(import.meta.dirname, '../../..');
    const serviceTs = readFileSync(resolve(root, 'services/svc-notify/src/notify-service.ts'), 'utf8');
    const indexTs = readFileSync(resolve(root, 'services/svc-notify/src/index.ts'), 'utf8');
    expect(serviceTs).not.toMatch(/createHash\(/);
    expect(serviceTs).toMatch(/createHmac\('sha256'/);
    expect(serviceTs).toMatch(/notify\.verify_code_pepper_unset/);
    expect(serviceTs).not.toContain(PEPPER);
    expect(indexTs).toMatch(/verifyCodePepper:\s*env\.NOTIFY_VERIFY_CODE_PEPPER/);
  });
});
