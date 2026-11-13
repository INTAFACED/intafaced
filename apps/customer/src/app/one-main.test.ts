import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The customer shells own the one `<main>` landmark of a page. A room inside them that draws a second one breaks the
// landmark for screen readers and makes `locator('main')` match two elements, which failed J-home-ia-02 #1 on
// /trade/bots whenever the room had drawn before the check ran (#8228).
const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELLS = new Set(['app/Shell.tsx', 'app/Web3Shell.tsx', 'features/public/PublicRoutes.tsx']);
const UI_PAGE = /import\s*\{([^}]*)\}\s*from\s*['"]@intafaced\/ui['"]/g;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'harness' || entry.name === '__gallery__' ? [] : sources(path);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [path] : [];
  });
}

/** The local names a file gives `@intafaced/ui`'s `Page`, which renders `<main>` unless told `landmark={false}`. */
function pageNames(text: string): string[] {
  return [...text.matchAll(UI_PAGE)].flatMap(([, names]) =>
    names!
      .split(',')
      .map((name) => name.trim().match(/^Page(?:\s+as\s+(\w+))?$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => m[1] ?? 'Page'),
  );
}

/** Opening tags of a component, props in braces kept whole so an arrow's `>` does not end the tag. */
function openingTags(text: string, name: string): string[] {
  return [...text.matchAll(new RegExp(`<${name}\\b(?:[^>{]|\\{(?:[^{}]|\\{[^{}]*\\})*\\})*>`, 'g'))].map(([tag]) => tag);
}

describe('one main landmark per customer page', () => {
  const files = sources(src).map((path) => ({ file: relative(src, path), text: readFileSync(path, 'utf8') }));

  it('rooms draw no <main> of their own; only the shells do', () => {
    const extra = files.filter(({ file, text }) => !SHELLS.has(file) && /(^|[^`])<main[\s>]/m.test(text)).map(({ file }) => file);
    expect(extra).toEqual([]);
  });

  it('every @intafaced/ui Page in a room is landmark={false}', () => {
    const bad = files.flatMap(({ file, text }) =>
      pageNames(text).flatMap((name) =>
        openingTags(text, name)
          .filter((tag) => !/\blandmark=\{false\}/.test(tag))
          .map((tag) => `${file}: ${tag}`),
      ),
    );
    expect(bad).toEqual([]);
  });

  it('finds a Page that would draw a second main, aliased or not', () => {
    const text = 'import { Badge, Page as Kit } from \'@intafaced/ui\';\nconst a = <Kit width="full" onX={() => 1 > 0}>x</Kit>;';
    expect(pageNames(text)).toEqual(['Kit']);
    expect(openingTags(text, 'Kit')).toEqual(['<Kit width="full" onX={() => 1 > 0}>']);
    const quoted = 'import { Page } from "@intafaced/ui";\nconst b = <Page style={{ gap: 1 }} landmark={false}>x</Page>;';
    expect(pageNames(quoted)).toEqual(['Page']);
    expect(openingTags(quoted, 'Page')).toEqual(['<Page style={{ gap: 1 }} landmark={false}>']);
  });
});
