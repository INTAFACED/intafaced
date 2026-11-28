#!/usr/bin/env node
/**
 * A BUG FIX'S TEST, SHOWN FAILING ON THE CODE BEFORE THE FIX (INTAFACED/intafaced#11267).
 *
 * A fix for a `bug` issue carries a test that fails without the fix. That used to be shown only by pushing the test
 * alone first, and the fix's push cancelled that run before it went red (#11112, #11087, #11180, #11210, #11093, #11130),
 * or the test came with the fix and never ran alone (#11115, #10758, #11136, #10782). This reads the pull request's
 * head instead, so the order of pushes no longer matters:
 *
 *   1. every file the change touches that is not a test file goes back to the base (main: HEAD^1 of the pull request's
 *      merge commit); a file the change added is removed;
 *   2. each test file the change added or changed runs there, alone (vitest in its package, or node:test);
 *   3. the job passes when at least one of them fails by its own assertion: an `expect` or `assert` (an AssertionError,
 *      or Testing Library's not-found error) in a test that ran.
 *
 * A test that fails on the base for another reason is not shown failing, and says why: a file that does not load (a
 * module or export only the fix adds: for TypeScript the compiler is asked first, since vitest turns a missing export
 * into `undefined` and an `expect` on it would look like a real failure), a TypeError or other thrown error, or no test
 * that ran (every one skipped). A test that passes on the base fails the job with the fix named:
 * "`<test>` passes on the code before this fix, so it does not catch #N. Make it fail on the base."
 *
 * Not run here, and named as a gap on the run: a real-app journey test (`*.pw.mjs`, which needs the whole stack: the
 * Real-app journeys run proves it on the head), a Rust test and any file whose package runs neither vitest nor
 * node:test. A change whose only tests are of those kinds passes with that warning. A change that touches no test file
 * fails.
 *
 * It changes the checkout and puts the changed files back at the end; files the base's build writes (`dist/`) stay.
 * Run it on a clean checkout of the change:
 *
 *   node tooling/ci/bug-test-base.mjs --issue <n> [--base <rev>]      (default base: HEAD^1)
 *   node tooling/ci/bug-test-base.mjs --which                         (CI: which bug issue the pull request closes)
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { plan as runAllPlan } from '../vitest/run-all.mjs';
import { githubFetch, githubToken } from './github-fetch.mjs';

// The checkout it runs in: the current folder, its root (as every tooling/ci script is run).
const ROOT = process.cwd();
const REPORTER = fileURLToPath(new URL('./bug-test-base-reporter.mjs', import.meta.url));

/** A test file by its name. Helper files in test folders (fixtures, snapshots) stay at the head but are not run. */
export const TEST_NAME = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const JOURNEY = /\.pw\.[cm]?[jt]s$/;
const TEST_DIRS = new Set(['__tests__', '__fixtures__', '__snapshots__', 'fixtures', 'tests', 'test']);
/** The errors that are a test's own check failing. */
export const OWN_CHECK = /^(?:AssertionError|TestingLibraryElementError)\b/;
/** The compiler's words for an import the base does not have: no such module, no such export. */
export const IMPORT_CODES = new Set([2305, 2307, 2459, 2460, 2614, 2724, 2792]);

/** A path that is part of the tests: kept at the head while every other changed file goes back to the base. */
export function isTestPath(path) {
  if (TEST_NAME.test(path) || JOURNEY.test(path) || path.endsWith('.snap')) return true;
  if (/^crates\/[^/]+\/tests\//.test(path)) return true;
  return path
    .split('/')
    .slice(0, -1)
    .some((d) => TEST_DIRS.has(d));
}

/** The issues a pull request says it closes, and the one its claim branch (`fix/<n>`) names, in order, once each. */
export function bugCandidates({ body = '', headRef = '' } = {}) {
  const found = [];
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:INTAFACED\/intafaced)?#(\d+)\b/gi;
  for (const m of String(body ?? '').matchAll(re)) found.push(Number(m[1]));
  const branch = /^fix\/(\d+)$/.exec(String(headRef ?? ''));
  if (branch) found.push(Number(branch[1]));
  return [...new Set(found)];
}

/** How a changed test file is run here: `vitest`, `node`, or `{ gap }` naming why it is not. Null: not a test to run. */
export function kindOf(path, text, pkg) {
  if (JOURNEY.test(path))
    return { gap: 'a real-app journey test: it needs the whole stack, and the Real-app journeys run proves it on the head' };
  if (path.endsWith('.rs')) return { gap: 'a Rust test, not run on the base here' };
  if (!TEST_NAME.test(path)) return null;
  if (/from\s+['"]node:test['"]|require\(\s*['"]node:test['"]\s*\)/.test(text)) return 'node';
  const script = String(pkg?.scripts?.test ?? '');
  if (/\bvitest\b|run-all\.mjs/.test(script)) return 'vitest';
  return { gap: `its package's test script (${script || 'none'}) runs neither vitest nor node:test` };
}

/** The vitest configs a package's test script runs: [null] for vitest's default, else each named config. */
export function vitestConfigs(script) {
  const words = String(script ?? '')
    .split(/\s+/)
    .filter(Boolean);
  const at = words.findIndex((w) => w.endsWith('run-all.mjs'));
  if (at >= 0) return runAllPlan(words.slice(at + 1)).map((args) => args[2]);
  const config = words.findIndex((w) => w === '--config' || w === '-c');
  return config >= 0 && words[config + 1] ? [words[config + 1]] : [null];
}

const firstLine = (s) =>
  String(s ?? '')
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim() ?? '';

/**
 * One test file's outcome on the base from vitest's JSON reports (one per config the file may belong to).
 * States: caught (failed by its own check), passes, not-loaded, other-error, no-tests.
 */
export function judgeVitest(absFile, reports) {
  const entries = reports.flatMap((r) => r?.testResults ?? []).filter((t) => t.name === absFile);
  if (!entries.length) return { state: 'no-tests', why: 'no vitest config of its package ran it' };
  const tests = entries.flatMap((e) => e.assertionResults ?? []);
  const failed = tests.filter((t) => t.status === 'failed');
  const caught = failed.find((t) => (t.failureMessages ?? []).some((m) => OWN_CHECK.test(firstLine(m))));
  if (caught)
    return { state: 'caught', why: `${caught.fullName}: ${firstLine(caught.failureMessages.find((m) => OWN_CHECK.test(firstLine(m))))}` };
  const fileError = entries.map((e) => firstLine(e.message)).find(Boolean);
  if (fileError && !tests.length) return { state: 'not-loaded', why: fileError };
  if (failed.length)
    return { state: 'other-error', why: `${failed[0].fullName}: ${firstLine(failed[0].failureMessages?.[0]) || 'failed'}` };
  if (fileError) return { state: 'other-error', why: fileError };
  if (!tests.some((t) => t.status === 'passed')) return { state: 'no-tests', why: 'every test in it was skipped' };
  return { state: 'passes', why: `${tests.filter((t) => t.status === 'passed').length} test(s) passed` };
}

/** The same from the node:test reporter's lines (bug-test-base-reporter.mjs). */
export function judgeNode(absFile, lines) {
  const events = lines.filter((e) => !e.file || e.file === absFile);
  const own = (e) => e.error && (e.error.code === 'ERR_ASSERTION' || OWN_CHECK.test(e.error.name));
  const caught = events.find((e) => !e.passed && own(e));
  if (caught) return { state: 'caught', why: `${caught.name}: ${caught.error.name}: ${caught.error.message}` };
  const failed = events.filter((e) => !e.passed && !e.skipped);
  // A file that could not load is one failure named after the file, and no test of it ran.
  const fileLevel = failed.find((e) => absFile.endsWith(`/${e.name}`) || e.name === absFile);
  if (fileLevel && !events.some((e) => e !== fileLevel && !e.skipped))
    return { state: 'not-loaded', why: 'the file failed before any test ran (a module or export it imports is missing)' };
  // A describe that failed only because a test in it did is not a failure of its own.
  const real = failed.filter((e) => !/^\d+ subtests? failed$/.test(e.error?.message ?? ''));
  if (real.length)
    return {
      state: 'other-error',
      why: `${real[0].name}: ${real[0].error ? `${real[0].error.name}: ${real[0].error.message}` : 'failed'}`,
    };
  if (!events.some((e) => e.passed && !e.skipped)) return { state: 'no-tests', why: 'every test in it was skipped' };
  return { state: 'passes', why: `${events.filter((e) => e.passed && !e.skipped).length} test(s) passed` };
}

/**
 * The compiler's import errors in one file, from `tsc --pretty false` output (paths relative to the project). An import
 * of a type alone (`import type`, `{ type X }`) is left out: vitest erases it, so the test still runs as written.
 */
export function importProblems(output, relFile, text = '') {
  const source = String(text).split('\n');
  const out = [];
  for (const line of String(output).split('\n')) {
    const m = /^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line.trim());
    if (!m || m[1].replaceAll('\\', '/') !== relFile || !IMPORT_CODES.has(Number(m[4]))) continue;
    const row = Number(m[2]) - 1;
    const at = source[row] ?? '';
    // The statement's first line: an import's names may sit on the lines after `import type {`.
    let start = row;
    while (start > 0 && !/^\s*(?:import|export)\b/.test(source[start] ?? '')) start -= 1;
    if (/^\s*(?:import|export)\s+type\b/.test(source[start] ?? '') || /\btype\s+$/.test(at.slice(0, Number(m[3]) - 1))) continue;
    out.push(`TS${m[4]}: ${m[5]}`);
  }
  return out;
}

/** The job's verdict: { ok, lines: [{ level: error|warning|notice, text }] }. */
export function verdict({ issue, results }) {
  const lines = [];
  const say = (level, text) => lines.push({ level, text });
  const ran = results.filter((r) => r.state !== 'gap');
  if (!results.length) {
    say(
      'error',
      `this fix for #${issue} adds or changes no test file, so nothing shows it catches the bug. Add a test that fails on the code before the fix.`,
    );
    return { ok: false, lines };
  }
  for (const r of results) {
    if (r.state === 'caught') say('notice', `\`${r.file}\` fails on the code before this fix, by its own check (${r.why}).`);
    else if (r.state === 'passes')
      say('error', `\`${r.file}\` passes on the code before this fix, so it does not catch #${issue}. Make it fail on the base.`);
    else if (r.state === 'not-loaded')
      say(
        'error',
        `\`${r.file}\` does not load on the code before this fix (${r.why}), so it is not shown failing: it must fail by its own expect or assert, not by importing something only the fix adds.`,
      );
    else if (r.state === 'other-error')
      say(
        'error',
        `\`${r.file}\` fails on the code before this fix only with ${r.why}, not by its own expect or assert, so it is not shown failing.`,
      );
    else if (r.state === 'no-tests')
      say('error', `\`${r.file}\` ran no test on the code before this fix (${r.why}), so it is not shown failing.`);
    else say('warning', `\`${r.file}\` is not run on the base here: ${r.why}. This job does not show it catches #${issue}.`);
  }
  if (!ran.length) return { ok: true, lines };
  const ok = ran.some((r) => r.state === 'caught');
  // With one test shown failing, the others' lines are only told, never a red of their own.
  if (ok) for (const l of lines) if (l.level === 'error') l.level = 'warning';
  return { ok, lines };
}

// ── Running it ────────────────────────────────────────────────────────────────────────────────────────────────────

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.error?.message}`);
  return r.stdout;
}

function run(cmd, args, cwd) {
  console.log(`::group::${relative(ROOT, cwd) || '.'}$ ${cmd} ${args.join(' ')}`);
  // A run started from inside a node:test file (this script's own test) must not tell node:test it is nested.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 256 << 20, timeout: 15 * 60_000 });
  process.stdout.write(r.stdout ?? '');
  process.stdout.write(r.stderr ?? '');
  console.log('::endgroup::');
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** The package a file belongs to: its nearest folder holding a package.json, and that file. */
function packageOf(path) {
  let dir = dirname(join(ROOT, path));
  while (dir.startsWith(ROOT)) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) return { dir, json: JSON.parse(readFileSync(file, 'utf8')) };
    if (dir === ROOT) break;
    dir = dirname(dir);
  }
  return { dir: ROOT, json: {} };
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

function runVitestPackage(pkg, files, out) {
  const results = [];
  const isApp = relative(ROOT, pkg.dir).startsWith('apps/');
  const name = pkg.json.name;
  if (name && pkg.dir !== ROOT) {
    // What its tests import: its dependencies' dist (an app's tests run from source), built from the base.
    const build = run('pnpm', ['turbo', 'run', 'build', `--filter=...${isApp ? '^' : ''}${name}`], ROOT);
    if (build.status !== 0) return files.map((file) => ({ file, state: 'not-loaded', why: 'the base does not build' }));
  }
  const tsconfig = ['tsconfig.test.json', 'tsconfig.json'].find((c) => existsSync(join(pkg.dir, c)));
  const configs = vitestConfigs(pkg.json.scripts?.test);
  for (const file of files) {
    const rel = relative(pkg.dir, join(ROOT, file));
    if (tsconfig && /\.[cm]?tsx?$/.test(file)) {
      const probe = join(pkg.dir, 'tsconfig.bug-test-base.json');
      writeFileSync(probe, JSON.stringify({ extends: `./${tsconfig}`, compilerOptions: { noEmit: true }, include: [], files: [rel] }));
      try {
        const tsc = run(
          'node',
          [join(ROOT, 'tooling/scripts/tsc.mjs'), '-p', 'tsconfig.bug-test-base.json', '--noEmit', '--pretty', 'false'],
          pkg.dir,
        );
        const problems = importProblems(tsc.output, rel, readFileSync(join(ROOT, file), 'utf8'));
        if (problems.length) {
          results.push({ file, state: 'not-loaded', why: problems.join('; ') });
          continue;
        }
      } finally {
        rmSync(probe, { force: true });
      }
    }
    const reports = configs.map((config, i) => {
      const report = join(out, `${file.replaceAll('/', '_')}.${i}.json`);
      run(
        'pnpm',
        [
          'exec',
          'vitest',
          'run',
          ...(config ? ['--config', config] : []),
          '--passWithNoTests',
          '--reporter=json',
          `--outputFile=${report}`,
          rel,
        ],
        pkg.dir,
      );
      return readJson(report);
    });
    results.push({ file, ...judgeVitest(join(ROOT, file), reports) });
  }
  return results;
}

function runNode(file, out) {
  const reporter = join(out, 'reporter.mjs');
  const report = join(out, `${file.replaceAll('/', '_')}.node.jsonl`);
  run(
    'node',
    [
      '--test',
      `--test-reporter=${pathToFileURL(reporter).href}`,
      `--test-reporter-destination=${report}`,
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      file,
    ],
    ROOT,
  );
  const lines = existsSync(report)
    ? readFileSync(report, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  return { file, ...judgeNode(join(ROOT, file), lines) };
}

/**
 * The first candidate that is a `bug` issue, or ''. `read(n)` answers fetch's Response. An issue that can't be read (a
 * refusal or a network error) is checked as a bug: the bug test runs, rather than every job after `changes` stopping.
 */
export async function bugOf(candidates, read, warn = (line) => console.log(`::warning::${line}`)) {
  for (const n of candidates) {
    let issue;
    try {
      const res = await read(n);
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      issue = await res.json();
    } catch (e) {
      warn(`could not read #${n} (${e.message}); the bug test runs for it`);
      return String(n);
    }
    if (!issue.pull_request && (issue.labels ?? []).some((l) => (l.name ?? l) === 'bug')) return String(n);
  }
  return '';
}

async function which() {
  const event = readJson(process.env.GITHUB_EVENT_PATH ?? '') ?? {};
  const pr = event.pull_request ?? {};
  const repo = process.env.GITHUB_REPOSITORY ?? 'INTAFACED/intafaced';
  const bug = await bugOf(bugCandidates({ body: pr.body, headRef: pr.head?.ref }), (n) =>
    githubFetch(`https://api.github.com/repos/${repo}/issues/${n}`, {
      headers: { authorization: `Bearer ${githubToken()}`, accept: 'application/vnd.github+json' },
    }),
  );
  console.log(bug ? `this pull request fixes bug #${bug}` : 'this pull request closes no `bug` issue: nothing to check');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `issue=${bug}\n`);
}

function check(issue, base) {
  if (git(['status', '--porcelain', '--untracked-files=no']).trim())
    throw new Error('the checkout has changes of its own; run this on a clean checkout of the change');
  const changed = git(['diff', '--name-status', '--no-renames', base, 'HEAD'])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .map(([status, path]) => ({ status: status[0], path }));
  const code = changed.filter((c) => !isTestPath(c.path));
  const tests = changed.filter((c) => c.status !== 'D' && isTestPath(c.path));
  const out = mkdtempSync(join(tmpdir(), 'bug-test-base-'));
  // The reporter runs from there: a change that adds it has it removed from the checkout below.
  copyFileSync(REPORTER, join(out, 'reporter.mjs'));
  const results = [];
  console.log(
    `base ${git(['rev-parse', '--short', base]).trim()}: ${code.length} changed file(s) go back to it; ${tests.length} test path(s) stay`,
  );
  try {
    for (const c of code) {
      if (c.status === 'A') rmSync(join(ROOT, c.path), { force: true });
      else git(['checkout', base, '--', c.path]);
    }
    const vitest = new Map();
    for (const t of tests) {
      const text = readFileSync(join(ROOT, t.path), 'utf8');
      const pkg = packageOf(t.path);
      const kind = kindOf(t.path, text, pkg.json);
      if (kind === null) continue;
      if (kind === 'node') results.push(runNode(t.path, out));
      else if (kind === 'vitest') vitest.set(pkg.dir, { pkg, files: [...(vitest.get(pkg.dir)?.files ?? []), t.path] });
      else results.push({ file: t.path, state: 'gap', why: kind.gap });
    }
    for (const { pkg, files } of vitest.values()) results.push(...runVitestPackage(pkg, files, out));
  } finally {
    for (const c of code) {
      if (c.status === 'D') rmSync(join(ROOT, c.path), { force: true });
      else git(['checkout', 'HEAD', '--', c.path]);
    }
    git(['reset', '--quiet']);
    rmSync(out, { recursive: true, force: true });
  }
  const v = verdict({ issue, results });
  const summary = [`### A test for #${issue}, run on the code before the fix`, ''];
  for (const l of v.lines) {
    console.log(`::${l.level}::${l.text}`);
    summary.push(`- ${l.level === 'notice' ? 'shown failing' : l.level}: ${l.text}`);
  }
  summary.push('', v.ok ? 'Shown failing on the base.' : 'Not shown failing on the base.');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  console.log(summary.join('\n'));
  return v.ok;
}

async function main(argv) {
  if (argv.includes('--which')) return which();
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const issue = arg('--issue');
  if (!/^\d+$/.test(issue ?? '')) throw new Error('usage: node tooling/ci/bug-test-base.mjs --issue <n> [--base <rev>] | --which');
  if (!check(Number(issue), arg('--base') ?? 'HEAD^1')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.log(`::error::bug-test-base: ${e.message}`);
    process.exitCode = 1;
  });
}
