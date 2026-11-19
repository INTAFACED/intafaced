/**
 * The post-merge job of .github/workflows/main-trust.yml: a step after "Compare with the earlier runs and act on a break"
 * runs even when that step fails. The journeys revert compares a run with the one before it, so a break that a run
 * shows first is started from that run or never: on 13 Nov 2026 run 4591's compare step stopped on a GitHub 403 and the
 * revert step after it was skipped. Each later step's `if:` must hold `!cancelled()` (or `always()`); a step with no
 * `if:` runs only on success. A planted fault at the bottom proves the rule fails on the shape it forbids.
 * Run by tooling/scripts/tooling-tests.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = join(process.cwd(), '.github', 'workflows', 'main-trust.yml');
const COMPARE = 'Compare with the earlier runs and act on a break';

/** The steps of job `job` in the workflow text: [{ name, if }], in order. A minimal reader of this file's shape. */
export function jobSteps(text, job) {
  const lines = text.split('\n');
  const start = lines.indexOf(`  ${job}:`);
  if (start < 0) return null;
  const steps = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line) && !/^ {2}#/.test(line)) break;
    if (/^ {6}- /.test(line)) steps.push({ name: null, if: null });
    const m = /^ {6}(?:- | {2})(name|if): (.*)$/.exec(line);
    if (m && steps.length) steps.at(-1)[m[1]] = m[2].trim();
  }
  return steps;
}

/** The names of the steps after the compare step that a failed compare step would skip. Pure. */
export function skippedAfterCompare(steps) {
  const at = steps.findIndex((s) => s.name === COMPARE);
  if (at < 0) throw new Error(`no "${COMPARE}" step`);
  return steps
    .slice(at + 1)
    .filter((s) => !/!\s*cancelled\(\)|always\(\)/.test(s.if ?? ''))
    .map((s) => s.name);
}

test('every step after the compare step runs when it fails', () => {
  const steps = jobSteps(readFileSync(FILE, 'utf8'), 'post-merge');
  assert.ok(steps?.length, 'the post-merge job and its steps are found');
  assert.ok(
    steps.some((s) => s.name === 'Start the journeys revert on a confirmed break'),
    'the revert step is read',
  );
  assert.deepEqual(skippedAfterCompare(steps), []);
});

test('planted fault: a later step with the plain condition is named', () => {
  const planted = readFileSync(FILE, 'utf8').replace(
    "if: ${{ !cancelled() && github.event.workflow_run.name == 'Real-app journeys' }}",
    "if: github.event.workflow_run.name == 'Real-app journeys'",
  );
  assert.deepEqual(skippedAfterCompare(jobSteps(planted, 'post-merge')), ['Start the journeys revert on a confirmed break']);
});

test('planted fault: a later step with no condition is named', () => {
  const steps = [
    { name: COMPARE, if: null },
    { name: 'x', if: null },
  ];
  assert.deepEqual(skippedAfterCompare(steps), ['x']);
});
