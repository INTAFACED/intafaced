import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CSS_VARS, color, font, space, tokens } from './tokens.js';
import { directionOf } from './primitives.js';

const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');

/** Trailing zeros in rgba() components (`0.5` vs `0.50`) are the same colour. */
const canonicalRgbaNumber = (raw: string) => {
  const n = Number(raw.trim());
  return Number.isFinite(n) ? String(n) : raw.trim();
};

/** Normalise for comparison: CSS is written lowercase, TS uses uppercase hex. */
const normalise = (v: string) =>
  v
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/rgba?\(([^)]+)\)/g, (match, inner: string) => {
      const fn = match.slice(0, match.indexOf('('));
      return `${fn}(${inner.split(',').map(canonicalRgbaNumber).join(', ')})`;
    });

describe('§3 design tokens are locked', () => {
  it('holds the brand to black with restrained identity accent #FF6B00', () => {
    expect(color.base).toBe('#000000');
    expect(color.accent).toBe('#FF6B00');
    expect(color.accentBright).toBe('#FF8A2B');
    expect(color.accentDim).toBe('#C24F00');
    expect(color.textOnAccent).toBe('#1A0A00');
    expect(css.toLowerCase()).toContain('#ff6b00');
  });

  /**
   * The surface ramp carries no hue.
   *
   * Any blue or warm cast in the background competes with the only two colours
   * that mean anything on a trading screen. A tinted grey also makes every red
   * look slightly wrong, which is the kind of bug nobody files and everybody
   * feels.
   */
  it('keeps the surface ramp neutral — no colour cast', () => {
    for (const hex of [color.surface, color.surfaceRaised, color.surfaceOverlay]) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThanOrEqual(8);
    }
  });

  it('specifies Orbitron for display and Inter for body', () => {
    expect(font.display).toContain('Orbitron');
    expect(font.body).toContain('Inter');
  });

  /**
   * The accent must never be a direction colour.
   *
   * If the identity accent also meant "up", nothing would be left to mean
   * "this is the button" on a falling market. Market green/red stay chromatic.
   */
  it('keeps the accent out of market semantics', () => {
    expect(color.accent).not.toBe(color.long);
    expect(color.accent).not.toBe(color.short);
    expect(color.long).toBe('#00C46A');
    expect(color.short).toBe('#FF3B5C');
  });

  /**
   * Body text clears WCAG AA (4.5:1) on the surface it sits on.
   *
   * Asserted as CONTRAST, not as a hex. A future tweak that looks nicer and
   * reads worse fails here rather than shipping — which is the whole point,
   * because "slightly dimmer grey" is the single easiest way to quietly make a
   * product unusable for a chunk of its users.
   */
  it('keeps text above 4.5:1 on the surfaces it sits on', () => {
    const lum = (hex: string) => {
      const parts = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const [r, g, b] = parts.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };

    expect(ratio(color.textMuted, color.surface)).toBeGreaterThan(4.5);
    expect(ratio(color.text, color.surface)).toBeGreaterThan(4.5);
    // The accent has to carry its own text, or every primary button is unreadable.
    expect(ratio(color.textOnAccent, color.accent)).toBeGreaterThan(4.5);
  });

  it('bases spacing on a 4px grid', () => {
    expect(space[1]).toBe('4px');
    expect(space[2]).toBe('8px');
    expect(space[4]).toBe('16px');
  });
});

describe('tokens.ts and tokens.css cannot drift', () => {
  it.each(Object.entries(CSS_VARS))('emits %s with the value from tokens.ts', (name, value) => {
    const declaration = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css);
    expect(declaration, `${name} is missing from tokens.css`).not.toBeNull();
    expect(normalise(declaration![1]!)).toBe(normalise(value));
  });

  it('declares no hex colour that is not a token', () => {
    const hexes = new Set((css.match(/#[0-9a-fA-F]{3,8}/g) ?? []).map((h) => h.toLowerCase()));
    const allowed = new Set(
      Object.values(color)
        .filter((c) => c.startsWith('#'))
        .map((c) => c.toLowerCase()),
    );
    for (const hex of hexes) {
      expect(allowed.has(hex), `${hex} in tokens.css is not a declared token`).toBe(true);
    }
  });

  it('respects prefers-reduced-motion', () => {
    expect(css).toContain('prefers-reduced-motion');
  });
});

describe('primitives', () => {
  it('reads direction from a signed change', () => {
    expect(directionOf(1.5)).toBe('up');
    expect(directionOf('-0.2')).toBe('down');
    expect(directionOf(0)).toBe('flat');
    expect(directionOf('not a number')).toBe('flat');
    expect(directionOf('0.' + '0'.repeat(30) + '1')).toBe('up');
    expect(directionOf('-0.00')).toBe('flat');
    expect(directionOf('\u22121.25')).toBe('down');
    expect(directionOf('+3')).toBe('up');
    expect(directionOf('.')).toBe('flat');
    expect(directionOf('1e5')).toBe('flat');
    expect(directionOf('+2.3%')).toBe('up');
  });
});

describe('token surface', () => {
  it('exposes one namespace so consumers never reach for a raw value', () => {
    expect(Object.keys(tokens).sort()).toEqual(['blur', 'border', 'color', 'font', 'motion', 'radius', 'shadow', 'space', 'zIndex'].sort());
  });
});
