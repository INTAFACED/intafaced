import { describe, expect, it } from 'vitest';
import {
  CODE_LENGTH,
  MIN_PASSWORD_LENGTH,
  RECOVERY_BLOCKER,
  RECOVERY_STEPS,
  controlsDisabled,
  recoveryAvailable,
  stepStates,
} from './password-recovery';

describe('password recovery journey', () => {
  it('is blocked today, names its blocker and the two calls it needs, and keeps every control disabled', () => {
    expect(RECOVERY_BLOCKER?.id).toBe('identity.password_reset_unwired');
    expect(RECOVERY_BLOCKER?.needs).toHaveLength(2);
    expect(recoveryAvailable()).toBe(false);
    expect(controlsDisabled()).toBe(true);
  });

  it('opens every control the moment there is no blocker', () => {
    expect(recoveryAvailable(null)).toBe(true);
    expect(controlsDisabled(null)).toBe(false);
  });

  it('walks request, then code, then password', () => {
    expect(RECOVERY_STEPS).toEqual(['request', 'code', 'password']);
    expect(stepStates('request')).toEqual({ request: 'current', code: 'upcoming', password: 'upcoming' });
    expect(stepStates('code')).toEqual({ request: 'done', code: 'current', password: 'upcoming' });
    expect(stepStates('password')).toEqual({ request: 'done', code: 'done', password: 'current' });
  });

  it('shows the same length rules as sign-up', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(CODE_LENGTH).toBe(6);
  });
});
