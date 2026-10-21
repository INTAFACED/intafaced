import { describe, expect, it } from 'vitest';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { MemoryDeliveryStore, MemoryTargetStore } from '../channel-store.js';
import { ChannelRefusal, type NotificationChannel, type OutboundMessage } from '../channels/channel.js';
import { InAppChannel, UnconfiguredChannel } from '../channels/gateway.js';
import { ChannelRegistry } from '../channels/registry.js';
import { NotificationDispatcher } from '../dispatch.js';
import { MemoryCommandLog } from '../preferences/account.js';
import type { NoticeApprovalConsumer } from '../notices/board.js';
import type { Notification } from '../store.js';
import { ChannelSettings, MemoryChannelSettingsStore } from './channel-settings.js';
import { OpsConfigError } from './four-eyes.js';
import {
  MemoryTemplateStore,
  MessageTemplates,
  TEMPLATE_FIELDS,
  TEMPLATE_KEYS,
  renderTemplateRow,
  sampleValues,
  validateTemplateCopy,
  type TemplateSendDeps,
} from './templates.js';

/**
 * Seam: owner channel settings and identity message templates. Every change needs
 * a second person; the copy in this file is the test's own, the service seeds none.
 */

const ACTOR = 'actor-1';
const SECOND = 'actor-2';

class Approvals implements NoticeApprovalConsumer {
  readonly seen: ActionApprovalConsumeInput[] = [];
  constructor(
    private readonly approverId: string | null,
    private readonly kind: ActionApproval['kind'] = undefined as never,
  ) {}
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    if (this.seen.some((s) => s.approvalId === input.approvalId)) throw new Error('already consumed');
    this.seen.push(input);
    return {
      approvalId: input.approvalId,
      actionType: 'notify.config',
      targetService: input.targetService,
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      payloadHash: input.payloadHash,
      requesterId: ACTOR,
      approverId: this.approverId,
      policyVersion: 'v1',
      createdAt: '2026-10-20T00:00:00.000Z',
      expiresAt: '2026-10-20T01:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
      ...(this.kind ? { kind: this.kind } : {}),
    } as ActionApproval;
  }
}

const status = (configured: Record<string, boolean>) => () =>
  (['inapp', 'email', 'push', 'sms'] as const).map((channel) => ({
    channel,
    configured: channel === 'inapp' || (configured[channel] ?? false),
    available: false,
    reason: null,
    requires: configured[channel] ? [] : [`NOTIFY_${channel.toUpperCase()}_GATEWAY_URL`],
    required: false,
    socket: null,
  }));

const change = (n: number, extra: Record<string, unknown> = {}) => ({
  clientRequestId: `req-${n}`,
  approvalId: `approval-${n}`,
  operationId: `op-${n}`,
  ...extra,
});

function settings(approvals: NoticeApprovalConsumer | null, configured: Record<string, boolean> = { email: true }) {
  return new ChannelSettings(new MemoryChannelSettingsStore(), approvals, new MemoryCommandLog(), status(configured) as never);
}

describe('channel settings', () => {
  it('shows configured:false and an unconfigured channel stays undeliverable', async () => {
    const rows = await settings(new Approvals(SECOND)).get();
    expect(rows.find((r) => r.channel === 'sms')).toMatchObject({
      configured: false,
      enabled: null,
      effective: 'unconfigured',
      notConnected: 'vendor.sms',
      requires: ['NOTIFY_SMS_GATEWAY_URL'],
    });
    expect(rows.find((r) => r.channel === 'email')).toMatchObject({ configured: true, effective: 'sending', notConnected: null });
  });

  it('refuses a change with no approval consumer, and by the same person', async () => {
    await expect(settings(null).set(ACTOR, { channel: 'email', enabled: false, ...change(1) })).rejects.toMatchObject({
      code: 'notify.approval_unavailable',
    });
    await expect(settings(new Approvals(ACTOR)).set(ACTOR, { channel: 'email', enabled: false, ...change(2) })).rejects.toMatchObject({
      code: 'notify.approval_same_operator',
    });
    await expect(settings(new Approvals(null)).set(ACTOR, { channel: 'email', enabled: false, ...change(3) })).rejects.toMatchObject({
      code: 'notify.approval_same_operator',
    });
  });

  it('binds the approval to this exact change and version', async () => {
    const approvals = new Approvals(SECOND);
    const service = settings(approvals);
    const proposal = await service.proposal({ channel: 'email', enabled: false, adapter: 'mail-primary' });
    await service.set(ACTOR, { channel: 'email', enabled: false, adapter: 'mail-primary', ...change(1) });
    expect(approvals.seen[0]).toMatchObject({
      payloadHash: proposal.payloadHash,
      targetId: 'email',
      expectedVersion: '0',
      targetService: 'svc-notify',
    });
    const next = await service.proposal({ channel: 'email', enabled: false, adapter: 'mail-primary' });
    expect(next.expectedVersion).toBe('1');
    expect(next.payloadHash).not.toBe(proposal.payloadHash);
  });

  it('switches a channel off, records the adapter, and replays a lost reply', async () => {
    const service = settings(new Approvals(SECOND));
    const first = await service.set(ACTOR, { channel: 'email', enabled: false, adapter: ' mail-primary ', ...change(1) });
    expect(first).toMatchObject({ enabled: false, adapter: 'mail-primary', version: 1, effective: 'disabled' });
    expect([...(await service.disabled())]).toEqual(['email']);
    const replay = await service.set(ACTOR, { channel: 'email', enabled: false, adapter: ' mail-primary ', ...change(1) });
    expect(replay).toEqual(first);
    expect((await service.history('email')).map((r) => r.version)).toEqual([1]);
  });

  it('spends an approval once and refuses a bad adapter name', async () => {
    const service = settings(new Approvals(SECOND));
    await service.set(ACTOR, { channel: 'email', enabled: false, ...change(1) });
    await expect(service.set(ACTOR, { channel: 'push', enabled: false, ...change(2, { approvalId: 'approval-1' }) })).rejects.toMatchObject(
      {
        code: 'notify.approval_spent',
      },
    );
    await expect(service.set(ACTOR, { channel: 'sms', enabled: true, adapter: 'Not Valid!', ...change(3) })).rejects.toMatchObject({
      code: 'notify.channel_adapter_invalid',
    });
  });

  it('cannot make an unconfigured channel send', async () => {
    const service = settings(new Approvals(SECOND), {});
    const row = await service.set(ACTOR, { channel: 'sms', enabled: true, ...change(1) });
    expect(row).toMatchObject({ enabled: true, effective: 'unconfigured' });
  });
});

describe('dispatch honours an owner-disabled channel', () => {
  const note = {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'user-1',
    kind: 'bank.margin_call',
    severity: 'critical',
    titleKey: 'notify.bank.margin_call.title',
    bodyKey: 'notify.bank.margin_call.body',
    params: {},
    href: null,
    readAt: null,
    sourceSubject: 'intafaced.bank.margin_call.created',
    sourceIdempotencyKey: 'loan-1:1',
    createdAt: new Date(),
  } as Notification;

  it('refuses channel.disabled for the switched-off channel only', async () => {
    const delivered: string[] = [];
    const gateway = (channel: 'email' | 'push' | 'sms'): NotificationChannel => ({
      channel,
      unavailableReason: null,
      async deliver(message: OutboundMessage) {
        delivered.push(message.channel);
        return { reference: null };
      },
    });
    const registry = new ChannelRegistry([
      new InAppChannel(),
      gateway('email'),
      gateway('push'),
      new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL']),
    ]);
    const targets = new MemoryTargetStore();
    for (const channel of ['email', 'push'] as const) {
      await targets.upsert({
        userId: 'user-1',
        channel,
        address: `${channel}@example.test`,
        locale: 'en',
        verifyTokenHash: 'h',
        verifyExpiresAt: new Date(Date.now() + 60_000),
      });
      await targets.markVerified('user-1', channel, 'h', new Date());
    }
    const dispatcher = new NotificationDispatcher(registry, targets, new MemoryDeliveryStore(), {
      maxAttempts: 3,
      outOfAppEnabled: true,
      disabledChannels: async () => new Set(['email']),
    });
    const report = await dispatcher.dispatch(note);
    expect(report.outcomes.find((o) => o.channel === 'email')).toMatchObject({ status: 'refused', code: 'channel.disabled' });
    expect(report.outcomes.find((o) => o.channel === 'push')).toMatchObject({ status: 'accepted' });
    expect(delivered).toEqual(['push']);
  });
});

describe('template copy validation', () => {
  it('declares fields for every key and never an address or secret', () => {
    for (const key of TEMPLATE_KEYS) {
      expect(TEMPLATE_FIELDS[key]).toContain('brand');
      expect(TEMPLATE_FIELDS[key]).toContain('antiPhishingCode');
      expect(TEMPLATE_FIELDS[key]).not.toContain('address');
    }
  });

  it('refuses an unknown field, a stray brace, empty copy, an unknown key and a code message with no code', () => {
    expect(() => validateTemplateCopy('login_code', 'Hi', 'Code {{code}} for {{email}}')).toThrow(
      expect.objectContaining({ code: 'notify.template_variable_unknown' }),
    );
    expect(() => validateTemplateCopy('login_code', 'Hi', 'Code {{code}} {oops}')).toThrow(
      expect.objectContaining({ code: 'notify.template_syntax_invalid' }),
    );
    expect(() => validateTemplateCopy('login_code', ' ', 'Code {{code}}')).toThrow(
      expect.objectContaining({ code: 'notify.template_copy_empty' }),
    );
    expect(() => validateTemplateCopy('nope', 'a', 'b')).toThrow(expect.objectContaining({ code: 'notify.template_key_unknown' }));
    expect(() => validateTemplateCopy('recovery_code', 'Hi', 'No code here')).toThrow(
      expect.objectContaining({ code: 'notify.template_variable_required' }),
    );
    expect(() => validateTemplateCopy('security_notice', 'Alert', 'Something happened {{eventSummary}}')).not.toThrow();
  });

  it('renders every field and refuses a missing one instead of guessing', () => {
    const row = {
      key: 'login_code',
      version: 3,
      subject: '{{brand}} code',
      body: '{{code}} {{antiPhishingCode}}',
      authorId: 'a',
      approvalId: 'x',
      createdAt: new Date(),
    } as const;
    expect(renderTemplateRow(row, { brand: 'B', code: '123456', antiPhishingCode: 'AP' })).toEqual({
      version: 3,
      subject: 'B code',
      body: '123456 AP',
    });
    expect(() => renderTemplateRow(row, { brand: 'B', code: '123456' })).toThrow(
      expect.objectContaining({ code: 'notify.template_variable_missing' }),
    );
    expect(() => renderTemplateRow(row, { brand: 'B', code: '', antiPhishingCode: 'AP' })).toThrow(OpsConfigError);
  });

  it('labels every sample value TEST or a placeholder, never a real-looking code', () => {
    for (const key of TEMPLATE_KEYS) {
      for (const value of Object.values(sampleValues(key))) expect(value === '000000' || value.startsWith('TEST')).toBe(true);
    }
  });
});

function templates(approvals: NoticeApprovalConsumer | null, send: TemplateSendDeps | null = null) {
  return new MessageTemplates(
    new MemoryTemplateStore(),
    approvals,
    new MemoryCommandLog(),
    send,
    () => new Date('2026-10-20T12:00:00.000Z'),
  );
}

const copy = (n: number) => ({ key: 'login_code', subject: `{{brand}} sign-in ${n}`, body: `Code {{code}} (v${n}). {{antiPhishingCode}}` });

describe('message templates', () => {
  it('refuses a template edit without a second person', async () => {
    await expect(templates(new Approvals(ACTOR)).set(ACTOR, { ...copy(1), ...change(1) })).rejects.toMatchObject({
      code: 'notify.approval_same_operator',
    });
    await expect(templates(null).set(ACTOR, { ...copy(1), ...change(1) })).rejects.toMatchObject({ code: 'notify.approval_unavailable' });
  });

  it('refuses an unknown variable at save and spends no approval', async () => {
    const approvals = new Approvals(SECOND);
    await expect(
      templates(approvals).set(ACTOR, { key: 'login_code', subject: 's', body: '{{code}} {{secret}}', ...change(1) }),
    ).rejects.toMatchObject({
      code: 'notify.template_variable_unknown',
    });
    expect(approvals.seen).toHaveLength(0);
  });

  it('appends versions; an in-flight send keeps the version it resolved', async () => {
    const service = templates(new Approvals(SECOND));
    await service.set(ACTOR, { ...copy(1), ...change(1) });
    const inFlight = await service.resolve('login_code');
    await service.set(ACTOR, { ...copy(2), ...change(2) });
    const values = { brand: 'B', code: '123456', antiPhishingCode: 'AP' };
    expect(renderTemplateRow(inFlight, values)).toMatchObject({ version: 1, body: 'Code 123456 (v1). AP' });
    expect(renderTemplateRow(await service.resolve('login_code'), values)).toMatchObject({ version: 2 });
    expect((await service.history('login_code')).map((r) => r.version)).toEqual([2, 1]);
    expect((await service.list()).find((t) => t.key === 'login_code')?.current?.version).toBe(2);
  });

  it('resolves nothing for a key with no saved version', async () => {
    await expect(templates(new Approvals(SECOND)).resolve('kyc_decision')).rejects.toMatchObject({ code: 'notify.template_unset' });
  });

  it('previews with TEST values and lets the caller override', async () => {
    const service = templates(new Approvals(SECOND));
    await service.set(ACTOR, { ...copy(1), ...change(1) });
    expect(await service.preview({ key: 'login_code' })).toEqual({
      sample: true,
      version: 1,
      subject: 'TEST brand sign-in 1',
      body: 'Code 000000 (v1). TEST-APC',
    });
    expect((await service.preview({ key: 'login_code', version: 1, values: { brand: 'Mine' } })).subject).toBe('Mine sign-in 1');
  });

  it('replays a lost reply and never spends the approval twice', async () => {
    const approvals = new Approvals(SECOND);
    const service = templates(approvals);
    const first = await service.set(ACTOR, { ...copy(1), ...change(1) });
    expect(await service.set(ACTOR, { ...copy(1), ...change(1) })).toEqual(first);
    expect(approvals.seen).toHaveLength(1);
  });
});

describe('template test-send', () => {
  function send(opts: { address?: string | null; disabled?: boolean; fail?: 'refuse' | 'throw' } = {}) {
    const sent: OutboundMessage[] = [];
    const asked: Array<[string, string]> = [];
    const deps: TemplateSendDeps = {
      verifiedAddress: async (userId, channel) => {
        asked.push([userId, channel]);
        return opts.address === null ? null : { address: opts.address ?? 'founder@example.test', locale: 'en' };
      },
      channel: (channel) => ({
        channel,
        unavailableReason: null,
        async deliver(message) {
          if (opts.fail === 'refuse') throw new ChannelRefusal(channel, 'channel.not_configured');
          if (opts.fail === 'throw') throw new Error('network');
          sent.push(message);
          return { reference: null };
        },
      }),
      status: status({ email: true }) as never,
      disabled: async () => new Set(opts.disabled ? ['email'] : []),
    };
    return { deps, sent, asked };
  }

  async function ready(deps: TemplateSendDeps) {
    const service = templates(new Approvals(SECOND), deps);
    await service.set(ACTOR, { ...copy(1), ...change(1) });
    return service;
  }

  it('sends TEST copy only to the caller own confirmed address', async () => {
    const { deps, sent, asked } = send();
    const result = await (await ready(deps)).testSend(ACTOR, { key: 'login_code', channel: 'email', clientRequestId: 't-1' });
    expect(result).toEqual({ status: 'accepted', code: null, version: 1 });
    expect(asked).toEqual([[ACTOR, 'email']]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ address: 'founder@example.test', userId: ACTOR, title: 'TEST: TEST brand sign-in 1' });
    expect(sent[0]?.body).toContain('000000');
  });

  it('refuses when the caller has no confirmed address, and sends nothing', async () => {
    const { deps, sent } = send({ address: null });
    await expect(
      (await ready(deps)).testSend(ACTOR, { key: 'login_code', channel: 'email', clientRequestId: 't-1' }),
    ).rejects.toMatchObject({
      code: 'notify.test_send_target_unverified',
    });
    expect(sent).toHaveLength(0);
  });

  it('refuses a switched-off channel, a gateway refusal, and reports an attempt that threw as failed', async () => {
    expect(
      await (await ready(send({ disabled: true }).deps)).testSend(ACTOR, { key: 'login_code', channel: 'email', clientRequestId: 't-1' }),
    ).toMatchObject({
      status: 'refused',
      code: 'channel.disabled',
    });
    expect(
      await (await ready(send({ fail: 'refuse' }).deps)).testSend(ACTOR, { key: 'login_code', channel: 'email', clientRequestId: 't-1' }),
    ).toMatchObject({
      status: 'refused',
      code: 'channel.not_configured',
    });
    expect(
      await (await ready(send({ fail: 'throw' }).deps)).testSend(ACTOR, { key: 'login_code', channel: 'email', clientRequestId: 't-1' }),
    ).toMatchObject({
      status: 'failed',
      code: null,
    });
  });

  it('does not send twice for one client request id', async () => {
    const { deps, sent } = send();
    const service = await ready(deps);
    await service.testSend(ACTOR, { key: 'login_code', channel: 'email', clientRequestId: 't-1' });
    await service.testSend(ACTOR, { key: 'login_code', channel: 'email', clientRequestId: 't-1' });
    expect(sent).toHaveLength(1);
  });

  it('refuses a key with no saved version', async () => {
    const service = templates(new Approvals(SECOND), send().deps);
    await expect(service.testSend(ACTOR, { key: 'kyc_decision', channel: 'email', clientRequestId: 't-1' })).rejects.toMatchObject({
      code: 'notify.template_unset',
    });
  });
});
