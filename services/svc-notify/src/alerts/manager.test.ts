/**
 * C-alerts-scan-02: the alert manager. Edit, stop, resume and delete an alert, memory engine and service rules.
 *
 * An edit is checked exactly as a create is (a blank owner setting still refuses). A stopped alert never fires and keeps its
 * place; resuming forgets the side a crossing was last seen on. Deleting works in any state and only for the owner.
 */

import { describe, expect, it } from 'vitest';
import { NotifyService } from '../notify-service.js';
import { MemoryNotifyStore } from '../store.js';
import { AlertLimitError, AlertNotEditableError, AlertService, type AlertLimits } from './service.js';
import { MemoryAlertStore } from './store.js';
import type { MarkSource } from './types.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const LATER = new Date('2026-10-20T13:00:00Z');
const LIMITS: AlertLimits = {
  maxExpiryDays: 30,
  textMaxLength: 40,
  maxConditions: 3,
  triggerLogDays: null,
  maxActivePrice: 20,
  repeatFrequencies: [],
  burstWindowMinutes: null,
  burstMaxTriggers: null,
};
const base = { userId: 'u1', marketId: 'BTC-USD', direction: 'above' as const, targetPrice: '100' };

function rig(limits: AlertLimits = LIMITS, price = '90') {
  const marks: MarkSource = { kind: 'live', quote: async (_m, at) => ({ kind: 'ok', price, at: at ?? new Date() }) };
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  return new AlertService(new MemoryAlertStore(), marks, notify, undefined, limits);
}

describe('edit', () => {
  it('changes the price and records when, leaving the rest as it was', async () => {
    const alerts = rig();
    const row = await alerts.create({ ...base, name: 'Breakout' }, NOW);
    const edited = await alerts.edit('u1', row.id, { targetPrice: '110' }, LATER);
    expect(edited).toMatchObject({ targetPrice: '110', name: 'Breakout', status: 'active', condition: 'greater_than' });
    expect(edited!.updatedAt).toEqual(LATER);
    expect(edited!.createdAt).toEqual(row.createdAt);
  });
  it('a new condition decides the direction, and the remembered side is forgotten', async () => {
    const alerts = rig();
    const row = await alerts.create({ ...base, condition: 'crossing_up' }, NOW);
    const edited = await alerts.edit('u1', row.id, { condition: 'less_than' }, LATER);
    expect(edited).toMatchObject({ condition: 'less_than', direction: 'below', lastSide: null });
  });
  it('null clears a name, message and expiry', async () => {
    const alerts = rig();
    const row = await alerts.create({ ...base, name: 'n', message: 'm', expiresAt: new Date(NOW.getTime() + 86_400_000) }, NOW);
    const edited = await alerts.edit('u1', row.id, { name: null, message: null, expiresAt: null }, LATER);
    expect(edited).toMatchObject({ name: null, message: null, expiresAt: null });
  });
  it('refuses a price that is not a positive decimal, and writes nothing', async () => {
    const alerts = rig();
    const row = await alerts.create(base, NOW);
    for (const targetPrice of ['0', '-1', '1e3', 'abc']) {
      await expect(alerts.edit('u1', row.id, { targetPrice }, LATER)).rejects.toBeInstanceOf(AlertLimitError);
    }
    expect((await alerts.get('u1', row.id))!.targetPrice).toBe('100');
  });
  it('is checked like a create: blank owner settings refuse, values outside a set one refuse', async () => {
    const blank = rig({
      maxExpiryDays: null,
      textMaxLength: null,
      maxConditions: null,
      triggerLogDays: null,
      maxActivePrice: 20,
      repeatFrequencies: [],
      burstWindowMinutes: null,
      burstMaxTriggers: null,
    });
    const row = await blank.create(base, NOW);
    await expect(blank.edit('u1', row.id, { message: 'hi' }, LATER)).rejects.toMatchObject({ code: 'notify.alert_text_limit_unset' });
    await expect(blank.edit('u1', row.id, { expiresAt: new Date(NOW.getTime() + 1e8) }, LATER)).rejects.toMatchObject({
      code: 'notify.alert_expiry_max_unset',
    });
    const set = rig();
    const other = await set.create(base, NOW);
    await expect(set.edit('u1', other.id, { name: 'x'.repeat(41) }, LATER)).rejects.toMatchObject({ code: 'alert.text_too_long' });
    await expect(set.edit('u1', other.id, { expiresAt: new Date(NOW.getTime() - 1) }, LATER)).rejects.toMatchObject({
      code: 'alert.expiry_in_past',
    });
  });
  it('refuses an alert that has triggered or been cancelled, and answers null for one that is not the person’s', async () => {
    const alerts = rig();
    const row = await alerts.create(base, NOW);
    await alerts.cancel('u1', row.id);
    await expect(alerts.edit('u1', row.id, { targetPrice: '120' }, LATER)).rejects.toBeInstanceOf(AlertNotEditableError);
    expect(await alerts.edit('someone-else', row.id, { targetPrice: '120' }, LATER)).toBeNull();
  });
});

describe('stop and resume', () => {
  it('a stopped alert does not fire; resuming brings it back with the rest intact', async () => {
    const alerts = rig(LIMITS, '120');
    const row = await alerts.create(base, NOW);
    const stopped = await alerts.setActive('u1', row.id, false, NOW);
    expect(stopped!.status).toBe('stopped');
    const report = await alerts.evaluateAlert('u1', row.id, NOW);
    expect(report.outcome).toMatchObject({ kind: 'refuse', code: 'alert.not_active' });
    expect((await alerts.get('u1', row.id))!.status).toBe('stopped');
    const resumed = await alerts.setActive('u1', row.id, true, LATER);
    expect(resumed).toMatchObject({ status: 'active', targetPrice: '100' });
    expect(resumed!.updatedAt).toEqual(LATER);
  });
  it('stopping twice or resuming an active alert is harmless', async () => {
    const alerts = rig();
    const row = await alerts.create(base, NOW);
    expect((await alerts.setActive('u1', row.id, true, NOW))!.status).toBe('active');
    await alerts.setActive('u1', row.id, false, NOW);
    expect((await alerts.setActive('u1', row.id, false, NOW))!.status).toBe('stopped');
  });
  it('a stopped alert past its expiry is expired, not resumed', async () => {
    const alerts = rig();
    const row = await alerts.create({ ...base, expiresAt: new Date(NOW.getTime() + 60_000) }, NOW);
    await alerts.setActive('u1', row.id, false, NOW);
    const after = await alerts.setActive('u1', row.id, true, LATER);
    expect(after!.status).toBe('expired');
  });
  it('a triggered or cancelled alert cannot be resumed or stopped', async () => {
    const alerts = rig();
    const row = await alerts.create(base, NOW);
    await alerts.cancel('u1', row.id);
    expect((await alerts.setActive('u1', row.id, true, NOW))!.status).toBe('cancelled');
    expect((await alerts.setActive('u1', row.id, false, NOW))!.status).toBe('cancelled');
  });
  it('can be cancelled while stopped, and is the owner’s alone', async () => {
    const alerts = rig();
    const row = await alerts.create(base, NOW);
    await alerts.setActive('u1', row.id, false, NOW);
    expect(await alerts.setActive('someone-else', row.id, true, NOW)).toBeNull();
    expect((await alerts.cancel('u1', row.id))!.status).toBe('cancelled');
  });
});

describe('delete', () => {
  it('removes an alert in any state, once, and only for its owner', async () => {
    const alerts = rig();
    const a = await alerts.create(base, NOW);
    const b = await alerts.create(base, NOW);
    await alerts.setActive('u1', b.id, false, NOW);
    expect(await alerts.remove('someone-else', a.id)).toBe(false);
    expect(await alerts.remove('u1', a.id)).toBe(true);
    expect(await alerts.remove('u1', a.id)).toBe(false);
    expect(await alerts.remove('u1', b.id)).toBe(true);
    expect(await alerts.list('u1')).toHaveLength(0);
  });
});
