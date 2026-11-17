#!/usr/bin/env node
/**
 * Every journey helper is used, and so is every name it exports (project-state#2762).
 *
 * A journey helper is a module directly in apps/customer/tests/real-app/ that is not a run, test, spec or config file. A builder
 * reads these to learn what the journeys can call, so a helper nothing imports, or an `export` nothing imports, reads as
 * live when it is not. Two kinds of dead code had built up this way: whole helpers named only in path lists (a frozen
 * first version of the clause helpers) and 21 exports only their own file used.
 *
 * A helper counts as used when another tracked file imports it (`import … from`, `export … from`, `import()`), or names it
 * by a relative path in a string outside an import (the Playwright config's reporter, a fixture config): such a use takes
 * the whole module, as does a `join(dir, 'helper.mjs')` call (a tooling test's built path). A name counts as used when an import names it (`{ a }`, `const { a } = await import(…)`, or `ns.a` off a
 * namespace binding), or when a file takes the whole module in a way no name can be read from (a path string). A name only its own file uses is fixed by dropping `export`; a helper nothing uses is
 * deleted, with every list that names it.
 *
 * Usage: node tooling/ci/journey-helpers-used.mjs   (from the repo root; exits 1 and names each finding)
 * Its test, journey-helpers-used.test.mjs, runs it on the repo in the tooling-tests gate, and on planted faults.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HELPER_DIR = 'apps/customer/tests/real-app/';
const CODE = /\.(m?[jt]sx?|cjs|cts|mts)$/;

/** A journey helper's path, or false: directly in HELPER_DIR, `.mjs`, not a run, test, spec or Playwright config file. */
export const isHelper = (f) =>
  f.startsWith(HELPER_DIR) && !f.slice(HELPER_DIR.length).includes('/') && f.endsWith('.mjs') && !/\.(test|spec|pw|config)\.mjs$/.test(f);

/** The names a module exports: declarations, `export { a, b as c }`, and `default`. */
export function exportedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  if (/^export\s+default\b/m.test(src)) names.add('default');
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}(?!\s*from)/gm))
    for (const part of m[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name) names.add(name);
    }
  return names;
}

// `import a, { b, c as d } from './x.mjs'`, `import * as x from`, `import './x.mjs'`, `export { e } from`, `export * from`.
const STATIC =
  /\b(import|export)\s+(?:type\s+)?([\w$]+\s*,?\s*)?(\{[^}]*\}|\*\s*(?:as\s+[\w$]+)?)?\s*(?:from\s*)?(['"])(\.{1,2}\/[^'"]+)\4/g;
const DYNAMIC = /\bimport\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;
const PATH_STRING = /(['"])(\.{1,2}\/[^'"\n]*\.mjs)\1/g;
// `join(dir, 'world-restore.mjs')`: a tooling test that imports a helper by a built path, itself or in a child's code
// (`import(${JSON.stringify(join(dir, 'world-restore.mjs'))})`).
const JOINED = /\bjoin\([^()]*,\s*(['"])([^'"\n]+\.mjs)\1\s*\)/g;

/** The names read off a namespace binding in a file: `ns.name`, `ns['name']` and `const { name } = ns`. */
function memberNames(src, ns) {
  const id = ns.replace(/\$/g, '\\$');
  const read = [...src.matchAll(new RegExp(`(?<![\\w$.])${id}(?:\\??\\.([\\w$]+)|\\[\\s*['"]([\\w$]+)['"]\\s*\\])`, 'g'))].map(
    (m) => m[1] ?? m[2],
  );
  for (const m of src.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${id}(?![\\w$])`, 'g')))
    for (const part of m[1].split(','))
      read.push(
        part
          .trim()
          .split(/\\s*:\\s*/)[0]
          .split(/\\s*=/)[0]
          .trim(),
      );
  return read.filter(Boolean);
}

/**
 * A dynamic import at `at` in `src`: `const { a, b } = await import(…)` takes a and b; `const ns = await import(…)` takes
 * what the file reads off ns; anything else (an import passed on, a template, `.then`) takes the whole module.
 */
function takeBound(use, src, at) {
  use.used = true;
  const before = src.slice(Math.max(0, src.lastIndexOf('\n', at - 1) - 400), at);
  const destructured = before.match(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s*$/);
  if (destructured) {
    for (const part of destructured[1].split(',')) {
      const name = part
        .trim()
        .split(/\s*:\s*/)[0]
        .split(/\s*=/)[0]
        .trim();
      if (name && !name.startsWith('...')) use.names.add(name);
      else if (name) use.all = true;
    }
    return;
  }
  const bound = before.match(/(?:const|let|var)\s+([\w$]+)\s*=\s*await\s*$/);
  if (bound) for (const name of memberNames(src, bound[1])) use.names.add(name);
  else use.all = true;
}

/**
 * What each helper's users take from it. `files` maps a path to its text. Returns a Map from helper path to
 * { used: boolean, all: boolean, names: Set } for every helper among `files`.
 */
export function helperUses(files) {
  const uses = new Map([...files.keys()].filter(isHelper).map((h) => [h, { used: false, all: false, names: new Set() }]));
  const target = (from, spec) => {
    const t = posix.normalize(posix.join(posix.dirname(from), spec));
    return t !== from && uses.get(t);
  };
  for (const [file, src] of files) {
    if (!src.includes('.mjs')) continue;
    const taken = [];
    for (const m of src.matchAll(STATIC)) {
      taken.push([m.index, m.index + m[0].length]);
      const use = target(file, m[5]);
      if (!use) continue;
      use.used = true;
      if (m[3]?.startsWith('*')) {
        const ns = m[3].match(/as\s+([\w$]+)/)?.[1];
        if (ns && m[1] === 'import') for (const name of memberNames(src, ns)) use.names.add(name);
        else use.all = true;
      }
      if (m[1] === 'import' && m[2]) use.names.add('default');
      if (m[3]?.startsWith('{'))
        for (const part of m[3].slice(1, -1).split(',')) {
          const name = part
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0];
          if (name) use.names.add(name);
        }
    }
    for (const m of src.matchAll(DYNAMIC)) {
      taken.push([m.index, m.index + m[0].length]);
      const use = target(file, m[2]);
      if (use) takeBound(use, src, m.index);
    }
    for (const m of src.matchAll(PATH_STRING)) {
      if (taken.some(([a, b]) => m.index >= a && m.index < b)) continue;
      const use = target(file, m[2]);
      if (use) Object.assign(use, { used: true, all: true });
    }
    for (const m of src.matchAll(JOINED)) {
      const name = m[2].split('/').pop();
      const use = (!m[2].includes('/') || m[2].endsWith(`real-app/${name}`)) && uses.get(HELPER_DIR + name);
      if (!use || HELPER_DIR + name === file) continue;
      const call = src.lastIndexOf('import(', m.index);
      if (call >= 0 && /^import\(\s*(?:\$\{\s*JSON\.stringify\(\s*)?$/.test(src.slice(call, m.index))) takeBound(use, src, call);
      else Object.assign(use, { used: true, all: true });
    }
  }
  return uses;
}

/** Each finding as one line: a helper nothing uses, or an export nothing imports, with its fix. */
export function findings(files) {
  const out = [];
  for (const [helper, use] of helperUses(files)) {
    if (!use.used) {
      out.push(`${helper}: no file imports it or names it by path. Delete it, and every list that names it.`);
      continue;
    }
    if (use.all) continue;
    const src = files.get(helper);
    for (const name of exportedNames(src)) {
      if (use.names.has(name)) continue;
      const inside = (src.match(new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g')) ?? []).length > 1;
      out.push(
        `${helper}: export ${name} is imported by no file. ${inside && name !== 'default' ? 'Drop `export`: only this file uses it.' : 'Delete it: nothing uses it.'}`,
      );
    }
  }
  return out;
}

/** Every tracked code file in the checkout, by path. */
export function trackedCode(root = process.cwd()) {
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 })
    .split('\0')
    .filter((f) => CODE.test(f));
  const files = new Map();
  for (const f of paths) {
    try {
      files.set(f, readFileSync(posix.join(root, f), 'utf8'));
    } catch {
      // Deleted in the working tree but still in the index: not a user.
    }
  }
  return files;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const found = findings(trackedCode());
  for (const line of found) console.error(line);
  if (found.length) process.exit(1);
  console.log('journey helpers: every helper and every export is used');
}
