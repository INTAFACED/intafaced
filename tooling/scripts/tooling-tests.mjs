#!/usr/bin/env node
/**
 * Every unit test of the local test stack and the gate tools, on every PR (owner decision 2026-10-31, OWNER 138).
 *
 * Until this ran, only gate-tools.test.mjs (two files) and journey-shards.test.mjs were wired to anything: the other
 * test files in tooling/scripts/ ran only when someone remembered `pnpm local:stack:test`, so a change to the stack
 * script could land with its own tests red. This runs every `tooling/scripts/*.test.mjs` it finds, so a new test file
 * is covered the day it lands, with no list to forget to update.
 *
 * It is a gate in tooling/ci/gates.mjs (`tooling-tests`), so `pnpm verify` runs what CI runs. A tree with no test
 * files refuses by name instead of reporting zero failures over nothing (tooling/ci/empty-denominator-gate.mjs).
 *
 * Usage: node tooling/scripts/tooling-tests.mjs   (from the repo root)
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const DIR = join(ROOT, 'tooling', 'scripts');
// gate-tools.test.mjs only imports two of the files below; running it too would run those twice.
const ENTRY_ONLY = new Set(['gate-tools.test.mjs']);

export function testFiles(dir = DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.mjs') && !ENTRY_ONLY.has(f))
    .sort()
    .map((f) => join('tooling', 'scripts', f));
}

/** The TAP summary counts, or null when the run printed none. */
export function tapCounts(output) {
  const n = (name) => {
    const m = output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const counts = { tests: n('tests'), pass: n('pass'), fail: n('fail'), cancelled: n('cancelled') };
  return counts.tests === null || counts.pass === null ? null : counts;
}

function main() {
  const files = testFiles();
  if (files.length === 0) {
    console.error(`TOOLING TESTS FAILED — no tooling/scripts/*.test.mjs under ${ROOT}. NOTHING WAS RUN.`);
    process.exit(1);
  }
  // One file at a time: several start throwaway servers and child processes, and a clash would read as a flaky gate.
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const counts = tapCounts(output);
  if (r.status !== 0 || !counts || counts.fail !== 0 || counts.cancelled || counts.pass === 0) {
    process.stdout.write(output);
    console.error(
      `TOOLING TESTS FAILED — exit ${r.status ?? r.signal}, ` +
        (counts ? `${counts.fail} failed, ${counts.cancelled ?? 0} cancelled, ${counts.pass} passed` : 'no TAP summary') +
        ` across ${files.length} files.`,
    );
    process.exit(1);
  }
  console.log(`tooling tests: ${counts.pass} passed across ${files.length} files`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
