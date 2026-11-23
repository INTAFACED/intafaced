/**
 * J-derivatives-06 #6: a margin alert, margin call or liquidation alert on the person's own venue position puts one row
 * in their inbox per crossing, however often svc-trade publishes it, in words naming every figure, and never the venue.
 */
import { en } from '@intafaced/i18n';
import { MemoryEventBus } from '@intafaced/events';
import { describe, expect, it } from 'vitest';
import { subscribeNotificationEvents } from './events.js';
import { NotifyService } from './notify-service.js';
import { MemoryNotifyStore } from './store.js';

const PERSON = '44444444-4444-4444-8444-4444444444b4';
const OTHER = '55555555-5555-4555-8555-5555555555b5';
const OWNER = '0x1111111111111111111111111111111111111111';

async function wired() {
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  const bus = new MemoryEventBus('svc-trade');
  await subscribeNotificationEvents(bus, notify);
  const inboxOf = async (userId: string) => (await notify.list({ userId, limit: 20, unreadOnly: false })).items;
  return { bus, inboxOf };
}

const raised = (sequence: number, kind: 'margin' | 'margin_call' | 'liquidation') => ({
  alertKey: `risk:${PERSON}:test-venue-sim:${OWNER}:BTC-PERP:${sequence}`,
  userId: PERSON,
  symbol: 'BTC-PERP',
  kind,
  asset: 'USDC',
  level: kind === 'margin' ? '100' : kind === 'margin_call' ? '50' : '100',
  marginWithResult: '9.5',
  marginRatio: kind === 'margin' ? '31.6' : '63.26',
  asked: kind === 'margin' ? null : '2.52',
  raisedAt: '2026-11-24T02:00:00.000Z',
});

describe('venue risk alert notice (J-derivatives-06 #6)', () => {
  it('one inbox row per crossing, however often it is published, for the person only', async () => {
    const { bus, inboxOf } = await wired();
    await bus.publish('venueRiskAlerted', raised(1, 'margin_call'));
    await bus.publish('venueRiskAlerted', raised(1, 'margin_call'));
    const items = await inboxOf(PERSON);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'trade.risk.margin_call',
      titleKey: 'notify.trade.risk.margin_call.title',
      bodyKey: 'notify.trade.risk.margin_call.body',
      params: { symbol: 'BTC-PERP', asset: 'USDC', level: '50', ratio: '63.26', asked: '2.52' },
      href: '/trade/positions',
    });
    expect(await inboxOf(OTHER)).toHaveLength(0);
  });

  it('each kind is its own row, and a new crossing is a new row', async () => {
    const { bus, inboxOf } = await wired();
    await bus.publish('venueRiskAlerted', raised(1, 'margin'));
    await bus.publish('venueRiskAlerted', raised(2, 'liquidation'));
    await bus.publish('venueRiskAlerted', raised(3, 'liquidation'));
    const kinds = (await inboxOf(PERSON)).map((r) => r.kind).sort();
    expect(kinds).toEqual(['trade.risk.liquidation', 'trade.risk.liquidation', 'trade.risk.margin']);
  });

  it('the words name every param the row carries, and no venue', () => {
    const words: [string, string, readonly string[]][] = [
      [en['notify.trade.risk.margin.title'], en['notify.trade.risk.margin.body'], ['symbol', 'margin', 'asset', 'level']],
      [en['notify.trade.risk.margin_call.title'], en['notify.trade.risk.margin_call.body'], ['symbol', 'ratio', 'level', 'asked', 'asset']],
      [en['notify.trade.risk.liquidation.title'], en['notify.trade.risk.liquidation.body'], ['symbol', 'ratio', 'level', 'asked', 'asset']],
    ];
    for (const [title, body, params] of words) {
      expect(title).toContain('{symbol}');
      for (const p of params) expect(body).toContain(`{${p}}`);
      expect(`${title} ${body}`).not.toMatch(/hyperliquid/i);
    }
  });
});
