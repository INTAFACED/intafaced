import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryDeliveryStore, MemoryTargetStore } from '../channel-store.js';
import { InAppChannel, UnconfiguredChannel } from '../channels/gateway.js';
import { ChannelRegistry } from '../channels/registry.js';
import { NotificationDispatcher } from '../dispatch.js';
import { MemoryCommandLog } from '../preferences/account.js';
import { NotifyService } from '../notify-service.js';
import { createNotifyRouter } from '../router.js';
import { MemoryNotifyStore } from '../store.js';
import type { NoticeApprovalConsumer } from '../notices/board.js';
import { OpsConfigError } from './four-eyes.js';
import { ContactPolicy, MemoryContactPolicyStore, validateContactPolicy, type ContactPolicyInput } from './contact-policy.js';

/**
 * Genuine-communication contact policy (BK-safe-02). The copy here is the test's own,
 * labelled TEST; the service seeds none.
 */

const SECRET = 'notify-contact-policy-edge-secret-value';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-notify' });
const ADMIN = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';

function signed(userId: string, scopes: string[]) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: `req-${userId}-${scopes.join('.')}`,
  });
}

class Second implements NoticeApprovalConsumer {
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    return {
      approvalId: input.approvalId,
      actionType: 'notify.config',
      targetService: input.targetService,
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      payloadHash: input.payloadHash,
      requesterId: ADMIN,
      approverId: SECOND,
      policyVersion: 'v1',
      createdAt: '2026-10-20T00:00:00.000Z',
      expiresAt: '2026-10-20T01:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    } as ActionApproval;
  }
}

class Same implements NoticeApprovalConsumer {
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    return { ...(await new Second().consume(input)), approverId: ADMIN } as ActionApproval;
  }
}

const POLICY: ContactPolicyInput = {
  officialDomains: ['Test.example', 'mail.test.example'],
  neverAskStatement: 'TEST never-ask statement',
  contactChannels: ['email', 'in_app'],
  smsCarriesLinks: false,
  phishingReport: 'TEST phishing report address',
};

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof OpsConfigError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof OpsConfigError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

const publishInput = (n: number, extra: Partial<ContactPolicyInput> = {}) => ({
  ...POLICY,
  ...extra,
  officialDomains: [...((extra.officialDomains ?? POLICY.officialDomains) as readonly string[])],
  contactChannels: [...((extra.contactChannels ?? POLICY.contactChannels) as readonly string[])],
  clientRequestId: `cp-${n}`,
  approvalId: `cp-appr-${n}`,
  operationId: `cp-op-${n}`,
});

describe('contact policy (BK-safe-02)', () => {
  it('reads not_published until the owner publishes, then the newest version', async () => {
    const policy = new ContactPolicy(
      new MemoryContactPolicyStore(),
      new Second(),
      new MemoryCommandLog(),
      () => new Date('2026-10-22T03:00:00.000Z'),
    );
    expect(await policy.current()).toEqual({ status: 'not_published' });
    const first = await policy.publish(ADMIN, publishInput(1));
    expect(first).toEqual({
      status: 'published',
      version: 1,
      publishedAt: '2026-10-22T03:00:00.000Z',
      officialDomains: ['test.example', 'mail.test.example'],
      neverAskStatement: 'TEST never-ask statement',
      contactChannels: ['email', 'in_app'],
      smsCarriesLinks: false,
      phishingReport: 'TEST phishing report address',
    });
    await policy.publish(ADMIN, publishInput(2, { smsCarriesLinks: true }));
    expect(await policy.current()).toMatchObject({ version: 2, smsCarriesLinks: true });
  });

  it('refuses every blank field instead of defaulting it', () => {
    for (const blank of [
      { officialDomains: [] },
      { officialDomains: null },
      { neverAskStatement: '  ' },
      { contactChannels: [] },
      { smsCarriesLinks: null },
      { phishingReport: '' },
    ] as Partial<ContactPolicyInput>[]) {
      expect(code(() => validateContactPolicy({ ...POLICY, ...blank }))).toBe('notify.contact_policy_field_unset');
    }
  });

  it('refuses a malformed domain, an unknown channel and over-long copy', () => {
    for (const bad of ['not a domain', 'https://test.example', 'test', '-bad.example']) {
      expect(code(() => validateContactPolicy({ ...POLICY, officialDomains: [bad] }))).toBe('notify.contact_policy_domain_invalid');
    }
    expect(
      code(() => validateContactPolicy({ ...POLICY, officialDomains: Array.from({ length: 21 }, (_, i) => `d${i}.test.example`) })),
    ).toBe('notify.contact_policy_domain_invalid');
    expect(code(() => validateContactPolicy({ ...POLICY, contactChannels: ['whatsapp'] }))).toBe('notify.contact_policy_channel_unknown');
    expect(code(() => validateContactPolicy({ ...POLICY, neverAskStatement: 'x'.repeat(2001) }))).toBe('notify.contact_policy_too_long');
    expect(code(() => validateContactPolicy({ ...POLICY, phishingReport: 'x'.repeat(2001) }))).toBe('notify.contact_policy_too_long');
  });

  it('needs a second person, refuses with no approval service, and spends an approval once', async () => {
    const same = new ContactPolicy(new MemoryContactPolicyStore(), new Same(), new MemoryCommandLog());
    expect(await refusal(same.publish(ADMIN, publishInput(1)))).toBe('notify.approval_same_operator');
    expect(await same.current()).toEqual({ status: 'not_published' });

    const none = new ContactPolicy(new MemoryContactPolicyStore(), null, new MemoryCommandLog());
    expect(await refusal(none.publish(ADMIN, publishInput(1)))).toBe('notify.approval_unavailable');

    const store = new MemoryContactPolicyStore();
    const policy = new ContactPolicy(store, new Second(), new MemoryCommandLog());
    await policy.publish(ADMIN, publishInput(1));
    expect(await refusal(policy.publish(ADMIN, { ...publishInput(2), approvalId: 'cp-appr-1' }))).toBe('notify.approval_spent');
    expect(await policy.current()).toMatchObject({ version: 1 });
  });

  it('replays a retried publish by its request id, success and refusal alike', async () => {
    const store = new MemoryContactPolicyStore();
    const policy = new ContactPolicy(store, new Second(), new MemoryCommandLog());
    const first = await policy.publish(ADMIN, publishInput(1));
    expect(await policy.publish(ADMIN, publishInput(1))).toEqual(first);
    expect(await policy.current()).toMatchObject({ version: 1 });
    expect(await refusal(policy.publish(ADMIN, publishInput(9, { phishingReport: '' })))).toBe('notify.contact_policy_field_unset');
    expect(await refusal(policy.publish(ADMIN, publishInput(9)))).toBe('notify.contact_policy_field_unset');
  });

  it('binds the approval to the exact copy and the version it replaces', async () => {
    const policy = new ContactPolicy(new MemoryContactPolicyStore(), new Second(), new MemoryCommandLog());
    const a = await policy.proposal(POLICY);
    const b = await policy.proposal({ ...POLICY, smsCarriesLinks: true });
    expect(a).toMatchObject({ targetId: 'contact_policy', expectedVersion: '0' });
    expect(a.payloadHash).not.toBe(b.payloadHash);
    await policy.publish(ADMIN, publishInput(1));
    expect((await policy.proposal(POLICY)).expectedVersion).toBe('1');
  });
});

describe('contact policy on the router', () => {
  function service(contactPolicy?: ContactPolicy) {
    const registry = new ChannelRegistry([
      new InAppChannel(),
      new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']),
      new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
      new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
    ]);
    const targets = new MemoryTargetStore();
    const deliveries = new MemoryDeliveryStore();
    const dispatcher = new NotificationDispatcher(registry, targets, deliveries, { maxAttempts: 3, outOfAppEnabled: false });
    return new NotifyService(
      new MemoryNotifyStore(),
      { fanoutEnabled: true },
      { targets, deliveries, channels: registry, dispatcher, ...(contactPolicy ? { contactPolicy } : {}) },
    );
  }

  it('reads signed out, publishes with admin:write only, and says when unwired', async () => {
    const wired = createNotifyRouter(service(new ContactPolicy(new MemoryContactPolicyStore(), new Second(), new MemoryCommandLog())));
    const anon = edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon-cp' });
    expect(await wired.createCaller(anon).notify.contactPolicy()).toEqual({ status: 'not_published' });
    await expect(wired.createCaller(signed(ADMIN, ['admin:read'])).notify.publishContactPolicy(publishInput(1))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      wired.createCaller(signed(ADMIN, ['admin:write'])).notify.publishContactPolicy(publishInput(2, { neverAskStatement: '' })),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'notify.contact_policy_field_unset' });
    const published = await wired.createCaller(signed(ADMIN, ['admin:write'])).notify.publishContactPolicy(publishInput(3));
    expect(published).toMatchObject({ status: 'published', version: 1 });
    expect(await wired.createCaller(anon).notify.contactPolicy()).toEqual(published);

    const unwired = createNotifyRouter(service());
    await expect(unwired.createCaller(anon).notify.contactPolicy()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.contact_policy_unavailable',
    });
  });
});
