import { describe, expect, it } from 'vitest';
import {
  BANK_EARN_CODES,
  bankEarnAutoProgramSchema,
  bankEarnPoolSchema,
  bankEarnPositionSchema,
  bankEarnSettingsSchema,
  bankEarnWithdrawInputSchema,
} from './bank-earn.js';

const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const pool = { id: a, assetId: 'USDT', kind: 'flexible', name: 'Flex', aprBps: 400, termDays: null, minDeposit: '10' };

describe('BK-earn-01 contracts (personal earn)', () => {
  it('whole withdraw needs no amount; a partial withdraw needs a positive decimal string and its own clientEventId', () => {
    expect(bankEarnWithdrawInputSchema.safeParse({ positionId: a }).success).toBe(true);
    expect(bankEarnWithdrawInputSchema.safeParse({ positionId: a, amount: '4', clientEventId: 'evt-00001' }).success).toBe(true);
    expect(bankEarnWithdrawInputSchema.safeParse({ positionId: a, amount: '4' }).success).toBe(false);
    for (const amount of ['0', '0.000', '-1', 4, '1e3'])
      expect(bankEarnWithdrawInputSchema.safeParse({ positionId: a, amount, clientEventId: 'evt-00001' }).success).toBe(false);
  });

  it('positions carry the new states and refuse unknown ones', () => {
    const p = {
      id: a,
      poolId: b,
      assetId: 'USDT',
      principal: '6',
      openedAt: '2026-10-22T03:00:00Z',
      accruesFrom: '2026-10-23T00:00:00Z',
      maturesAt: null,
    };
    for (const state of ['pending', 'waiting_accrual', 'active', 'deallocating', 'closed'])
      expect(bankEarnPositionSchema.safeParse({ ...p, state }).success).toBe(true);
    expect(bankEarnPositionSchema.safeParse({ ...p, state: 'paused' }).success).toBe(false);
  });

  it('a pool says whether it is offered, and why not; extra fields are refused', () => {
    expect(bankEarnPoolSchema.safeParse({ ...pool, availability: { offered: true } }).success).toBe(true);
    expect(bankEarnPoolSchema.safeParse({ ...pool, availability: { offered: false, reason: 'country' } }).success).toBe(true);
    expect(bankEarnPoolSchema.safeParse({ ...pool, availability: { offered: false } }).success).toBe(false);
    expect(bankEarnPoolSchema.safeParse({ ...pool, availability: { offered: true }, ownerId: a }).success).toBe(false);
  });

  it('an enabled auto program with a blank cap refuses bank.autoearn_cap_unset; disabled may be blank', () => {
    const r = bankEarnAutoProgramSchema.safeParse({ assetId: 'USDT', poolId: a, enabled: true, cap: null });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('bank.autoearn_cap_unset');
    expect(bankEarnAutoProgramSchema.safeParse({ assetId: 'USDT', poolId: a, enabled: false, cap: null }).success).toBe(true);
    expect(bankEarnAutoProgramSchema.safeParse({ assetId: 'USDT', poolId: a, enabled: true, cap: '100' }).success).toBe(true);
  });

  it('one auto program per asset', () => {
    const p = { assetId: 'USDT', poolId: a, enabled: false, cap: null };
    expect(bankEarnSettingsSchema.safeParse({ autoPrograms: [p, p] }).success).toBe(false);
  });

  it('carries no business earn codes (BK-pots-04)', () => {
    expect(BANK_EARN_CODES.some((c) => c.startsWith('business.'))).toBe(false);
    expect(BANK_EARN_CODES).toContain('bank.earn_frozen_withdraw_rule_unset');
  });
});
