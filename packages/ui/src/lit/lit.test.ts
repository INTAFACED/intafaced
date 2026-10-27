import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { accents, roleNames, roleVar, templateSlots, templates, typeRoles } from './contracts.js';
import { formattedLitCss } from './format.js';
import { looks } from '../theme/tokens.js';
import { accentSets, accentTextLight, flat, flatTypeMap, lit, litLight } from './tokens.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const css = readFileSync(join(here, 'lit.css'), 'utf8');
const themeTokens = readFileSync(join(here, '../theme/tokens.css'), 'utf8');

const hex = (h: string) => {
  const m = /^#([0-9a-f]{6})$/i.exec(h);
  if (!m) throw new Error(`not an opaque hex: ${h}`);
  return h;
};
const lum = (h: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex(h).slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** An rgba() role laid over an opaque hex surface, as the hex the eye sees. */
const over = (rgba: string, base: string) => {
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(rgba);
  if (!m) throw new Error(`not an rgba: ${rgba}`);
  const a = Number(m[4]);
  return (
    '#' +
    [1, 3, 5]
      .map((i, k) => Math.round(Number(m[k + 1]) * a + parseInt(hex(base).slice(i, i + 2), 16) * (1 - a)))
      .map((c) => c.toString(16).padStart(2, '0'))
      .join('')
  );
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('lit tokens: lit.ts and lit.css cannot drift', () => {
  it('lit.css is exactly what tokens.ts generates', async () => {
    expect(css).toBe(await formattedLitCss(join(here, 'lit.css')));
  });

  it.each(roleNames)('role %s has a flat and a lit value and is emitted', (r) => {
    expect(flat[r]).toBeTruthy();
    expect(lit[r]).toBeTruthy();
    expect(css).toContain(`${roleVar(r)}:`);
  });

  it('declares every type role in both skins', () => {
    for (const t of Object.keys(typeRoles))
      for (const p of ['size', 'line', 'weight', 'tracking']) expect(css).toContain(`--lit-type-${t}-${p}:`);
  });

  it('the flat skin only points at tokens that exist today, and holds no colour of its own', () => {
    for (const [role, value] of Object.entries(flat)) {
      expect(value, role).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
      for (const m of value.matchAll(/var\((--if-[a-z0-9-]+)\)/g)) expect(themeTokens, `${role} -> ${m[1]}`).toContain(`${m[1]}:`);
    }
  });

  it('the flat type roles point at text styles that exist today', () => {
    for (const f of Object.values(flatTypeMap))
      for (const p of ['text', 'leading', 'weight']) expect(themeTokens, `--if-${p}-${f}`).toContain(`--if-${p}-${f}:`);
  });

  it('lit is not also a theme look (one switch, one generator)', () => {
    expect(Object.keys(looks)).not.toContain('lit');
  });

  it('colour roles hold one value type in every skin (image roles are named in contracts)', () => {
    const imageRoles = new Set(['field', 'sheen', 'glass-bg', 'primary-bg', 'secondary-bg', 'key-bg', 'key-lit-bg']);
    const isImage = (x: string) => /gradient\(/.test(x);
    for (const r of roleNames) {
      if (imageRoles.has(r)) continue;
      for (const [skin, m] of [
        ['flat', flat],
        ['lit', lit],
        ['light', litLight],
      ] as const) {
        const val = (m as Record<string, string | undefined>)[r];
        if (val) expect(isImage(val), `${skin}.${r}`).toBe(false);
      }
    }
  });

  it('light and accent sets only re-value known roles', () => {
    const known = new Set<string>(roleNames);
    for (const k of Object.keys(litLight)) expect(known.has(k), k).toBe(true);
    for (const a of accents) for (const k of Object.keys(accentSets[a])) expect(known.has(k), `${a}.${k}`).toBe(true);
  });
});

describe('lit tokens: contrast at the worst point (text sits on opaque surfaces)', () => {
  const darkSurfaces = ['solid-bg', 'solid-bg-raised', 'solid-bg-sunken', 'page', 'refusal-bg'] as const;
  const lightSurfaces = ['solid-bg', 'solid-bg-raised', 'solid-bg-sunken', 'page', 'refusal-bg'] as const;
  const textRoles = [
    'text-1',
    'text-2',
    'text-3',
    'accent-text',
    'up-text',
    'down-text',
    'warn-text',
    'error-text',
    'status-pending',
    'status-failed',
    'status-done',
    'status-unknown',
    'status-stale',
  ] as const;

  it.each(textRoles)('dark: %s meets 4.5:1 on every solid surface', (t) => {
    for (const s of darkSurfaces) expect(contrast(lit[t], lit[s]), `${t} on ${s}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(textRoles)('light: %s meets 4.5:1 on every solid surface', (t) => {
    const L = { ...lit, ...litLight };
    for (const s of lightSurfaces) expect(contrast(L[t], L[s]), `${t} on ${s}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(accents)('accent text of %s meets 4.5:1 in both schemes', (a) => {
    const dark = { ...lit, ...accentSets[a] }['accent-text'];
    for (const s of darkSurfaces) expect(contrast(dark, lit[s]), `${a} dark on ${s}`).toBeGreaterThanOrEqual(4.5);
    const L = { ...lit, ...litLight };
    for (const s of lightSurfaces) expect(contrast(accentTextLight[a], L[s]), `${a} light on ${s}`).toBeGreaterThanOrEqual(4.5);
  });

  it('the risk band text is high contrast and its border is visible (COBS 4.12A: prominent, never faded)', () => {
    expect(contrast(lit['legal-fg'], lit['legal-bg'])).toBeGreaterThanOrEqual(7);
    expect(contrast(lit['legal-border'], lit['legal-bg'])).toBeGreaterThanOrEqual(3);
    const L = { ...lit, ...litLight };
    expect(contrast(L['legal-fg'], L['legal-bg'])).toBeGreaterThanOrEqual(7);
    expect(contrast(L['legal-border'], L['legal-bg'])).toBeGreaterThanOrEqual(3);
  });

  it.each(accents)('text on a %s lit fill meets 4.5:1', (a) => {
    const m = { ...lit, ...accentSets[a] };
    expect(contrast(m['on-accent'], m['accent-fill'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(m['on-accent'], m['accent-fill-2'])).toBeGreaterThanOrEqual(4.5);
  });

  it("a control's edge meets 3:1 against every solid surface it sits on (SC 1.4.11)", () => {
    const L = { ...lit, ...litLight };
    for (const s of ['solid-bg', 'solid-bg-raised', 'solid-bg-sunken', 'control-bg'] as const) {
      expect(contrast(over(lit['control-rim'], lit[s]), lit[s]), `dark rim on ${s}`).toBeGreaterThanOrEqual(3);
      expect(contrast(over(L['control-rim'], L[s]), L[s]), `light rim on ${s}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('the risk band and refusals never use a brand colour, in either scheme', () => {
    const brand = new Set<string>([
      lit.accent,
      lit['accent-text'],
      lit['accent-fill'],
      lit['accent-fill-2'],
      ...Object.values(accentTextLight),
    ]);
    for (const a of accents) for (const x of Object.values(accentSets[a])) brand.add(x);
    for (const m of [lit, { ...lit, ...litLight }]) {
      for (const r of ['legal-bg', 'legal-fg', 'legal-border', 'refusal-bg', 'refusal-fg', 'refusal-border'] as const) {
        expect(m[r], r).not.toContain('accent');
        expect(brand.has(m[r]), r).toBe(false);
      }
    }
  });

  it('the focus ring is not a lit or selected colour, and is visible, in either scheme', () => {
    for (const m of [lit, { ...lit, ...litLight }]) {
      for (const r of ['accent', 'accent-text', 'control-rim-active', 'key-lit-bg'] as const) expect(m.focus, r).not.toBe(m[r]);
      expect(contrast(m.focus, m['solid-bg'])).toBeGreaterThanOrEqual(3);
      expect(contrast(m.focus, m.page)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('lit contracts', () => {
  it('every template has the legal slot first', () => {
    for (const t of Object.keys(templates) as (keyof typeof templates)[]) expect(templateSlots[t][0]).toBe('legal');
  });
});

describe('the founder console never reaches the lit kit', () => {
  it('no file in apps/admin imports @intafaced/ui/lit', () => {
    const admin = join(here, '../../../../apps/admin');
    const hits = walk(admin).filter(
      (f) => /\.(tsx?|css|mjs|js)$/.test(f) && /@intafaced\/ui\/lit|ui\/src\/lit/.test(readFileSync(f, 'utf8')),
    );
    expect(hits).toEqual([]);
  });
});

describe('lit fonts are self-hosted and named as the roles name them', () => {
  const fonts = readFileSync(join(here, 'fonts.css'), 'utf8');
  it('imports only pinned local packages, never a URL', () => {
    expect(fonts).not.toMatch(/https?:\/\//);
    expect([...fonts.matchAll(/@import '([^']+)'/g)].map((m) => m[1])).toEqual([
      '@fontsource-variable/geist/index.css',
      '@fontsource-variable/geist-mono/index.css',
    ]);
  });
  it('the font roles lead with the families those packages declare', () => {
    expect(lit['font-ui'].startsWith("'Geist Variable'")).toBe(true);
    expect(lit['font-figure'].startsWith("'Geist Variable'")).toBe(true);
    expect(lit['font-mono'].startsWith("'Geist Mono Variable'")).toBe(true);
    for (const pkg of ['geist', 'geist-mono']) {
      const css = readFileSync(require.resolve(`@fontsource-variable/${pkg}/index.css`), 'utf8');
      expect(css).toContain(pkg === 'geist' ? "font-family: 'Geist Variable'" : "font-family: 'Geist Mono Variable'");
    }
  });
});
