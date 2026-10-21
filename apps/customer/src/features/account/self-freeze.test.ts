import { describe, expect, it } from 'vitest';
import { FREEZE_REASONS, FREEZE_REFUSAL_KEYS, REASON_KEYS, freezeDone, freezeStatus } from './self-freeze';
import { selfFreezeCopy } from './self-freeze-copy';

describe('self-service freeze', () => {
  it('has a sentence for every reason and every typed refusal it handles', () => {
    for (const reason of FREEZE_REASONS) expect(selfFreezeCopy.t(REASON_KEYS[reason] as 'reasonPersonal').length).toBeGreaterThan(5);
    for (const key of Object.values(FREEZE_REFUSAL_KEYS)) expect(selfFreezeCopy.t(key as 'refusedPassword').length).toBeGreaterThan(10);
  });

  it('reads the service answers', () => {
    expect(freezeStatus.parse({ frozen: false, reason: null, since: null }).frozen).toBe(false);
    expect(freezeStatus.safeParse({ frozen: true, reason: 'other', since: 'x' }).success).toBe(false);
    expect(freezeDone.parse({ frozen: true, reason: 'compromise', since: '2026-10-20T00:00:00Z', changed: true }).changed).toBe(true);
    expect(freezeDone.safeParse({ frozen: false, reason: 'compromise', since: 'x', changed: false }).success).toBe(false);
  });
});
