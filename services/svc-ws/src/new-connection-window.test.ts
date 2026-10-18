import { describe, expect, it } from 'vitest';
import { NewConnectionWindow } from './new-connection-window.js';

describe('NewConnectionWindow', () => {
  it('admits everything when the cap is blank', () => {
    const w = new NewConnectionWindow(undefined);
    for (let i = 0; i < 100; i += 1) expect(w.admit(1_000)).toBe(true);
  });

  it('refuses over the cap, then admits again once the oldest entry is a minute old', () => {
    const w = new NewConnectionWindow(2);
    expect(w.admit(0)).toBe(true);
    expect(w.admit(10_000)).toBe(true);
    expect(w.admit(59_999)).toBe(false);
    // The first entry expires at exactly 60s; the second is still inside.
    expect(w.admit(60_000)).toBe(true);
    expect(w.admit(60_001)).toBe(false);
    expect(w.admit(70_000)).toBe(true);
  });
});
