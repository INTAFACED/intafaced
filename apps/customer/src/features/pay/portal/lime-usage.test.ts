import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Lime marks three things in the merchant portal: the one primary action, the active tab or menu item, and the focus
 * ring. Statuses, links, ids, progress bars, timeline dots and chart bars are never lime.
 */
const root = fileURLToPath(new URL('.', import.meta.url));
const lime = /--if-lime|--if-accent|--color-accent|#c8f64a|lime/i;
const allowed = /:focus|aria-current|\.primary|--primary/;

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return name.endsWith('.css') ? [full] : [];
  });
}

/** Every declaration that names lime, with the full selector it sits under (nesting included). */
function limeRules(css: string): { selector: string; declaration: string }[] {
  const out: { selector: string; declaration: string }[] = [];
  const stack: string[] = [];
  let buffer = '';
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') {
      stack.push(buffer.trim());
      buffer = '';
    } else if (ch === '}') {
      if (buffer.trim() && lime.test(buffer)) out.push({ selector: stack.join(' '), declaration: buffer.trim() });
      stack.pop();
      buffer = '';
    } else if (ch === ';') {
      if (lime.test(buffer)) out.push({ selector: stack.join(' '), declaration: buffer.trim() });
      buffer = '';
    } else buffer += ch;
  }
  return out;
}

describe('lime in the merchant portal', () => {
  const files = cssFiles(root);
  it('reads the portal stylesheets', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });
  it.each(files.map((f) => [f.slice(root.length), f] as const))(
    '%s uses lime only for the focus ring, the active tab and the primary action',
    (_n, file) => {
      const offenders = limeRules(readFileSync(file, 'utf8')).filter((rule) => !allowed.test(rule.selector));
      expect(offenders).toEqual([]);
    },
  );
  it('finds lime where it is used (the check can fail)', () => {
    const found = limeRules('.a { .b { color: var(--if-lime); } }');
    expect(found).toEqual([{ selector: '.a .b', declaration: 'color: var(--if-lime)' }]);
    expect(allowed.test(found[0]!.selector)).toBe(false);
  });
});
