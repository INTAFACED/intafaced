#!/usr/bin/env node
/**
 * RULE TESTS BEFORE A PUSH: the unit tests that walk the tree, for the packages a branch changed.
 *
 * Why: a rule test (a copy rule, a pin, an inventory) walks a directory with readdirSync or `git ls-files` and checks
 * every file it finds, so no file imports it and a builder's affected vitest run never selects it. CI's unit run runs
 * every test of every affected package, so that is where it went red: of 98 journey pull requests, 31 first heads were
 * red on a unit test, and 37 of the 41 failures in the ten most frequent files were rule tests (copy-no-yet 13,
 * copy-promises 6, developers-reference 5, refusals 4, no-new-hand-schemas 3, live-path-inventory 2, ...). A fast red
 * makes the builder push again, which cancels the journeys run before its verdict.
 *
 * What runs, derived on every call, with no list to keep:
 *   · the packages: each package a changed file is in, plus each package whose tests read a changed package
 *     (tooling/ci/test-read-edges.json and the reads cross-package-reads.mjs finds, the same edges CI selects by);
 *   · in each, every vitest file (`*.test.ts`, `*.test.tsx`) whose text walks a directory (WALKS) and reads the source
 *     files it finds (READS_SOURCE), except the Postgres (`.pg.test`) and stack (`.e2e.test`) files and any file
 *     that reaches a database or container (NEEDS_SERVICES_TEXT), which need services a laptop run doesn't have.
 * A walking test reads only its own package or a package it declares (cross-package-reads.mjs fails an undeclared
 * read), so these packages are every place such a test can go red from this change.
 *
 * `node tooling/ci/gates.mjs` runs it after the gates on a builder's machine (no new habit), and not in CI, whose unit
 * job already runs every one of these tests. It is an early copy of CI's verdict, never a replacement for it.
 *
 *   node tooling/scripts/rule-tests.mjs                  the branch's diff against its merge-base with origin/main
 *   node tooling/scripts/rule-tests.mjs --base <ref>     against another ref (a stacked branch)
 *   node tooling/scripts/rule-tests.mjs --all            every package's rule tests
 *   node tooling/scripts/rule-tests.mjs --list           print the selected files, run nothing
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();

/** A test that walks a directory: the shape every rule test in the census has. */
export const WALKS = /\breaddirSync\b|\bopendirSync\b|\bglobSync\b|\bls-files\b/;
/**
 * ...over source files: it names `.ts` or `.tsx` in a string or pattern. Tests that walk a migrations folder to build an
 * in-memory database walk `.sql` and are behaviour tests, which a builder's affected run already selects.
 */
export const READS_SOURCE = /\\?\.tsx?(?:\?|\$|['"`)\]|])|\bts\|tsx\b/;
/** Vitest files that need Postgres or a running stack. */
export const NEEDS_SERVICES = /\.(pg|e2e)\.test\.tsx?$/;
/** ...and the ones that reach a database or a container by text: CI gives them Postgres; a laptop run would fail them. */
export const NEEDS_SERVICES_TEXT =
  /@testcontainers\/|\bTEST_DATABASE_URL\b|\bDATABASE_URL\b|from ['"]postgres['"]|from ['"]pg['"]|\bcreateTest(?:Db|Database)\b|\bREDIS_URL\b|\bNATS_URL\b/;
export const IS_VITEST_FILE = /\.test\.tsx?$/;

/** The package directory a repo path is in (`apps/customer`), or null outside apps/, services/, packages/. */
export function packageOf(path, packages) {
  const parts = String(path).split('/');
  if (parts.length < 3) return null;
  const dir = parts.slice(0, 2).join('/');
  return packages.has(dir) ? dir : null;
}

/** The packages a change reaches: the changed ones, plus each reader of a changed package. */
export function selectPackages(changed, packages, edges) {
  const own = new Set(changed.map((f) => packageOf(f, packages)).filter(Boolean));
  const out = new Set(own);
  for (const [reader, reads] of Object.entries(edges)) {
    if (!packages.has(reader)) continue;
    if (reads.some((dir) => changed.some((f) => f === dir || f.startsWith(`${dir}/`)))) out.add(reader);
  }
  return [...out].sort();
}

/** A rule test's text: it walks a directory and reads the source files it finds. */
export const rule = (text) => WALKS.test(text) && READS_SOURCE.test(text) && !NEEDS_SERVICES_TEXT.test(text);

/** The rule tests among a package's tracked files: vitest files that walk a directory and need no services. */
export function ruleTestsIn(files, read) {
  return files.filter((f) => IS_VITEST_FILE.test(f) && !NEEDS_SERVICES.test(f) && rule(read(f))).sort();
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Every workspace package with its own package.json under apps/, services/ or packages/. */
function workspacePackages() {
  const dirs = new Set();
  for (const f of git(['ls-files', 'apps/*/package.json', 'services/*/package.json', 'packages/*/package.json']).split('\n'))
    if (f) dirs.add(f.split('/').slice(0, 2).join('/'));
  return dirs;
}

/** Files changed since the merge-base with `base`, committed or not; null when git cannot say. */
function changedFiles(base) {
  try {
    const mergeBase = git(['merge-base', 'HEAD', base]).trim();
    const tracked = git(['diff', '--name-only', '--no-renames', mergeBase]);
    const untracked = git(['ls-files', '--others', '--exclude-standard']);
    return [...new Set((tracked + '\n' + untracked).split('\n').filter(Boolean))].sort();
  } catch {
    return null;
  }
}

/**
 * Select and run. Returns { ok, ran, packages, summary }. `log` prints a line. A diff git cannot read selects every
 * package, so a broken diff never reads as "nothing to run".
 */
export async function runRuleTests({ base = 'origin/main', list = false, all = false, log = console.log } = {}) {
  const packages = workspacePackages();
  const changed = all ? null : changedFiles(base);
  const { readEdges } = await import(new URL('../ci/ci-affected.mjs', import.meta.url));
  const selected = changed === null ? [...packages].sort() : selectPackages(changed, packages, readEdges());
  if (changed === null && !all) log(`  rule tests: the diff against ${base} is unreadable, so every package is selected`);

  const plan = [];
  for (const pkg of selected) {
    const files = git(['ls-files', pkg]).split('\n').filter(Boolean);
    const tests = ruleTestsIn(files, (f) => (existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), 'utf8') : ''));
    if (tests.length) plan.push({ pkg, tests });
  }
  const count = plan.reduce((n, p) => n + p.tests.length, 0);

  if (list) {
    for (const { tests } of plan) for (const t of tests) log(t);
    return { ok: true, ran: 0, packages: plan.length, summary: `${count} rule tests` };
  }
  if (count === 0) {
    const summary =
      selected.length === 0
        ? 'no package changed, so no rule test can go red from this diff'
        : `none of ${selected.length} reached packages (${selected.join(', ')}) has a test that walks the tree`;
    return { ok: true, ran: 0, packages: 0, summary };
  }

  // CI builds what the tests import before it runs them; without the build every import of a workspace package fails
  // to resolve, which is no verdict on the change. turbo's shared cache makes this seconds when nothing changed.
  const build = spawnSync(
    'pnpm',
    ['turbo', 'run', 'build', '--output-logs=errors-only', ...plan.map(({ pkg }) => `--filter=./${pkg}^...`)],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (build.status !== 0)
    return { ok: false, ran: 0, packages: plan.length, summary: 'the build of what the rule tests import failed (above)' };

  const failed = [];
  for (const { pkg, tests } of plan) {
    log(`  rule tests: ${pkg} (${tests.length})`);
    const rel = tests.map((t) => t.slice(pkg.length + 1));
    const r = spawnSync('pnpm', ['exec', 'vitest', 'run', '--maxWorkers=2', ...rel], {
      cwd: join(ROOT, pkg),
      stdio: 'inherit',
      // CI's runners are on UTC; a test that prints a clock time would go red here on a Bali clock and not there.
      env: { ...process.env, TZ: 'UTC', FORCE_COLOR: process.env.FORCE_COLOR ?? '0' },
    });
    if (r.status !== 0) failed.push(pkg);
  }
  return {
    ok: failed.length === 0,
    ran: count,
    packages: plan.length,
    summary: failed.length
      ? `red in ${failed.join(', ')}: CI's unit run fails on the same tests, so fix them before you push`
      : `${count} rule tests in ${plan.length} packages passed`,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const at = process.argv.indexOf('--base');
  const res = await runRuleTests({
    base: at > 0 ? process.argv[at + 1] : 'origin/main',
    list: process.argv.includes('--list'),
    all: process.argv.includes('--all'),
  });
  console.log(`${res.ok ? '✓' : '✖'} rule tests: ${res.summary}`);
  process.exit(res.ok ? 0 : 1);
}
