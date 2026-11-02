import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  BASELINE_PATH,
  FAIL_FAST,
  failFastSteps,
  failsFast,
  passedSteps,
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

test('only unbuilt steps fail fast, never a regression', () => {
  const steps = unbuiltSteps({
    steps: [{ step: 'J-a-01#1', state: 'unbuilt' }, { step: 'J-a-01#2', state: 'regression' }, { step: 'J-a-01#3' }],
  });
  assert.deepEqual([...steps], ['J-a-01#1']);
  assert.equal(failsFast(steps, 'J-a-01 #1 x'), true);
  assert.equal(failsFast(steps, 'J-a-01 #2 x'), false);
  assert.equal(failsFast(steps, 'J-a-01 #10 x'), false);
});

test('only a run that asks fails fast, only on planned steps still unbuilt, and an unreadable baseline fails fast on nothing', () => {
  const read = () =>
    JSON.stringify({
      steps: [
        { step: 'J-a-01#1', state: 'unbuilt' },
        { step: 'J-a-01#2', state: 'regression' },
      ],
    });
  const on = { JOURNEY_FAIL_FAST: '1', JOURNEY_FAIL_FAST_STEPS: 'J-a-01#1 J-a-01#2 J-b-01#1 junk' };
  assert.equal(failFastSteps({}, read).size, 0);
  assert.equal(failFastSteps({ ...on, JOURNEY_FAIL_FAST: '0' }, read).size, 0);
  assert.deepEqual([...failFastSteps(on, read)], ['J-a-01#1']);
  assert.equal(failFastSteps({ JOURNEY_FAIL_FAST: '1' }, read).size, 0, 'no plan, nothing fails fast');
  assert.equal(failFastSteps(on, () => 'not json').size, 0);
});

const report = (results) => ({
  suites: [
    {
      specs: [],
      suites: [
        {
          specs: Object.entries(results).map(([title, statuses]) => ({
            title,
            tests: [{ results: statuses.map((status) => ({ status })) }],
          })),
        },
      ],
    },
  ],
});

test('a step that passed in a run read is built: the plan leaves it to the ordinary limits', () => {
  const baseline = {
    steps: ['J-m-07#2', 'J-m-07#5', 'J-m-07#9'].map((step) => ({ step, state: 'unbuilt' })),
  };
  const r1 = report({ 'J-m-07 #2 reads funds': ['passed'], 'J-m-07 #9 x': ['failed'] });
  const r2 = report({ 'J-m-07 #5 tops up': ['failed', 'passed'], 'J-m-07 #9 x': ['timedOut'] });
  assert.deepEqual([...passedSteps(r1)], ['J-m-07#2']);
  assert.deepEqual(planFailFast(baseline, [r1, r2]), ['J-m-07#9']);
  assert.deepEqual(planFailFast(baseline, []), [], 'no report read, no list');
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
