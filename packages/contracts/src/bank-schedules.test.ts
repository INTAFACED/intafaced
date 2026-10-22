import { describe, expect, it } from 'vitest';
import {
  BANK_SCHEDULE_CADENCES,
  BANK_SCHEDULE_CODES,
  bankScheduleRetryRunInputSchema,
  bankScheduleRunSchema,
  bankScheduleUpdateInputSchema,
} from './bank-schedules.js';

const s = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('BK-xfer-10 contracts', () => {
  it('adds the once cadence alongside the existing three', () => {
    expect(BANK_SCHEDULE_CADENCES).toEqual(['once', 'daily', 'weekly', 'monthly']);
  });

  it('update needs a revision and a change; the recipient is not editable', () => {
    expect(bankScheduleUpdateInputSchema.safeParse({ scheduleId: s, revision: 0, amount: '12.5' }).success).toBe(true);
    expect(bankScheduleUpdateInputSchema.safeParse({ scheduleId: s, amount: '12.5' }).success).toBe(false);
    expect(bankScheduleUpdateInputSchema.safeParse({ scheduleId: s, revision: 0 }).success).toBe(false);
    expect(bankScheduleUpdateInputSchema.safeParse({ scheduleId: s, revision: 0, amount: '1', toUserId: s }).success).toBe(false);
    expect(bankScheduleUpdateInputSchema.safeParse({ scheduleId: s, revision: 0, amount: '0' }).success).toBe(false);
    expect(bankScheduleUpdateInputSchema.safeParse({ scheduleId: s, revision: 1, endsAt: null }).success).toBe(true);
  });

  it('a once schedule has no end date', () => {
    expect(
      bankScheduleUpdateInputSchema.safeParse({ scheduleId: s, revision: 0, cadence: 'once', endsAt: '2026-11-01T00:00:00Z' }).success,
    ).toBe(false);
    expect(bankScheduleUpdateInputSchema.safeParse({ scheduleId: s, revision: 0, cadence: 'once' }).success).toBe(true);
  });

  it('retry and run shapes', () => {
    expect(bankScheduleRetryRunInputSchema.safeParse({ scheduleId: s, occurrence: 3, reason: 'rail back' }).success).toBe(true);
    expect(bankScheduleRetryRunInputSchema.safeParse({ scheduleId: s, occurrence: -1, reason: 'rail back' }).success).toBe(false);
    expect(
      bankScheduleRunSchema.safeParse({ occurrence: 0, status: 'skipped', code: 'bank.account_frozen', ranAt: '2026-10-22T03:00:00Z' })
        .success,
    ).toBe(true);
    expect(BANK_SCHEDULE_CODES).toContain('bank.schedule_cutoff');
  });
});
