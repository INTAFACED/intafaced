// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { applyLook, isLook, resolveLook } from './look';

describe('the Lit glass switch', () => {
  beforeEach(() => localStorage.clear());

  it('is off by default', () => {
    expect(resolveLook('')).toBeNull();
    const root = document.createElement('html');
    applyLook(root, '');
    expect(root.dataset.look).toBeUndefined();
    expect(isLook('lit', root)).toBe(false);
  });

  it('turns on with ?look=lit, is remembered, and turns off with ?look=off', () => {
    const root = document.createElement('html');
    applyLook(root, '?look=lit');
    expect(root.dataset.look).toBe('lit');
    expect(resolveLook('')).toBe('lit');
    applyLook(root, '?look=off');
    expect(root.dataset.look).toBeUndefined();
    expect(resolveLook('')).toBeNull();
  });

  it('ignores unknown looks', () => {
    expect(resolveLook('?look=neon')).toBeNull();
  });
});
