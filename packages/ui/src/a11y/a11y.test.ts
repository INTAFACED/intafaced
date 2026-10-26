import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTRAST_MIN,
  OBSCURED_BOTTOM_VAR,
  OBSCURED_TOP_VAR,
  SURFACES_ATTRIBUTE,
  SURFACES_STORAGE_KEY,
  applySurfaces,
  composite,
  contrastRatio,
  isLargeText,
  meetsContrast,
  obscuredInsets,
  parseColor,
  readSurfacesSetting,
  resolveSurfaces,
  systemAsksForSolid,
  worstPixelContrast,
  writeSurfacesSetting,
} from './index.js';

describe('contrast', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio(parseColor('#000'), parseColor('#fff'))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor('#fff'), parseColor('#fff'))).toBe(1);
    // #767676 on white is the classic 4.54:1 pass; #777777 is 4.48:1 and fails.
    expect(contrastRatio(parseColor('#767676'), parseColor('#ffffff'))).toBeCloseTo(4.54, 2);
    expect(meetsContrast(contrastRatio(parseColor('#767676'), parseColor('#fff')), 'text')).toBe(true);
    expect(meetsContrast(contrastRatio(parseColor('#777777'), parseColor('#fff')), 'text')).toBe(false);
  });

  it('never rounds a near miss up', () => {
    expect(meetsContrast(4.499, 'text')).toBe(false);
    expect(meetsContrast(4.5, 'text')).toBe(true);
    expect(meetsContrast(2.999, 'nonText')).toBe(false);
    expect(CONTRAST_MIN.largeText).toBe(3);
  });

  it('knows large text by size and weight', () => {
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(18.67, 700)).toBe(true);
    expect(isLargeText(18.6, 700)).toBe(false);
    expect(isLargeText(20, 600)).toBe(false);
    expect(isLargeText(16, 900)).toBe(false);
  });

  it('reads the colour forms the tokens use', () => {
    expect(parseColor('#3f7dff')).toEqual({ r: 63, g: 125, b: 255, a: 1 });
    expect(parseColor('#3f7dff80').a).toBeCloseTo(128 / 255, 5);
    expect(parseColor('rgba(245, 240, 235, 0.64)')).toEqual({ r: 245, g: 240, b: 235, a: 0.64 });
    expect(parseColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(() => parseColor('color-mix(in srgb, red, blue)')).toThrow();
    expect(() => parseColor('rgba(0, 0, 0, 50)')).toThrow();
    expect(() => parseColor('rgb(300, 0, 0)')).toThrow();
    expect(() => parseColor('rgb(., 0, 0)')).toThrow('Not a colour');
    expect(() => parseColor('rgba(1.2.3, 0, 0, 1)')).toThrow('Not a colour');
    expect(parseColor('rgba(0, 0, 0, 50%)').a).toBe(0.5);
    expect(parseColor('rgba(0, 0, 0, .5)').a).toBe(0.5);
    expect(parseColor('rgba(1.5, 0.25, 10, 0.05)')).toEqual({ r: 1.5, g: 0.25, b: 10, a: 0.05 });
    expect(parseColor('rgb(0 0 0 / 7.5%)').a).toBeCloseTo(0.075, 10);
  });

  it('paints a translucent colour over its backdrop before measuring', () => {
    const half = composite({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0 });
    expect(half).toEqual({ r: 127.5, g: 127.5, b: 127.5 });
  });
});

describe('worstPixelContrast', () => {
  /** A dark panel with one bright glow pixel: the median passes, the worst pixel fails. */
  function panel(): { width: number; height: number; data: Uint8ClampedArray } {
    const width = 10;
    const height = 4;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set([17, 14, 13, 255], i * 4);
    data.set([200, 210, 255, 255], (2 * width + 7) * 4); // the glow at (7, 2)
    return { width, height, data };
  }

  it('finds the one pixel that fails and says where', () => {
    const worst = worstPixelContrast(parseColor('#f5f0eb'), panel());
    expect(worst.x).toBe(7);
    expect(worst.y).toBe(2);
    expect(worst.sampled).toBe(40);
    expect(meetsContrast(worst.ratio, 'text')).toBe(false);
    expect(contrastRatio(parseColor('#f5f0eb'), parseColor('#110e0d'))).toBeGreaterThan(15);
  });

  it('reads only the text box', () => {
    const worst = worstPixelContrast(parseColor('#f5f0eb'), panel(), { x: 0, y: 0, width: 5, height: 4 });
    expect(worst.sampled).toBe(20);
    expect(meetsContrast(worst.ratio, 'text')).toBe(true);
  });

  it('composites translucent text over each pixel', () => {
    const faded = worstPixelContrast(parseColor('rgba(245, 240, 235, 0.2)'), panel(), { x: 0, y: 0, width: 5, height: 4 });
    expect(faded.ratio).toBeLessThan(CONTRAST_MIN.text);
  });

  it('refuses a box outside the image', () => {
    expect(() => worstPixelContrast(parseColor('#fff'), panel(), { x: 20, y: 0, width: 5, height: 5 })).toThrow();
    expect(() => worstPixelContrast(parseColor('#fff'), panel(), { x: Number.NaN, y: 0, width: 5, height: 5 })).toThrow();
  });
});

describe('Solid surfaces', () => {
  const memory = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      map,
    };
  };

  it('is solid when chosen or when the system asks, glass otherwise', () => {
    expect(resolveSurfaces('auto', false)).toBe('glass');
    expect(resolveSurfaces('auto', true)).toBe('solid');
    expect(resolveSurfaces('solid', false)).toBe('solid');
  });

  it('remembers the choice, and falls back to auto when storage fails', () => {
    const store = memory();
    expect(readSurfacesSetting(store)).toBe('auto');
    expect(writeSurfacesSetting('solid', store)).toBe(true);
    expect(store.map.get(SURFACES_STORAGE_KEY)).toBe('solid');
    expect(readSurfacesSetting(store)).toBe('solid');
    writeSurfacesSetting('auto', store);
    expect(store.map.has(SURFACES_STORAGE_KEY)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readSurfacesSetting(broken)).toBe('auto');
    expect(writeSurfacesSetting('solid', broken)).toBe(false);
    expect(writeSurfacesSetting('solid', null)).toBe(false);
  });

  it('follows more contrast, forced colours and reduced transparency, live', () => {
    const listeners = new Map<string, () => void>();
    const state: Record<string, boolean> = {};
    const env = {
      matchMedia: (query: string) => ({
        get matches() {
          return state[query] === true;
        },
        addEventListener: (_: 'change', fn: () => void) => void listeners.set(query, fn),
        removeEventListener: (_: 'change', fn: () => void) => {
          if (listeners.get(query) === fn) listeners.delete(query);
        },
      }),
    };
    const attrs: Record<string, string> = {};
    const root = {
      setAttribute: (name: string, value: string) => void (attrs[name] = value),
      removeAttribute: (name: string) => void delete attrs[name],
    };

    const stop = applySurfaces(root, 'auto', env);
    expect(attrs[SURFACES_ATTRIBUTE]).toBe('glass');
    for (const query of ['(prefers-contrast: more)', '(forced-colors: active)', '(prefers-reduced-transparency: reduce)']) {
      state[query] = true;
      listeners.get(query)?.();
      expect(attrs[SURFACES_ATTRIBUTE], query).toBe('solid');
      expect(systemAsksForSolid(env)).toBe(true);
      state[query] = false;
      listeners.get(query)?.();
      expect(attrs[SURFACES_ATTRIBUTE], query).toBe('glass');
    }
    stop();
    expect(listeners.size).toBe(0);
    expect(attrs[SURFACES_ATTRIBUTE]).toBeUndefined();
  });

  it('treats an engine without matchMedia, or a query it rejects, as not asking', () => {
    expect(systemAsksForSolid({})).toBe(false);
    const throwing = {
      matchMedia: () => {
        throw new Error('unknown query');
      },
    };
    expect(systemAsksForSolid(throwing)).toBe(false);
    const attrs: Record<string, string> = {};
    const stop = applySurfaces(
      { setAttribute: (n, v) => void (attrs[n] = v), removeAttribute: (n) => void delete attrs[n] },
      'solid',
      throwing,
    );
    expect(attrs[SURFACES_ATTRIBUTE]).toBe('solid');
    stop();
    expect(attrs[SURFACES_ATTRIBUTE]).toBeUndefined();
  });
});

describe('focus not obscured', () => {
  it('adds stacked bars per edge and ignores anything else', () => {
    expect(
      obscuredInsets([
        { edge: 'top', height: 56 },
        { edge: 'top', height: 61.5 },
        { edge: 'bottom', height: 88 },
        { edge: 'left', height: 40 },
        { edge: null, height: 10 },
        { edge: 'bottom', height: Number.NaN },
      ]),
    ).toEqual({ top: 117.5, bottom: 88 });
    expect(OBSCURED_TOP_VAR).toBe('--a11y-obscured-top');
    expect(OBSCURED_BOTTOM_VAR).toBe('--a11y-obscured-bottom');
  });
});

/** A selector list split on its top-level commas only. */
function topLevelParts(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of selector) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  parts.push(current.trim());
  return parts;
}

describe('a11y.css', () => {
  const css = readFileSync(fileURLToPath(new URL('./a11y.css', import.meta.url)), 'utf8');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('scopes every rule to the Lit look, so the app with the look off is unchanged', () => {
    const selectors = rules
      .split('{')
      .slice(0, -1)
      .map((chunk) => chunk.split('}').pop()?.trim() ?? '')
      .filter((selector) => selector && !selector.startsWith('@'));
    expect(selectors.length).toBeGreaterThan(8);
    for (const selector of selectors) {
      for (const part of topLevelParts(selector)) expect(part, part).toMatch(/^:where\(:root\[data-look='lit'\]/);
    }
  });

  it('uses logical properties only', () => {
    expect(rules).not.toMatch(/(?<![-\w])(margin|padding|border|inset)-(left|right|top|bottom)\b/);
    expect(rules).not.toMatch(/(?<![-\w])(left|right|top|bottom)\s*:/);
    expect(rules).not.toMatch(/(?<![-\w])(width|height)\s*:/);
    expect(rules).not.toMatch(/text-align\s*:\s*(left|right)/);
  });

  it('reads the scroll padding from the measured bars before the tokens', () => {
    expect(rules).toContain(`var(${OBSCURED_TOP_VAR}`);
    expect(rules).toContain(`var(${OBSCURED_BOTTOM_VAR}`);
    expect(rules).toContain('var(--lit-legal-band-min-h');
  });

  it('exempts inline targets inside a sentence from the 24 px floor', () => {
    expect(rules).toMatch(/:where\(p, li, dd, \[data-inline\]\)[^{]*\{\s*min-block-size: auto;/);
    expect(rules.indexOf('min-block-size: auto')).toBeGreaterThan(rules.indexOf('min-block-size: 24px'));
  });

  it('never mirrors with transform, which would wipe a component rotate', () => {
    expect(rules).not.toMatch(/transform\s*:/);
  });

  it('gives controls a 24 px floor and covers forced colours', () => {
    expect(rules).toMatch(/min-block-size:\s*24px/);
    expect(rules).toMatch(/min-inline-size:\s*24px/);
    expect(rules).toMatch(/@media \(forced-colors: active\)/);
  });
});
