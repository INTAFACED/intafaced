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
import { describe, expect, it } from 'vitest';
import {
  NOTIFY_EVENT_CONSUMERS,
  SKIPPED_NOTIFY_SUBJECTS,
  notifyEventConsumerCount,
  notifyEventDurableNames,
} from './event-wiring-matrix.js';

const here = dirname(fileURLToPath(import.meta.url));
const eventsSource = readFileSync(join(here, 'events.ts'), 'utf8');
const readmeSource = readFileSync(join(here, '..', 'README.md'), 'utf8');
/** Every durable events.ts attaches: the 4th string argument to attach(bus, '<event>', …, 'notify-…'). */
const attachedDurables = [...eventsSource.matchAll(/attach\(\s*bus,\s*'[^']+',\s*[^,]+,\s*'(notify-[a-z0-9-]+)'/g)].map((m) => m[1]!);

describe('notify event-wiring matrix — Class B no silent growth', () => {
  // The count is read from events.ts, not written here: a consumer added to both events.ts and the matrix passes; one
  // added to only one side, or a matrix row listed twice, fails.
  it('the matrix has one row per durable events.ts attaches, no more and no fewer', () => {
    expect(notifyEventConsumerCount()).toBe(new Set(attachedDurables).size);
    expect(NOTIFY_EVENT_CONSUMERS).toHaveLength(attachedDurables.length);
  });

  it('every matrix durable is attached in events.ts', () => {
    for (const row of NOTIFY_EVENT_CONSUMERS) {
      expect(eventsSource, `missing durable ${row.durable}`).toContain(`'${row.durable}'`);
      // attach(bus, 'fillSettled', …) — event name is the catalog key
      expect(eventsSource, `missing event attach ${row.event}`).toContain(`'${row.event}'`);
    }
  });

  it('every attach durable in events.ts is on the matrix (no shadow consumers)', () => {
    const unique = [...new Set(attachedDurables)].sort();
    const matrix = [...notifyEventDurableNames()].sort();
    expect(unique).toEqual(matrix);
  });

  it('skipped subjects stay documented and unattached', () => {
    expect(SKIPPED_NOTIFY_SUBJECTS.map((s) => s.event).sort()).toEqual(['p2pDisputeResolved', 'p2pTradeExpired'].sort());
    for (const skip of SKIPPED_NOTIFY_SUBJECTS) {
      expect(eventsSource).toContain(skip.event);
      // Not attached as a durable consumer name.
      expect(eventsSource).not.toMatch(new RegExp(`attach\\(bus,\\s*'${skip.event}'`));
    }
  });

  it('README Events table names every matrix subject', () => {
    for (const row of NOTIFY_EVENT_CONSUMERS) {
      expect(readmeSource, `README missing ${row.subject}`).toContain(row.subject);
      expect(readmeSource, `README missing durable ${row.durable}`).toContain(row.durable);
    }
  });
});
