/**
 * J-agents-05 #4: a held tool call of an own agent puts one notice in the owner's inbox, naming the action and linking
 * to the Approvals inbox, once per approval request however often svc-agents sends it. It never carries what the agent
 * wants to write.
 */
import { en } from '@intafaced/i18n';
import { MemoryEventBus } from '@intafaced/events';
import { describe, expect, it } from 'vitest';
import { renderInboxCopy } from './channels/render.js';
import { subscribeNotificationEvents } from './events.js';
import { NotifyService } from './notify-service.js';
import { MemoryNotifyStore } from './store.js';

const OWNER = '11111111-1111-4111-8111-1111111111b1';
const OTHER = '22222222-2222-4222-8222-2222222222b2';
const AGENT = '33333333-3333-4333-8333-3333333333b3';
const SESSION = '44444444-4444-4444-8444-4444444444b4';
const REQUEST = '55555555-5555-4555-8555-5555555555b5';
const EDITED = '66666666-6666-4666-8666-6666666666b6';

async function wired() {
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  /** What the consumer asked svc-notify to create, as sent. */
  const created: Parameters<NotifyService['create']>[0][] = [];
  const create = notify.create.bind(notify);
  notify.create = async (input) => {
    created.push(input);
    return create(input);
  };
  const bus = new MemoryEventBus('svc-agents');
  await subscribeNotificationEvents(bus, notify);
  const inboxOf = async (userId: string) => (await notify.list({ userId, limit: 20, unreadOnly: false })).items;
  return { bus, inboxOf, created };
}

const requested = (requestId: string, tool = 'support.ticket.comment') => ({
  requestId,
  userId: OWNER,
  agentId: AGENT,
  sessionId: SESSION,
  tool,
  expiresAt: '2026-11-06T01:00:00.000Z',
});

describe('own agent approval request notice (J-agents-05 #4)', () => {
  it('the owner gets one inbox row per request, naming the action and linking to the Approvals inbox, however often it is sent', async () => {
    const { bus, inboxOf, created } = await wired();
    await bus.publish('agentApprovalRequested', requested(REQUEST));
    await bus.publish('agentApprovalRequested', requested(REQUEST));
    const items = await inboxOf(OWNER);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'agents.approval.requested',
      titleKey: 'notify.agents.approval.requested.comment.title',
      bodyKey: 'notify.agents.approval.requested.body',
      href: '/agents/approvals',
      severity: 'action',
      sourceIdempotencyKey: REQUEST,
      params: { tool: 'support.ticket.comment', requestId: REQUEST, agentId: AGENT, expiresAt: '2026-11-06T01:00:00.000Z' },
    });
    expect(renderInboxCopy(items[0]!, 'en')).toEqual({
      title: 'Your agent wants to send a comment',
      body: 'It waits for your approval in the Approvals inbox. Nothing runs until you approve it.',
    });
    // It asks the person to act before the request expires, so it goes out of app: the push channel is attempted.
    expect(created.map((input) => input.outOfApp)).toEqual([true, true]);
    expect(await inboxOf(OTHER)).toHaveLength(0);
  });

  it('an edit is a new request, so it is a second row', async () => {
    const { bus, inboxOf } = await wired();
    await bus.publish('agentApprovalRequested', requested(REQUEST));
    await bus.publish('agentApprovalRequested', requested(EDITED));
    expect((await inboxOf(OWNER)).map((row) => row.sourceIdempotencyKey).sort()).toEqual([REQUEST, EDITED].sort());
  });

  it('a held tool with no title of its own reads the general title, never its raw id', async () => {
    const { bus, inboxOf } = await wired();
    await bus.publish('agentApprovalRequested', requested(REQUEST, 'support.ticket.close'));
    const [row] = await inboxOf(OWNER);
    expect(row!.titleKey).toBe('notify.agents.approval.requested.title');
    expect(renderInboxCopy(row!, 'en').title).toBe('Your agent wants to use a tool that needs your approval');
    expect(renderInboxCopy(row!, 'en').title).not.toContain('support.ticket');
    expect(en['notify.agents.approval.requested.title']).not.toContain('{tool}');
  });
});
