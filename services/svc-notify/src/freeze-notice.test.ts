import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryNotifyStore } from './store.js';
import { NotifyService } from './notify-service.js';
import { subscribeNotificationEvents } from './events.js';
import { FreezeCopyUnsetError, noticeFreezeChange } from './freeze-notice.js';
import { renderInboxCopy } from './channels/render.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const REASON = 'reconciliation drift on account 4471 (secret-internal-detail)';

async function setup() {
  const store = new MemoryNotifyStore();
  const notify = new NotifyService(store, { fanoutEnabled: true });
  const bus = new MemoryEventBus('svc-ledger');
  await subscribeNotificationEvents(bus, notify);
  return { notify, bus };
}

const frozen = { frozen: true, reason: REASON, actor: 'op-secret-actor', changedAt: '2026-10-20T12:00:00.000Z' };
const cleared = { frozen: false, reason: null, actor: 'op-secret-actor', changedAt: '2026-10-20T13:00:00.000Z' };

describe('posting freeze customer notice', () => {
  it('writes one system notice that every user’s inbox read includes', async () => {
    const { notify, bus } = await setup();
    await bus.publish('ledgerFreezeUpdated', frozen);
    for (const userId of [U1, U2]) {
      const page = await notify.list({ userId, limit: 10, unreadOnly: false });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ kind: 'ledger.freeze.set', severity: 'action', readAt: null });
      expect(await notify.unreadCount(userId)).toBe(1);
    }
  });

  it('the same event delivered twice leaves one row', async () => {
    const { notify, bus } = await setup();
    await bus.publish('ledgerFreezeUpdated', frozen);
    await bus.publish('ledgerFreezeUpdated', frozen);
    expect((await notify.list({ userId: U1, limit: 10, unreadOnly: false })).items).toHaveLength(1);
  });

  it('a cleared event adds a cleared notice and the first stays in history', async () => {
    const { notify, bus } = await setup();
    await bus.publish('ledgerFreezeUpdated', frozen);
    await bus.publish('ledgerFreezeUpdated', cleared);
    const kinds = (await notify.list({ userId: U1, limit: 10, unreadOnly: false })).items.map((r) => r.kind).sort();
    expect(kinds).toEqual(['ledger.freeze.cleared', 'ledger.freeze.set']);
  });

  it('reading is per user', async () => {
    const { notify, bus } = await setup();
    await bus.publish('ledgerFreezeUpdated', frozen);
    expect(await notify.markAllRead(U1)).toBe(1);
    expect(await notify.unreadCount(U1)).toBe(0);
    expect(await notify.unreadCount(U2)).toBe(1);
  });

  it('never shows the internal reason or actor, in params or copy', async () => {
    const { notify, bus } = await setup();
    await bus.publish('ledgerFreezeUpdated', frozen);
    const row = (await notify.list({ userId: U1, limit: 10, unreadOnly: false })).items[0]!;
    for (const locale of ['en', 'es', 'fr']) {
      const copy = renderInboxCopy(row, locale);
      expect(copy.title).not.toMatch(/^notify\./);
      expect(copy.body).not.toMatch(/^notify\./);
    }
    const wire = JSON.stringify(row);
    expect(wire).not.toContain('secret-internal-detail');
    expect(wire).not.toContain('op-secret-actor');
  });

  it('writes nothing and refuses by name when the copy keys are unset', async () => {
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
    const attempt = noticeFreezeChange(notify, { frozen: true, changedAt: frozen.changedAt }, () => false);
    await expect(attempt).rejects.toBeInstanceOf(FreezeCopyUnsetError);
    await expect(attempt).rejects.toMatchObject({ code: 'notify.freeze_copy_unset' });
    expect((await notify.list({ userId: U1, limit: 10, unreadOnly: false })).items).toHaveLength(0);
  });

  it('writes nothing when fan-out is killed, and still acks', async () => {
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: false });
    const bus = new MemoryEventBus('svc-ledger');
    await subscribeNotificationEvents(bus, notify);
    await bus.publish('ledgerFreezeUpdated', frozen);
    expect((await notify.list({ userId: U1, limit: 10, unreadOnly: false })).items).toHaveLength(0);
  });
});
