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
    { step: 'J-y-02#1', state: 'regression' },
    { step: 'J-y-02#2', state: 'unbuilt' },
  ],
};
const spec = (file, title, status) => ({ file, title, tests: [{ status }] });
// J-x-01: #1 built, #2 and #3 unbuilt and failing, #4 has two tests. J-y-02: every step failing, #1 a regression.
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
  assert.deepEqual(keys(p), ['J-x-01#2', 'J-x-01#3', 'J-x-01#4', 'J-y-02#2']);
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
  // #3 sits between #2 and #4, which now run, so it runs too (only a file's tail goes).
  assert.deepEqual(keys(p), ['J-y-02#2']);
});

test('planted: a commit after the run that names the journey, or changes its file, brings it back', () => {
  assert.deepEqual(keys(plan({ log: log({ c: 'customer: J-x-01 #2 pays the invoice (#9)' }) })), ['J-y-02#2']);
  assert.deepEqual(keys(plan({ log: log({ cFiles: ['apps/customer/tests/real-app/J-x-01-pay.pw.mjs'] }) })), ['J-y-02#2']);
  // A commit older than the run read (A) does not.
  assert.deepEqual(keys(plan({ runs: [{ report: report(), sha: C }], log: log({ b: 'J-x-01 #2 older work' }) })), [
    'J-x-01#2',
    'J-x-01#3',
    'J-x-01#4',
    'J-y-02#2',
  ]);
});

test('planted: a run whose head is not in the history, a serial file, a regression step, no run or no history leave nothing out', () => {
  assert.deepEqual(plan({ runs: [{ report: report(), sha: 'd'.repeat(40) }] }), []);
  assert.deepEqual(keys(plan({ isSerial: (f) => f === 'J-x-01.pw.mjs' })), ['J-y-02#2']);
  assert.ok(!plan().some((t) => t.key === 'J-y-02#1'));
  assert.deepEqual(planLeaveOut({ baseline, runs: [], log: log(), history: { runs: {} }, isSerial: () => false }), []);
  assert.deepEqual(
    planLeaveOut({ baseline, runs: [{ report: report(), sha: B }], log: [], history: { runs: {} }, isSerial: () => false }),
    [],
  );
});

test('planted: a file whose every step would go keeps its first, so the run still holds every journey file', () => {
  const all = { steps: [...baseline.steps, { step: 'J-x-01#1', state: 'unbuilt' }].filter((s) => s.step !== 'J-y-02#1') };
  const r = report();
  r.suites[0].specs[0].tests[0].status = 'unexpected';
  const p = planLeaveOut({ baseline: all, runs: [{ report: r, sha: B }], log: log(), history: { runs: {} }, isSerial: () => false });
  assert.ok(!p.some((t) => t.key === 'J-x-01#1'), 'the first step of J-x-01 stays');
  // A kept step before the ones left out is fine: what goes is still the file's tail.
  assert.deepEqual(keys(p.filter((t) => t.key.startsWith('J-x-01'))), ['J-x-01#2', 'J-x-01#3', 'J-x-01#4']);
  // J-y-02 has #1 a regression and #2 unbuilt: #1 runs anyway, so #2, its tail, may go.
  assert.ok(p.some((t) => t.key === 'J-y-02#2'));
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

test('planted (main run 4788, 13 Nov 2026): an unbuilt step with a kept step after it in its file runs, since that step may act on what it made', () => {
  // J-copy-bots-otc-06's shape: #1 and #3 unbuilt and failing, #2 #4 #5 #6 passing and reading #1's follower and leader.
  const steps = [1, 3].map((n) => ({ step: `J-c-06#${n}`, state: 'unbuilt' }));
  const st = (n) => (n === 1 || n === 3 ? 'unexpected' : 'expected');
  const r = { suites: [{ file: 'J-c-06.pw.mjs', specs: [1, 2, 3, 4, 5, 6].map((n) => spec('J-c-06.pw.mjs', `J-c-06 #${n} x`, st(n))) }] };
  assert.deepEqual(
    planLeaveOut({ baseline: { steps }, runs: [{ report: r, sha: B }], log: log(), history: { runs: {} }, isSerial: () => false }),
    [],
  );
  // With #5 and #6 unbuilt too, only that tail goes, and #1 and #3 still run.
  const tail = [...steps, ...[5, 6].map((n) => ({ step: `J-c-06#${n}`, state: 'unbuilt' }))];
  const r2 = structuredClone(r);
  for (const sp of r2.suites[0].specs.slice(4)) sp.tests[0].status = 'unexpected';
  const p = planLeaveOut({
    baseline: { steps: tail },
    runs: [{ report: r2, sha: B }],
    log: log(),
    history: { runs: {} },
    isSerial: () => false,
  });
  assert.deepEqual(keys(p), ['J-c-06#5', 'J-c-06#6']);
});

test('the tail is read in source order (the spec line), not the report order a describe block changes', () => {
  // The report lists top-level specs first, then a describe block's; in the file the describe block (#1, line 5) comes first.
  const steps = [{ step: 'J-d-07#1', state: 'unbuilt' }];
  const r = {
    suites: [
      {
        file: 'J-d-07.pw.mjs',
        specs: [{ ...spec('J-d-07.pw.mjs', 'J-d-07 #2 b', 'expected'), line: 20 }],
        suites: [{ title: 'g', file: 'J-d-07.pw.mjs', specs: [{ ...spec('J-d-07.pw.mjs', 'J-d-07 #1 a', 'unexpected'), line: 5 }] }],
      },
    ],
  };
  assert.deepEqual(
    planLeaveOut({ baseline: { steps }, runs: [{ report: r, sha: B }], log: log(), history: { runs: {} }, isSerial: () => false }),
    [],
  );
});
