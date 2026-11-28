/**
 * Class B growth pin — the consumer matrix must match the attach block.
 *
 * Promise: README + events.ts only grow when product law adds a subject with a
 * real publisher and a user principal (Engine A A3 / Engine B event-wiring).
 *
 * Break: a casual second attach without updating the matrix (or the reverse).
 * Done bar: matrix lists exactly the attached durables; skipped subjects named.
 * Class N. Paths: svc-notify only.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventBus } from '@intafaced/events';
import { describe, expect, it } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import {
  NOTIFY_EVENT_CONSUMERS,
  SKIPPED_NOTIFY_SUBJECTS,
  notifyEventConsumerCount,
  notifyEventDurableNames,
} from './event-wiring-matrix.js';
import { subscribeNotificationEvents } from './events.js';
import type { NotifyService } from './notify-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const readmeSource = readFileSync(join(here, '..', 'README.md'), 'utf8');

/** What subscribeNotificationEvents attaches, read off a bus that records each subscription (and, if asked, refuses it). */
async function attachedBy(refuse: boolean) {
  const subscriptions: Array<{ event: string; durable: string }> = [];
  const bus = partial<EventBus>({
    async subscribe(event, _handler, options) {
      subscriptions.push({ event, durable: options.durable });
      if (refuse) throw new Error(`no stream for ${event}`);
      return { unsubscribe: async () => undefined };
    },
    async close() {
      return undefined;
    },
  });
  const report = await subscribeNotificationEvents(bus, {} as NotifyService);
  return { subscriptions, report };
}

describe('notify event-wiring matrix — Class B no silent growth', () => {
  // The attached set is read from subscribeNotificationEvents itself: a consumer added to both it and the matrix
  // passes; one added to only one side, or a matrix row listed twice, fails.
  it('the matrix has one row per durable events.ts attaches, no more and no fewer', async () => {
    const { subscriptions } = await attachedBy(false);
    expect(notifyEventConsumerCount()).toBe(new Set(subscriptions.map((s) => s.durable)).size);
    expect(NOTIFY_EVENT_CONSUMERS).toHaveLength(subscriptions.length);
  });

  it('every matrix durable is attached in events.ts', async () => {
    // Refused by the bus, every attach reports its event, subject and durable: each matrix row is one of them.
    const { report } = await attachedBy(true);
    const pending = report.pending.map((p) => `${p.event} ${p.subject} ${p.durable}`);
    for (const row of NOTIFY_EVENT_CONSUMERS) {
      expect(pending, `missing ${row.event} ${row.durable}`).toContain(`${row.event} ${row.subject} ${row.durable}`);
    }
  });

  it('every attach durable in events.ts is on the matrix (no shadow consumers)', async () => {
    const { subscriptions } = await attachedBy(false);
    const unique = [...new Set(subscriptions.map((s) => s.durable))].sort();
    const matrix = [...notifyEventDurableNames()].sort();
    expect(unique).toEqual(matrix);
  });

  it('skipped subjects stay documented and unattached', async () => {
    expect(SKIPPED_NOTIFY_SUBJECTS.map((s) => s.event).sort()).toEqual(['p2pDisputeResolved', 'p2pTradeExpired'].sort());
    const { subscriptions } = await attachedBy(false);
    for (const skip of SKIPPED_NOTIFY_SUBJECTS) {
      expect(skip.why.trim().length, `${skip.event} has no reason`).toBeGreaterThan(0);
      // Not attached as a durable consumer.
      expect(subscriptions.map((s) => s.event)).not.toContain(skip.event);
    }
  });

  it('README Events table names every matrix subject', () => {
    for (const row of NOTIFY_EVENT_CONSUMERS) {
      expect(readmeSource, `README missing ${row.subject}`).toContain(row.subject);
      expect(readmeSource, `README missing durable ${row.durable}`).toContain(row.durable);
    }
  });
});
