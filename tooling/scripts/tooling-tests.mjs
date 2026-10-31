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
import { readdirSync, existsSync, realpathSync, statSync } from 'node:fs';
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
    for (const name of readdirSync(d)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.test.mjs')) found.push(relative(ROOT, full).split('\\').join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return found.filter((f) => !ENTRY_ONLY.has(f) && !NEEDS_BUILD.includes(f)).sort();
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
    process.stdout.write(output);
    console.error(
      `TOOLING TESTS FAILED — exit ${r.status ?? r.signal}${r.error ? ` (${r.error.message})` : ''}, ` +
        (counts ? `${counts.fail} failed, ${counts.cancelled ?? 0} cancelled, ${counts.pass} passed` : 'no TAP summary') +
        ` across ${files.length} files.`,
    );
    process.exit(1);
  }
  // Skips are printed, never hidden: a test that skips itself (no browser on this runner) is not a test that ran.
  console.log(
    `tooling tests: ${counts.pass} passed, ${counts.skipped ?? 0} skipped, ${counts.todo ?? 0} todo across ${files.length} files`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
