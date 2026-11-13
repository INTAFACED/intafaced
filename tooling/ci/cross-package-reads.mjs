#!/usr/bin/env node
/**
 * CROSS-PACKAGE READ SCAN.
 *
 * `turbo --affected` picks tests from the workspace dependency graph. A test
 * that reads another package's files (a source scan, a fixture, a migration)
 * without declaring that package is invisible to the graph: change the other
 * package and this test is not selected, and a red lands on main instead of
 * the PR (MAINRED3: a svc-trade change broke an apps/customer test that reads
 * svc-trade's files).
 *
 * Finds every test file that names another workspace package's directory, by
 * literal path or by `..` hops. The affected-test selection (ci-affected.mjs)
 * adds each detected read as an edge itself, so an undeclared read is only
 * printed as a notice. What still fails: an edge-list entry naming a directory
 * that is not a workspace package. An edge can also be declared in
 * `tooling/ci/test-read-edges.json` for a read the scan cannot see ("<reader dir>": ["<read dir>", ...]); the
 * affected-test selection treats each edge as "the reader depends on the read
 * package". The edge list, not a package.json devDependency, because a
 * devDependency would make a cycle for 18 of today's 38 edges (contracts and
 * i18n are read by nearly everything, and read back) and turbo rejects cycles.
 * A reader that already lists the package in package.json needs no edge.
 *
 * The same reads are hidden from turbo's cache key: turbo hashes a task from its own package's files and its declared
 * dependencies, so a cached `typecheck` of a reader would replay a pass after a package its tests import changed. The
 * plain run therefore also fails when turbo.json's `<reader>#typecheck` / `#build` inputs differ from what these reads
 * need (turboReadInputs below); `--write-turbo` rewrites them.
 *
 *   node tooling/ci/cross-package-reads.mjs
 *   node tooling/ci/cross-package-reads.mjs --write-turbo
 *   node tooling/ci/cross-package-reads.mjs --self-test
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, sep, dirname, resolve, posix } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const WORKSPACE_GLOBS = ['apps', 'services', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'build', 'target', '.git']);
export const EDGES_FILE = 'tooling/ci/test-read-edges.json';
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

/** @returns {Map<string, {dir:string, name:string, deps:Set<string>, scripts:Record<string,string>}>} keyed by dir (posix, repo-relative) */
export function loadPackages(root = ROOT) {
  const out = new Map();
  for (const group of WORKSPACE_GLOBS) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      const pj = join(base, d, 'package.json');
      if (!existsSync(pj)) continue;
      const json = JSON.parse(readFileSync(pj, 'utf8'));
      const deps = new Set();
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const n of Object.keys(json[k] ?? {})) deps.add(n);
      }
      out.set(`${group}/${d}`, { dir: `${group}/${d}`, name: json.name, deps, scripts: json.scripts ?? {} });
    }
  }
  return out;
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (TEST_FILE.test(e.name)) yield p;
  }
}

/** Comments only mention paths; they read nothing. Cheap strip, not a parser: URLs in strings keep their `//`. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Workspace dirs a test file's text points at (own package excluded). */
export function referencedDirs(text, fileDir, own, dirs) {
  const hit = new Set();
  // 1. literal "packages/foo" / "services/svc-x" / "apps/y" followed by a path boundary
  for (const m of text.matchAll(/\b(apps|services|packages)\/([A-Za-z0-9._-]+)(?=[/'"`\s)\]]|$)/g)) {
    const d = `${m[1]}/${m[2]}`;
    if (dirs.has(d)) hit.add(d);
  }
  // 2. segment-list joins: 'packages', 'foo'
  for (const m of text.matchAll(/['"`](apps|services|packages)['"`]\s*,\s*['"`]([A-Za-z0-9._-]+)['"`]/g)) {
    const d = `${m[1]}/${m[2]}`;
    if (dirs.has(d)) hit.add(d);
  }
  // 3. relative hops: '../../svc-bar/...' or '../../../packages/foo'
  for (const m of text.matchAll(/['"`]((?:\.\.\/)+)([A-Za-z0-9._-]+)(?:\/([A-Za-z0-9._-]+))?/g)) {
    const up = resolve(ROOT, fileDir, m[1]);
    const rel = relative(ROOT, up).split(sep).join('/');
    for (const cand of [`${rel}/${m[2]}`.replace(/^\//, ''), rel && m[3] ? `${rel}/${m[2]}/${m[3]}` : null]) {
      if (cand && dirs.has(cand)) hit.add(cand);
    }
    // '../..' landing at a group dir: services + svc-x
    if (['apps', 'services', 'packages'].includes(rel.split('/')[0]) && rel.split('/').length === 1) {
      const d = `${rel}/${m[2]}`;
      if (dirs.has(d)) hit.add(d);
    }
  }
  hit.delete(own);
  return hit;
}

export function loadEdges(root = ROOT) {
  const path = join(root, EDGES_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')).edges ?? {}) : {};
}

export function scan(root = ROOT, { ignoreDeclared = false } = {}) {
  const pkgs = loadPackages(root);
  const dirs = new Set(pkgs.keys());
  const edges = loadEdges(root);
  const problems = [];
  for (const [reader, reads] of Object.entries(edges)) {
    for (const d of [reader, ...reads]) {
      if (!dirs.has(d)) problems.push({ file: EDGES_FILE, owner: reader, reads: d, dir: d, stale: true });
    }
  }
  let files = 0;
  for (const pkg of pkgs.values()) {
    const base = join(root, pkg.dir);
    for (const file of walk(base)) {
      files++;
      const rel = relative(root, file).split(sep).join('/');
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const d of referencedDirs(text, dirname(rel), pkg.dir, dirs)) {
        const other = pkgs.get(d);
        if (pkg.deps.has(other.name) || (!ignoreDeclared && (edges[pkg.dir] ?? []).includes(d))) continue;
        problems.push({ file: rel, owner: pkg.name, reads: other.name, dir: d });
      }
    }
  }
  return { problems, files, packages: pkgs.size };
}

/** Reads the scan found, as the edge-list shape: { "<reader dir>": ["<read dir>", ...] }. */
export function detectedEdges(root = ROOT) {
  const out = {};
  for (const p of scan(root, { ignoreDeclared: true }).problems) {
    if (p.stale) continue;
    const reader = p.file.split('/').slice(0, 2).join('/');
    (out[reader] ??= []).includes(p.dir) || out[reader].push(p.dir);
  }
  return out;
}

/** Every read: the declared edges plus what the scan finds. The affected-test selection (ci-affected.mjs) uses this too. */
export function allEdges(root = ROOT) {
  const out = {};
  for (const src of [loadEdges(root), detectedEdges(root)])
    for (const [reader, reads] of Object.entries(src)) out[reader] = [...new Set([...(out[reader] ?? []), ...reads])];
  return out;
}

// ── TURBO'S HASH COVERS EVERY READ ───────────────────────────────────────────
// turbo.json's `<package>#build` and `<package>#typecheck` entries belong to this section: it writes them and checks them.
export const TURBO_FILE = 'turbo.json';
export const CACHED_TASKS = ['typecheck', 'build'];
/**
 * turbo 2.11 hashes every file an explicit `$TURBO_ROOT$` input matches, .gitignore or not (measured 13 Nov 2026: a file
 * in an ignored dist/ changed the hash), so build output and installs are left out by name. checkTurbo fails if any
 * tracked file sits under one of them, since that file would then be missing from the hash.
 */
export const IGNORED_SEGMENTS = ['node_modules', 'dist', '.next', '.turbo', 'coverage'];
const IGNORED_INPUTS = [`!$TURBO_ROOT$/**/{${IGNORED_SEGMENTS.join(',')}}/**`, '!$TURBO_ROOT$/**/*.tsbuildinfo'];
const REL_PATH = /(?:\.\.\/)+[A-Za-z0-9._@/-]*/g;

/** tsconfig is JSONC: comments and trailing commas, skipped outside strings only (a glob like "src/**\/*" holds `/*`). */
function looseJson(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') i = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i) - 1;
    else if (c === '/' && text[i + 1] === '*') i = text.indexOf('*/', i + 2) === -1 ? text.length : text.indexOf('*/', i + 2) + 1;
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function globRegex(glob) {
  const g = glob.replace(/^\.\//, '').replace(/\/$/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      re += g[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += g[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

/** True when the package's build can type its test files: some test file is not excluded by its tsconfig.json. */
export function buildCompilesTests(root, pkg) {
  const tsconfig = join(root, pkg.dir, 'tsconfig.json');
  if (!existsSync(tsconfig)) return true;
  const exclude = (looseJson(readFileSync(tsconfig, 'utf8')).exclude ?? []).map(globRegex);
  for (const file of walk(join(root, pkg.dir))) {
    const rel = relative(join(root, pkg.dir), file).split(sep).join('/');
    if (!exclude.some((re) => re.test(rel))) return true;
  }
  return false;
}

/**
 * Packages a task reads through its own script or a tsconfig (`node ../svc-ledger/ensure-workspace-types.mjs`), per
 * task, and paths outside every package that turbo would not hash.
 */
export function scriptReads(root, pkg, dirs, globalDeps = []) {
  const reads = Object.fromEntries(CACHED_TASKS.map((t) => [t, new Set()]));
  const unhashed = [];
  const tsconfigs = readdirSync(join(root, pkg.dir))
    .filter((f) => /^tsconfig.*\.json$/.test(f))
    .map((f) => readFileSync(join(root, pkg.dir, f), 'utf8'))
    .join('\n');
  for (const task of CACHED_TASKS) {
    if (!pkg.scripts[task]) continue;
    for (const m of `${pkg.scripts[task]}\n${tsconfigs}`.matchAll(REL_PATH)) {
      const target = posix.normalize(`${pkg.dir}/${m[0]}`).replace(/\/$/, '');
      if (target === '.' || target.startsWith('..') || WORKSPACE_GLOBS.includes(target)) continue;
      const dir = [...dirs].find((d) => target === d || target.startsWith(`${d}/`));
      if (dir) {
        if (dir !== pkg.dir) reads[task].add(dir);
      } else if (!globalDeps.includes(target)) unhashed.push({ task, path: target });
    }
  }
  return { reads, unhashed };
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?|json)$/;
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`]((?:\.\.?\/)+[^'"`\s]+)['"`]/g;
/** A triple-slash reference is a comment, so it is matched before comments are stripped (review R2 of round 2). */
const REFERENCE_PATH = /^\s*\/\/\/\s*<reference\s+path\s*=\s*['"]((?:\.\.?\/)+[^'"\s]+)['"]/gm;

function* walkCode(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkCode(p);
    else if (CODE_FILE.test(e.name)) yield p;
  }
}

/** True when `rel` (package-relative) is compiled by this tsconfig: matched by its include (default all) and not its exclude. */
function inTsconfig(cfg, rel) {
  const include = (cfg.include ?? (cfg.files ? [] : ['**/*'])).map(globRegex);
  const exclude = (cfg.exclude ?? []).map(globRegex);
  return ((cfg.files ?? []).includes(rel) || include.some((re) => re.test(rel))) && !exclude.some((re) => re.test(rel));
}

/**
 * Files outside every workspace package that a task's compiler reads through an import (review of 13 Nov 2026:
 * packages/ui's look-codemod.test.ts imports tooling/scripts/look-codemod.mjs, typed by its .d.mts sibling). Per task:
 * build compiles tsconfig.json's files, typecheck every tsconfig*.json's. Each read becomes `$TURBO_ROOT$/<stem>.*`
 * (the module and its type siblings) and, for an extensionless import, `$TURBO_ROOT$/<stem>/**`; an outside file's own
 * relative imports are followed, and a package one of them imports joins the reader's reads. A non-script file (JSON)
 * is hashed as itself; `/// <reference path>` counts as an import. Reads into node_modules, outside the repo or into
 * globalDependencies are not added.
 */
export function outsideImports(root, pkg, dirs, globalDeps = []) {
  const out = Object.fromEntries(CACHED_TASKS.map((t) => [t, new Set()]));
  const reads = Object.fromEntries(CACHED_TASKS.map((t) => [t, new Set()]));
  const cfgs = readdirSync(join(root, pkg.dir))
    .filter((f) => /^tsconfig.*\.json$/.test(f))
    .map((f) => ({ f, cfg: looseJson(readFileSync(join(root, pkg.dir, f), 'utf8')) }));
  const workspaceDir = (t) => [...dirs].find((d) => t === d || t.startsWith(`${d}/`));
  // `pkgDirs` collects packages an outside file imports back into: the reader's hash must cover them too.
  const follow = (fromFile, text, into, seen, pkgDirs, fromOutside) => {
    const specs = [...stripComments(text).matchAll(IMPORT_SPEC), ...text.matchAll(REFERENCE_PATH)].map((m) => m[1]);
    for (const spec of specs) {
      const target = posix.normalize(posix.join(posix.dirname(fromFile), spec));
      if (target.startsWith('..') || target.split('/').includes('node_modules')) continue;
      const ws = workspaceDir(target);
      if (ws) {
        if (fromOutside && ws !== pkg.dir) pkgDirs.add(ws);
        continue;
      }
      if (globalDeps.includes(target)) continue;
      const ext = posix.extname(target);
      if (ext && !/^\.[cm]?[jt]sx?$/.test(ext)) {
        into.add(`$TURBO_ROOT$/${target}`); // JSON and other data: the file itself
        continue;
      }
      const stem = ext ? target.slice(0, -ext.length) : target;
      into.add(`$TURBO_ROOT$/${stem}.*`);
      if (!ext) into.add(`$TURBO_ROOT$/${stem}/**`);
      if (seen.has(stem)) continue;
      seen.add(stem);
      const base = join(root, posix.dirname(stem));
      if (!existsSync(base)) continue;
      for (const f of readdirSync(base)) {
        if (!f.startsWith(`${posix.basename(stem)}.`) || !CODE_FILE.test(f)) continue;
        const rel = posix.join(posix.dirname(stem), f);
        follow(rel, readFileSync(join(root, rel), 'utf8'), into, seen, pkgDirs, true);
      }
    }
  };
  for (const file of walkCode(join(root, pkg.dir))) {
    const inPkg = relative(join(root, pkg.dir), file).split(sep).join('/');
    const tasks = cfgs.length
      ? CACHED_TASKS.filter((t) => cfgs.some(({ f, cfg }) => (t === 'typecheck' || f === 'tsconfig.json') && inTsconfig(cfg, inPkg)))
      : CACHED_TASKS;
    if (!tasks.length) continue;
    const found = new Set();
    const back = new Set();
    // `back`: packages imported only through an outside file (the reader's own reads are the scan's edges).
    follow(`${pkg.dir}/${inPkg}`, readFileSync(file, 'utf8'), found, new Set(), back, false);
    for (const t of tasks) {
      for (const i of found) out[t].add(i);
      for (const d of back) reads[t].add(d);
    }
  }
  return { inputs: out, reads };
}

/** The `<package>#<task>` entries turbo.json must hold so that each task's hash covers what it reads. */
export function turboReadInputs(root = ROOT) {
  const pkgs = loadPackages(root);
  const dirs = new Set(pkgs.keys());
  const byName = new Map([...pkgs.values()].map((p) => [p.name, p.dir]));
  const turbo = JSON.parse(readFileSync(join(root, TURBO_FILE), 'utf8'));
  const closure = (dir) => {
    const seen = new Set();
    const stack = [dir];
    while (stack.length) {
      for (const n of pkgs.get(stack.pop()).deps) {
        const d = byName.get(n);
        if (d && !seen.has(d)) {
          seen.add(d);
          stack.push(d);
        }
      }
    }
    return seen;
  };
  const testReads = allEdges(root);
  const entries = {};
  const unhashed = [];
  for (const pkg of [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const scripts = scriptReads(root, pkg, dirs, turbo.globalDependencies ?? []);
    const outside = outsideImports(root, pkg, dirs, turbo.globalDependencies ?? []);
    unhashed.push(...scripts.unhashed.map((u) => ({ ...u, owner: pkg.name })));
    for (const task of CACHED_TASKS) {
      if (!pkg.scripts[task]) continue;
      const reads = new Set([...scripts.reads[task], ...outside.reads[task]]);
      if (task === 'typecheck' || buildCompilesTests(root, pkg)) for (const d of testReads[pkg.dir] ?? []) reads.add(d);
      // The reader's own dependency tree is in its hash already (turbo folds in every dependency task's hash).
      const own = closure(pkg.dir).add(pkg.dir);
      const extra = new Set();
      for (const d of reads) for (const x of [d, ...closure(d)]) if (!own.has(x)) extra.add(x);
      if (!extra.size && !outside.inputs[task].size) continue;
      const { inputs = ['$TURBO_DEFAULT$'], ...generic } = turbo.tasks[task];
      entries[`${pkg.name}#${task}`] = {
        ...generic,
        inputs: [
          ...inputs,
          ...[...extra].sort().map((d) => `$TURBO_ROOT$/${d}/**`),
          ...[...outside.inputs[task]].sort(),
          ...IGNORED_INPUTS,
        ],
      };
    }
  }
  return { entries, unhashed, turbo };
}

const OWNED_KEY = new RegExp(`#(?:${CACHED_TASKS.join('|')})$`);

/** Problems: an entry missing, stale or extra in turbo.json; a script path turbo cannot hash; a tracked file left out by IGNORED_INPUTS. */
export function checkTurbo(root = ROOT, { tracked } = {}) {
  const { entries, unhashed, turbo } = turboReadInputs(root);
  const problems = [];
  const have = Object.fromEntries(Object.entries(turbo.tasks).filter(([k]) => OWNED_KEY.test(k)));
  for (const key of new Set([...Object.keys(entries), ...Object.keys(have)])) {
    if (!have[key])
      problems.push(`${key} is missing: its hash leaves out ${entries[key].inputs.filter((i) => i.startsWith('$TURBO_ROOT$')).join(', ')}`);
    else if (!entries[key]) problems.push(`${key} is in turbo.json but reads nothing outside its own dependencies`);
    else if (JSON.stringify(have[key]) !== JSON.stringify(entries[key])) problems.push(`${key} differs from what its reads need`);
  }
  for (const u of unhashed) problems.push(`${u.owner} ${u.task} names ${u.path}, which no package or globalDependencies entry covers`);
  const files = tracked ?? trackedFiles(root);
  const leftOut = files.filter(
    (f) =>
      f.endsWith('.tsbuildinfo') ||
      f
        .split('/')
        .slice(0, -1)
        .some((s) => IGNORED_SEGMENTS.includes(s)),
  );
  for (const f of leftOut) problems.push(`${f} is tracked but the generated inputs leave it out (IGNORED_SEGMENTS)`);
  return { problems, entries, turbo };
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z', '--', ...WORKSPACE_GLOBS], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter(Boolean);
}

export function writeTurbo(root = ROOT) {
  const { entries, turbo } = turboReadInputs(root);
  const kept = Object.fromEntries(Object.entries(turbo.tasks).filter(([k]) => !OWNED_KEY.test(k)));
  turbo.tasks = { ...kept, ...entries };
  writeFileSync(join(root, TURBO_FILE), `${JSON.stringify(turbo, null, 2)}\n`);
  return Object.keys(entries).length;
}

function turboSelfTest() {
  const root = mkdtempSync(join(tmpdir(), 'turbo-reads-'));
  const put = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body));
  };
  const pkg = (dir, name, deps = {}, scripts = { typecheck: 'tsc --noEmit', build: 'tsc' }) =>
    put(`${dir}/package.json`, { name, dependencies: deps, scripts });
  try {
    put(TURBO_FILE, {
      globalDependencies: ['tooling/ci/test-typecheck.mjs'],
      tasks: { build: { dependsOn: ['^build'], outputs: ['dist/**'] }, typecheck: { dependsOn: ['^build'], outputs: [] } },
    });
    pkg(
      'apps/r',
      '@t/r',
      { '@t/lib': '*' },
      { typecheck: 'tsc --noEmit && node ../../tooling/ci/test-typecheck.mjs', build: 'next build' },
    );
    pkg('services/p', '@t/p', { '@t/dep2': '*', '@t/lib': '*' });
    pkg('packages/lib', '@t/lib');
    pkg('packages/dep2', '@t/dep2');
    pkg('services/q', '@t/q', {}, { typecheck: 'node ../p/ensure.mjs && tsc --noEmit', build: 'tsc' });
    put('services/q/tsconfig.json', '{ "exclude": ["src/**/*.test.ts", "dist"] }');
    put('services/q/src/a.test.ts', "import { x } from '../../../packages/lib/src/x';");
    put('apps/r/src/a.test.ts', "import { x } from '../../../services/p/src/x';");
    const tracked = ['apps/r/src/a.test.ts'];
    const eq = (a, b, m) => {
      if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)}`);
    };
    writeTurbo(root);
    const { problems, entries } = checkTurbo(root, { tracked });
    eq(problems, [], 'known-good tree passes');
    eq(
      entries['@t/r#typecheck'].inputs.slice(0, 3),
      ['$TURBO_DEFAULT$', '$TURBO_ROOT$/packages/dep2/**', '$TURBO_ROOT$/services/p/**'],
      'read + its deps, minus own',
    );
    eq(entries['@t/r#typecheck'].dependsOn, ['^build'], 'generic task copied');
    eq(Boolean(entries['@t/r#build']), true, 'a build that types its tests covers the reads');
    eq(
      Object.keys(entries).filter((k) => k.startsWith('@t/q')),
      ['@t/q#typecheck'],
      'script read covered; excluded tests leave build alone',
    );
    // Planted fault 1: an input dropped from turbo.json.
    const t = JSON.parse(readFileSync(join(root, TURBO_FILE), 'utf8'));
    t.tasks['@t/r#typecheck'].inputs = t.tasks['@t/r#typecheck'].inputs.filter((i) => !i.includes('services/p'));
    writeFileSync(join(root, TURBO_FILE), JSON.stringify(t));
    eq(checkTurbo(root, { tracked }).problems, ['@t/r#typecheck differs from what its reads need'], 'dropped input fails');
    writeTurbo(root);
    // Planted fault 2: a new test read that turbo.json does not carry yet.
    put('packages/lib/src/b.test.ts', "readFileSync('services/p/src/x.ts')");
    eq(checkTurbo(root, { tracked }).problems.length, 2, 'new read fails until --write-turbo');
    writeTurbo(root);
    eq(checkTurbo(root, { tracked }).problems, [], 'rewritten tree passes');
    // Planted fault 4: a test imports a file outside every package, whose types import another (review of 13 Nov 2026).
    put('tooling/s/x.mjs', 'export const x = 1;');
    put('tooling/s/x.d.mts', "export { y as x } from './y.mjs';");
    put('tooling/s/y.d.mts', 'export declare const y: number;');
    put('services/q/tsconfig.test.json', '{ "include": ["src/**/*"], "exclude": ["dist"] }');
    put(
      'services/q/src/c.test.ts',
      "import { x } from '../../../tooling/s/x.mjs';\nconst u = new URL('../../../tooling/s/run.mjs', import.meta.url);",
    );
    eq(
      checkTurbo(root, { tracked }).problems,
      ['@t/q#typecheck differs from what its reads need'],
      'outside import fails until --write-turbo',
    );
    writeTurbo(root);
    eq(
      checkTurbo(root, { tracked }).entries['@t/q#typecheck'].inputs.filter((i) => i.includes('tooling')),
      ['$TURBO_ROOT$/tooling/s/x.*', '$TURBO_ROOT$/tooling/s/y.*'],
      'outside import and its type import hashed; a runtime URL is not; excluded tests leave build alone',
    );
    eq(Boolean(checkTurbo(root, { tracked }).entries['@t/q#build']), false, 'build skips tests its tsconfig excludes');
    // Planted faults 5 to 7 (review round 2): a JSON import, a triple-slash reference, and an outside file that imports
    // back into a package the reader does not depend on.
    put(
      'services/q/src/d.test.ts',
      '/// <reference path="../../../tooling/s/ref.d.ts" />\nimport data from \'../../../tooling/s/data.json\';',
    );
    put('tooling/s/y.d.mts', "export type { Z } from '../../packages/dep2/src/z.js';\nexport declare const y: number;");
    eq(checkTurbo(root, { tracked }).problems, ['@t/q#typecheck differs from what its reads need'], 'faults 5 to 7 fail');
    writeTurbo(root);
    eq(
      checkTurbo(root, { tracked }).entries['@t/q#typecheck'].inputs.filter((i) => i.includes('tooling') || i.includes('dep2')),
      [
        '$TURBO_ROOT$/packages/dep2/**',
        '$TURBO_ROOT$/tooling/s/data.json',
        '$TURBO_ROOT$/tooling/s/ref.d.*',
        '$TURBO_ROOT$/tooling/s/x.*',
        '$TURBO_ROOT$/tooling/s/y.*',
      ],
      'JSON hashed as itself, reference followed, package imported back covered',
    );
    // Planted fault 3: a tracked file under an ignored output dir, and a script path nothing hashes.
    eq(checkTurbo(root, { tracked: ['services/p/dist/x.js'] }).problems.length, 1, 'tracked file left out of the hash fails');
    pkg('services/q', '@t/q', {}, { typecheck: 'node ../../tooling/x.mjs && tsc --noEmit' });
    eq(checkTurbo(root, { tracked }).problems.length, 2, 'unhashed script path fails');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log('✓ cross-package-reads --self-test: turbo inputs OK (known-good passes, 8 planted faults fail)');
}

function selfTest() {
  const dirs = new Set(['services/svc-a', 'services/svc-b', 'packages/lib']);
  const t = (text, fileDir = 'services/svc-a/src') => [...referencedDirs(text, fileDir, 'services/svc-a', dirs)].sort();
  const eq = (a, b, m) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)}`);
  };
  eq(t("readFileSync('services/svc-b/src/x.ts')"), ['services/svc-b'], 'literal');
  eq(t("join(root, 'packages', 'lib', 'src')"), ['packages/lib'], 'segments');
  eq(t("readFileSync(new URL('../../svc-b/src/x.ts', import.meta.url))"), ['services/svc-b'], 'hop to sibling');
  eq(t("join(__dirname, '../../../packages/lib/src/x.ts')"), ['packages/lib'], 'hop to group');
  eq(t("readFileSync('services/svc-a/src/x.ts')"), [], 'own package ignored');
  eq(t("import x from '../helpers'"), [], 'plain relative import ignored');
  console.log('✓ cross-package-reads --self-test OK (6 fixtures)');
  turboSelfTest();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) {
    selfTest();
    process.exit(0);
  }
  if (process.argv.includes('--write-turbo')) {
    console.log(`✓ ${TURBO_FILE}: ${writeTurbo()} generated <package>#<task> entries written; run prettier on it`);
    process.exit(0);
  }
  const { problems, files, packages } = scan();
  if (files === 0) {
    console.error(
      '\n✖ cross-package-reads — scope is EMPTY: no test file found in any workspace package. A scan of nothing is not a pass.\n',
    );
    process.exit(1);
  }
  const stale = problems.filter((p) => p.stale);
  const undeclared = problems.filter((p) => !p.stale);
  if (undeclared.length) {
    console.log(
      `ℹ cross-package-reads — ${undeclared.length} read(s) not in ${EDGES_FILE}; the selection adds them itself, no action needed:`,
    );
    for (const p of undeclared) console.log(`  ${p.file} reads ${p.reads} (${p.dir})`);
  }
  if (stale.length) {
    console.error(`\n✖ CROSS-PACKAGE READ SCAN FAILED — ${stale.length} stale edge(s) in ${EDGES_FILE}\n`);
    for (const p of stale) console.error(`  ${p.file}\n    → names ${p.dir}, which is not a workspace package\n`);
    process.exit(1);
  }
  const turbo = checkTurbo();
  if (turbo.problems.length) {
    console.error(
      `\n✖ CROSS-PACKAGE READ SCAN FAILED — turbo's cache key would miss ${turbo.problems.length} read(s); a cached pass could hide a red\n`,
    );
    for (const p of turbo.problems) console.error(`  ${p}`);
    console.error(`\n  Fix: node tooling/ci/cross-package-reads.mjs --write-turbo && pnpm exec prettier --write ${TURBO_FILE}\n`);
    process.exit(1);
  }
  console.log(
    `✓ cross-package-reads clean — ${files} test file(s) across ${packages} package(s); ${TURBO_FILE} covers every read (${Object.keys(turbo.entries).length} entries)`,
  );
}
