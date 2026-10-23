import { describe, expect, it } from 'vitest';
import { lockStage, securityLockChangeSchema, securityLockRefusal, securityLockSchema, unlockStepUp } from './security-lock';

const USER = '5b3c1f2e-8d4a-4c6b-9e7f-0a1b2c3d4e5f';
const off = { userId: USER, locked: false, lockedAt: null, setBy: null, unlockRequestedAt: null, unlocksAt: null } as const;
const on = { ...off, locked: true, lockedAt: '2026-10-23T03:00:00.000Z', setBy: 'self' } as const;

describe('security lock in Security', () => {
  it('names the three states from identity’s answer', () => {
    expect(lockStage(off)).toBe('open');
    expect(lockStage(on)).toBe('locked');
    expect(lockStage({ ...on, unlockRequestedAt: '2026-10-23T03:10:00.000Z', unlocksAt: '2026-10-24T03:10:00.000Z' })).toBe('unlocking');
  });

  it('confirms an unlock bound to a fresh request id, named as the target', () => {
    expect(unlockStepUp('req-1')).toEqual({
      scope: 'identity.step_up.security_lock_unlock',
      purpose: 'account.securityLock.unlock',
      target: 'req-1',
      fields: { clientRequestId: 'req-1' },
    });
  });

  it('reads identity’s answers strictly', () => {
    expect(securityLockSchema.parse(on)).toEqual(on);
    expect(securityLockChangeSchema.parse({ ...on, changed: true }).changed).toBe(true);
    expect(() => securityLockSchema.parse({ ...on, balance: '1' })).toThrow();
  });

  it('gives its own words for the unset wait and a delegated caller, and leaves the rest to the general refusal', () => {
    expect(securityLockRefusal({ ok: false, code: 'identity.security_lock_unlock_wait_unset' })).toBe('refusedWaitUnset');
    expect(securityLockRefusal({ ok: false, code: 'identity.delegated_refused' })).toBe('refusedDelegated');
    expect(securityLockRefusal({ ok: false, code: 'identity.step_up_used' })).toBeNull();
    expect(securityLockRefusal({ ok: false, reason: 'uncertain', code: 'identity.security_lock_unlock_wait_unset' })).toBeNull();
    expect(securityLockRefusal({ ok: true })).toBeNull();
  });
});
