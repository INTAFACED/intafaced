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
import { ChannelSettings, MemoryChannelSettingsStore } from './channel-settings.js';
import { MemoryTemplateStore, MessageTemplates } from './templates.js';

/** Seam: the admin doors for channel settings and templates, with scopes and typed refusals. */

const SECRET = 'notify-ops-config-edge-secret-value-long';
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

function open(wired: boolean) {
  const registry = new ChannelRegistry([
    new InAppChannel(),
    new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']),
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]);
  const targets = new MemoryTargetStore();
  const deliveries = new MemoryDeliveryStore();
  const commands = new MemoryCommandLog();
  const approvals = new Second();
  const notify = new NotifyService(
    new MemoryNotifyStore(),
    { fanoutEnabled: true },
    {
      targets,
      deliveries,
      channels: registry,
      dispatcher: new NotificationDispatcher(registry, targets, deliveries, { maxAttempts: 3, outOfAppEnabled: false }),
      ...(wired
        ? {
            channelSettings: new ChannelSettings(new MemoryChannelSettingsStore(), approvals, commands, () => registry.status()),
            templates: new MessageTemplates(new MemoryTemplateStore(), approvals, commands, null),
          }
        : {}),
    },
  );
  const router = createNotifyRouter(notify);
  return {
    admin: router.createCaller(signed(ADMIN, ['admin:read', 'admin:write'])),
    reader: router.createCaller(signed(ADMIN, ['admin:read'])),
    member: router.createCaller(signed(ADMIN, ['notify:read', 'notify:write'])),
  };
}

describe('channel settings and template doors', () => {
  it('refuse a customer principal and a read-only operator for writes', async () => {
    const { member, reader } = open(true);
    await expect(member.notify.channelSettings()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(member.notify.templates()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      reader.notify.setChannelSettings({ channel: 'email', enabled: false, clientRequestId: 'r', approvalId: 'a', operationId: 'o' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reader.notify.testSendTemplate({ key: 'login_code', channel: 'email', clientRequestId: 'r' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('say unavailable by name when the stores are not wired', async () => {
    const { admin } = open(false);
    await expect(admin.notify.channelSettings()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.channel_settings_unavailable',
    });
    await expect(admin.notify.templates()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'notify.templates_unavailable' });
  });

  it('change a channel and a template end to end, with typed refusals', async () => {
    const { admin, reader } = open(true);
    const channels = await reader.notify.channelSettings();
    expect(channels.map((c) => [c.channel, c.configured, c.effective])).toEqual([
      ['email', false, 'unconfigured'],
      ['push', false, 'unconfigured'],
      ['sms', false, 'unconfigured'],
    ]);
    const proposal = await reader.notify.channelSettingProposal({ channel: 'email', enabled: false });
    expect(proposal).toMatchObject({ targetId: 'email', expectedVersion: '0' });
    expect(
      await admin.notify.setChannelSettings({
        channel: 'email',
        enabled: false,
        adapter: 'mail-primary',
        clientRequestId: 'c1',
        approvalId: 'a1',
        operationId: 'o1',
      }),
    ).toMatchObject({ enabled: false, adapter: 'mail-primary', version: 1 });
    await expect(
      admin.notify.setChannelSettings({
        channel: 'push',
        enabled: true,
        adapter: 'Bad Name',
        clientRequestId: 'c2',
        approvalId: 'a2',
        operationId: 'o2',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'notify.channel_adapter_invalid' });

    await expect(
      admin.notify.setTemplate({
        key: 'login_code',
        subject: 's',
        body: '{{code}} {{nope}}',
        clientRequestId: 't1',
        approvalId: 'a3',
        operationId: 'o3',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'notify.template_variable_unknown' });
    const saved = await admin.notify.setTemplate({
      key: 'login_code',
      subject: '{{brand}} sign-in',
      body: 'Code {{code}}. {{antiPhishingCode}}',
      clientRequestId: 't2',
      approvalId: 'a4',
      operationId: 'o4',
    });
    expect(saved.current).toMatchObject({ version: 1, authorId: ADMIN });
    expect(await reader.notify.previewTemplate({ key: 'login_code' })).toMatchObject({
      sample: true,
      version: 1,
      body: 'Code 000000. TEST-APC',
    });
    expect((await reader.notify.templateHistory({ key: 'login_code' })).map((r) => r.version)).toEqual([1]);
    expect((await reader.notify.templates()).find((t) => t.key === 'kyc_decision')?.current).toBeNull();
    await expect(admin.notify.testSendTemplate({ key: 'login_code', channel: 'email', clientRequestId: 'ts1' })).rejects.toMatchObject({
      message: 'notify.test_send_unavailable',
    });
  });
});
