import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { journeysOf, parseLog, planLeaveOut, testListText } from './journey-leave-out.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const baseline = {
  steps: [
    { step: 'J-x-01#2', state: 'unbuilt' },
    { step: 'J-x-01#3', state: 'unbuilt' },
    { step: 'J-x-01#4', state: 'unbuilt' },
    { step: 'J-y-02#1', state: 'unbuilt' },
    { step: 'J-y-02#2', state: 'regression' },
  ],
};
const spec = (file, title, status) => ({ file, title, tests: [{ status }] });
// J-x-01: #1 built, #2 and #3 unbuilt and failing, #4 has two tests. J-y-02: every step failing.
const report = (over = {}) => ({
  suites: [
    {
      file: 'J-x-01.pw.mjs',
      specs: [
        spec('J-x-01.pw.mjs', 'J-x-01 #1 opens', 'expected'),
        spec('J-x-01.pw.mjs', 'J-x-01 #2 pays', over.x2 ?? 'unexpected'),
        spec('J-x-01.pw.mjs', 'J-x-01 #3 reads', 'unexpected'),
      ],
      suites: [
        {
          title: 'more',
          file: 'J-x-01.pw.mjs',
          specs: [spec('J-x-01.pw.mjs', 'J-x-01 #4 one', 'unexpected'), spec('J-x-01.pw.mjs', 'J-x-01 #4 two', over.x4 ?? 'unexpected')],
        },
      ],
    },
    {
      file: 'J-y-02.pw.mjs',
      specs: [spec('J-y-02.pw.mjs', 'J-y-02 #1 a', 'unexpected'), spec('J-y-02.pw.mjs', 'J-y-02 #2 b', 'unexpected')],
    },
  ],
});
const log = (subjects = {}) =>
  parseLog(
    [
      `@${C}\t${subjects.c ?? 'svc: an unrelated change'}`,
      ...(subjects.cFiles ?? ['services/svc-x/a.ts']),
      `@${B}\t${subjects.b ?? 'tests: another'}`,
      'apps/customer/src/x.ts',
      `@${A}\tolder`,
    ].join('\n'),
  );
const plan = (over = {}) =>
  planLeaveOut({
    baseline,
    runs: over.runs ?? [{ report: report(over), sha: B }],
    log: over.log ?? log(),
    history: over.history === undefined ? { runs: { 1: { passed: ['J-x-01#1'] } } } : over.history,
    isSerial: over.isSerial ?? (() => false),
  });
const keys = (p) => [...new Set(p.map((t) => t.key))].sort();

test('unbuilt steps that failed in a run read and that nothing touched since are left out, whole', () => {
  const p = plan();
  assert.deepEqual(keys(p), ['J-x-01#2', 'J-x-01#3', 'J-x-01#4', 'J-y-02#1']);
  // Both tests of #4 go together.
  assert.equal(p.filter((t) => t.key === 'J-x-01#4').length, 2);
  assert.equal(
    testListText(p.filter((t) => t.key === 'J-x-01#4')),
    'J-x-01.pw.mjs › more › J-x-01 #4 one\nJ-x-01.pw.mjs › more › J-x-01 #4 two',
  );
});

test('planted: a test that passed in any run read always runs, and so do the other tests of its step', () => {
  const p = plan({
    runs: [
      { report: report(), sha: B },
      { report: report({ x2: 'expected', x4: 'flaky' }), sha: A },
    ],
  });
  assert.deepEqual(keys(p), ['J-x-01#3', 'J-y-02#1']);
});

test('planted: a commit after the run that names the journey, or changes its file, brings it back', () => {
  assert.deepEqual(keys(plan({ log: log({ c: 'customer: J-x-01 #2 pays the invoice (#9)' }) })), ['J-y-02#1']);
  assert.deepEqual(keys(plan({ log: log({ cFiles: ['apps/customer/tests/real-app/J-x-01-pay.pw.mjs'] }) })), ['J-y-02#1']);
  // A commit older than the run read (A) does not.
  assert.deepEqual(keys(plan({ runs: [{ report: report(), sha: C }], log: log({ b: 'J-x-01 #2 older work' }) })), [
    'J-x-01#2',
    'J-x-01#3',
    'J-x-01#4',
    'J-y-02#1',
  ]);
});

test('planted: a run whose head is not in the history, a serial file, a regression step, no run or no history leave nothing out', () => {
  assert.deepEqual(plan({ runs: [{ report: report(), sha: 'd'.repeat(40) }] }), []);
  assert.deepEqual(keys(plan({ isSerial: (f) => f === 'J-x-01.pw.mjs' })), ['J-y-02#1']);
  assert.ok(!plan().some((t) => t.key === 'J-y-02#2'));
  assert.deepEqual(planLeaveOut({ baseline, runs: [], log: log(), history: { runs: {} }, isSerial: () => false }), []);
  assert.deepEqual(
    planLeaveOut({ baseline, runs: [{ report: report(), sha: B }], log: [], history: { runs: {} }, isSerial: () => false }),
    [],
  );
});

test('planted: a file whose every step would go keeps its first, so the run still holds every journey file', () => {
  const all = { steps: [...baseline.steps, { step: 'J-x-01#1', state: 'unbuilt' }].filter((s) => s.step !== 'J-y-02#2') };
  const r = report();
  r.suites[0].specs[0].tests[0].status = 'unexpected';
  const p = planLeaveOut({ baseline: all, runs: [{ report: r, sha: B }], log: log(), history: { runs: {} }, isSerial: () => false });
  assert.ok(!p.some((t) => t.key === 'J-x-01#1'), 'the first step of J-x-01 stays');
  // J-y-02 has #1 unbuilt and #2 a regression: #2 runs anyway, so #1 may go.
  assert.ok(p.some((t) => t.key === 'J-y-02#1'));
});

test('a title holding the list delimiter is never listed', () => {
  const r = report();
  r.suites[0].specs[1].title = 'J-x-01 #2 a › b';
  assert.ok(!plan({ runs: [{ report: r, sha: B }] }).some((t) => t.key === 'J-x-01#2'));
});

test('journeysOf reads a subject and the journey files a commit changed', () => {
  assert.deepEqual(
    [...journeysOf({ subject: 'x: J-Bank-13 #2 and J-wallet-05', files: ['apps/customer/tests/real-app/J-p2p-01.pw.mjs', 'x.ts'] })].sort(),
    ['J-bank-13', 'J-p2p-01', 'J-wallet-05'],
  );
});

test('planted: a step that passed on main at any time since the baseline (the pass history) always runs; no history, nothing goes', () => {
  // J-x-01 #3 passed in an old run the planner did not read: the verdict calls it "unbuilt, but passed on main", so it runs.
  assert.ok(!plan({ history: { runs: { 7: { passed: ['J-x-01#3'] } } } }).some((t) => t.key === 'J-x-01#3'));
  assert.ok(plan().some((t) => t.key === 'J-x-01#3'));
  assert.deepEqual(plan({ history: null }), []);
});
