import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recipes } from '../index.js';
import { LEDGER_POST_ALLOWLIST } from './caller-allowlist.js';

/** Every grant cites a production file that posts it, and every production post is granted (moved from svc-ledger's caller-binding.test.ts). */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('ledger post allowlist cites real callers', () => {
  it('every grant file calls that recipe', () => {
    for (const grants of Object.values(LEDGER_POST_ALLOWLIST)) {
      for (const [recipe, grant] of Object.entries(grants)) {
        const cite = grant.cite;
        const text = readFileSync(join(ROOT, cite), 'utf8');
        // Built in the caller (`recipes.<name>(`), or named on the postRecipe door (`postRecipe({ recipe: '<name>'`), or in
        // a Rust service named as `"<name>"` (crates/svc-academy) or built as `Recipe::<Name>` (crates/svc-agents) in the file
        // that sends it through its `post_recipe(` client.
        // Or a Rust file that hands `"<name>"` to its crate's recipe wrapper (a `fn` with a `recipe: &str` parameter that
        // posts it, as crates/svc-bank's `loans::service::post`).
        const variant = `Recipe::${recipe.charAt(0).toUpperCase()}${recipe.slice(1)}`;
        const rust =
          cite.endsWith('.rs') &&
          ((text.includes('post_recipe(') && (text.includes(`"${recipe}"`) || text.includes(variant))) ||
            wrapperCalls(text, crateWrappers(cite.split('/').slice(0, 2).join('/'))).includes(recipe));
        if (!rust) expect(text, cite).toMatch(new RegExp('recipes\\.' + recipe + "\\(|postRecipe\\(\\{\\s*recipe:\\s*'" + recipe + "'"));
      }
    }
  });

  it('does not grant subAccountTransfer — identity only mentions it in a comment', () => {
    const granted = Object.values(LEDGER_POST_ALLOWLIST).flatMap((grants) => Object.keys(grants));
    expect(granted).not.toContain('subAccountTransfer');
  });

  it('grants every production recipes.<name>( pair', () => {
    const pairs = new Set<string>();
    const servicesDir = join(ROOT, 'services');
    for (const service of readdirSync(servicesDir)) {
      if (!service.startsWith('svc-') || service === 'svc-ledger') continue;
      const src = join(servicesDir, service, 'src');
      if (!existsSync(src)) continue;
      for (const file of productionSources(src)) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/recipes\.([A-Za-z0-9_]+)\(|postRecipe\(\{\s*recipe:\s*'([A-Za-z0-9_]+)'/g)) {
          const recipe = match[1] ?? match[2];
          if (recipe) pairs.add(`${service} ${recipe}`);
        }
      }
    }
    // A Rust service (`crates/svc-<x>`) sends a recipe through its client's `.post_recipe(`: in a file that calls it, each
    // string literal naming a recipe, and each `Recipe::<Name>` variant it builds, is a pair. Its tests (the `#[cfg(test)]` module, and `tests/`) are not production.
    const cratesDir = join(ROOT, 'crates');
    for (const service of existsSync(cratesDir) ? readdirSync(cratesDir) : []) {
      const src = join(cratesDir, service, 'src');
      if (!service.startsWith('svc-') || !existsSync(src)) continue;
      const wrappers = crateWrappers(join('crates', service));
      for (const file of rustSources(src)) {
        const text = readFileSync(file, 'utf8').split('#[cfg(test)]')[0] ?? '';
        for (const name of wrapperCalls(text, wrappers)) if (Object.hasOwn(recipes, name)) pairs.add(`${service} ${name}`);
        if (!/\.post_recipe\(/.test(text)) continue;
        for (const [, name] of text.matchAll(/"([A-Za-z][A-Za-z0-9_]*)"/g))
          if (name !== undefined && Object.hasOwn(recipes, name)) pairs.add(`${service} ${name}`);
        for (const [, v] of text.matchAll(/\bRecipe::([A-Z][A-Za-z0-9]*)/g)) {
          const name = v === undefined ? undefined : v.charAt(0).toLowerCase() + v.slice(1);
          if (name !== undefined && Object.hasOwn(recipes, name)) pairs.add(`${service} ${name}`);
        }
      }
    }

    const allowlist = new Set<string>();
    for (const [service, grants] of Object.entries(LEDGER_POST_ALLOWLIST)) {
      for (const recipe of Object.keys(grants)) allowlist.add(`${service} ${recipe}`);
    }
    const missing = [...pairs].filter((pair) => !allowlist.has(pair)).sort();
    const stray = [...allowlist].filter((pair) => !pairs.has(pair)).sort();
    expect({ missing, stray }).toEqual({ missing: [], stray: [] });
  });
});

/**
 * A crate's recipe wrappers: each `fn <name>(` with a `recipe: &str` parameter in a production file that sends through
 * its client's `.post_recipe(`. The same reading as tooling/ci/custody-layer-check.mjs `rustRecipeWrappers`.
 */
function crateWrappers(crate: string): string[] {
  const src = join(ROOT, crate, 'src');
  if (!existsSync(src)) return [];
  const names = rustSources(src).flatMap((file) => {
    const text = readFileSync(file, 'utf8').split('#[cfg(test)]')[0] ?? '';
    if (!/\.post_recipe\(/.test(text)) return [];
    return [...text.matchAll(/\bfn\s+([a-z_][a-z0-9_]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g)]
      .filter((m) => /\brecipe\s*:\s*&str\b/.test(m[2] ?? ''))
      .map((m) => m[1] ?? '');
  });
  return [...new Set(names)].filter(Boolean);
}

/** The recipe names a file hands to one of its crate's wrappers: each string literal in that call's statement. */
function wrapperCalls(text: string, wrappers: string[]): string[] {
  if (wrappers.length === 0) return [];
  const live = text.split('#[cfg(test)]')[0] ?? '';
  const call = new RegExp(`(?<![.\\w])(?:${wrappers.join('|')})\\s*\\(([^;]*)`, 'g');
  return [...live.matchAll(call)].flatMap((m) => [...(m[1] ?? '').matchAll(/"([A-Za-z][A-Za-z0-9_]*)"/g)].map((x) => x[1] ?? ''));
}

function rustSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return rustSources(path);
    return entry.name.endsWith('.rs') ? [path] : [];
  });
}

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === '__tests__' || entry.name === 'scripts') continue;
      out.push(...productionSources(path));
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue;
    out.push(path);
  }
  return out;
}
