import { describe, expect, it } from 'vitest';
import { bankScheduleRetryRunApprovedInputSchema, bankScheduleRetryRunInputSchema } from './bank-schedules.js';

const s = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base = { scheduleId: s, occurrence: 0, reason: 'rail back' };

describe('operator retry approved input (BK-xfer-10 #7)', () => {
  it('needs the identity approvalId and operationId on top of the retry', () => {
    expect(bankScheduleRetryRunApprovedInputSchema.safeParse({ ...base, approvalId: 'ap-1', operationId: 'op-1' }).success).toBe(true);
    expect(bankScheduleRetryRunApprovedInputSchema.safeParse(base).success).toBe(false);
    expect(bankScheduleRetryRunApprovedInputSchema.safeParse({ ...base, approvalId: '', operationId: 'op-1' }).success).toBe(false);
    expect(bankScheduleRetryRunApprovedInputSchema.safeParse({ ...base, approvalId: 'a'.repeat(129), operationId: 'op-1' }).success).toBe(false);
  });
  it('is strict: the operator (actorId) cannot be supplied by the caller', () => {
    expect(
      bankScheduleRetryRunApprovedInputSchema.safeParse({ ...base, approvalId: 'ap-1', operationId: 'op-1', actorId: 'x' }).success,
    ).toBe(false);
  });
  it('keeps the base retry schema unchanged', () => {
    expect(bankScheduleRetryRunInputSchema.safeParse(base).success).toBe(true);
  });
});
