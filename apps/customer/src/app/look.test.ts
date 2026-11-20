// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { accents } from '@intafaced/ui/lit';
import { LOOK_ACCENTS, applyLook, isLook, resolveAccent, resolveLook, resolvePreviewScheme } from './look';

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

  it('draws dark unless the light preview was asked for, and forgets it with ?scheme=dark', () => {
    expect(resolvePreviewScheme('')).toBe('dark');
    expect(resolvePreviewScheme('?scheme=sepia')).toBe('dark');
    expect(resolvePreviewScheme('?scheme=light')).toBe('light');
    expect(resolvePreviewScheme('')).toBe('light');
    expect(resolvePreviewScheme('?scheme=dark')).toBe('dark');
    expect(resolvePreviewScheme('')).toBe('dark');
  });

  it('sets the asked accent on the root, remembers it, and drops it with ?accent=off', () => {
    const root = document.createElement('html');
    applyLook(root, '?look=lit&accent=ember');
    expect(root.dataset.accent).toBe('ember');
    applyLook(root, '');
    expect(root.dataset.accent).toBe('ember');
    applyLook(root, '?accent=off');
    expect(root.dataset.accent).toBeUndefined();
    expect(resolveAccent('?accent=neon')).toBeNull();
  });

  it('knows the same accents as the kit', () => {
    expect([...LOOK_ACCENTS]).toEqual([...accents]);
  });
});
