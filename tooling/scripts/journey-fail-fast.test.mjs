import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  BASELINE_PATH,
  FAIL_FAST,
  failFastSteps,
  failsFast,
  passedTitles,
  planFailFast,
  stepKey,
  unbuiltSteps,
} from './journey-fail-fast.mjs';

test('a step is keyed as Main trust keys it', () => {
  assert.equal(stepKey('J-agents-03 #5 publishes the identity page'), 'J-agents-03#5');
  assert.equal(stepKey('J-copy-bots-otc-23 #06 stops'), 'J-copy-bots-otc-23#6');
  assert.equal(stepKey('J-agents-03 starts: a verified TEST account'), null);
  assert.equal(stepKey('look sweep 390'), null);
});

test('only unbuilt steps fail fast, never a regression, and a title that passed keeps the ordinary limits', () => {
  const steps = unbuiltSteps({
    steps: [{ step: 'J-a-01#1', state: 'unbuilt' }, { step: 'J-a-01#2', state: 'regression' }, { step: 'J-a-01#3' }],
  });
  assert.deepEqual([...steps], ['J-a-01#1']);
  const plan = { steps, passed: new Set(['J-a-01 #1 the built one']) };
  assert.equal(failsFast(plan, 'J-a-01 #1 x'), true);
  assert.equal(failsFast(plan, 'J-a-01 #1 the built one'), false);
  assert.equal(failsFast(plan, 'J-a-01 #2 x'), false);
  assert.equal(failsFast(plan, 'J-a-01 #10 x'), false);
});

test('only a run that asks fails fast, only on planned steps still unbuilt; no or a bad plan or baseline fails fast on nothing', () => {
  const read = () =>
    JSON.stringify({
      steps: [
        { step: 'J-a-01#1', state: 'unbuilt' },
        { step: 'J-a-01#2', state: 'regression' },
      ],
    });
  const plan = JSON.stringify({ steps: ['J-a-01#1', 'J-a-01#2', 'J-b-01#1', 'junk'], passed: ['J-a-01 #1 built'] });
  const on = { JOURNEY_FAIL_FAST: '1', JOURNEY_FAIL_FAST_PLAN: plan };
  assert.equal(failFastSteps({}, read).steps.size, 0);
  assert.equal(failFastSteps({ ...on, JOURNEY_FAIL_FAST: '0' }, read).steps.size, 0);
  const got = failFastSteps(on, read);
  assert.deepEqual([...got.steps], ['J-a-01#1']);
  assert.deepEqual([...got.passed], ['J-a-01 #1 built']);
  assert.equal(failFastSteps({ JOURNEY_FAIL_FAST: '1' }, read).steps.size, 0, 'no plan, nothing fails fast');
  assert.equal(failFastSteps({ ...on, JOURNEY_FAIL_FAST_PLAN: '' }, read).steps.size, 0);
  assert.equal(failFastSteps(on, () => 'not json').steps.size, 0);
});

const report = (results) => ({
  suites: [
    {
      specs: [],
      suites: [
        {
          specs: Object.entries(results).map(([title, status]) => ({ title, tests: [{ status }] })),
        },
      ],
    },
  ],
});

test('a test that passed in a run read keeps the ordinary limits, though its step key names another that fails', () => {
  const baseline = { steps: ['J-m-07#2', 'J-m-07#9'].map((step) => ({ step, state: 'unbuilt' })) };
  // As in J-merchant-07: two tests share #2, and only one is built.
  const r1 = report({ 'J-m-07 #2 reads funds': 'expected', 'J-m-07 #2 a speed': 'unexpected', 'J-m-07 #9 x': 'unexpected' });
  const r2 = report({ 'J-m-07 #9 x': 'flaky', 'J-other-01 #1 y': 'expected' });
  assert.deepEqual([...passedTitles(r1)], ['J-m-07 #2 reads funds']);
  const plan = planFailFast(baseline, [r1, r2]);
  assert.deepEqual(plan, { steps: ['J-m-07#2', 'J-m-07#9'], passed: ['J-m-07 #2 reads funds', 'J-m-07 #9 x'] });
  const p = { steps: new Set(plan.steps), passed: new Set(plan.passed) };
  assert.equal(failsFast(p, 'J-m-07 #2 reads funds'), false);
  assert.equal(failsFast(p, 'J-m-07 #2 a speed'), true);
  assert.equal(planFailFast(baseline, []), null, 'no report read, no plan');
});

test("the waits are the journeys' own UNBUILT bar, and a step outlasts its waits", () => {
  assert.equal(FAIL_FAST.waitMs, 5_000);
  assert.ok(FAIL_FAST.testMs > FAIL_FAST.waitMs);
});

test("main's baseline is read: hundreds of unbuilt steps, every one a real step key", () => {
  const steps = unbuiltSteps(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')));
  assert.ok(steps.size > 100, `only ${steps.size} unbuilt steps read`);
  for (const k of steps) assert.match(k, /^J-[a-z0-9-]+-\d+#\d+$/);
});
