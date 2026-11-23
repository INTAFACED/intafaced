import { describe, expect, it } from 'vitest';
import { badgeText } from './use-notifications';

describe('the bell badge (HM-notifications-01)', () => {
  it("stops at the owner's cap, whatever the cap is", () => {
    expect(badgeText(99, 99)).toBe('99');
    expect(badgeText(100, 99)).toBe('99+');
    expect(badgeText(51, 50)).toBe('50+');
    expect(badgeText(50, 50)).toBe('50');
  });

  it('shows the exact count while the owner has set no cap, never an invented one', () => {
    expect(badgeText(250, null)).toBe('250');
  });
});
