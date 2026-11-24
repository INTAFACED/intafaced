/**
 * J-ops-console-07 #10 (OPS-reconciliation-04): svc-ops' reconciliation alert transitions reach svc-notify, which keeps one
 * feed row per business key, so a transition received twice applies once. Nothing reaches a customer's inbox.
 */
import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryNotifyStore } from '../store.js';
import { NotifyService } from '../notify-service.js';
import { subscribeNotificationEvents } from '../events.js';
import { MemoryReconAlertFeedStore } from './feed.js';

const ALERT = '3f1c0a52-6a43-4f5e-9d9b-0d9a8a5f0c11';
const CONTROL = '7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const RUN = '0b1c2d3e-4f5a-4b6c-8d7e-8f9a0b1c2d3e';
const PASSING = '1c2d3e4f-5a6b-4c7d-8e8f-9a0b1c2d3e4f';
const FOUNDER = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const key = (n: number) => `ops:reconciliation-alert:${ALERT}:${n}`;

async function setup() {
  const store = new MemoryNotifyStore();
  const notify = new NotifyService(store, { fanoutEnabled: true });
  const feed = new MemoryReconAlertFeedStore();
  const bus = new MemoryEventBus('svc-ops');
  const report = await subscribeNotificationEvents(bus, notify, { reconAlertFeed: feed, now: () => new Date('2026-11-18T12:00:00Z') });
  return { notify, feed, bus, report };
}

const opened = {
  alertId: ALERT,
  sequence: 1,
  controlId: CONTROL,
  runId: RUN,
  assetId: 'USDT',
  periodStart: '2026-11-18T00:00:00.000Z',
  periodEnd: '2026-11-18T23:59:59.999Z',
  cause: 'fail' as const,
  team: 'finance' as const,
  openedAt: '2026-11-18T10:00:00.000Z',
};

describe('reconciliation alert feed', () => {
  it('attaches a consumer for each of the four transition subjects', async () => {
    const { report } = await setup();
    expect(report.pending).toEqual([]);
  });

  it('keeps each transition once however often it is delivered, in sequence order', async () => {
    const { feed, bus } = await setup();
    await bus.publish('coreOpsReconciliationAlertOpened', opened, { idempotencyKey: key(1) });
    const ack = {
      alertId: ALERT,
      sequence: 2,
      transition: 'acknowledged' as const,
      state: 'acknowledged' as const,
      actor: FOUNDER,
      changedAt: '2026-11-18T10:05:00.000Z',
    };
    await bus.publish('coreOpsReconciliationAlertUpdated', ack, { idempotencyKey: key(2) });
    await bus.publish('coreOpsReconciliationAlertUpdated', ack, { idempotencyKey: key(2) });
    const fixed = {
      alertId: ALERT,
      sequence: 3,
      resolution: 'fixed' as const,
      correctiveTxIds: [PASSING],
      passingRunId: null,
      actor: FOUNDER,
      resolvedAt: '2026-11-18T10:10:00.000Z',
    };
    await bus.publish('coreOpsReconciliationAlertResolved', fixed, { idempotencyKey: key(3) });
    // The same transition republished under a fresh key (a relay that lost its key) is still one row: (alert, sequence).
    await bus.publish('coreOpsReconciliationAlertResolved', fixed, { idempotencyKey: `${key(3)}:again` });
    const reopen = {
      alertId: ALERT,
      sequence: 4,
      transition: 'reopened' as const,
      state: 'open' as const,
      actor: 'auto',
      changedAt: '2026-11-18T11:00:00.000Z',
    };
    await bus.publish('coreOpsReconciliationAlertUpdated', reopen, { idempotencyKey: key(4) });
    await bus.publish('coreOpsReconciliationAlertUpdated', reopen, { idempotencyKey: key(4) });

    const rows = await feed.list(ALERT);
    expect(rows.map((r) => [r.sequence, r.kind, r.state, r.actor, r.eventKey])).toEqual([
      [1, 'opened', 'open', 'auto', key(1)],
      [2, 'acknowledged', 'acknowledged', FOUNDER, key(2)],
      [3, 'resolved', 'resolved', FOUNDER, key(3)],
      [4, 'reopened', 'open', 'auto', key(4)],
    ]);
    expect(rows[0]!.team).toBe('finance');
    expect(rows[0]!.receivedAt).toBe('2026-11-18T12:00:00.000Z');
  });

  it('names the second founder as the actor of an acceptance, and writes no customer inbox row', async () => {
    const { feed, bus, notify } = await setup();
    await bus.publish(
      'coreOpsReconciliationAlertAccepted',
      {
        alertId: ALERT,
        sequence: 5,
        requestedBy: FOUNDER,
        approvedBy: SECOND,
        evidenceHash: 'a'.repeat(64),
        noteHash: 'b'.repeat(64),
        acceptedAt: '2026-11-18T12:00:00.000Z',
      },
      { idempotencyKey: key(5) },
    );
    expect(await feed.list(ALERT)).toMatchObject([{ kind: 'accepted', state: 'accepted', actor: SECOND, team: null }]);
    for (const userId of [FOUNDER, SECOND]) expect((await notify.list({ userId, limit: 10, unreadOnly: false })).items).toEqual([]);
  });
});
