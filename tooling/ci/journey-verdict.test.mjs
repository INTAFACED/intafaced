// Tests of the journeys verdict (tooling/ci/journey-verdict.mjs): each rule shown both ways, on small reports.
//   node --test tooling/ci/journey-verdict.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SET_ASIDE_DAYS,
  historyRuns,
  issueProblem,
  judge,
  moneyRule,
  passesSince,
  readReport,
  regressionState,
  setAsideSteps,
} from './journey-verdict.mjs';

const spec = (title, status, file = 'J-a-01.pw.mjs') => ({ title, file, tests: [{ status }] });
const report = (...specs) => ({ suites: [{ file: 'J-a-01.pw.mjs', specs }] });
const ok = (t, f) => spec(t, 'expected', f);
const bad = (t, f) => spec(t, 'unexpected', f);
const skip = (t, f) => spec(t, 'skipped', f);
const flaky = (t, f) => spec(t, 'flaky', f);
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

// The set-aside (OWNER 225, 227): a step that failed, then passed on its retry, on main, is set aside by the machine for
// SET_ASIDE_DAYS from the first such run, never a money step.
const at = (day) => `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const moneyToo = { ...money, 'J-a-05#1': true };
const aside = (runs, now) => setAsideSteps(runs, { money: moneyToo, owners: { 'J-a-01': 'alpha' }, now });

test('a flaky test reads as "flaky", and a failing duplicate still wins', () => {
  assert.equal(readReport(report(flaky('J-a-01 #1'))).states['J-a-01#1'], 'flaky');
  assert.equal(readReport(report(ok('J-a-01 #1 a'), flaky('J-a-01 #1 b'))).states['J-a-01#1'], 'flaky');
  assert.equal(readReport(report(flaky('J-a-01 #1 a'), bad('J-a-01 #1 b'))).states['J-a-01#1'], 'failed');
  assert.deepEqual(passesSince([[101, readReport(report(flaky('J-a-01 #2')))]]), { 'J-a-01#2': 101 });
});

test('the set-aside list: non-money flaky steps, from the first flaky run, never a money step', () => {
  const runs = [
    { number: 101, at: at(1), states: { 'J-a-01#1': 'failed' } },
    { number: 102, at: at(2), states: { 'J-a-01#1': 'flaky', 'J-a-05#1': 'flaky', 'J-a-06#1': 'flaky' } },
    { number: 103, at: at(3), states: { 'J-a-01#1': 'flaky' } },
  ];
  const list = aside(runs, at(4));
  assert.deepEqual(Object.keys(list), ['J-a-01#1']); // J-a-05 is money; J-a-06 is missing from journeys.json, so money
  assert.equal(list['J-a-01#1'].since, 102);
  assert.equal(list['J-a-01#1'].until, new Date(Date.parse(at(2)) + SET_ASIDE_DAYS * 864e5).toISOString());
  assert.equal(list['J-a-01#1'].active, true);
  assert.equal(list['J-a-01#1'].owner, 'the alpha area');
  assert.equal(aside(runs, at(2 + SET_ASIDE_DAYS))['J-a-01#1'].active, false); // the end date counts from run 102, not 103
});

test('set aside: a non-money step on the list that fails leaves the verdict green, and is reported', () => {
  const setAside = aside([{ number: 102, at: at(2), states: { 'J-a-01#1': 'flaky' } }], at(3));
  const v = run(report(bad('J-a-01 #1'), bad('J-a-01 #2')), { setAside });
  assert.deepEqual(v.red, []);
  assert.deepEqual(v.setAside, ['J-a-01#1']);
  // The same failure with no set-aside is red (the planted break, unchanged).
  assert.match(run(report(bad('J-a-01 #1'), bad('J-a-01 #2'))).red[0].why, /failing, not in the baseline/);
});

test('set aside: a flaky non-money step in this run is green while its set-aside lasts', () => {
  const setAside = aside([{ number: 103, at: at(3), states: { 'J-a-01#1': 'flaky' } }], at(3));
  assert.deepEqual(run(report(flaky('J-a-01 #1'), bad('J-a-01 #2')), { setAside }).red, []);
});

test('never set aside: a money step that failed, then passed on its retry, is red', () => {
  const v = run(report(ok('J-a-01 #1'), flaky('J-a-05 #1')), { money: moneyToo, setAside: {} });
  assert.deepEqual(
    v.red.map((r) => [r.step, r.money]),
    [['J-a-05#1', true]],
  );
  assert.match(v.red[0].why, /money step is never set aside/);
  // Even a hand-made list naming it changes nothing: the verdict reads the money rule itself.
  const forged = { 'J-a-05#1': { active: true, until: at(30) } };
  assert.equal(run(report(ok('J-a-01 #1'), flaky('J-a-05 #1')), { money: moneyToo, setAside: forged }).red.length, 1);
  assert.equal(run(report(ok('J-a-01 #1'), bad('J-a-05 #1')), { money: moneyToo, setAside: forged }).red.length, 1);
});

test('after the end date: a failure, or a pass only on the retry, is red again', () => {
  const setAside = aside([{ number: 102, at: at(2), states: { 'J-a-01#1': 'flaky' } }], at(2 + SET_ASIDE_DAYS));
  assert.match(run(report(bad('J-a-01 #1')), { setAside }).red[0].why, /failing, not in the baseline/);
  assert.match(run(report(flaky('J-a-01 #1')), { setAside }).red[0].why, /after its set-aside ended/);
});

test('never excused: a set-aside step that is skipped or missing', () => {
  const setAside = aside([{ number: 102, at: at(2), states: { 'J-a-01#1': 'flaky' } }], at(3));
  assert.match(run(report(skip('J-a-01 #1')), { setAside }).red[0].why, /skipped now/);
  assert.match(run(report(bad('J-a-01 #2')), { setAside }).red[0].why, /missing now/);
});
