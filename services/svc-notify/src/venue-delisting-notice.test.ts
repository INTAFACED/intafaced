/**
 * J-cex-spot-16 #8: a scheduled venue delisting puts one dated notice in every customer's inbox, filed under the
 * delisting's own key, so a republish or redelivery adds nothing. The copy names the market and the date, not the venue.
 */
import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryNotifyStore } from './store.js';
import { NotifyService } from './notify-service.js';
import { subscribeNotificationEvents } from './events.js';
import { renderInboxCopy } from './channels/render.js';
import { VenueDelistingCopyUnsetError, noticeVenueDelisting } from './venue-delisting-notice.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

const scheduled = {
  venueId: 'test-venue-sim',
  symbol: 'ETH-USDC',
  delistsAt: '2026-12-01T00:00:00.000Z',
  scheduledAt: '2026-11-09T12:00:00.000Z',
  noticeKey: 'venue-delisting:test-venue-sim:ETH-USDC:2026-12-01T00:00:00.000Z',
};

async function setup() {
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  const bus = new MemoryEventBus('svc-trade');
  await subscribeNotificationEvents(bus, notify);
  return { notify, bus };
}

describe('venue delisting customer notice', () => {
  it('writes one dated notice every customer reads, once however often it is sent', async () => {
    const { notify, bus } = await setup();
    await bus.publish('venueDelistingScheduled', scheduled);
    await bus.publish('venueDelistingScheduled', scheduled);
    for (const userId of [U1, U2]) {
      const items = (await notify.list({ userId, limit: 10, unreadOnly: false })).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: 'trade.venue_delisting',
        titleKey: 'notify.trade.venue_delisting.title',
        bodyKey: 'notify.trade.venue_delisting.body',
        params: { symbol: 'ETH-USDC', delistsAt: '2026-12-01T00:00:00.000Z' },
        severity: 'action',
        sourceIdempotencyKey: scheduled.noticeKey,
      });
    }
  });

  it('names the market and the date in words, and never the venue', async () => {
    const { notify, bus } = await setup();
    await bus.publish('venueDelistingScheduled', scheduled);
    const row = (await notify.list({ userId: U1, limit: 10, unreadOnly: false })).items[0]!;
    const copy = renderInboxCopy(row, 'en');
    expect(copy.title).toContain('ETH-USDC');
    expect(copy.body).toContain('2026-12-01');
    expect(copy.body).not.toMatch(/^notify\./);
    expect(JSON.stringify(row.params)).not.toContain('test-venue-sim');
  });

  it('writes nothing and refuses by name when the copy keys are unset', async () => {
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
    const attempt = noticeVenueDelisting(notify, scheduled, () => false);
    await expect(attempt).rejects.toBeInstanceOf(VenueDelistingCopyUnsetError);
    await expect(attempt).rejects.toMatchObject({ code: 'notify.venue_delisting_copy_unset' });
    expect((await notify.list({ userId: U1, limit: 10, unreadOnly: false })).items).toHaveLength(0);
  });
});
