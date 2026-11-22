#!/usr/bin/env node
// Rewrites each value import of the contracts barrel in Node code (`import { a, type B } from '@intafaced/contracts'` in
// services/*/src and packages/*/src, tests aside) to the files that define the names: `import { a } from
// '@intafaced/contracts/<file>'`, with the type names left on the barrel as `import type` (erased when compiled, so they
// load nothing). The barrel re-exports all 210 contract files, so importing one name ran every one of them: 40 MB of heap
// in each service, where the 10 files svc-quant uses take 6 MB. `export { a } from` and `import * as ns from` are
// rewritten the same way. oxlint's no-restricted-imports (.oxlintrc.json) refuses a new value import of the barrel.
//
//   node tooling/codemod/contracts-subpaths/rewrite.mjs           rewrite, then prettier the files it changed
//   node tooling/codemod/contracts-subpaths/rewrite.mjs --check   list what it would change; exit 1 if anything
//
// The names come from the built package (packages/contracts/dist, `pnpm --filter @intafaced/contracts... build`): each
// file the barrel re-exports, imported, and its runtime export names; a name goes to the first file in the barrel's own
// order, as `export *` resolves it. A name that is in no file stops the run.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PKG = '@intafaced/contracts';
const CONTRACTS = join(REPO, 'packages', 'contracts');
const TEST = /(\.(test|spec)\.ts$)|(\/(test|tests|testing|__tests__|fixtures)\/)/u;
const NAMED = /(import|export)(\s+type)?\s*\{([^}]*)\}\s*from\s*'@intafaced\/contracts';/gu;
const STAR = /import\s+\*\s+as\s+(\w+)\s+from\s+'@intafaced\/contracts';/gu;

/** name -> the barrel's file (`edge`) that exports it at runtime, in the barrel's order. */
async function nameFiles(contracts = CONTRACTS) {
  const barrel = readFileSync(join(contracts, 'src', 'index.ts'), 'utf8');
  const files = [...barrel.matchAll(/^export \* from '\.\/(.+)\.js';$/gmu)].map((m) => m[1]);
  const other = barrel.split('\n').filter((l) => l.startsWith('export ') && !/^export \* from '\.\/.+\.js';$/u.test(l));
  if (other.length) throw new Error(`the barrel has exports this codemod does not read: ${other.join(' | ')}`);
  const out = new Map();
  for (const f of files) {
    const mod = await import(pathToFileURL(join(contracts, 'dist', `${f}.js`)).href);
    for (const k of Object.keys(mod)) if (!out.has(k)) out.set(k, f);
  }
  return out;
}

/** One file's text with its barrel imports rewritten, or the same text. Throws on a name no file exports. */
export function rewrite(text, names, file = '') {
  const fileOf = (name) => {
    const f = names.get(name);
    if (!f) throw new Error(`${file}: ${name} is imported from ${PKG} but no contracts file exports it at runtime`);
    return f;
  };
  const named = (all, kind, typeOnly, list) => {
    if (typeOnly) return all;
    const specs = list
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const types = specs.filter((s) => s.startsWith('type '));
    const byFile = new Map();
    for (const s of specs.filter((x) => !x.startsWith('type '))) {
      const f = fileOf(s.split(/\s+as\s+/u)[0]);
      byFile.set(f, [...(byFile.get(f) ?? []), s]);
    }
    const lines = [...byFile].sort(([a], [b]) => a.localeCompare(b)).map(([f, s]) => `${kind} { ${s.join(', ')} } from '${PKG}/${f}';`);
    if (types.length) lines.unshift(`${kind} type { ${types.map((t) => t.slice(5)).join(', ')} } from '${PKG}';`);
    return lines.join('\n');
  };
  let next = text.replace(NAMED, named);
  for (const [all, ns] of next.matchAll(STAR)) {
    // `ns.member` becomes the bare name, imported from its file; a member no file exports at runtime is a type, imported
    // as a type from the barrel. A bare name the file already uses for something else stops the run.
    const used = [...new Set([...next.matchAll(new RegExp(`\\b${ns}\\.(\\w+)`, 'gu'))].map((m) => m[1]))];
    const rest = next.replace(all, '').replace(new RegExp(`\\b${ns}\\.\\w+`, 'gu'), '');
    const clash = used.filter((u) => new RegExp(`(?<![.\\w$])${u}\\b`, 'u').test(rest));
    if (clash.length) throw new Error(`${file}: ${ns}.* members ${clash.join(', ')} are names the file already uses; rewrite it by hand`);
    const list = used.map((u) => (names.has(u) ? u : `type ${u}`)).join(', ');
    next = next.replace(new RegExp(`\\b${ns}\\.(\\w+)`, 'gu'), '$1').replace(all, `import { ${list} } from '${PKG}';`);
    next = next.replace(NAMED, named);
  }
  return next;
}

async function main() {
  const check = process.argv.includes('--check');
  const names = await nameFiles();
  const files = execFileSync('git', ['grep', '-l', `'${PKG}'`, '--', 'services/*/src/**.ts', 'packages/*/src/**.ts'], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f && !TEST.test(f) && !f.startsWith('packages/contracts/'));
  const changed = [];
  for (const f of files) {
    const text = readFileSync(join(REPO, f), 'utf8');
    const next = rewrite(text, names, f);
    if (next === text) continue;
    changed.push(f);
    if (!check) writeFileSync(join(REPO, f), next);
  }
  if (!check && changed.length)
    execFileSync(join(REPO, 'node_modules', '.bin', 'prettier'), ['--write', ...changed], { cwd: REPO, stdio: 'ignore' });
  console.log(`${check ? 'would rewrite' : 'rewrote'} ${changed.length} file(s)`);
  if (check && changed.length) {
    for (const f of changed) console.log(`  ${f}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
