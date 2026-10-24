import { describe, expect, it } from 'vitest';
import { OPS_CONTROL_MARGIN_UNSET, LEDGER_RECONCILE_ASOF_INVALID } from '@intafaced/contracts/ledger-reconciliation';
import { ReconciliationControlError } from './reconciliation-control-error.js';
import { assertNotFuture, dueInstant, marginMillis, periodBounds, readInstant, utcIsoWeekStart } from './reconciliation-schedule.js';
import { runScheduledReconciliationTick } from './scheduled-reconcile-tick.js';

describe('reconciliation schedule (OPS-reconciliation-01)', () => {
  it('starts an ISO week on Monday and a calendar month on the 1st, both UTC', () => {
    const wednesday = new Date('2026-03-18T15:04:00.000Z');
    expect(wednesday.getUTCDay()).toBe(3);
    expect(utcIsoWeekStart(wednesday).toISOString()).toBe('2026-03-16T00:00:00.000Z');
    const week = periodBounds('iso_week', wednesday);
    expect(week.start.toISOString()).toBe('2026-03-16T00:00:00.000Z');
    expect(week.end.toISOString()).toBe('2026-03-23T00:00:00.000Z');
    const month = periodBounds('month', wednesday);
    expect(month.start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(month.end.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('has no due instant on a monthly day the month does not contain', () => {
    const february = periodBounds('month', new Date('2026-02-10T00:00:00.000Z'));
    expect(dueInstant({ cadence: 'monthly', day: 31, hour: 0, minute: 0 }, february.start)).toBeNull();
    expect(dueInstant({ cadence: 'monthly', day: 28, hour: 6, minute: 30 }, february.start)?.toISOString()).toBe(
      '2026-02-28T06:30:00.000Z',
    );
  });

  it('accepts a typed zero margin, refuses a blank one, and refuses a future instant', () => {
    const asOf = new Date('2026-01-02T00:00:10.000Z');
    expect(marginMillis('0')).toBe(0n);
    expect(readInstant(asOf, '0').toISOString()).toBe(asOf.toISOString());
    expect(readInstant(asOf, '20').toISOString()).toBe('2026-01-01T23:59:50.000Z');
    expect(() => marginMillis(undefined)).toThrow(ReconciliationControlError);
    expect(() => marginMillis('')).toThrow(OPS_CONTROL_MARGIN_UNSET);
    expect(() => assertNotFuture(new Date('2999-01-01T00:00:00.000Z'), asOf)).toThrow(LEDGER_RECONCILE_ASOF_INVALID);
    expect(() => assertNotFuture(asOf, asOf)).not.toThrow();
  });

  it('runs due controls from the tick and does not freeze when that hook throws', async () => {
    let froze = false;
    let called = false;
    await runScheduledReconciliationTick(
      async () => ({ outcome: 'skipped' }),
      {
        freeze: async () => {
          froze = true;
        },
        runDueReconciliationControls: async () => {
          called = true;
          throw new Error('control store down');
        },
      },
      { fatal() {}, info() {} },
    );
    expect(called).toBe(true);
    expect(froze).toBe(false);
  });
});
