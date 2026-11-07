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
  priorSetAside,
  readReport,
  regressionState,
  manifestsAt,
  setAsideGuard,
  setAsideSteps,
} from './journey-verdict.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const spec = (title, status, file = 'J-a-01.pw.mjs') => ({ title, file, tests: [{ status }] });
const report = (...specs) => ({ suites: [{ file: 'J-a-01.pw.mjs', specs }] });
const ok = (t, f) => spec(t, 'expected', f);
const bad = (t, f) => spec(t, 'unexpected', f);
const skip = (t, f) => spec(t, 'skipped', f);
const flaky = (t, f) => ({
  title: t,
  file: f ?? 'J-a-01.pw.mjs',
  tests: [{ status: 'flaky', results: [{ status: 'failed' }, { status: 'passed' }] }],
});
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
// SET_ASIDE_DAYS, never a money step.
const at = (day) => `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const moneyToo = { ...money, 'J-a-05#1': true };
const owners = { 'J-a-01': 'alpha' };
const aside = (states, day, prior = []) =>
  setAsideSteps({ prior, states, money: moneyToo, owners, run: { number: 100 + day, at: at(day) } });
const rows = (list, states = {}) =>
  Object.entries(list).map(([step, { before, ...e }]) => ({ step, state: states[step] ?? 'passed', ...e }));

test('a flaky test reads as "flaky", and a failing duplicate still wins', () => {
  assert.equal(readReport(report(flaky('J-a-01 #1'))).states['J-a-01#1'], 'flaky');
  assert.equal(readReport(report(ok('J-a-01 #1 a'), flaky('J-a-01 #1 b'))).states['J-a-01#1'], 'flaky');
  assert.equal(readReport(report(flaky('J-a-01 #1 a'), bad('J-a-01 #1 b'))).states['J-a-01#1'], 'failed');
  assert.deepEqual(passesSince([[101, readReport(report(flaky('J-a-01 #2')))]]), { 'J-a-01#2': 101 });
});

test('the set-aside list: a non-money flaky step gets one, never a money step or a step missing from journeys.json', () => {
  const list = aside({ 'J-a-01#1': 'flaky', 'J-a-05#1': 'flaky', 'J-a-06#1': 'flaky', 'J-a-01#2': 'failed' }, 2);
  assert.deepEqual(Object.keys(list), ['J-a-01#1']);
  assert.deepEqual(list['J-a-01#1'], {
    since: 102,
    sinceAt: at(2),
    until: new Date(Date.parse(at(2)) + SET_ASIDE_DAYS * 864e5).toISOString(),
    active: true,
    owner: 'the alpha area',
  });
});

test('the set-aside list carries on from run to run, ends on time, and is not renewed until a second window passes', () => {
  const first = rows(aside({ 'J-a-01#1': 'flaky' }, 2), { 'J-a-01#1': 'flaky' });
  const later = aside({ 'J-a-01#1': 'flaky' }, 5, first); // flaky again: the end date still counts from day 2
  assert.equal(later['J-a-01#1'].since, 102);
  assert.equal(later['J-a-01#1'].before, 'flaky');
  const ended = aside({ 'J-a-01#1': 'flaky' }, 2 + SET_ASIDE_DAYS, first);
  assert.equal(ended['J-a-01#1'].active, false);
  assert.equal(ended['J-a-01#1'].since, 102, 'no new set-aside while the first one is in its second window');
  const fresh = aside({ 'J-a-01#1': 'flaky' }, 2 + 2 * SET_ASIDE_DAYS, rows(ended));
  assert.deepEqual([fresh['J-a-01#1'].since, fresh['J-a-01#1'].active], [102 + 2 * SET_ASIDE_DAYS, true]);
  // A prior entry the money rule now calls money is dropped.
  assert.deepEqual(aside({}, 3, [{ step: 'J-a-05#1', since: 1, sinceAt: at(1), until: at(8) }]), {});
});

test('the last complete list on main carries on; an incomplete one is passed over', () => {
  const runs = [1, 2, 3].map((n) => ({ id: n, run_number: n }));
  const lists = {
    3: { ref: 'refs/heads/main', incomplete: true, steps: [] },
    2: { ref: 'refs/heads/main', steps: [{ step: 'J-a-01#1' }] },
    1: { ref: 'refs/heads/main', steps: [] },
  };
  assert.deepEqual(
    priorSetAside(runs, (id) => lists[id] ?? null),
    { steps: [{ step: 'J-a-01#1' }], from: 2, previous: false },
  );
  assert.deepEqual(
    priorSetAside(runs, () => null),
    { steps: [], from: null, previous: false },
  );
  assert.equal(
    priorSetAside(runs, (id) => (id === 3 ? { ref: 'refs/heads/main', steps: [] } : null)).previous,
    true,
    'the run just before is complete',
  );
});

test('set aside: a non-money step on the list that fails leaves the verdict green, and is reported', () => {
  const setAside = aside({}, 3, rows(aside({ 'J-a-01#1': 'flaky' }, 2), { 'J-a-01#1': 'flaky' }));
  const v = run(report(bad('J-a-01 #1'), bad('J-a-01 #2')), { setAside });
  assert.deepEqual(v.red, []);
  assert.deepEqual(v.setAside, ['J-a-01#1']);
  // The same failure with no set-aside is red (the planted break, unchanged).
  assert.match(run(report(bad('J-a-01 #1'), bad('J-a-01 #2'))).red[0].why, /failing, not in the baseline/);
});

test('set aside: a flaky non-money step in this run is green while its set-aside lasts', () => {
  const setAside = aside({ 'J-a-01#1': 'flaky' }, 3);
  assert.deepEqual(run(report(flaky('J-a-01 #1'), bad('J-a-01 #2')), { setAside }).red, []);
});

test('broken, not flaky: a set-aside step that fails outright in two runs in a row is red', () => {
  const setAside = aside({}, 4, rows(aside({ 'J-a-01#1': 'flaky' }, 2), { 'J-a-01#1': 'failed' }));
  assert.match(run(report(bad('J-a-01 #1'), bad('J-a-01 #2')), { setAside }).red[0].why, /failing, not in the baseline/);
});

test('never set aside: a money step that failed, then passed on its retry, is red', () => {
  const v = run(report(ok('J-a-01 #1'), flaky('J-a-05 #1')), { money: moneyToo, setAside: aside({ 'J-a-05#1': 'flaky' }, 3) });
  assert.deepEqual(
    v.red.map((r) => [r.step, r.money]),
    [['J-a-05#1', true]],
  );
  assert.match(v.red[0].why, /money step is never set aside: failing, not in the baseline/);
  // Even a hand-made list naming it changes nothing: the verdict reads the money rule itself.
  const forged = { 'J-a-05#1': { active: true, until: at(30) } };
  assert.equal(run(report(ok('J-a-01 #1'), flaky('J-a-05 #1')), { money: moneyToo, setAside: forged }).red.length, 1);
  assert.equal(run(report(ok('J-a-01 #1'), bad('J-a-05 #1')), { money: moneyToo, setAside: forged }).red.length, 1);
});

test('a pass only on the retry is judged as a failure: excused only where a failure would be', () => {
  // J-a-01#2 is unbuilt in the baseline, so failing is excused; passing only on its retry is excused the same way.
  assert.deepEqual(run(report(ok('J-a-01 #1'), flaky('J-a-01 #2')), { money: { ...money, 'J-a-01#2': false } }).red, []);
});

test('after the end date: a failure, or a pass only on the retry, is red again', () => {
  const setAside = aside({}, 2 + SET_ASIDE_DAYS, rows(aside({ 'J-a-01#1': 'flaky' }, 2)));
  assert.match(run(report(bad('J-a-01 #1')), { setAside }).red[0].why, /failing, not in the baseline/);
  assert.match(run(report(flaky('J-a-01 #1')), { setAside }).red[0].why, /not set aside now: failing, not in the baseline/);
});

test('never excused: a set-aside step that is skipped or missing', () => {
  const setAside = aside({ 'J-a-01#1': 'flaky' }, 3);
  assert.match(run(report(skip('J-a-01 #1')), { setAside }).red[0].why, /skipped now/);
  assert.match(run(report(bad('J-a-01 #2')), { setAside }).red[0].why, /missing now/);
});

// GPT-6.1 Sol's review of 7f61f4d (#7363), both reproduced there and here before the fix.
const retried = (title, ...results) => ({
  title,
  file: 'J-a-01.pw.mjs',
  tests: [{ status: 'flaky', results: results.map((status) => ({ status })) }],
});

test('a failed test whose retry was skipped is a failure, not flaky: it gets no set-aside and is red', () => {
  const newest = readReport(report(retried('J-a-01 #1', 'failed', 'skipped')));
  assert.equal(newest.states['J-a-01#1'], 'failed');
  assert.deepEqual(aside(newest.states, 3), {});
  assert.match(run(report(retried('J-a-01 #1', 'failed', 'skipped'))).red[0].why, /failing, not in the baseline/);
  // A real flake still reads as flaky: a failed attempt, then a passed one.
  assert.equal(readReport(report(retried('J-a-01 #1', 'failed', 'passed'))).states['J-a-01#1'], 'flaky');
  assert.equal(readReport(report(retried('J-a-01 #1', 'timedOut', 'passed'))).states['J-a-01#1'], 'flaky');
  assert.equal(readReport(report(retried('J-a-01 #1', 'passed', 'failed'))).states['J-a-01#1'], 'failed');
});

test('two failures in a row stay red when the run between them kept an incomplete list', () => {
  // Run 102: flaky, a complete list. Run 103: failed outright, its list incomplete. Run 104: failed outright.
  const l102 = { ref: 'refs/heads/main', steps: rows(aside({ 'J-a-01#1': 'flaky' }, 2), { 'J-a-01#1': 'flaky' }) };
  const l103 = { ref: 'refs/heads/main', incomplete: true, steps: rows(aside({}, 3, l102.steps), { 'J-a-01#1': 'failed' }) };
  const lists = { 102: l102, 103: l103 };
  const found = priorSetAside(
    [
      { id: 102, run_number: 102 },
      { id: 103, run_number: 103 },
    ],
    (id) => lists[id] ?? null,
  );
  assert.equal(found.from, 102);
  assert.equal(found.previous, false, 'run 102 is not the run just before 104');
  const setAside = setAsideSteps({
    prior: found.steps,
    priorIsPrevious: found.previous,
    money: moneyToo,
    owners,
    run: { number: 104, at: at(4) },
  });
  assert.equal(setAside['J-a-01#1'].since, 102, 'the end date still counts from run 102');
  assert.match(run(report(bad('J-a-01 #1'), bad('J-a-01 #2')), { setAside }).red[0].why, /failing, not in the baseline/);
});

test('fail closed: a set-aside step excuses a failure only when the run just before showed it passing', () => {
  const prior = rows(aside({ 'J-a-01#1': 'flaky' }, 2), { 'J-a-01#1': 'missing' });
  const setAside = setAsideSteps({ prior, money: moneyToo, owners, run: { number: 103, at: at(3) } });
  assert.match(run(report(bad('J-a-01 #1'), bad('J-a-01 #2')), { setAside }).red[0].why, /failing, not in the baseline/);
});

// The fresh Opus review of 7f61f4d (#7363): a money check must never be set aside, even where the baseline's money rule
// says non-money (a slice that touches nothing, no slices, a wallet, bank or pay journey).
test('the set-aside guard: money by the rule, a wallet, bank or pay journey, J-ops-console-27, no slices, or a slice that touches nothing', () => {
  const journeys = [
    { id: 'J-wallet-01', steps: [{ n: 1, slices: ['UI'] }] },
    { id: 'J-pay-01', steps: [{ n: 1, slices: ['UI'] }] },
    { id: 'J-bank-02', steps: [{ n: 1, slices: ['UI'] }] },
    { id: 'J-ops-console-27', steps: [{ n: 1, slices: ['UI'] }] },
    {
      id: 'J-a-07',
      steps: [
        { n: 1, slices: [] },
        { n: 2, slices: ['EMPTY'] },
        { n: 3, slices: ['UI'] },
        { n: 4, slices: ['UI', 'EMPTY'] },
        { n: 5, slices: ['UI'] },
      ],
    },
  ];
  const slices = [
    { id: 'UI', touches: ['customer: charts'] },
    { id: 'EMPTY', touches: [] },
  ];
  const rule = Object.fromEntries(journeys.flatMap((j) => j.steps.map((st) => [`${j.id}#${st.n}`, false])));
  rule['J-a-07#5'] = true;
  assert.deepEqual(setAsideGuard({ journeys, slices, money: rule }), {
    'J-wallet-01#1': true,
    'J-pay-01#1': true,
    'J-bank-02#1': true,
    'J-ops-console-27#1': true,
    'J-a-07#1': true,
    'J-a-07#2': true,
    'J-a-07#3': false,
    'J-a-07#4': true,
    'J-a-07#5': true,
  });
});

test('never set aside: a wallet step the baseline rule calls non-money is red when flaky, and gets no set-aside', () => {
  const guard = { ...money, 'J-wallet-01#1': true };
  const states = readReport(report(flaky('J-wallet-01 #1'))).states;
  assert.deepEqual(setAsideSteps({ states, money: guard, run: { number: 103, at: at(3) } }), {});
  const v = judge({
    newest: readReport(report(ok('J-a-01 #1'), flaky('J-wallet-01 #1'))),
    named,
    baseline,
    money: { ...money, 'J-wallet-01#1': false },
    guard,
    setAside: { 'J-wallet-01#1': { active: true, before: 'passed', until: at(30) } },
  });
  assert.deepEqual(
    v.red.map((r) => r.step),
    ['J-wallet-01#1'],
  );
  assert.match(v.red[0].why, /money step is never set aside/);
});

test("a carried list's end date is re-derived from its start, never taken as written", () => {
  const forged = [{ step: 'J-a-01#1', since: 102, sinceAt: at(2), until: at(28), state: 'passed' }];
  const list = aside({}, 2 + SET_ASIDE_DAYS, forged);
  assert.equal(list['J-a-01#1'].until, new Date(Date.parse(at(2)) + SET_ASIDE_DAYS * 864e5).toISOString());
  assert.equal(list['J-a-01#1'].active, false);
  // A start in the future, or none, carries nothing.
  assert.deepEqual(aside({}, 3, [{ step: 'J-a-01#1', since: 1, sinceAt: at(20), until: at(27), state: 'passed' }]), {});
  assert.deepEqual(aside({}, 3, [{ step: 'J-a-01#1', since: 1, until: at(9), state: 'passed' }]), {});
});

// The OG's round 2 (the fresh Opus review's blocker): money fails closed, on the repo's own journeys.json and slices.json.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const repoJson = (f) => JSON.parse(readFileSync(`${ROOT}${f}`, 'utf8'));
const realJourneys = repoJson('docs/roadmap/journeys.json');
const realSlices = repoJson('docs/roadmap/slices.json');
const realMoney = moneyRule({ journeys: realJourneys, slices: realSlices, manifests: manifestsAt(ROOT) });
const realGuard = setAsideGuard({ journeys: realJourneys, slices: realSlices, money: realMoney });

test("the reviewer's case: J-wallet-01 #1 and J-pay-01 #1, non-money by the slice rule, are never set aside and are red when flaky", () => {
  for (const step of ['J-wallet-01#1', 'J-pay-01#1']) {
    assert.equal(realMoney[step], false, `${step}: the slice rule alone calls it non-money (the hole)`);
    assert.equal(realGuard[step], true, `${step}: the set-aside guard calls it money`);
  }
  const states = { 'J-wallet-01#1': 'flaky', 'J-pay-01#1': 'flaky' };
  assert.deepEqual(setAsideSteps({ states, money: realGuard, run: { number: 103, at: at(3) } }), {});
  const newest = readReport(report(flaky('J-wallet-01 #1'), flaky('J-pay-01 #1')));
  const v = judge({
    newest,
    named: readReport(report()),
    baseline: { run: { number: 100 }, steps: [] },
    money: realMoney,
    guard: realGuard,
    setAside: {},
  });
  assert.deepEqual(v.red.map((r) => r.step).sort(), ['J-pay-01#1', 'J-wallet-01#1']);
  assert.ok(v.red.every((r) => /money step is never set aside/.test(r.why)));
});

test("money by the proof count's definition: every wallet, bank and pay step and J-ops-console-27 is guarded, whatever its slices", () => {
  const named = Object.keys(realGuard).filter((k) => /^J-(wallet|bank|pay)-\d+#/.test(k) || k.startsWith('J-ops-console-27#'));
  assert.ok(named.length > 100, `found ${named.length}`);
  assert.deepEqual(
    named.filter((k) => !realGuard[k]),
    [],
  );
  const one = (id) =>
    setAsideGuard({
      journeys: [{ id, steps: [{ n: 1, slices: ['UI'] }] }],
      slices: [{ id: 'UI', touches: ['customer: charts'] }],
      money: { [`${id}#1`]: false },
    })[`${id}#1`];
  assert.deepEqual(['J-wallet-09', 'J-bank-03', 'J-pay-04', 'J-ops-console-27', 'J-charts-01'].map(one), [true, true, true, true, false]);
});

test('missing or empty slices count as money: no slices key, an empty list, a slice that touches nothing, an unknown slice', () => {
  const journeys = [
    {
      id: 'J-a-08',
      steps: [{ n: 1 }, { n: 2, slices: [] }, { n: 3, slices: ['EMPTY'] }, { n: 4, slices: ['GONE'] }, { n: 5, slices: ['UI'] }],
    },
  ];
  const slices = [
    { id: 'UI', touches: ['customer: charts'] },
    { id: 'EMPTY', touches: [] },
  ];
  const money = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`J-a-08#${n}`, false]));
  const g = setAsideGuard({ journeys, slices, money });
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((n) => g[`J-a-08#${n}`]),
    [true, true, true, true, false],
  );
  const fromRepo = Object.keys(realGuard).filter((k) => {
    const [id, n] = k.split('#');
    const st = realJourneys.find((j) => j.id === id).steps.find((x) => String(x.n) === n);
    return !(st.slices?.length > 0);
  });
  assert.deepEqual(
    fromRepo.filter((k) => !realGuard[k]),
    [],
    'every step in journeys.json with no slices is guarded',
  );
});

test('the list is taken only from a run on refs/heads/main: a tag named main, or a list with no ref, feeds nothing', () => {
  const runs = [{ id: 1, run_number: 1 }];
  const list = (ref) => () => ({ ref, steps: [{ step: 'J-a-01#1' }] });
  assert.equal(priorSetAside(runs, list('refs/heads/main')).from, 1);
  assert.deepEqual(priorSetAside(runs, list('refs/tags/main')), { steps: [], from: null, previous: false });
  assert.deepEqual(priorSetAside(runs, list(undefined)), { steps: [], from: null, previous: false });
});
