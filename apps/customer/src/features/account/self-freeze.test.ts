import { describe, expect, it } from 'vitest';
import {
  FREEZE_REASONS,
  FREEZE_REFUSAL_KEYS,
  LIFT_REFUSAL_KEYS,
  REASON_KEYS,
  freezeDone,
  freezeStatus,
  liftWaitWords,
} from './self-freeze';
import { selfFreezeCopy } from './self-freeze-copy';

describe('self-service freeze', () => {
  it('has a sentence for every reason and every typed refusal it handles', () => {
    for (const reason of FREEZE_REASONS) expect(selfFreezeCopy.t(REASON_KEYS[reason] as 'reasonPersonal').length).toBeGreaterThan(5);
    for (const key of Object.values(FREEZE_REFUSAL_KEYS)) expect(selfFreezeCopy.t(key as 'refusedPassword').length).toBeGreaterThan(10);
    for (const key of Object.values(LIFT_REFUSAL_KEYS)) expect(selfFreezeCopy.t(key as 'liftWaitUnset').length).toBeGreaterThan(10);
  });

  it('reads the service answers', () => {
    expect(freezeStatus.parse({ frozen: false, reason: null, since: null }).frozen).toBe(false);
    expect(freezeStatus.safeParse({ frozen: true, reason: 'other', since: 'x' }).success).toBe(false);
    expect(freezeDone.parse({ frozen: true, reason: 'compromise', since: '2026-10-20T00:00:00Z', changed: true }).changed).toBe(true);
    expect(freezeDone.safeParse({ frozen: false, reason: 'compromise', since: 'x', changed: false }).success).toBe(false);
  });
});

describe('liftWaitWords', () => {
  it('reads the wait left in the unit a person reads, always rounded up', () => {
    expect(liftWaitWords(1)).toEqual({ key: 'liftTooSoonOneSecond', n: 1 });
    expect(liftWaitWords(17)).toEqual({ key: 'liftTooSoonSeconds', n: 17 });
    expect(liftWaitWords(119)).toEqual({ key: 'liftTooSoonSeconds', n: 119 });
    expect(liftWaitWords(121)).toEqual({ key: 'liftTooSoonMinutes', n: 3 });
    expect(liftWaitWords(7199)).toEqual({ key: 'liftTooSoonMinutes', n: 120 });
    expect(liftWaitWords(259_187)).toEqual({ key: 'liftTooSoonHours', n: 72 });
  });
});
