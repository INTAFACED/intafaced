#!/usr/bin/env node
/**
 * Every unit test of the local test stack and the gate tools, on every PR (owner decision 2026-10-31, OWNER 138).
 *
 * Until this ran, only gate-tools.test.mjs (two files) ran here and journey-shards.test.mjs ran in the journeys workflow;
 * the other test files in tooling/scripts/ ran only when someone remembered `pnpm local:stack:test`, so a change to the stack
 * script could land with its own tests red. This runs every `*.test.mjs` it finds under tooling/ (not in node_modules,
 * and not pay-sim's vitest files, which turbo runs), so a new test file is covered the day it lands, with no list to forget
 * to update. The one file that needs a build first runs in CI's build job instead (NEEDS_BUILD).
 *
 * It is a gate in tooling/ci/gates.mjs (`tooling-tests`), so `pnpm verify` runs what CI runs. A tree with no test
 * files refuses by name instead of reporting zero failures over nothing (tooling/ci/empty-denominator-gate.mjs).
 *
 * Usage: node tooling/scripts/tooling-tests.mjs   (from the repo root)
 */
import { readdirSync, existsSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const DIR = join(ROOT, 'tooling');
// gate-tools.test.mjs only imports two of the files below; running it too would run those twice.
const ENTRY_ONLY = new Set(['tooling/scripts/gate-tools.test.mjs']);
// It reads packages/contracts/dist and skips itself without it, so here it would only ever skip: CI's build job runs it
// after the build (.github/workflows/ci.yml, "Tooling tests that need the build").
export const NEEDS_BUILD = ['tooling/preview/outreach/fixture.test.mjs'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo']);
const TIMEOUT_MS = 5 * 60_000;

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
  const elsewhere = new Set([...ENTRY_ONLY, ...NEEDS_BUILD]);
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

function main() {
  const files = testFiles();
  if (files.length === 0) {
    console.error(`TOOLING TESTS FAILED — no tooling/**/*.test.mjs under ${ROOT}. NOTHING WAS RUN.`);
    process.exit(1);
  }
  // One file at a time: several start throwaway servers and child processes, and a clash would read as a flaky gate.
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // A test that leaves a server running would otherwise hold the gates job until its 10-minute limit, silently.
    timeout: TIMEOUT_MS,
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const counts = tapCounts(output);
  if (r.status !== 0 || !counts || counts.fail !== 0 || counts.cancelled || counts.pass === 0) {
    // The failed tests' names and messages come first, then the whole TAP output: the log's first screen names what
    // to fix (J-merchant-01 and J-algo-dev-03 on 14 Nov each spent a push digging for one), and the gate's stderr line
    // below repeats them, which GitHub shows before every other gate's result.
    const named = failureSummary(failedTests(output));
    process.stdout.write(`${named}\n${output}`);
    console.error(
      `TOOLING TESTS FAILED — exit ${r.status ?? r.signal}${r.error ? ` (${r.error.message})` : ''}, ` +
        (counts ? `${counts.fail} failed, ${counts.cancelled ?? 0} cancelled, ${counts.pass} passed` : 'no TAP summary') +
        ` across ${files.length} files.\n${named}`,
    );
    process.exit(1);
  }
  // Skips are printed, never hidden: a test that skips itself (no browser on this runner) is not a test that ran.
  console.log(
    `tooling tests: ${counts.pass} passed, ${counts.skipped ?? 0} skipped, ${counts.todo ?? 0} todo across ${files.length} files`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
