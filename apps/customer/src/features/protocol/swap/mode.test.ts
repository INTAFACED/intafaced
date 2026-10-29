// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepMode, readMode } from './mode';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('swap mode memory', () => {
  it('starts a new viewer in Simple, and keeps Manual only after its notice was seen', () => {
    expect(readMode()).toEqual({ mode: 'simple', manualSeen: false });
    keepMode('manual', false);
    expect(readMode().mode).toBe('simple');
    keepMode('manual', true);
    expect(readMode()).toEqual({ mode: 'manual', manualSeen: true });
    keepMode('simple', true);
    expect(readMode()).toEqual({ mode: 'simple', manualSeen: true });
  });
  it('works in Simple when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    expect(readMode()).toEqual({ mode: 'simple', manualSeen: false });
    expect(() => keepMode('manual', true)).not.toThrow();
  });
});
