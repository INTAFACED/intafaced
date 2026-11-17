/**
 * journeys-revert-probe.mjs: the binary search, the report reading, the parallel decision and the leave-out check, on
 * fixtures. tooling-tests.mjs runs it with every other tooling test.
 */
import test from 'node:test';
import {
  MAX_LEGS,
  SEARCH,
  decideCulprit,
  firstBad,
  leavesOut,
  planPoints,
  probeVerdict,
  stepsFail,
  stepsRan,
  validCandidates,
} from './journeys-revert-probe.mjs';

const eq = (got, want, m) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};
const c = ['1', '2', '3', '4', '5'].map((d) => d.repeat(40));
const rep = (status) => ({ suites: [{ specs: [{ title: 'J-a-01 #2 y', tests: [{ status }] }] }] });

test('the binary search finds the first bad commit in at most ceil(log2 n) probes; a lone candidate is left unprobed', () => {
  for (let k = 0; k < c.length; k++) {
    const calls = [];
    const r = firstBad(c, (s) => (calls.push(s), c.indexOf(s) >= k));
    eq(r.culprit, c[k], `culprit at ${k}`);
    eq(calls.length <= 3, true, `at most ceil(log2 5) probes for ${k}`);
  }
  const one = firstBad([c[0]], () => {
    throw new Error('a lone candidate needs no search');
  });
  eq([one.culprit, one.probed.has(c[0])], [c[0], false], 'a lone candidate is settled unprobed, so main() probes it before blaming it');
  eq([validCandidates([c[0]]), validCandidates([]), validCandidates(['x'])], [true, false, false], 'one or more full shas');
});

test('the report reading: fails, runs and the probe verdict', () => {
  eq(stepsFail(rep('unexpected'), ['J-a-01#2']), true, 'outright failure is bad');
  eq(stepsFail(rep('expected'), ['J-a-01#2']), false, 'a pass is good');
  eq(stepsFail(rep('unexpected'), ['J-a-01#3']), false, 'another step does not count');
  eq(stepsRan(rep('skipped'), ['J-a-01#2']), false, 'a skipped step did not run');
  eq(stepsRan(rep('expected'), ['J-a-01#2']), true, 'a step that ran');
  // A commit that holds the journey file without the failing step: not there yet reads as a pass, so the merge that
  // brought the step is the culprit; a report that loaded nothing says nothing.
  const other = { suites: [{ specs: [{ title: 'J-a-01 #1 x', tests: [{ status: 'expected' }] }] }] };
  eq(
    [probeVerdict(rep('unexpected'), ['J-a-01#2']), probeVerdict(rep('expected'), ['J-a-01#2']), probeVerdict(other, ['J-a-01#2'])],
    ['bad', 'good', 'good'],
    'fails, passes, and a step not there yet passes',
  );
  eq(
    [
      probeVerdict({ suites: [] }, ['J-a-01#2']),
      probeVerdict({ ...other, errors: [{ message: 'x' }] }, ['J-a-01#2']),
      probeVerdict(null, ['J-a-01#2']),
    ],
    ['error', 'error', 'error'],
    'nothing loaded, a load error, or no report: the probe says nothing',
  );
  eq(probeVerdict(rep('skipped'), ['J-a-01#2']), 'error', 'a step there but skipped says nothing');
  eq(
    decideCulprit(
      c,
      new Map([
        [c[0], { bad: false }],
        [c[1], { bad: false }],
        [c[2], { bad: true }],
        [c[3], { bad: true }],
        [c[4], { bad: true }],
      ]),
    ).culprit,
    c[2],
    'the commits before the step existed pass, so the merge that added it is named',
  );
});

test('the parallel plan and the decision from every candidate', () => {
  const many = Array.from({ length: MAX_LEGS + 1 }, (_, i) => String(i % 10).repeat(39) + 'abcdefghijklmnopq'[i]);
  eq([planPoints(c), planPoints(many)], [c, [SEARCH]], 'each candidate at once, or one search past MAX_LEGS');
  const res = (...xs) =>
    new Map(
      xs
        .map((x, i) => [c[i], x === 'F' ? { bad: true } : x === 'P' ? { bad: false } : x === 'E' ? { error: 'e' } : undefined])
        .filter(([, v]) => v),
    );
  eq(decideCulprit(c, res('P', 'P', 'F', 'F', 'F')).culprit, c[2], 'the oldest of the failing run that ends at the red commit');
  eq(decideCulprit(c, res('F', 'F', 'F', 'F', 'F')).culprit, c[0], 'all fail: the first candidate, after the last green commit');
  eq(decideCulprit(c, res('F', 'P', 'P', 'F', 'F')).culprit, c[3], 'an older fail followed by a pass is not the break that reaches main');
  eq(decideCulprit(c, res('P', 'P', 'F', 'F', 'P')).culprit, null, 'the newest passing: nothing reproduces');
  eq(decideCulprit(c, res('P', 'E', 'F', 'F', 'F')).culprit, null, 'the commit before the failing run could not run: no one is blamed');
  eq(decideCulprit(c, res('E', 'P', 'F', 'F', 'F')).culprit, c[2], 'a probe that could not run outside the deciding pair does not matter');
  eq(decideCulprit(c, res('P', 'P', 'F', 'F', 'E')).culprit, null, 'the red commit could not run: no one is blamed');
  eq(decideCulprit(c, res('P', 'P', 'F', 'F')).culprit, null, 'a missing result: no one is blamed');
  eq(decideCulprit([c[0]], res('F')).culprit, c[0], 'a lone candidate that fails is blamed');
  eq(decideCulprit([c[0]], res('P')).culprit, null, 'a lone candidate that passes is not');
});

test('a commit leaves tests out only when its own journeys run runs the leave-out planner', () => {
  const wf = (planner) =>
    `jobs:\n  touch:\n    steps:\n      - run: |\n${planner ? '          node tooling/scripts/journey-leave-out.mjs --log x > y\n' : ''}          echo done\n`;
  eq(
    [leavesOut(wf(true)), leavesOut(wf(false)), leavesOut(''), leavesOut(null)],
    [true, false, false, false],
    'a commit leaves out only when its own run plans it',
  );
  // Planted: the paths list naming the planner's files is not the planner running.
  eq(leavesOut("paths:\n  - 'tooling/scripts/journey-leave-out*.mjs'\n"), false, 'a paths entry is not the planner');
});
