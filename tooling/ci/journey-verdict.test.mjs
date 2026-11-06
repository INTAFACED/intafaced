// Tests of the journeys verdict (tooling/ci/journey-verdict.mjs): each rule shown both ways, on small reports.
//   node --test tooling/ci/journey-verdict.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyRuns, issueProblem, judge, moneyRule, parkedSteps, passesSince, readReport, regressionState } from './journey-verdict.mjs';

const spec = (title, status, file = 'J-a-01.pw.mjs') => ({ title, file, tests: [{ status }] });
const report = (...specs) => ({ suites: [{ file: 'J-a-01.pw.mjs', specs }] });
const ok = (t, f) => spec(t, 'expected', f);
const bad = (t, f) => spec(t, 'unexpected', f);
const skip = (t, f) => spec(t, 'skipped', f);
const parkedIssue = {
  issue: { number: 9, state: 'open', title: 'Journey broken on main: J-a-02' },
  comments: [
    { author_association: 'MEMBER', created_at: '2026-11-01T00:00:00Z', body: 'Regression state: parked — needs the stack. Lane B1.' },
  ],
};
const baseline = {
  run: { number: 100, id: 1 },
  steps: [
    { step: 'J-a-01#2', state: 'unbuilt', money: false },
    { step: 'J-a-02#1', state: 'regression', money: false, issue: 9 },
  ],
  notBaselined: [{ step: 'J-a-03#1' }],
};
const money = { 'J-a-01#1': false, 'J-a-01#2': false, 'J-a-02#1': false, 'J-a-03#1': false };
const named = readReport(report(ok('J-a-01 #1'), bad('J-a-01 #2'), bad('J-a-02 #1'), bad('J-a-03 #1')));
const run = (newest, extra = {}) => judge({ newest: readReport(newest), named, baseline, money, issues: { 9: parkedIssue }, ...extra });

test('green when only listed steps fail by their rules', () => {
  const v = run(report(ok('J-a-01 #1'), bad('J-a-01 #2'), bad('J-a-02 #1'), ok('J-a-03 #1')));
  assert.deepEqual(v.red, []);
  assert.equal(v.failing, 2);
});

test('red: a step outside the list fails (the planted break)', () => {
  const v = run(report(bad('J-a-01 #1'), bad('J-a-01 #2'), bad('J-a-02 #1'), ok('J-a-03 #1')));
  assert.deepEqual(
    v.red.map((r) => [r.step, r.why]),
    [['J-a-01#1', 'failing, not in the baseline']],
  );
});

test('a parked journey or step: its red never turns the verdict red, and unparked it is judged again (OWNER 183)', () => {
  // J-a-01 #1 passed in the named run; here it fails, and it is not on the baseline: red unless parked.
  const broken = report(bad('J-a-01 #1'), bad('J-a-01 #2'), bad('J-a-02 #1'), ok('J-a-03 #1'));
  const lost = report(bad('J-a-01 #2'), bad('J-a-02 #1'), ok('J-a-03 #1'));
  const whole = [
    { id: 'J-a-01', parked: true, parkedUntil: 'after launch', steps: [{ n: 1 }, { n: 2 }] },
    { id: 'J-a-02', steps: [{ n: 1 }] },
  ];
  const oneStep = [{ id: 'J-a-01', steps: [{ n: 1, parked: true }, { n: 2 }] }];
  const unparked = [{ id: 'J-a-01', steps: [{ n: 1 }, { n: 2 }] }];
  assert.deepEqual([...parkedSteps(whole)], ['J-a-01#1', 'J-a-01#2']);
  assert.deepEqual([...parkedSteps(oneStep)], ['J-a-01#1']);
  assert.deepEqual([...parkedSteps(unparked)], []);
  assert.deepEqual([...parkedSteps(null)], []);
  for (const journeys of [whole, oneStep]) {
    const v = run(broken, { parked: parkedSteps(journeys) });
    assert.deepEqual(v.red, [], 'a parked step failing is not red');
    assert.ok(v.parked.includes('J-a-01#1'));
    assert.deepEqual(run(lost, { parked: parkedSteps(journeys) }).red, [], 'a parked step that stopped running is not red');
  }
  // Unparked: the same reports are red again, under the ordinary rules.
  assert.deepEqual(
    run(broken, { parked: parkedSteps(unparked) }).red.map((r) => [r.step, r.why]),
    [['J-a-01#1', 'failing, not in the baseline']],
  );
  assert.match(run(lost, { parked: parkedSteps(unparked) }).red[0].why, /passed in run 100, missing now/);
  // Parking one step leaves the rest of the journey judged.
  const other = run(report(bad('J-a-01 #1'), ok('J-a-01 #2'), bad('J-a-02 #1'), bad('J-a-03 #1')), { parked: parkedSteps(oneStep) });
  assert.deepEqual(
    other.red.map((r) => r.step),
    ['J-a-03#1'],
  );
});

test('a parked money step stays judged unless the baseline shows it was never built (fail closed; Codex read of #7198)', () => {
  const journeys = [{ id: 'J-a-01', parked: true, steps: [{ n: 1 }, { n: 2 }] }];
  const parked = parkedSteps(journeys);
  const moneyToo = { ...money, 'J-a-01#1': true, 'J-a-01#2': true };
  const unbuiltMoney = { ...baseline, steps: baseline.steps.map((e) => (e.step === 'J-a-01#2' ? { ...e, money: true } : e)) };
  const rep = (one) => report(one, bad('J-a-01 #2'), bad('J-a-02 #1'), ok('J-a-03 #1'));
  // Passed in the named run, fails now: judged though parked.
  assert.deepEqual(
    run(rep(bad('J-a-01 #1')), { money: moneyToo, baseline: unbuiltMoney, parked }).red.map((r) => [r.step, r.money]),
    [['J-a-01#1', true]],
  );
  // Listed unbuilt, no pass on record: left out like any parked step.
  const w = run(rep(ok('J-a-01 #1')), { money: moneyToo, baseline: unbuiltMoney, parked });
  assert.deepEqual(w.red, []);
  assert.deepEqual(w.parked, ['J-a-01#2']);
  // Passed on main after the named run: judged.
  assert.deepEqual(
    run(rep(ok('J-a-01 #1')), { money: moneyToo, baseline: unbuiltMoney, parked, passedSince: { 'J-a-01#2': 101 } }).red.map((r) => r.step),
    ['J-a-01#2'],
  );
  // Listed unbuilt but with a pass on record (lastPassedRun): judged.
  const withPass = { ...unbuiltMoney, steps: unbuiltMoney.steps.map((e) => (e.step === 'J-a-01#2' ? { ...e, lastPassedRun: 99 } : e)) };
  assert.equal(run(rep(ok('J-a-01 #1')), { money: moneyToo, baseline: withPass, parked }).parked.length, 0);
  // Codex's case: passed in run 99, failing since, in notBaselined with lastPassedRun 99, no pass since: still red.
  const known = {
    ...unbuiltMoney,
    steps: unbuiltMoney.steps.filter((e) => e.step !== 'J-a-01#2'),
    notBaselined: [...unbuiltMoney.notBaselined, { step: 'J-a-01#2', lastPassedRun: 99 }],
  };
  assert.match(
    run(rep(ok('J-a-01 #1')), { money: moneyToo, baseline: known, parked }).red.find((r) => r.step === 'J-a-01#2').why,
    /notBaselined/,
  );
  // Missing from the baseline: no proof it was never built, so judged.
  const missing = { ...unbuiltMoney, steps: unbuiltMoney.steps.filter((e) => e.step !== 'J-a-01#2') };
  assert.match(run(rep(ok('J-a-01 #1')), { money: moneyToo, baseline: missing, parked }).red[0].why, /failing, not in the baseline/);
  // A parked step that isn't money is left out whatever its history.
  assert.deepEqual(run(rep(ok('J-a-01 #1')), { baseline: known, parked }).red, []);
});

test('red: a step that passed in the named run is skipped or missing now', () => {
  assert.match(run(report(skip('J-a-01 #1'), bad('J-a-01 #2'))).red[0].why, /passed in run 100, skipped now/);
  assert.match(run(report(bad('J-a-01 #2'))).red[0].why, /passed in run 100, missing now/);
});

test('green: a skipped step that never passed is not a failure (the runbook counts failures and lost passes)', () => {
  const v = run(report(ok('J-a-01 #1'), skip('J-a-04 #1')));
  assert.deepEqual(v.red, []);
});

test('red: a notBaselined step that fails', () => {
  assert.match(run(report(ok('J-a-01 #1'), bad('J-a-03 #1'))).red[0].why, /notBaselined/);
});

test('red: an unbuilt step that passed on main after the named run fails now', () => {
  const passedSince = passesSince([
    [101, readReport(report(ok('J-a-01 #2')))],
    [102, readReport(report(bad('J-a-01 #2')))],
  ]);
  assert.deepEqual(passedSince, { 'J-a-01#2': 101 });
  const v = run(report(ok('J-a-01 #1'), bad('J-a-01 #2')), { passedSince });
  assert.match(v.red[0].why, /called unbuilt, but passed on main in run 101/);
});

test('red: the money rule disagrees with the entry, and a step missing from journeys.json is money', () => {
  assert.match(
    run(report(ok('J-a-01 #1'), bad('J-a-01 #2')), { money: { ...money, 'J-a-01#2': true } }).red[0].why,
    /money false.*says true/,
  );
  const { 'J-a-01#2': _, ...without } = money;
  assert.match(run(report(ok('J-a-01 #1'), bad('J-a-01 #2')), { money: without }).red[0].why, /money false.*says true/);
});

test('red: a regression entry whose issue is not parked with a blocker, or is money', () => {
  const closed = { ...parkedIssue, issue: { ...parkedIssue.issue, state: 'closed' } };
  assert.match(run(report(ok('J-a-01 #1'), bad('J-a-02 #1')), { issues: { 9: closed } }).red[0].why, /#9 is closed/);
  const noBlocker = { ...parkedIssue, comments: [{ ...parkedIssue.comments[0], body: 'Regression state: parked' }] };
  assert.match(run(report(ok('J-a-01 #1'), bad('J-a-02 #1')), { issues: { 9: noBlocker } }).red[0].why, /unset, not parked/);
  const outsider = { ...parkedIssue, comments: [{ ...parkedIssue.comments[0], author_association: 'NONE' }] };
  assert.match(run(report(ok('J-a-01 #1'), bad('J-a-02 #1')), { issues: { 9: outsider } }).red[0].why, /unset/);
  assert.match(run(report(ok('J-a-01 #1'), bad('J-a-02 #1')), { issues: { 9: { problem: 'HTTP 403' } } }).red[0].why, /couldn't be read/);
  assert.match(
    run(report(ok('J-a-01 #1'), bad('J-a-02 #1')), { money: { ...money, 'J-a-02#1': true } }).red[0].why,
    /money false.*says true/,
  );
  const moneyBase = { ...baseline, steps: [{ step: 'J-a-02#1', state: 'regression', money: true, issue: 9 }] };
  const v = judge({
    newest: readReport(report(ok('J-a-01 #1'), bad('J-a-02 #1'))),
    named,
    baseline: moneyBase,
    money: { ...money, 'J-a-02#1': true },
    issues: { 9: parkedIssue },
  });
  assert.match(v.red[0].why, /only as unbuilt/);
});

test('red: a step listed twice, or in a state the runbook does not allow', () => {
  const twice = { ...baseline, steps: [...baseline.steps, baseline.steps[0]] };
  assert.match(
    judge({ newest: readReport(report(ok('J-a-01 #1'), bad('J-a-01 #2'))), named, baseline: twice, money }).red[0].why,
    /more than once/,
  );
  const odd = { ...baseline, steps: [{ step: 'J-a-01#2', state: 'flaky', money: false }] };
  assert.match(
    judge({ newest: readReport(report(ok('J-a-01 #1'), bad('J-a-01 #2'))), named, baseline: odd, money }).red[0].why,
    /not one the baseline allows/,
  );
});

test('a targeted run judges only the files it ran', () => {
  const named2 = readReport(report(ok('J-a-01 #1'), ok('J-b-01 #1', 'J-b-01.pw.mjs')));
  const newest = readReport(report(ok('J-a-01 #1')));
  assert.deepEqual(judge({ newest, named: named2, baseline, money, target: new Set(['J-a-01.pw.mjs']) }).red, []);
  assert.match(judge({ newest, named: named2, baseline, money, target: null }).red[0].why, /missing now/);
  const broken = readReport(report(bad('J-a-01 #1')));
  assert.equal(judge({ newest: broken, named: named2, baseline, money, target: new Set(['J-a-01.pw.mjs']) }).red.length, 1);
});

test('a failing duplicate title never hides behind a passing one', () => {
  assert.equal(readReport(report(ok('J-a-01 #1 first'), bad('J-a-01 #1 second'))).states['J-a-01#1'], 'failed');
});

test('the money rule: ledger-client and its direct dependants, by slice touches', () => {
  const manifests = new Map([
    ['packages/ledger-client', { name: '@intafaced/ledger-client' }],
    ['services/svc-bank', { dependencies: { '@intafaced/ledger-client': '*' } }],
    ['services/svc-docs', {}],
  ]);
  const slices = [
    { id: 'S1', touches: ['svc-bank'] },
    { id: 'S2', touches: ['svc-docs'] },
    { id: 'S3', touches: ['something odd'] },
    { id: 'S4', touches: ['packages/stealth'] },
  ];
  const journeys = [
    {
      id: 'J-a-01',
      steps: [
        { n: 1, slices: ['S1'] },
        { n: 2, slices: ['S2'] },
        { n: 3, slices: ['S3'] },
        { n: 4, slices: [] },
        { n: 5, slices: ['S4'] },
      ],
    },
  ];
  assert.deepEqual(moneyRule({ journeys, slices, manifests }), {
    'J-a-01#1': true,
    'J-a-01#2': false,
    'J-a-01#3': true,
    'J-a-01#4': false,
    'J-a-01#5': false,
  });
});

test('regression state: the newest member line wins, and code blocks are skipped', () => {
  const c = (body, at, who = 'MEMBER') => ({ body, created_at: at, author_association: who });
  assert.equal(
    regressionState([
      c('Regression state: parked — x', '2026-11-01T00:00:00Z'),
      c('Regression state: fixed #1, run 5', '2026-11-02T00:00:00Z'),
    ]).kind,
    'fixed',
  );
  assert.equal(regressionState([c('```\nRegression state: parked — x\n```', '2026-11-01T00:00:00Z')]), null);
  assert.equal(issueProblem(undefined, null), 'names no issue');
});

test("history: only main's own finished runs between the named run and this one", () => {
  const repo = 'o/r';
  const r = (id, n, extra = {}) => ({
    id,
    run_number: n,
    head_branch: 'main',
    head_repository: { full_name: repo },
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    created_at: `2026-11-0${n}T00:00:00Z`,
    ...extra,
  });
  const runs = [
    r(1, 1),
    r(2, 2),
    r(3, 3, { conclusion: 'cancelled' }),
    r(4, 4, { head_repository: { full_name: 'fork/r' } }),
    r(5, 5, { event: 'pull_request' }),
    r(6, 6, { conclusion: 'success' }),
    r(7, 7),
  ];
  assert.deepEqual(
    historyRuns(runs, { repo, namedCreated: r(1, 1).created_at, thisCreated: r(7, 7).created_at, thisId: 7 }).map((x) => x.run_number),
    [2, 6],
  );
});
