import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { roleNames, roleVar, templateSlots, templates, typeRoles } from './contracts.js';
import { formattedLitCss } from './format.js';
import { looks } from '../theme/tokens.js';
import { flat, flatTypeMap, lit, litLight } from './tokens.js';
import { contrastRatio, deltaE2000, hue, toHex } from './colour.js';

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
    const imageRoles = new Set([
      'field',
      'sheen',
      'glass-bg',
      'primary-bg',
      'secondary-bg',
      'key-bg',
      'key-lit-bg',
      'object-bg',
      'object-spark-bg',
    ]);
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

  it('the light set only re-values known roles', () => {
    const known = new Set<string>(roleNames);
    for (const k of Object.keys(litLight)) expect(known.has(k), k).toBe(true);
  });

  it('draws Volt on the root with no switch: no direction or accent selector is left in lit.css', () => {
    expect(css).not.toMatch(/data-direction|data-accent/);
    expect(css.toLowerCase()).toContain(`--lit-accent: ${lit.accent.toLowerCase()};`);
    expect(lit.accent).toBe('#E0F83A');
  });

  it("today's medium and large radii are box radii, never the control's pill (a tall box drawn with a pill clips into an ellipse)", () => {
    for (const name of ['--if-r-md', '--if-r-lg']) {
      const role = css.match(new RegExp(`${name}: var\\(--lit-([a-z-]+)\\);`))?.[1];
      expect(role, name).toBeDefined();
      expect(parseFloat(String(lit[role as keyof typeof lit])), `${name} → --lit-${role}`).toBeLessThan(40);
    }
  });
});

describe('lit tokens: contrast at the worst point (text sits on opaque surfaces)', () => {
  const darkSurfaces = ['solid-bg', 'solid-bg-raised', 'solid-bg-sunken', 'page', 'refusal-bg'] as const;
  const lightSurfaces = ['solid-bg', 'solid-bg-raised', 'solid-bg-sunken', 'page', 'refusal-bg'] as const;
  const textRoles = [
    'text-1',
    'text-2',
    'text-3',
    'text-disabled',
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

  it('the risk band text is high contrast and its border is visible (COBS 4.12A: prominent, never faded)', () => {
    expect(contrast(lit['legal-fg'], lit['legal-bg'])).toBeGreaterThanOrEqual(7);
    expect(contrast(lit['legal-border'], lit['legal-bg'])).toBeGreaterThanOrEqual(3);
    const L = { ...lit, ...litLight };
    expect(contrast(L['legal-fg'], L['legal-bg'])).toBeGreaterThanOrEqual(7);
    expect(contrast(L['legal-border'], L['legal-bg'])).toBeGreaterThanOrEqual(3);
  });

  it('text on the lit fill meets 4.5:1', () => {
    const m = lit;
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
      litLight['accent-text'] ?? lit['accent-text'],
    ]);
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

describe('Volt: the chartreuse spark (intafaced issue 9302)', () => {
  const dark = lit;
  const light = { ...lit, ...litLight };
  const stops = (gradient: string) => [...gradient.matchAll(/#[0-9A-F]{6}/gi)].map((m) => m[0]);

  it('the colour measures agree with known values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('rgb(10, 10, 9)', '#0A0A09')).toBeCloseTo(1, 5);
    expect(toHex('rgba(255, 255, 255, 0.5)', '#000000')).toBe('#808080');
    expect(toHex('rgb(255 255 255 / 50%)')).toBe('#808080');
    expect(toHex('rgb(224, 248, 58)')).toBe('#E0F83A');
    expect(deltaE2000('#E0F83A', '#E0F83A')).toBe(0);
    expect(deltaE2000('#FAF33E', '#FFC452')).toBeCloseTo(17.5, 1);
  });

  it('is chartreuse, not lemon: its hue sits on the green side of yellow, as in the references', () => {
    expect(hue(dark.accent)).toBeGreaterThanOrEqual(64);
    expect(hue(dark.accent)).toBeLessThanOrEqual(80);
    expect(hue('#FAF33E')).toBeLessThan(64);
  });

  it('reads as another colour than the warning and the gain, in both schemes (CIEDE2000 at least 20)', () => {
    for (const m of [dark, light]) {
      expect(deltaE2000(m.accent, m['warn-text']), 'warning').toBeGreaterThanOrEqual(20);
      expect(deltaE2000(m['accent-text'], m['warn-text']), 'warning as text').toBeGreaterThanOrEqual(20);
      expect(deltaE2000(m.accent, m.up), 'gain').toBeGreaterThanOrEqual(20);
    }
  });

  it('passes AA as text on the page and every solid surface, dark and light', () => {
    for (const m of [dark, light])
      for (const s of ['page', 'solid-bg', 'solid-bg-raised', 'solid-bg-sunken'] as const)
        expect(contrastRatio(m['accent-text'], m[s]), s).toBeGreaterThanOrEqual(4.5);
    expect(dark['accent-text']).toBe(dark.accent);
  });

  it('carries its text as a fill at every stop of its gradients, and on the light primary', () => {
    for (const m of [dark, light]) {
      for (const stop of [m['accent-fill'], m['accent-fill-2'], ...stops(m['object-spark-bg'])])
        expect(contrastRatio(m['on-accent'], stop), stop).toBeGreaterThanOrEqual(4.5);
    }
    for (const stop of stops(dark['primary-bg'])) expect(contrastRatio(dark['primary-fg'], stop), stop).toBeGreaterThanOrEqual(4.5);
    for (const stop of stops(light['primary-bg'])) expect(contrastRatio(light['primary-fg'], stop), stop).toBeGreaterThanOrEqual(4.5);
  });

  it('a warning or a refusal stays readable on its badge (its own colour at 15%, as Badge draws it) over every light surface', () => {
    const tint = (fg: string, bg: string) =>
      '#' +
      [1, 3, 5]
        .map((i) => Math.round(parseInt(fg.slice(i, i + 2), 16) * 0.15 + parseInt(bg.slice(i, i + 2), 16) * 0.85))
        .map((c) => c.toString(16).padStart(2, '0'))
        .join('');
    for (const t of ['warn-text', 'error-text'] as const)
      for (const s of ['page', 'solid-bg', 'solid-bg-raised', 'solid-bg-sunken'] as const)
        expect(contrastRatio(light[t], tint(light[t], light[s])), `${t} on its tint over ${s}`).toBeGreaterThanOrEqual(4.5);
  });

  it('as a ring it stands 3:1 off the page in both schemes; the focus ring itself stays white or ink, never the spark', () => {
    expect(contrastRatio(dark.accent, dark.page)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(light['accent-text'], light.page)).toBeGreaterThanOrEqual(3);
    for (const m of [dark, light]) expect([m.accent, m['accent-text'], m['accent-fill']]).not.toContain(m.focus);
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
      '@fontsource-variable/archivo/wdth.css',
    ]);
  });
  it('the font roles lead with the families those packages declare', () => {
    expect(lit['font-ui'].startsWith("'Archivo Variable'")).toBe(true);
    expect(lit['font-figure'].startsWith("'Archivo Variable'")).toBe(true);
    expect(lit['font-mono'].startsWith("'Geist Mono Variable'")).toBe(true);
    expect(readFileSync(require.resolve('@fontsource-variable/archivo/wdth.css'), 'utf8')).toContain("font-family: 'Archivo Variable'");
    for (const pkg of ['geist', 'geist-mono']) {
      const css = readFileSync(require.resolve(`@fontsource-variable/${pkg}/index.css`), 'utf8');
      expect(css).toContain(pkg === 'geist' ? "font-family: 'Geist Variable'" : "font-family: 'Geist Mono Variable'");
    }
  });
});

describe('the kit draws the arrows its faces lack', () => {
  // Archivo and Geist carry no ▲ ▼ → ← ↗, so a typed one falls back to a system face (look gate run 45061471946: ▲ in
  // WenQuanYi Zen Hei). The kit draws them: lt-arrow-up, lt-arrow-down, lt-arrow-go, lt-arrow-back, lt-arrow-out.
  // The one left: Change's ▲ ▼, which J-portfolio-01 #7 and money.pw.mjs read as text ('▲ up'). It is drawn once those
  // tests read the drawn arrow instead; then this list is empty.
  const waiting = new Set(["components/index.tsx: const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '';"]);
  it('no kit component types one outside a comment', () => {
    const typed = walk(here)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''))
          .split('\n')
          .map((line, i) => ({ at: `${f.slice(here.length)}:${i + 1}`, code: line.replace(/\/\/.*$/, '') }))
          .filter(({ code }) => /[▲▼→←↗]/.test(code))
          .filter(({ at, code }) => !waiting.has(`${at.replace(/:\d+$/, '')}: ${code.trim()}`))
          .map(({ at }) => at),
      );
    expect(typed).toEqual([]);
  });
});
