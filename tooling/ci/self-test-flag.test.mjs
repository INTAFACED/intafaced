// A tooling script tests itself in a `<script>.test.mjs` file (node:test), never through a `--self-test` flag of its own.
// The tooling-tests gate (tooling/scripts/tooling-tests.mjs) runs every tooling/**/*.test.mjs on every PR, so a test file
// is covered the day it lands; a flag runs only where a workflow step remembers to call it, and that step holds up every
// job that waits on it.
// Run: node --test tooling/ci/self-test-flag.test.mjs (also by the tooling-tests gate).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * The scripts that still read a `--self-test` flag. This list may only shrink: move a script's cases into its
 * `.test.mjs` file, delete the flag and the workflow step that runs it, and delete its line here.
 */
const FROZEN = new Set([
  'tooling/ci/brand-scan.mjs',
  'tooling/ci/dependency-audit.mjs',
  'tooling/ci/look-gate/look-gate.mjs',
  'tooling/ci/secret-rotation-readiness-scan.mjs',
  'tooling/scripts/matching-ledger-load-test.mjs',
]);

/** A `--self-test` string literal: the flag a script reads, not a mention in prose. */
const FLAG = /['"]--self-test['"]/;
const SCRIPT = /^tooling\/.+\.mjs$/;
const WORKFLOW = /^\.github\/workflows\/.+\.ya?ml$/;

const testFileOf = (path) => path.replace(/\.mjs$/, '.test.mjs');

/** Every finding, each naming its fix, for `files`: a Map of repo path to text. */
function findings(files) {
  const out = [];
  for (const [path, text] of files) {
    if (SCRIPT.test(path) && !path.endsWith('.test.mjs') && FLAG.test(text) && !FROZEN.has(path))
      out.push(
        `${path}: reads a --self-test flag. Move its cases into ${testFileOf(path)} (node:test; the tooling-tests gate runs it on every PR) and delete the flag.`,
      );
    if (!WORKFLOW.test(path)) continue;
    text.split('\n').forEach((line, i) => {
      if (!line.includes('--self-test')) return;
      for (const [script] of line.matchAll(/tooling\/[\w./-]+\.mjs/g))
        if (!FROZEN.has(script))
          out.push(
            `${path}:${i + 1}: runs ${script} --self-test. Delete the step: its cases run from ${testFileOf(script)} in the tooling-tests gate.`,
          );
    });
  }
  for (const path of FROZEN)
    if (files.has(path) && !FLAG.test(files.get(path)))
      out.push(`${path}: no longer reads a --self-test flag. Delete its line from FROZEN in tooling/ci/self-test-flag.test.mjs.`);
    else if (!files.has(path)) out.push(`${path}: does not exist. Delete its line from FROZEN in tooling/ci/self-test-flag.test.mjs.`);
  return out;
}

function checkout() {
  const paths = execFileSync('git', ['ls-files', '-z', 'tooling', '.github/workflows'], { encoding: 'utf8' })
    .split('\0')
    .filter((p) => SCRIPT.test(p) || WORKFLOW.test(p));
  return new Map(paths.map((p) => [p, readFileSync(p, 'utf8')]));
}

test('this checkout: no script outside FROZEN reads a --self-test flag, and no workflow runs one', () => {
  assert.deepEqual(findings(checkout()), []);
});

test('the fault it was written for: a tool with its own --self-test, run by a CI step', () => {
  const files = new Map([
    ['tooling/ci/ci-affected.mjs', "if (process.argv.includes('--self-test')) selfTest();\n"],
    ['.github/workflows/ci.yml', 'steps:\n      - run: node tooling/ci/ci-affected.mjs --self-test\n'],
    ...[...FROZEN].map((p) => [p, "argv.includes('--self-test')"]),
  ]);
  assert.deepEqual(findings(files), [
    'tooling/ci/ci-affected.mjs: reads a --self-test flag. Move its cases into tooling/ci/ci-affected.test.mjs (node:test; the tooling-tests gate runs it on every PR) and delete the flag.',
    '.github/workflows/ci.yml:2: runs tooling/ci/ci-affected.mjs --self-test. Delete the step: its cases run from tooling/ci/ci-affected.test.mjs in the tooling-tests gate.',
  ]);
});

test('prose, test files and frozen scripts pass; a frozen script that lost its flag must leave the list', () => {
  const ok = new Map([
    ['tooling/ci/gates.mjs', "  reason: 'the worktree-gc --self-test precedent',\n"],
    ['tooling/ci/x.test.mjs', "spawnSync('node', ['x.mjs', '--self-test']);\n"],
    ['.github/workflows/look-gate.yml', '        run: node "$GATE" --self-test\n'],
    ['.github/workflows/pr-checks.yml', '      - run: node tooling/ci/dependency-audit.mjs --self-test\n'],
    ...[...FROZEN].map((p) => [p, "argv.includes('--self-test')"]),
  ]);
  assert.deepEqual(findings(ok), []);
  const lost = new Map(ok);
  lost.set('tooling/ci/brand-scan.mjs', 'no flag here');
  lost.delete('tooling/scripts/matching-ledger-load-test.mjs');
  assert.deepEqual(findings(lost), [
    'tooling/ci/brand-scan.mjs: no longer reads a --self-test flag. Delete its line from FROZEN in tooling/ci/self-test-flag.test.mjs.',
    'tooling/scripts/matching-ledger-load-test.mjs: does not exist. Delete its line from FROZEN in tooling/ci/self-test-flag.test.mjs.',
  ]);
});
