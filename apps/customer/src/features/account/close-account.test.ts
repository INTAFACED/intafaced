import { describe, expect, it } from 'vitest';
import { BLOCKER_KEYS, CLOSE_REFUSAL_KEYS, closeStepUp, closureCheck, closureStatus, daysLeft, isSixDigits } from './close-account';
import { closeAccountCopy } from './close-account-copy';

describe('close account', () => {
  it('begins the step-up with the three fields the service re-hashes and the request id as target', () => {
    expect(closeStepUp('request', 'r1')).toEqual({
      scope: 'identity.step_up.close_account',
      purpose: 'account.close',
      target: 'r1',
      fields: { intent: 'request', clientRequestId: 'r1' },
    });
    expect(closeStepUp('cancel', 'r1').fields.intent).toBe('cancel');
  });

  it('words every blocker code the money services send, and every typed refusal it handles', () => {
    for (const code of [
      'balance_remaining',
      'open_loan',
      'earn_position',
      'active_card',
      'active_schedule',
      'pending_ramp',
      'open_order',
      'open_position',
      'open_offer',
      'open_trade',
      'open_dispute',
    ]) {
      const key = BLOCKER_KEYS[code];
      expect(key, code).toBeTruthy();
      expect(closeAccountCopy.t(key as 'blockOrder', { count: 2 })).toContain('2');
    }
    for (const key of Object.values(CLOSE_REFUSAL_KEYS)) expect(closeAccountCopy.t(key as 'refusedCheck').length).toBeGreaterThan(10);
  });

  it('reads the service answers strictly', () => {
    expect(
      closureCheck.safeParse({ blockers: [{ code: 'open_order', count: 1 }], balances: [{ assetId: 'USDT', amount: '1.50' }] }).success,
    ).toBe(true);
    expect(closureCheck.safeParse({ blockers: [] }).success).toBe(false);
    expect(closureStatus.safeParse({ closure: null }).success).toBe(true);
    expect(closureStatus.safeParse({ closure: { id: 'x' } }).success).toBe(false);
  });

  it('takes exactly six digits and counts whole days left', () => {
    expect(isSixDigits(' 123456 ')).toBe(true);
    expect(isSixDigits('12345')).toBe(false);
    const now = Date.parse('2026-10-20T00:00:00.000Z');
    expect(daysLeft('2026-10-27T00:00:00.000Z', now)).toBe(7);
    expect(daysLeft('2026-10-20T00:00:01.000Z', now)).toBe(1);
    expect(daysLeft('2026-10-19T00:00:00.000Z', now)).toBe(0);
    expect(daysLeft('nonsense', now)).toBe(0);
  });
});
