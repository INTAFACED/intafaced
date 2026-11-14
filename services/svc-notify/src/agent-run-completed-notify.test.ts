/**
 * J-agents-06 #2: a background run of an agent session that finished puts one notice in the person's inbox, linking to
 * the run's page with its result, once per run however often svc-agents sends it. The channel the person asked for is
 * tried, and with no vendor for it the inbox row is still written. It never carries the run's reply.
 */
import { MemoryEventBus } from '@intafaced/events';
import { describe, expect, it } from 'vitest';
import { renderInboxCopy } from './channels/render.js';
import { subscribeNotificationEvents } from './events.js';
import { NotifyService } from './notify-service.js';
import { MemoryNotifyStore } from './store.js';

const PERSON = '11111111-1111-4111-8111-1111111111c1';
const OTHER = '22222222-2222-4222-8222-2222222222c2';
const SESSION = '44444444-4444-4444-8444-4444444444c4';
const RUN = '55555555-5555-4555-8555-5555555555c5';

async function wired() {
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
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

const completed = (notice: 'inapp' | 'email' | 'sms' | 'push') => ({
  runId: RUN,
  userId: PERSON,
  sessionId: SESSION,
  agentId: 'navigator',
  notice,
  finishedAt: '2026-11-14T09:00:00.000Z',
});

describe('background run finished notice (J-agents-06 #2)', () => {
  it('the person gets one inbox row per run, linking to the run, however often it is sent', async () => {
    const { bus, inboxOf } = await wired();
    await bus.publish('agentRunCompleted', completed('email'));
    await bus.publish('agentRunCompleted', completed('email'));
    const items = await inboxOf(PERSON);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'agents.run.completed',
      titleKey: 'notify.agents.run.completed.title',
      href: `/agents/runs/${RUN}`,
      sourceIdempotencyKey: RUN,
      params: { runId: RUN, agentId: 'navigator', finishedAt: '2026-11-14T09:00:00.000Z' },
    });
    expect(renderInboxCopy(items[0]!, 'en')).toEqual({ title: 'Your agent run finished', body: 'Open the run to read its result.' });
    expect(await inboxOf(OTHER)).toHaveLength(0);
  });

  it('email chosen asks for the email channel, so its delivery is recorded even with no mail vendor; in-app only stays in the inbox', async () => {
    const { bus, created } = await wired();
    await bus.publish('agentRunCompleted', completed('email'));
    expect(created[0]).toMatchObject({ outOfApp: true, askedChannels: ['email'] });
    const other = await wired();
    await other.bus.publish('agentRunCompleted', completed('inapp'));
    expect(other.created[0]!.outOfApp).toBe(false);
    expect(other.created[0]!.askedChannels).toBeUndefined();
  });
});
