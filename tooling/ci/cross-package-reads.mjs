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
 * Fails any test file that names another workspace package's directory, by
 * literal path or by `..` hops, unless the read is declared. Declare it in
 * `tooling/ci/test-read-edges.json` ("<reader dir>": ["<read dir>", ...]); the
 * affected-test selection treats each edge as "the reader depends on the read
 * package". The edge list, not a package.json devDependency, because a
 * devDependency would make a cycle for 18 of today's 38 edges (contracts and
 * i18n are read by nearly everything, and read back) and turbo rejects cycles.
 * A reader that already lists the package in package.json needs no edge.
 *
 *   node tooling/ci/cross-package-reads.mjs
 *   node tooling/ci/cross-package-reads.mjs --self-test
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep, dirname, resolve } from 'node:path';

const ROOT = process.cwd();
const WORKSPACE_GLOBS = ['apps', 'services', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'build', 'target', '.git']);
export const EDGES_FILE = 'tooling/ci/test-read-edges.json';
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

/** @returns {Map<string, {dir:string, name:string, deps:Set<string>}>} keyed by dir (posix, repo-relative) */
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
      out.set(`${group}/${d}`, { dir: `${group}/${d}`, name: json.name, deps });
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

export function scan(root = ROOT) {
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
        if (pkg.deps.has(other.name) || (edges[pkg.dir] ?? []).includes(d)) continue;
        problems.push({ file: rel, owner: pkg.name, reads: other.name, dir: d });
      }
    }
  }
  return { problems, files, packages: pkgs.size };
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
}

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { problems, files, packages } = scan();
  if (files === 0) {
    console.error(
      '\n✖ cross-package-reads — scope is EMPTY: no test file found in any workspace package. A scan of nothing is not a pass.\n',
    );
    process.exit(1);
  }
  if (problems.length) {
    console.error(`\n✖ CROSS-PACKAGE READ SCAN FAILED — ${problems.length} undeclared read(s)\n`);
    console.error("  A test reads another package's files without declaring it, so the affected-test");
    console.error('  selection would not run the test when that package changes. Add the read to');
    console.error(`  ${EDGES_FILE} under the reader's directory.\n`);
    for (const p of problems) {
      console.error(
        p.stale
          ? `  ${p.file}\n    → names ${p.dir}, which is not a workspace package\n`
          : `  ${p.file}\n    → reads ${p.reads} (${p.dir}); ${p.owner} does not declare it\n`,
      );
    }
    process.exit(1);
  }
  console.log(`✓ cross-package-reads clean — ${files} test file(s) across ${packages} package(s)`);
}
