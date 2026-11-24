/**
 * J-agents-16 #3: an operator's agent alert rule that went above its threshold puts one notice in the inbox of the
 * operator who stored it, sent out of app, once per rule and window however often svc-agents hands it over.
 */
import { en } from '@intafaced/i18n';
import { MemoryEventBus } from '@intafaced/events';
import { describe, expect, it } from 'vitest';
import { subscribeNotificationEvents } from './events.js';
import { NotifyService } from './notify-service.js';
import { MemoryNotifyStore } from './store.js';

const OPERATOR = '44444444-4444-4444-8444-4444444444a4';
const OTHER = '55555555-5555-4555-8555-5555555555a5';
const ALERT = '66666666-6666-4666-8666-6666666666a6';

async function wired() {
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  const bus = new MemoryEventBus('svc-agents');
  await subscribeNotificationEvents(bus, notify);
  const inboxOf = async (userId: string) => (await notify.list({ userId, limit: 20, unreadOnly: false })).items;
  return { bus, inboxOf };
}

const fired = (windowStart: string, measure: 'refusal_rate' | 'cost' = 'refusal_rate') => ({
  alertKey: `agents.alert:r1:${windowStart}`,
  alertId: ALERT,
  userId: OPERATOR,
  ruleName: 'TEST refusals',
  measure,
  value: '25',
  threshold: '0',
  windowStart,
  windowEnd: '2026-11-15T15:00:00.000Z',
});

describe('operator agent alert notice (J-agents-16 #3)', () => {
  it('the operator gets one inbox row per rule and window, the rate in percent, however often it is handed over', async () => {
    const { bus, inboxOf } = await wired();
    await bus.publish('agentAlertFired', fired('2026-11-15T14:00:00.000Z'));
    await bus.publish('agentAlertFired', fired('2026-11-15T14:00:00.000Z'));
    const items = await inboxOf(OPERATOR);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'agents.alert.fired',
      titleKey: 'notify.agents.alert.fired.title',
      bodyKey: 'notify.agents.alert.fired.body',
      params: { rule: 'TEST refusals', measure: 'Refusal rate', value: '25%', threshold: '0%' },
    });
    expect(await inboxOf(OTHER)).toHaveLength(0);
  });

  it('a cost alert carries its figure without a percent sign; a new window is a second row', async () => {
    const { bus, inboxOf } = await wired();
    await bus.publish('agentAlertFired', fired('2026-11-15T14:00:00.000Z', 'cost'));
    await bus.publish('agentAlertFired', fired('2026-11-15T13:00:00.000Z', 'cost'));
    const items = await inboxOf(OPERATOR);
    expect(items).toHaveLength(2);
    expect(items.every((row) => row.params.value === '25' && row.params.measure === 'Cost in the fee asset')).toBe(true);
  });

  it('the title and body are words in the catalog, naming every param the row carries', () => {
    const body: string = en['notify.agents.alert.fired.body'];
    expect(en['notify.agents.alert.fired.title']).toContain('{rule}');
    for (const param of ['measure', 'value', 'from', 'to', 'threshold']) expect(body).toContain(`{${param}}`);
  });
});
