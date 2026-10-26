import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aliases,
  colors,
  controlHeights,
  cssValue,
  cssVars,
  defaultLook,
  legacyVars,
  looks,
  renderLegacyCss,
  radii,
  redUpOverrides,
  renderTokensCss,
  sizes,
  textStyles,
  tightTextTokens,
} from './tokens.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (name: string) => readFileSync(join(here, name), 'utf8');
const css = read('tokens.css');
const themeCss = read('theme.css');

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('UI-SPEC 2 tokens: tokens.ts and tokens.css cannot drift', () => {
  it('tokens.css is exactly what tokens.ts generates', () => {
    expect(css).toBe(renderTokensCss());
  });

  it.each(Object.entries(cssVars()))('declares %s', (name, value) => {
    expect(css).toContain(`${name}: ${cssValue(value)};`);
  });

  it('holds the spec anchors', () => {
    expect(colors.bg).toBe('#000000');
    expect(colors.lime).toBe('#C8F64A');
    expect(colors['on-lime']).toBe('#0B0B0B');
    // OKX's own lime is never used.
    expect(JSON.stringify(colors).toLowerCase()).not.toContain('#bcff2f');
    expect(controlHeights).toEqual([28, 32, 40, 48, 56]);
    expect(textStyles.hero.size).toBe('48px');
    expect(textStyles.base.size).toBe('14px');
  });

  it('holds the measured OKX values from critic round 1', () => {
    expect(colors.warn).toBe('#F5A915');
    expect(colors['warn-text']).toBe('#FFC452');
    expect(colors.scrim).toBe('rgba(0, 0, 0, 0.68)');
    expect(colors['ma-2']).toBe('#EC407A');
    expect(colors['lime-soft']).toBe('rgba(200, 246, 74, 0.16)');
    expect(textStyles['2xs']).toEqual({ size: '12px', line: '16px', weight: '500' });
    expect(textStyles.xl).toEqual({ size: '24px', line: '28px', weight: '600' });
    expect(textStyles['2xl']).toEqual({ size: '28px', line: '34px', weight: '700' });
    expect(textStyles.hero).toEqual({ size: '48px', line: '58px', weight: '700' });
    expect(tightTextTokens).toEqual(['hero']);
    expect(radii['2xs']).toBe('2px');
    expect(sizes['topbar-h']).toBe('48px');
    expect(sizes['container-max']).toBe('1224px');
    expect(css).toContain('--if-topbar-h: 48px;');
  });

  it('pins Tailwind spacing to 4 px so the legacy 14 px root cannot shrink every kit size', () => {
    expect(themeCss).toContain('--spacing: 4px;');
  });

  it('turns every motion token to 0 ms under prefers-reduced-motion', () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)![1]!;
    for (const name of ['--if-t-fast', '--if-t-menu', '--if-t-tab', '--if-t-flash']) {
      expect(block).toContain(`${name}: 0ms;`);
    }
  });
});

describe('contrast (WCAG 2.2 AA) on the surfaces the tokens sit on', () => {
  it.each([
    ['fg', 'bg'],
    ['fg-2', 'bg'],
    ['fg-2', 'panel'],
    ['down-text', 'bg'],
    ['up-text', 'bg'],
    ['on-lime', 'lime'],
    ['on-up', 'up'],
    ['fg', 'down'],
    ['lime', 'bg'],
    ['error-text', 'bg'],
    ['error-text', 'panel'],
    ['error-text', 'field'],
    ['fg-2', 'field'],
    ['warn-text', 'bg'],
  ] as const)('%s on %s is at least 4.5:1', (fg, bg) => {
    expect(contrast(colors[fg], colors[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the red-up swap readable', () => {
    const t = { ...colors, ...redUpOverrides } as Record<string, string>;
    expect(contrast(t['up-text']!, t['bg']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['down-text']!, t['bg']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['on-up']!, t['up']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['on-down']!, t['down']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps faint text (fg-3) at WCAG AA on the surfaces text sits on', () => {
    for (const surface of ['bg', 'panel', 'hover', 'field'] as const) {
      expect(contrast(colors['fg-3'], colors[surface]), surface).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('defines the focus ring the screens use', () => {
    expect(css).toContain('--if-focus: var(--if-lime);');
    expect(themeCss).toContain('--color-focus: var(--if-focus);');
  });

  it('gives the accent as text its own name, today the same lime', () => {
    expect(css).toContain('--if-accent-text: var(--if-lime);');
    expect(themeCss).toContain('--color-accent-text: var(--if-accent-text);');
    // Today it is the lime, so the lime is held to AA on the surfaces accent text sits on.
    expect(aliases['accent-text']).toBe('var(--if-lime)');
    for (const surface of ['bg', 'panel', 'hover', 'field'] as const) {
      expect(contrast(colors.lime, colors[surface]), surface).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('only overrides tokens that exist', () => {
    for (const key of Object.keys(redUpOverrides)) expect(key in colors).toBe(true);
  });
});

describe('kit additions (feat/ui-kit-core)', () => {
  it('adds the table and control sizes without changing an existing one', () => {
    expect(sizes['ctl-h']).toBe('44px');
    expect(sizes['ctl-h-dense']).toBe('32px');
    expect(sizes['table-row-h']).toBe('44px');
    expect(sizes['table-row-h-dense']).toBe('32px');
    expect(sizes['table-head-h']).toBe('39px');
    expect(sizes['table-head-h-dense']).toBe('28px');
    expect(sizes['row-h']).toBe('60px');
    expect(sizes['book-row-h']).toBe('22px');
  });

  it('keeps --if-base as an alias of --if-bg, never a second value', () => {
    expect(aliases.base).toBe('var(--if-bg)');
    expect(css).toContain('--if-base: var(--if-bg);');
  });

  it('names the error pair so it cannot collide with the legacy --if-danger', () => {
    expect(colors.error).toBe('#FF5D73');
    expect(colors['error-text']).toBe('#F57A8A');
    expect(css).not.toContain('--if-danger');
  });

  it('only --if-font-mono and --if-warn (plus the base/bg alias pair) differ from the legacy admin stylesheet', () => {
    const legacy = readFileSync(join(here, '../tokens.css'), 'utf8');
    const decls = (text: string) =>
      new Map([...text.matchAll(/^\s*(--if-[a-z0-9-]+)\s*:\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!.trim().toLowerCase()]));
    const mine = decls(css);
    const theirs = decls(legacy);
    const different = [...mine.keys()].filter((k) => theirs.has(k) && theirs.get(k) !== mine.get(k)).sort();
    // --if-base and --if-bg differ only in spelling (each file points one at the other, both resolve to black).
    // A new name in this list means two stylesheets disagree: rename the new token or alias it, do not add it here.
    expect(different).toEqual(['--if-base', '--if-bg', '--if-font-mono', '--if-warn']);
  });

  it('maps the error colours into Tailwind', () => {
    expect(themeCss).toContain('--color-error: var(--if-error);');
    expect(themeCss).toContain('--color-error-text: var(--if-error-text);');
  });
});

describe('theme.css (Tailwind @theme mapping)', () => {
  it('maps every colour token except the chart lines', () => {
    for (const key of Object.keys(colors)) {
      if (key.startsWith('ma-')) continue;
      expect(themeCss, key).toContain(`--color-${key}: var(--if-${key});`);
    }
  });

  it('only references custom properties that tokens.css declares', () => {
    const declared = new Set(Object.keys(cssVars()));
    for (const [, name] of themeCss.matchAll(/var\((--if-[a-z0-9-]+)\)/g)) {
      expect(declared.has(name!), `${name} is not declared in tokens.css`).toBe(true);
    }
  });

  it('is imported without preflight and disables the default palette', () => {
    expect(themeCss).toContain('--color-*: initial;');
    const code = themeCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/@import/);
    expect(code).not.toContain('preflight');
  });

  it("does not reuse one of the customer app's older names as a theme key", () => {
    const legacyNames = new Set(Object.keys(legacyVars));
    const mine = [...themeCss.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!).filter((n) => !n.endsWith('*'));
    const clashes = mine.filter((n) => legacyNames.has(n));
    expect(clashes).toEqual([]);
  });

  it('customer-legacy.css is exactly what tokens.ts generates', () => {
    expect(read('customer-legacy.css')).toBe(renderLegacyCss());
  });

  it("is the customer app's one token source: the old stylesheet is gone and nothing imports it", () => {
    const app = join(here, '../../../../apps/customer');
    if (!existsSync(app)) return; // package used outside the monorepo
    expect(existsSync(join(app, 'src/shared/tokens.css'))).toBe(false);
    const skip = new Set(['node_modules', 'dist', 'test-results', 'playwright-report']);
    const files = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        if (skip.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) files(full, out);
        else if (/\.(tsx?|m?js|css|html)$/.test(name)) out.push(full);
      }
      return out;
    };
    expect(files(app).filter((f) => /shared\/tokens\.css/.test(readFileSync(f, 'utf8')))).toEqual([]);
    expect(readFileSync(join(app, 'src/app/redesign.css'), 'utf8')).toContain("@import '@intafaced/ui/theme/customer-legacy.css';");
  });
});

describe('looks: stable names, values per look', () => {
  // Only --if-* names: customer-legacy.css loads after tokens.css, so a look could not override an older name.
  const names = new Set(Object.keys(cssVars()));

  it('has the default look, which keeps the values written in tokens.ts', () => {
    expect(looks[defaultLook]).toEqual({});
  });

  it.each(Object.entries(looks))('look %s sets only names that exist', (_id, vars) => {
    expect(Object.keys(vars).filter((n) => !names.has(n))).toEqual([]);
  });
});

describe('no hex colour outside tokens.ts', () => {
  const hexPattern = /#[0-9a-fA-F]{3,8}\b/;
  const roots = [
    join(here, '../components'),
    join(here, '../../../../apps/customer/src/screens'),
    join(here, '../../../../apps/customer/src/app'),
  ].filter(existsSync);

  it('finds no hex in component, screen or shell source (.ts, .tsx, .css)', () => {
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        if (!/\.(tsx?|css)$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
        // Coin art is third-party trademark artwork stored as data, not our palette.
        if (file.includes('/components/coins/')) continue;
        const text = readFileSync(file, 'utf8');
        if (hexPattern.test(text)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('theme.css and base.css contain no hex either', () => {
    expect(hexPattern.test(themeCss)).toBe(false);
    expect(hexPattern.test(read('base.css'))).toBe(false);
  });
});
