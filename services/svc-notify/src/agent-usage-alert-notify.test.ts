/**
 * J-agents-02 #6: an own agent whose spend this month reaches the alert its owner set puts one notice in the owner's
 * inbox, with the month's spend and the alert in words, once per agent and month however often svc-agents sends it.
 */
import { en } from '@intafaced/i18n';
import { MemoryEventBus } from '@intafaced/events';
import { describe, expect, it } from 'vitest';
import { subscribeNotificationEvents } from './events.js';
import { NotifyService } from './notify-service.js';
import { MemoryNotifyStore } from './store.js';

const OWNER = '11111111-1111-4111-8111-1111111111a1';
const OTHER = '22222222-2222-4222-8222-2222222222a2';
const AGENT = '33333333-3333-4333-8333-3333333333a3';

async function wired() {
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  const bus = new MemoryEventBus('svc-agents');
  await subscribeNotificationEvents(bus, notify);
  const inboxOf = async (userId: string) => (await notify.list({ userId, limit: 20, unreadOnly: false })).items;
  return { bus, inboxOf };
}

const crossed = (month: string, spent: string) => ({
  alertKey: `agents.usage_alert:${AGENT}:${month}`,
  userId: OWNER,
  agentId: AGENT,
  month,
  alertAt: '0.01',
  spent,
  assetId: 'USDT',
  email: true,
});

describe('own agent usage alert notice (J-agents-02 #6)', () => {
  it('the owner gets one inbox row for the month, linking to the agent, however often it is sent', async () => {
    const { bus, inboxOf } = await wired();
    await bus.publish('agentUsageAlertCrossed', crossed('2026-10', '0.0102'));
    await bus.publish('agentUsageAlertCrossed', crossed('2026-10', '0.0102'));
    const items = await inboxOf(OWNER);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'agents.usage_alert.crossed',
      titleKey: 'notify.agents.usage_alert.crossed.title',
      bodyKey: 'notify.agents.usage_alert.crossed.body',
      href: `/agents/${AGENT}`,
      params: { amount: '0.0102', alertAt: '0.01', asset: 'USDT', month: '2026-10' },
    });
    expect(await inboxOf(OTHER)).toHaveLength(0);
  });

  it('a new month is a new alert key, so it is a second row', async () => {
    const { bus, inboxOf } = await wired();
    await bus.publish('agentUsageAlertCrossed', crossed('2026-10', '0.0102'));
    await bus.publish('agentUsageAlertCrossed', crossed('2026-11', '0.011'));
    expect((await inboxOf(OWNER)).map((row) => row.params.month).sort()).toEqual(['2026-10', '2026-11']);
  });

  it('the title and body are words in the catalog, naming every param the row carries', () => {
    expect(en['notify.agents.usage_alert.crossed.title']).toBe('Agent spend passed your alert');
    const body: string = en['notify.agents.usage_alert.crossed.body'];
    for (const param of ['amount', 'alertAt', 'asset', 'month']) expect(body).toContain(`{${param}}`);
  });
});
