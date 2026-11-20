// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { accents, directions } from '@intafaced/ui/lit';
import { resolvePreviewScheme } from '../shared/preferences';
import { LOOK_ACCENTS, LOOK_DIRECTIONS, applyLook, isDirectionOn, isLook, resolveAccent, resolveDirection, resolveLook } from './look';

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

  it('draws a direction only when asked and only with the look on, remembers it, and drops it with ?direction=off', () => {
    const root = document.createElement('html');
    applyLook(root, '?direction=volt');
    expect(root.dataset.direction).toBeUndefined();
    expect(isDirectionOn('volt', root)).toBe(false);
    applyLook(root, '?look=lit');
    expect(root.dataset.direction).toBe('volt');
    expect(isDirectionOn('volt', root)).toBe(true);
    applyLook(root, '?direction=off');
    expect(root.dataset.direction).toBeUndefined();
    expect(resolveDirection('?direction=neon')).toBeNull();
  });

  it('knows the same directions as the kit', () => {
    expect([...LOOK_DIRECTIONS]).toEqual([...directions]);
  });
});
