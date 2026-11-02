import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { BASELINE_PATH, FAIL_FAST, failFastSteps, failsFast, stepKey, unbuiltSteps } from './journey-fail-fast.mjs';

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

test('only a run that asks fails fast, and an unreadable baseline fails fast on nothing', () => {
  const read = () => JSON.stringify({ steps: [{ step: 'J-a-01#1', state: 'unbuilt' }] });
  assert.equal(failFastSteps({}, read).size, 0);
  assert.equal(failFastSteps({ JOURNEY_FAIL_FAST: '0' }, read).size, 0);
  assert.equal(failFastSteps({ JOURNEY_FAIL_FAST: '1' }, read).size, 1);
  assert.equal(failFastSteps({ JOURNEY_FAIL_FAST: '1' }, () => 'not json').size, 0);
});

test("the waits are the journeys' own UNBUILT bar, and navigation is never the shorter one", () => {
  assert.equal(FAIL_FAST.waitMs, 5_000);
  assert.ok(FAIL_FAST.navigationMs >= FAIL_FAST.testMs);
  assert.ok(FAIL_FAST.testMs > FAIL_FAST.waitMs);
});

test("main's baseline is read: hundreds of unbuilt steps, every one a real step key", () => {
  const steps = unbuiltSteps(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')));
  assert.ok(steps.size > 100, `only ${steps.size} unbuilt steps read`);
  for (const k of steps) assert.match(k, /^J-[a-z0-9-]+-\d+#\d+$/);
});
