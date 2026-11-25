#!/usr/bin/env node
/**
 * Every unit test of the local test stack and the gate tools, on every PR (owner decision 2026-10-31, OWNER 138).
 *
 * Until this ran, only gate-tools.test.mjs (two files) ran here and journey-shards.test.mjs ran in the journeys workflow;
 * the other test files in tooling/scripts/ ran only when someone remembered `pnpm local:stack:test`, so a change to the stack
 * script could land with its own tests red. This runs every `*.test.mjs` it finds under tooling/ (not in node_modules,
 * and not pay-sim's vitest files, which turbo runs), so a new test file is covered the day it lands, with no list to forget
 * to update. The files that need a build first run in CI's build job instead (NEEDS_BUILD).
 *
 * It is a gate in tooling/ci/gates.mjs (`tooling-tests`), so `pnpm verify` runs what CI runs. A tree with no test
 * files refuses by name instead of reporting zero failures over nothing (tooling/ci/empty-denominator-gate.mjs).
 *
 * Usage: node tooling/scripts/tooling-tests.mjs   (from the repo root)
 */
import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const DIR = join(ROOT, 'tooling');
// gate-tools.test.mjs only imports two of the files below; running it too would run those twice.
const ENTRY_ONLY = new Set(['tooling/scripts/gate-tools.test.mjs']);
/**
 * The files that read a build, each with the one output that proves everything it reads was built: CI's build job runs a
 * file when its output is there (.github/workflows/ci.yml, "Tooling tests that need the build"), and on a build of the
 * whole repo fails when one is missing. The fixture reads packages/contracts/dist. deep-entries reads the Customer
 * app's modules, which import built packages (contracts and i18n today): the app's own build builds every one (turbo's
 * ^build), and every change that can move its list builds the app (tooling-tests.test.mjs). Waiting on contracts alone
 * failed every service-only pull request, whose build had contracts but not i18n (#10764, 24 Nov 2026).
 */
export const NEEDS_BUILD = {
  'tooling/preview/outreach/fixture.test.mjs': 'packages/contracts/dist/index.js',
  'tooling/lint/deep-entries.test.mjs': 'apps/customer/dist/index.html',
};
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo']);
// The whole run's limit, and each file's: a file that leaves a server running is stopped and named, not left to hold the
// gates job until its 10-minute limit. The run took about 4 of its 5 minutes one file at a time by 22 Nov (#9648 and
// #9650 ran past it); four at a time it takes about a third of that.
const TIMEOUT_MS = 5 * 60_000;
// TOOLING_TESTS_FILE_TIMEOUT_MS can only lower it (tooling-tests.test.mjs plants a hang and waits 3 s, not 3 minutes).
const FILE_TIMEOUT_MS = Math.min(3 * 60_000, Number(process.env.TOOLING_TESTS_FILE_TIMEOUT_MS) || Infinity);
/** How many files run at once: the runner's cores, at most 4 (GitHub's ubuntu-24.04 runner has 4). */
const AT_ONCE = Math.max(1, Math.min(4, availableParallelism()));
/**
 * A test file whose first lines hold `// tooling-tests: alone. <why>` runs alone, after the others, with nothing beside
 * it: it writes outside its own temporary folders (the checkout's tree or .git, a fixed path) or listens on a fixed
 * port, so a file beside it could read its half-written state or lose the port. Every other file was traced (strace,
 * every write and bind of its processes; 22 Nov, all 168 files, four at a time, every one passing) and writes only into
 * temporary folders it made itself and listens only on ports the system picks. The mark is in the file, not a list
 * here, so it moves with a renamed file, and this file names no test by its path (tooling-reach.mjs would follow it).
 */
export const runsAlone = (text) => text.split('\n', 12).some((l) => l.startsWith('// tooling-tests: alone.'));

export function testFiles(dir = DIR) {
  const found = [];
  const walk = (d) => {
    // Dirents, not stat: a link is never followed, so a dangling one or one pointing back up cannot break the walk.
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) found.push(relative(ROOT, full).split('\\').join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  const elsewhere = new Set([...ENTRY_ONLY, ...Object.keys(NEEDS_BUILD)]);
  return found.filter((f) => !elsewhere.has(f)).sort();
}

/**
 * The TAP summary counts, or null when the run printed none. A test's own printed lines also come back as `# …`
 * lines, so the LAST match of each is the summary's.
 */
export function tapCounts(output) {
  const n = (name) => {
    const all = [...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
    return all.length ? Number(all.at(-1)[1]) : null;
  };
  const counts = {
    tests: n('tests'),
    pass: n('pass'),
    fail: n('fail'),
    cancelled: n('cancelled'),
    skipped: n('skipped'),
    todo: n('todo'),
  };
  return counts.tests === null || counts.pass === null ? null : counts;
}

/** How many lines of each failed test's error the summary keeps; the whole output follows it. */
const ERROR_LINES = 8;

/** A YAML scalar from the TAP reporter: `'single quoted'` (with '' for '), or bare. */
const unquote = (v) => (/^'.*'$/.test(v) ? v.slice(1, -1).replaceAll("''", "'") : v);

/**
 * Each failed test in node's TAP output, in order: `{ name, location, error }`, `error` being up to ERROR_LINES lines.
 * A parent that failed only because a child did is left out (the child is listed). A test file that threw outside any
 * `test()` fails as one test named by its path with the error `test failed`; its own message is in the `# ` lines
 * printed just before it, so those are kept instead.
 */
export function failedTests(output) {
  const lines = output.split('\n');
  const failed = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)not ok \d+ - (.*?)(?: # (?:SKIP|TODO).*)?$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1];
    const yaml = [];
    if (lines[i + 1] === `${indent}  ---`) {
      for (let j = i + 2; j < lines.length && lines[j] !== `${indent}  ...`; j += 1) yaml.push(lines[j].slice(indent.length + 2));
    }
    const field = (key) => {
      const at = yaml.findIndex((l) => l.startsWith(`${key}:`));
      if (at < 0) return null;
      const v = yaml[at].slice(key.length + 1).trim();
      if (!/^[|>]/.test(v)) return [unquote(v)];
      const block = [];
      for (let j = at + 1; j < yaml.length && (yaml[j] === '' || /^\s/.test(yaml[j])); j += 1) block.push(yaml[j].trim());
      return block;
    };
    if ((field('failureType') ?? [])[0] === 'subtestsFailed') continue;
    let error = (field('error') ?? []).filter(Boolean);
    if (error.length === 0 || (error.length === 1 && error[0] === 'test failed')) {
      // The file's own stderr, printed as `# ` lines between the test before it and its `# Subtest:` line.
      const printed = [];
      let j = i - 1;
      if (lines[j]?.trim().startsWith('# Subtest:')) j -= 1;
      for (; j >= 0 && /^\s*# /.test(lines[j]) && !lines[j].trim().startsWith('# Subtest:'); j -= 1)
        printed.unshift(lines[j].trim().slice(2));
      // The thrown error's own line (`AssertionError [ERR_ASSERTION]: …`), else the first that reads like one.
      let from = printed.findIndex((l) => /^[\w.]*Error\b[^(]*:/.test(l));
      if (from < 0) from = printed.findIndex((l) => /Error\b|✖|not ok/.test(l));
      if (printed.length) error = printed.slice(from < 0 ? 0 : from);
    }
    const stack = field('stack') ?? [];
    const where = stack.find((l) => /\.test\.mjs:\d+/.test(l));
    if (where && !error.some((l) => l.includes(where.trim()))) error.push(where.trim());
    failed.push({ name: m[2], location: (field('location') ?? [null])[0], error: error.slice(0, ERROR_LINES) });
  }
  return failed;
}

/** The lines printed before the full output: each failed test's name, where it is, and the first lines of its error. */
export function failureSummary(failed) {
  if (failed.length === 0) return 'FAILED TOOLING TESTS: no `not ok` line in the output; read the whole output below.\n';
  const out = [`FAILED TOOLING TESTS (${failed.length}), each with the first lines of its error; the whole output follows:`];
  for (const f of failed) {
    const at = f.location?.replace(/^file:\/\//, '') ?? null;
    const inRepo = at && relative(ROOT, at);
    const loc = inRepo && !inRepo.startsWith('..') ? inRepo : at;
    // A file that failed as a whole is already named by its path.
    const named = loc && (loc.split(':')[0] === f.name || loc.split(':')[0].endsWith(`/${f.name}`));
    out.push(`  ✖ ${f.name}${loc && !named ? `  (${loc})` : ''}`);
    for (const l of f.error) out.push(`      ${l}`);
  }
  return `${out.join('\n')}\n`;
}

/** The process groups still running, so a stopped gate (Ctrl-C at a pre-push) stops them too: they are not in its group. */
const RUNNING = new Set();
function stopAllOnSignal() {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      for (const pid of RUNNING) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      process.exit(1);
    });
  }
}

/**
 * What says which run this is: its event, its branch, its commit and the journeys it targets. A tooling test gets the
 * same answer on main, on any branch and on the Mac, so no test file sees these: a test that needs one sets it. On 25 Nov
 * journey-verdict.test.mjs spawned the verdict with the run's GITHUB_HEAD_REF, so on every `beta/` pull request the beta
 * lane (#10900) excused its planted red and the Doctrine gates job of six pull requests failed (CI run 45564726213).
 */
export const RUN_CONTEXT = [
  'GITHUB_EVENT_NAME',
  'GITHUB_EVENT_PATH',
  'GITHUB_HEAD_REF',
  'GITHUB_BASE_REF',
  'GITHUB_REF',
  'GITHUB_REF_NAME',
  'GITHUB_REF_TYPE',
  'GITHUB_REF_PROTECTED',
  'GITHUB_SHA',
  'JOURNEYS_TARGET',
];
const withoutRunContext = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !RUN_CONTEXT.includes(k)));

/**
 * One test file in its own `node --test` process and process group, so a timeout stops the servers and child processes
 * it started too; it never sees RUN_CONTEXT. Resolves `{ file, output, status, signal, ms, timedOut }`; never rejects.
 */
function runFile(file, { cwd = ROOT, timeoutMs = FILE_TIMEOUT_MS, env = process.env } = {}) {
  const started = Date.now();
  return new Promise((done) => {
    const chunks = [];
    let timedOut = false;
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', file], {
      cwd,
      env: withoutRunContext(env),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    RUNNING.add(child.pid);
    const stopGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopGroup('SIGTERM');
      setTimeout(() => stopGroup('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    const finish = (status, signal, error) => {
      clearTimeout(timer);
      // Whatever the file left behind in its group (a server, a child) goes with it.
      stopGroup('SIGKILL');
      RUNNING.delete(child.pid);
      const output = Buffer.concat(chunks).toString('utf8') + (error ? `\n# ${error.message}\n` : '');
      done({ file, output, status, signal, ms: Date.now() - started, timedOut });
    };
    child.on('error', (e) => finish(null, null, e));
    child.on('close', (status, signal) => finish(status, signal));
  });
}

/**
 * Every file, `atOnce` at a time, then each of `alone` by itself; the order of the results is the order of `files`.
 * Past `timeoutMs` for the whole run, files not yet started are not started and come back with `notRun`.
 */
export async function runFiles(
  files,
  { alone = [], atOnce = AT_ONCE, timeoutMs = TIMEOUT_MS, fileTimeoutMs = FILE_TIMEOUT_MS, cwd = ROOT, env } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const results = new Map();
  const left = () => Math.max(0, deadline - Date.now());
  const one = async (file) => {
    if (left() === 0) return results.set(file, { file, output: '', status: null, signal: null, ms: 0, timedOut: false, notRun: true });
    const r = await runFile(file, { cwd, env, timeoutMs: Math.min(fileTimeoutMs, left()) });
    results.set(file, r);
  };
  const shared = files.filter((f) => !alone.includes(f));
  const queue = [...shared];
  await Promise.all(
    Array.from({ length: Math.min(atOnce, queue.length) }, async () => {
      while (queue.length) await one(queue.shift());
    }),
  );
  for (const f of files.filter((f) => alone.includes(f))) await one(f);
  return files.map((f) => results.get(f));
}

/** One file's verdict line: what stopped it, or its counts. */
const fileProblem = (r, counts) => {
  if (r.notRun) return 'not run: the whole run reached its limit first';
  if (r.timedOut) return `stopped after ${Math.round(r.ms / 1000)} s, its limit (a test that never ends, or a server left running)`;
  if (counts && (counts.fail || counts.cancelled)) return `${counts.fail} failed, ${counts.cancelled ?? 0} cancelled`;
  if (r.status !== 0) return `exit ${r.status ?? r.signal}`;
  if (!counts) return 'no TAP summary';
  return null;
};

async function main() {
  const files = testFiles();
  if (files.length === 0) {
    console.error(`TOOLING TESTS FAILED — no tooling/**/*.test.mjs under ${ROOT}. NOTHING WAS RUN.`);
    process.exit(1);
  }
  stopAllOnSignal();
  const started = Date.now();
  const alone = files.filter((f) => runsAlone(readFileSync(join(ROOT, f), 'utf8')));
  const results = await runFiles(files, { alone });
  const seconds = Math.round((Date.now() - started) / 1000);
  const total = { pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  const bad = [];
  for (const r of results) {
    const counts = tapCounts(r.output);
    if (counts) for (const k of Object.keys(total)) total[k] += counts[k] ?? 0;
    const problem = fileProblem(r, counts);
    if (problem) bad.push({ r, problem });
  }
  if (bad.length || total.pass === 0) {
    // The failed tests' names and messages come first, then each failed file's whole TAP output: the log's first screen
    // names what to fix (J-merchant-01 and J-algo-dev-03 on 14 Nov each spent a push digging for one), and the gate's
    // stderr line below repeats them, which GitHub shows before every other gate's result.
    const named = failureSummary(bad.flatMap(({ r }) => failedTests(r.output)));
    const fileLines = bad.map(({ r, problem }) => `  ✖ ${r.file}: ${problem}`).join('\n');
    const outputs = bad.map(({ r }) => `\n── ${r.file} (${Math.round(r.ms / 1000)} s) ──\n${r.output}`).join('');
    process.stdout.write(`${named}${fileLines}\n${outputs}`);
    console.error(
      `TOOLING TESTS FAILED — ${bad.length} of ${files.length} files: ${total.fail} failed, ${total.cancelled} cancelled, ` +
        `${total.pass} passed, in ${seconds} s.\n${fileLines}\n${named}`,
    );
    process.exit(1);
  }
  const slowest = [...results]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 4)
    .map((r) => `${r.file.split('/').pop()} ${Math.round(r.ms / 1000)} s`);
  const aloneSeconds = Math.round(results.filter((r) => alone.includes(r.file)).reduce((n, r) => n + r.ms, 0) / 1000);
  // One line, the last: gates.mjs shows only a passing gate's last line. Skips are printed, never hidden: a test that
  // skips itself (no browser on this runner) is not a test that ran.
  console.log(
    `tooling tests: ${total.pass} passed, ${total.skipped} skipped, ${total.todo} todo across ${files.length} files ` +
      `(${AT_ONCE} at once, ${alone.length} alone for ${aloneSeconds} s) in ${seconds} s; slowest: ${slowest.join(', ')}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
