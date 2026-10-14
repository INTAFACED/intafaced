import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Preview isolation (PRO-TERMINAL-PLAN section 11; ROADMAP risk 1). Sample numbers must never reach real money screens, and a
 * Preview screen must never reach the API client or the data layer. Sample numbers leaking into real totals would be a trust
 * incident, so these are import-graph checks over the source, not behaviour checks.
 */
const src = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(src, 'preview', 'fixtures');
const previewDir = join(src, 'preview');
const previewScreensDir = join(src, 'screens', 'preview');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const sourceFiles = walk(src).filter((file) => /\.(ts|tsx|mjs|js|jsx)$/.test(file));
const isTest = (file: string) => /\.(test|pw)\.(ts|tsx|mjs)$/.test(file) || file.includes(`${sep}harness${sep}`);
const inside = (file: string, dir: string) => file === dir || file.startsWith(dir + sep);

/** Every module specifier a file imports, re-exports or dynamically imports. */
function specifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const found: string[] = [];
  for (const pattern of [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ])
    for (const match of text.matchAll(pattern)) found.push(match[1]!);
  return found;
}
/** Absolute path a relative specifier points at (file or folder), or the bare specifier when it is a package. */
function target(file: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  const base = resolve(dirname(file), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.tsx')])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return base;
}
const rel = (file: string) => relative(src, file).split(sep).join('/');

const production = sourceFiles.filter((file) => !isTest(file));
const fixtureFiles = production.filter((file) => inside(file, fixturesDir));
const previewUi = production.filter((file) => (inside(file, previewDir) && !inside(file, fixturesDir)) || inside(file, previewScreensDir));

describe('preview isolation', () => {
  it('finds the files it is meant to police', () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(14); // 13 products + types
    expect(previewUi.length).toBeGreaterThan(13);
    expect(production.length).toBeGreaterThan(200);
  });

  it('lets no file outside the preview folders import a fixture (real data paths never read sample data)', () => {
    const offenders: string[] = [];
    for (const file of production) {
      if (inside(file, previewDir) || inside(file, previewScreensDir)) continue;
      for (const specifier of specifiers(file)) {
        const resolved = target(file, specifier);
        if (inside(resolved, fixturesDir) || /(^|\/)preview\/fixtures(\/|$)/.test(specifier))
          offenders.push(`${rel(file)} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('lets the data layer, the API client, features and real screens import nothing from the preview folders', () => {
    const real = production.filter(
      (file) =>
        inside(file, join(src, 'data')) ||
        inside(file, join(src, 'features')) ||
        inside(file, join(src, 'shared')) ||
        (inside(file, join(src, 'screens')) && !inside(file, previewScreensDir)),
    );
    expect(real.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const file of real)
      for (const specifier of specifiers(file)) {
        const resolved = target(file, specifier);
        if (inside(resolved, previewDir) || inside(resolved, previewScreensDir)) offenders.push(`${rel(file)} imports ${specifier}`);
      }
    expect(offenders).toEqual([]);
  });

  it('keeps fixtures plain data: they import only each other and never the API client, data layer, features or session', () => {
    const offenders: string[] = [];
    for (const file of fixtureFiles)
      for (const specifier of specifiers(file)) {
        const resolved = target(file, specifier);
        if (!specifier.startsWith('.') || !(inside(resolved, fixturesDir) || resolved === join(previewDir, 'products.ts')))
          offenders.push(`${rel(file)} imports ${specifier}`);
      }
    expect(offenders).toEqual([]);
  });

  it('keeps Preview UI and screens off the API client, the data hooks and the session', () => {
    const forbiddenFolders = [join(src, 'features'), join(src, 'shared', 'api.ts')];
    // Pure formatting helpers may be shared; nothing that reads or writes through the network.
    const allowedData = new Set([join(src, 'data', 'format.ts'), join(src, 'data', 'decimal.ts'), join(src, 'data', 'types.ts')]);
    const offenders: string[] = [];
    for (const file of previewUi)
      for (const specifier of specifiers(file)) {
        const resolved = target(file, specifier);
        if (forbiddenFolders.some((folder) => inside(resolved, folder))) offenders.push(`${rel(file)} imports ${specifier}`);
        else if (inside(resolved, join(src, 'data')) && !allowedData.has(resolved)) offenders.push(`${rel(file)} imports ${specifier}`);
        else if (/^@intafaced\/(ledger-client|contracts|exchange-contract|auth)(\/|$)/.test(specifier))
          offenders.push(`${rel(file)} imports ${specifier}`);
        else if (/session|\bapi\b/.test(specifier.split('/').pop() ?? '') && specifier.startsWith('.'))
          offenders.push(`${rel(file)} imports ${specifier}`);
      }
    expect(offenders).toEqual([]);
  });

  it('makes no request anywhere in a Preview file', () => {
    const offenders: string[] = [];
    for (const file of [...fixtureFiles, ...previewUi]) {
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/.test(text)) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  it('keeps Preview chrome out of live money paths: Home, Money and the order ticket never mention it', () => {
    const offenders: string[] = [];
    const money = production.filter(
      (file) =>
        inside(file, join(src, 'screens', 'money')) ||
        inside(file, join(src, 'screens', 'home')) ||
        inside(file, join(src, 'screens', 'trade')) ||
        inside(file, join(src, 'screens', 'coin')),
    );
    for (const file of money)
      if (/PreviewActionButton|PreviewScreen|definePreviewFixture/.test(readFileSync(file, 'utf8'))) offenders.push(rel(file));
    expect(offenders).toEqual([]);
  });

  it('is able to catch a leak (the checker flags a fabricated import)', () => {
    // Guards the guard: the resolver must see through relative paths and index files, not only the literal string.
    const fake = join(src, 'data', 'hooks.ts');
    expect(inside(target(fake, '../preview/fixtures/futures'), fixturesDir)).toBe(true);
    expect(inside(target(fake, '../screens/preview/futures'), previewScreensDir)).toBe(true);
    expect(specifiers(join(previewDir, 'index.ts'))).toContain('./PreviewChip');
  });
});
