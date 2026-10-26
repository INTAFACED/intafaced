#!/usr/bin/env node
/**
 * Moves hand-typed sizes in the customer app's CSS onto token names, so a look change is a values swap.
 *
 *   node tooling/scripts/look-codemod.mjs            report only: what it would change, and what stays hand-typed
 *   node tooling/scripts/look-codemod.mjs --write    rewrite the files
 *   node tooling/scripts/look-codemod.mjs --write apps/customer/src/features/bank   one area (any paths or folders)
 *
 * Re-runnable and safe to run on a branch that conflicts: it only replaces a value with the token whose value
 * is exactly that value today (read from packages/ui/src/theme/tokens.css), so the page looks the same.
 *
 * What it touches, in declarations only (never selectors or @media):
 *   gap, row-gap, column-gap, padding*, margin*  -> --if-space-*   (positive px on the scale)
 *   font-size, the size/line pair of `font:`     -> --if-text-*, --if-leading-*   (not the hero sizes)
 *   line-height                                  -> --if-leading-*
 *   *radius                                      -> --if-r-*
 *   var(--spacing-N | --text-N | --leading-N | --radius-N) in a property of that family, and var(--color-accent)
 *   anywhere: the customer app's older names, where the kit token has the same value.
 *   text colours (color, caret-color, text-decoration-color, -webkit-text-fill-color, text-emphasis-color): the
 *   accent (--if-lime, the shell's --tb-lime, the older --color-accent) -> --if-accent-text, today the same lime, so a
 *   light theme can darken accent text without darkening fills. Not --if-accent: the founder console's is orange.
 * Lines with two declarations or a comment are left as written.
 * Widths, heights, borders, outlines, grid tracks and breakpoints are geometry and stay px.
 */
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * px value -> token name for each family, read from the default look (the first `:root {` block) of the generated
 * kit tokens, so a look's retuned values never feed the map. Hero sizes are left out on purpose: a 48 px heading is
 * not the hero role just because it shares its size today. `prefer` breaks ties.
 */
export function scales(tokensCss) {
  const block = tokensCss.match(/^:root \{\n([\s\S]*?)^\}/m)?.[1] ?? '';
  const vars = [...block.matchAll(/^\s*(--if-[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]);
  const family = (prefix, prefer = [], skip = []) => {
    const out = new Map();
    for (const [name, value] of vars) {
      if (!name.startsWith(prefix) || !/^\d+(\.\d+)?px$/.test(value)) continue;
      const key = name.slice(prefix.length);
      if (skip.includes(key)) continue;
      if (!out.has(value) || prefer.includes(key)) out.set(value, name);
    }
    return out;
  };
  return {
    space: family('--if-space-'),
    text: family('--if-text-', ['xs'], ['hero', 'hero-pro']),
    leading: family('--if-leading-', ['xs', 'lg'], ['hero', 'hero-pro']),
    radius: family('--if-r-'),
  };
}

/**
 * The customer app's older size names with the values apps/customer/src/shared/tokens.css gave them (frozen here,
 * so a branch cut before they were retired still maps them), and the family each may move to. A name not listed
 * was never defined and is left alone.
 */
const LEGACY_SIZES = {
  '--text-13': ['text', '13px'],
  '--text-14': ['text', '14px'],
  '--text-15': ['text', '15px'],
  '--text-16': ['text', '16px'],
  '--text-18': ['text', '18px'],
  '--text-20': ['text', '20px'],
  '--text-24': ['text', '24px'],
  '--text-60': ['text', '60px'],
  '--leading-20': ['leading', '20px'],
  '--leading-22': ['leading', '22px'],
  '--leading-24': ['leading', '24px'],
  '--leading-26': ['leading', '26px'],
  '--leading-28': ['leading', '28px'],
  '--leading-32': ['leading', '32px'],
  '--leading-68': ['leading', '68px'],
  '--radius-4': ['radius', '4px'],
  '--radius-8': ['radius', '8px'],
  '--radius-10': ['radius', '10px'],
  '--radius-12': ['radius', '12px'],
  '--radius-16': ['radius', '16px'],
  '--radius-26': ['radius', '26px'],
  '--radius-28': ['radius', '28px'],
  ...Object.fromEntries(
    [2, 4, 8, 10, 12, 14, 16, 20, 28, 32, 40, 44, 48, 52, 56, 64, 72, 76, 80, 84].map((n) => [`--spacing-${n}`, ['space', `${n}px`]]),
  ),
};
// Only names the light theme (features/account/account.css) does not override; --color-background stays until light ships or goes.
const LEGACY_COLOURS = { '--color-accent': '--if-lime' };

// The accent's names, which as text colour move to the accent-text role (same value today). A fallback is kept.
const ACCENT = /var\(--(?:if-lime|tb-lime|color-accent)(?=[\s,)])/g;
const TEXT_COLOUR = /^(color|caret-color|text-decoration-color|-webkit-text-fill-color|text-emphasis-color)$/;

const PX = /(^|[\s(,/])(\d+(?:\.\d+)?px)(?=$|[\s),/;!])/g;

function familyOf(prop) {
  if (/^(gap|row-gap|column-gap|padding(-[a-z-]+)?|margin(-[a-z-]+)?)$/.test(prop)) return 'space';
  if (prop === 'font-size') return 'text';
  if (prop === 'line-height') return 'leading';
  if (/^border(-[a-z]+)*-radius$/.test(prop)) return 'radius';
  return null;
}

/** Rewrites one stylesheet. Returns the new text and the counts. */
export function transform(css, s) {
  let changed = 0;
  const swap = (value, map) =>
    value.replace(PX, (all, lead, px) => {
      const name = map.get(px);
      if (!name) return all;
      changed++;
      return `${lead}var(${name})`;
    });
  /** Older names: colours anywhere, sizes only where the property is of that size's family. */
  const renameLegacy = (value, families) =>
    value.replace(/var\((--[a-z0-9-]+)(\s*,\s*([^()]*))?\)/g, (all, name, _fb, fallback) => {
      if (LEGACY_COLOURS[name]) {
        changed++;
        return all.replace(name, LEGACY_COLOURS[name]);
      }
      const [fam, px] = LEGACY_SIZES[name] ?? [];
      const token = fam && families.includes(fam) && s[fam].get(px);
      if (!token) return all;
      changed++;
      // A fallback equal to the value is now redundant; any other fallback is kept as written.
      return fallback === undefined || fallback.trim() === px ? `var(${token})` : `var(${token}, ${fallback.trim()})`;
    });

  const out = css
    .split('\n')
    .map((line) => {
      // One declaration per line, no comment on it (prettier's shape); anything else is left as written.
      if (line.includes('/*') || (line.match(/;/g) ?? []).length > 1) return line;
      const m = line.match(/^(\s*)(-?[a-z][a-z-]*)(\s*:\s*)(.*?)(;?\s*)$/);
      if (!m || /[{,]\s*$/.test(line) || /^\s*@/.test(line)) return line;
      const [, indent, prop, colon, value, tail] = m;
      let v;
      if (prop === 'font') {
        v = renameLegacy(value, ['text', 'leading']).replace(/(\d+(?:\.\d+)?px)(\s*\/\s*)(\d+(?:\.\d+)?px)/, (all, size, slash, lead) => {
          const a = s.text.get(size);
          const b = s.leading.get(lead);
          if (a) changed++;
          if (b) changed++;
          return `${a ? `var(${a})` : size}${slash}${b ? `var(${b})` : lead}`;
        });
      } else {
        const fam = familyOf(prop);
        v = value;
        if (TEXT_COLOUR.test(prop))
          v = v.replace(ACCENT, () => {
            changed++;
            return 'var(--if-accent-text';
          });
        v = renameLegacy(v, fam ? [fam] : []);
        if (fam) v = swap(v, s[fam]);
      }
      return v === value ? line : `${indent}${prop}${colon}${v}${tail}`;
    })
    .join('\n');
  const left = (out.replace(/\/\*[\s\S]*?\*\//g, '').match(/-?\d*\.?\d+px\b/g) ?? []).length;
  return { css: out, changed, left };
}

function cssFiles(path, out = []) {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name === 'node_modules' || name === 'dist') continue;
      cssFiles(join(path, name), out);
    }
  } else if (path.endsWith('.css')) out.push(path);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const targets = args.filter((a) => !a.startsWith('--'));
  const s = scales(readFileSync(join(root, 'packages/ui/src/theme/tokens.css'), 'utf8'));
  const missing = targets.filter((t) => !existsSync(resolve(root, t)));
  if (missing.length) {
    console.error(`look-codemod: no such path: ${missing.join(', ')}`);
    process.exit(2);
  }
  const files = (targets.length ? targets : ['apps/customer/src']).flatMap((t) => cssFiles(resolve(root, t)));
  let changed = 0;
  let left = 0;
  const rows = [];
  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    const r = transform(before, s);
    changed += r.changed;
    left += r.left;
    if (r.changed || r.left) rows.push(`${String(r.changed).padStart(5)} ${String(r.left).padStart(5)}  ${relative(root, file)}`);
    if (write && r.css !== before) writeFileSync(file, r.css);
  }
  console.log(`${write ? 'moved' : 'would move'}  px left  file`);
  for (const row of rows.sort()) console.log(row);
  console.log(`${files.length} files: ${changed} values ${write ? 'moved' : 'to move'} onto tokens, ${left} px left as written.`);
}
