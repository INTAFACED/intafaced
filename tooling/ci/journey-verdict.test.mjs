// Tests of the journeys verdict (tooling/ci/journey-verdict.mjs): each rule shown both ways, on small reports.
//   node --test tooling/ci/journey-verdict.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SET_ASIDE_DAYS,
  historyRuns,
  readHistory,
  historyThrough,
  findStored,
  storedRuns,
  passedSteps,
  HISTORY_VERSION,
  issueProblem,
  judge,
  moneyRule,
  passesSince,
  priorSetAside,
  readReport,
  regressionState,
  manifestsAt,
  missingArtifact,
  ghDownload,
  refusedDownload,
  setAsideGuard,
  setAsideSteps,
  isAncestor,
  writesSetAside,
  assertFullHistory,
  excusedSetAside,
  runIsOnMain,
} from './journey-verdict.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('a file whose tests each prove part of a step is listed as ran only when every one of them passed', () => {
  const part = (t, status) => spec(t, status, 'J-p-15.pw.mjs');
  const clean = readReport(report(part('J-p-15, part of #1: one half', 'expected'), part('J-p-15, part of #1: the other', 'expected')));
  assert.deepEqual(clean.ran, ['J-p-15.pw.mjs']);
  assert.deepEqual(clean.states, {}, 'a part of a step is no step state');
  const oneFailed = readReport(
    report(part('J-p-15, part of #1: one half', 'expected'), part('J-p-15, part of #1: the other', 'unexpected')),
  );
  assert.deepEqual(oneFailed.ran, [], 'a failing part keeps the file off the list, so the seal fails closed');
  const allSkipped = readReport(report(part('J-p-15 step 12 (part 1)', 'skipped')));
  assert.deepEqual(allSkipped.ran, [], 'a skipped part did not run');
  // A file that also has whole-step tests is listed by them, as before, whatever its partial tests did.
  const mixed = readReport(report(spec('J-p-15 #2 whole', 'unexpected', 'J-p-15.pw.mjs'), part('J-p-15, part of #1', 'unexpected')));
  assert.deepEqual(mixed.ran, ['J-p-15.pw.mjs']);
  assert.equal(mixed.states['J-p-15#2'], 'failed');
  // A spec outside the journey files (the look sweep) is not listed by this.
  assert.deepEqual(readReport(report(spec('every room at each width', 'expected', 'look-sweep.mjs'))).ran, []);
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

// Run 4084 (43127556856, 12 Nov 2026) finished `failure` with a report artifact that had no report.json, after its shard
// merge hit the API rate limit; run 4005 (11 Nov) finished with none after no shard started. Each failed every pull
// request's verdict ("the pass history couldn't be read") until it was re-run or cancelled. A finished run with no report
// is skipped and named; a report that can't be read (a refusal, a rate limit) still fails the read.
test('the pass history skips a finished main run that kept no report, and still fails on one it cannot read', () => {
  const hr = (n) => ({ id: 43127556000 + n, run_number: n });
  const report = (states) => ({ states });
  const reports = { 4083: report({ 'J-a-01#1': 'passed' }), 4085: report({ 'J-a-02#1': 'flaky' }) };
  const got = readHistory([hr(4083), hr(4084), hr(4085)], (r) => reports[r.run_number] ?? null);
  assert.deepEqual(got.skipped, [4084]);
  assert.deepEqual(passesSince(got.reports), { 'J-a-01#1': 4083, 'J-a-02#1': 4085 });
  // What a skip lets through: a step that passed only in the skipped run is not in the pass history.
  const only = readHistory([hr(4084)], () => null);
  assert.deepEqual(passesSince(only.reports), {});
  // Unreadable stays red: a rate-limited or refused download throws, named by run.
  assert.throws(
    () =>
      readHistory([hr(4083), hr(4084)], (r) => {
        if (r.run_number === 4084)
          throw new Error('Command failed: gh run download: error fetching artifacts: HTTP 403: API rate limit exceeded for installation.');
        return reports[r.run_number];
      }),
    /run 4084's report couldn't be read \(Command failed: gh run download: error fetching artifacts: HTTP 403: API rate limit exceeded/,
  );
});

test("fetchInputs reads the history with the optional reader, so only a missing artifact or a missing report.json skips, and the named run's report stays required", () => {
  const src = readFileSync(new URL('./journey-verdict.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function fetchInputs('), src.indexOf('function main()'));
  assert.match(body, /historyThrough\(runs, \{[\s\S]*downloadReport\(repo, r\.id, 'report\.json', true\)/);
  assert.match(body, /named = reportOf\(baseline\.run\.id\);/);
  assert.match(body, /readReport\(raw \?\? downloadReport\(repo, id\)\)/);
});

// The stored pass history: a verdict reads the newest main run's pass-history.json and downloads only what it doesn't
// cover, and gets the same pass history as reading every run (12 Nov 2026: 208 calls and about 10 minutes per verdict).
const STATES = ['passed', 'flaky', 'failed', 'skipped', 'missing'];
const seeded = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const fakeHistory = (n, rnd) =>
  Array.from({ length: n }, (_, i) => {
    const states = {};
    for (let k = 1; k <= 12; k++) states[`J-a-${String(k).padStart(2, '0')}#1`] = STATES[Math.floor(rnd() * STATES.length)];
    return { run: { id: 9000 + i, run_number: 100 + i, run_attempt: 1 }, report: rnd() < 0.1 ? null : { states } };
  });
const entriesOf = (list) =>
  Object.fromEntries(
    list.filter((x) => x.report).map((x) => [String(x.run.id), { number: x.run.run_number, attempt: 1, passed: passedSteps(x.report) }]),
  );

test('the stored pass history gives exactly the pass history of reading every run, and downloads only what it lacks', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rnd = seeded(seed);
    const list = fakeHistory(30, rnd);
    const runs = list.map((x) => x.run);
    const byId = new Map(list.map((x) => [x.run.id, x.report]));
    const full = readHistory(runs, (r) => byId.get(r.id));
    // The file a run part-way along wrote, one run it read at an attempt since re-run, and runs newer than it.
    const cut = 5 + Math.floor(rnd() * 20);
    const stored = { from: runs[cut - 1].run_number, runs: entriesOf(list.slice(0, cut)) };
    const rerun = runs[Math.floor(rnd() * cut)];
    const now = runs.map((r) => (r === rerun ? { ...r, run_attempt: 2 } : r));
    const via = historyThrough(now, { stored, read: (r) => byId.get(r.id) });
    assert.deepEqual(passesSince(via.reports), passesSince(full.reports), `seed ${seed}`);
    assert.deepEqual(via.skipped, full.skipped, `seed ${seed}: a run with no report is skipped either way`);
    const expectRead = now.filter((r, i) => i >= cut || r === now[runs.indexOf(rerun)] || !byId.get(r.id)).map((r) => r.run_number);
    assert.deepEqual(via.read, expectRead, `seed ${seed}: downloads only runs the file doesn't cover`);
    // The next file holds every run with a report, the re-run at its new attempt.
    assert.equal(Object.keys(via.entries).length, list.filter((x) => x.report).length);
    if (byId.get(rerun.id)) assert.equal(via.entries[rerun.id].attempt, 2);
  }
});

test('a stored file is read only when it is whole: newest first, within the lookback, a refusal stays red', () => {
  const runs = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: n, run_number: n }));
  const good = { version: HISTORY_VERSION, runs: { 1: { number: 1, attempt: 1, passed: ['J-a-01#1'] } } };
  assert.equal(storedRuns(good), good.runs);
  for (const bad of [null, {}, { version: 99, runs: {} }, { version: HISTORY_VERSION, runs: { 1: { number: 1, attempt: 1 } } }])
    assert.equal(storedRuns(bad), null, JSON.stringify(bad));
  // Newest first: run 7 has none, run 6 a malformed one, run 5 a good one.
  const files = { 7: null, 6: { version: HISTORY_VERSION, runs: { 1: { passed: 'x' } } }, 5: good };
  assert.deepEqual(
    findStored(runs, (r) => files[r.run_number] ?? null),
    { from: 5, runs: good.runs },
  );
  // Only within the lookback; past it the verdict reads every run, as before.
  assert.equal(
    findStored(runs, (r) => (r.run_number === 1 ? good : null)),
    null,
  );
  // A failed download that isn't a refusal passes the file over; a refusal is thrown on.
  const broken = (r) => {
    if (r.run_number === 7) throw Object.assign(new Error('malformed'), { stderr: 'unexpected end of JSON' });
    return files[r.run_number] ?? null;
  };
  assert.equal(findStored(runs, broken).from, 5);
  const limited = () => {
    throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 403: API rate limit exceeded for installation.' });
  };
  assert.throws(() => findStored(runs, limited), /Command failed/);
});

test("fetchInputs finds the stored history among main's own history runs and writes only on main from a whole read", () => {
  const src = readFileSync(new URL('./journey-verdict.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function fetchInputs('), src.indexOf('function main()'));
  assert.match(body, /readStored = \(r\) => downloadReport\(repo, r\.id, HISTORY_FILE, true, \{ artifact: HISTORY_ARTIFACT \}\)/);
  assert.match(body, /const stored = findStored\(runs, readStored\);/);
  assert.match(body, /historyThrough\(runs, \{\s*stored,/);
  const main = src.slice(src.indexOf('function main()'));
  assert.match(main, /if \(arg\('--history-out'\) && onMain && entries\)/);
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
  // A step whose journey names no owner is never set aside, and a prior entry that lost its owner is dropped.
  const noOwner = setAsideSteps({ states: { 'J-a-01#1': 'flaky' }, money: moneyToo, owners: {}, run: { number: 102, at: at(2) } });
  assert.deepEqual(noOwner, {});
  assert.deepEqual(setAsideSteps({ prior: first, money: moneyToo, owners: {}, run: { number: 103, at: at(3) } }), {});
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
    { steps: [], from: null, previous: false, unreadable: true },
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

test('OWNER 278: on main, a money step that failed, then passed on its retry, stays red, marked for the seal, with its flaky issue', () => {
  const v = run(report(ok('J-a-01 #1'), flaky('J-a-05 #1')), { money: moneyToo, onMain: true });
  assert.deepEqual(
    v.red.map((r) => [r.step, r.money, r.retryFlaky]),
    [['J-a-05#1', true, true]],
    'red on main, marked as a retry pass',
  );
  assert.match(v.red[0].why, /failed, then passed on its retry, and a money step is never set aside/);
  assert.deepEqual(v.moneyFlaky, ['J-a-05#1'], 'listed for its flaky issue, never proven');
  assert.deepEqual(v.setAside, [], 'never set aside');
  assert.equal(
    v.red[0].why,
    run(report(ok('J-a-01 #1'), flaky('J-a-05 #1')), { money: moneyToo }).red[0].why,
    'the same verdict line off main',
  );
  // The planted break: the same money step failing outright on main is red.
  const broke = run(report(ok('J-a-01 #1'), bad('J-a-05 #1')), { money: moneyToo, onMain: true });
  assert.deepEqual(
    broke.red.map((r) => [r.step, r.money]),
    [['J-a-05#1', true]],
  );
  assert.deepEqual(broke.moneyFlaky, []);
  assert.equal(broke.red[0].retryFlaky, undefined, 'failing outright is not marked as a retry pass');
  // A baseline entry that breaks its rules is still red, flaky or not.
  const listed = { ...baseline, notBaselined: [{ step: 'J-a-05#1' }] };
  const notBase = run(report(ok('J-a-01 #1'), flaky('J-a-05 #1')), { money: moneyToo, onMain: true, baseline: listed });
  assert.deepEqual(
    notBase.red.map((r) => r.step),
    ['J-a-05#1'],
  );
  // It is not OWNER 278's retry pass: not marked for the seal, so the seal never passes it over, and no flaky issue.
  assert.equal(notBase.red[0].retryFlaky, undefined, 'a notBaselined money step that passed on its retry is not marked retryFlaky');
  assert.deepEqual(notBase.moneyFlaky, [], 'a notBaselined money step goes to no flaky issue');
  // The same for a money step the baseline lists: red, never marked for the seal, no flaky issue.
  const inBase = { ...baseline, steps: [...baseline.steps, { step: 'J-a-05#1', state: 'regression', money: true, issue: 9 }] };
  const based = run(report(ok('J-a-01 #1'), flaky('J-a-05 #1')), { money: moneyToo, onMain: true, baseline: inBase });
  assert.deepEqual(
    based.red.map((r) => r.step),
    ['J-a-05#1'],
    'a money step the baseline lists as a regression is red',
  );
  assert.equal(based.red[0].retryFlaky, undefined, 'a baselined money step that passed on its retry is not marked retryFlaky');
  assert.deepEqual(based.moneyFlaky, [], 'a baselined money step goes to no flaky issue');
  // A non-money flaky step with no set-aside is red, as before: OWNER 278 is about money steps only.
  assert.deepEqual(
    run(report(flaky('J-a-01 #1')), { onMain: true }).red.map((r) => r.step),
    ['J-a-01#1'],
  );
});

test('never set aside: off main, a money step that failed, then passed on its retry, is red', () => {
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

// The first outside review of 7f61f4d (#7363): both cases reproduced there and here before the fix.
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
  assert.deepEqual(priorSetAside(runs, list('refs/tags/main')), { steps: [], from: null, previous: false, unreadable: true });
  assert.deepEqual(priorSetAside(runs, list(undefined)), { steps: [], from: null, previous: false, unreadable: true });
});

test('p2p is a money journey: its escrow and settlement steps are never set aside', () => {
  for (const step of ['J-p2p-15#6', 'J-p2p-19#1', 'J-p2p-19#3', 'J-p2p-19#4']) assert.equal(realGuard[step], true, step);
  assert.deepEqual(
    Object.keys(realGuard).filter((k) => k.startsWith('J-p2p-') && !realGuard[k]),
    [],
  );
  const one = setAsideGuard({
    journeys: [{ id: 'J-p2p-40', steps: [{ n: 1, slices: ['UI'] }] }],
    slices: [{ id: 'UI', touches: ['customer: p2p'] }],
    money: { 'J-p2p-40#1': false },
  });
  assert.equal(one['J-p2p-40#1'], true);
});

test('a set-aside list that cannot be downloaded is unreadable (red), not "no list" (CI review on #7363, c9fcdb2)', () => {
  // gh run download's own words when the run has no such artifact: then an older run's list may carry on.
  assert.equal(missingArtifact(Buffer.from('no valid artifacts found to download\n')), true);
  assert.equal(missingArtifact('no artifact matches any of the names or patterns provided'), true);
  // Anything else is a failed read, and must not lengthen the set-aside by falling back to an older list.
  assert.equal(missingArtifact(Buffer.from('HTTP 403: API rate limit exceeded for user ID 1\n')), false);
  assert.equal(missingArtifact('HTTP 502: Bad Gateway'), false);
  assert.equal(missingArtifact(''), false);
  assert.equal(missingArtifact(undefined), false);
});

test('downloadReport gives null only for a missing artifact, so a refused download of the list stays red', () => {
  const src = readFileSync(fileURLToPath(new URL('./journey-verdict.mjs', import.meta.url)), 'utf8');
  const body = src.slice(src.indexOf('function downloadReport('), src.indexOf('export function manifestsAt('));
  assert.match(body, /if \(optional && missingArtifact\(e\.stderr\)\) return null;/);
  assert.doesNotMatch(body, /if \(optional\) return null;\n\s*throw e;/);
});

/** A stand-in for execFileSync that fails with each given stderr in turn, then succeeds. */
function flakyGh(...stderrs) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args);
    const said = stderrs[calls.length - 1];
    if (said === undefined) return Buffer.from('');
    throw Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}`), { stderr: Buffer.from(said) });
  };
  return { run, calls };
}

test('a report download that drops its connection is tried again, so one flaky read of the pass history is not a red verdict', () => {
  const waits = [];
  const { run, calls } = flakyGh('error downloading artifact: read: connection reset by peer\n', 'HTTP 502: Bad Gateway\n');
  ghDownload(['run', 'download', '1'], { run, wait: (ms) => waits.push(ms) });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [5_000, 15_000]);
});

test("a download that keeps failing still throws after its tries, and names gh's own error", () => {
  const { run, calls } = flakyGh('x\n', 'y\n', 'error downloading artifact: unexpected EOF\n');
  assert.throws(
    () => ghDownload(['run', 'download', '1'], { run, wait: () => {} }),
    (e) => /^Command failed: gh run download 1: error downloading artifact: unexpected EOF \(attempt 3 of 3\)/.test(e.message),
  );
  assert.equal(calls.length, 3);
});

test('a refused download (403, 429, a rate limit) or a missing artifact is never retried', () => {
  assert.equal(refusedDownload('HTTP 403: API rate limit exceeded for user ID 1'), true);
  assert.equal(refusedDownload('HTTP 429: Too Many Requests'), true);
  assert.equal(refusedDownload('HTTP 502: Bad Gateway'), false);
  for (const said of [
    'HTTP 403: Resource not accessible by integration\n',
    'HTTP 429: Too Many Requests\n',
    'no valid artifacts found to download\n',
  ]) {
    const { run, calls } = flakyGh(said, said, said);
    let waited = 0;
    assert.throws(() => ghDownload(['run', 'download', '1'], { run, wait: () => waited++ }), /attempt 1 of 3/);
    assert.equal(calls.length, 1, said);
    assert.equal(waited, 0, said);
  }
});

// ── CI review on #7363, 7a3b0af: the set-aside only on main, and a fresh list only when main never had one ──

const freeStep = Object.keys(realGuard).find((k) => realGuard[k] === false);
/** The verdict CLI offline on one failing step `freeStep`, with a prior list that has it set aside and passing before. */
function cli({ ref, target, priorIncomplete = false, state = 'unexpected' }) {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-test-'));
  const [id, n] = freeStep.split('#');
  const f = (name, body) => (writeFileSync(join(dir, name), JSON.stringify(body)), join(dir, name));
  const newest = {
    suites: [
      {
        file: `${id}.pw.mjs`,
        specs: [state === 'flaky' ? flaky(`${id} #${n}`, `${id}.pw.mjs`) : spec(`${id} #${n}`, state, `${id}.pw.mjs`)],
      },
    ],
  };
  mkdirSync(join(dir, 'history'));
  const args = [
    'tooling/ci/journey-verdict.mjs',
    ...['--report', f('report.json', newest), '--named-report', f('named.json', { suites: [] })],
    ...['--baseline', f('baseline.json', { run: { number: 1, id: 1 }, steps: [] }), '--history-dir', join(dir, 'history')],
    ...['--issues-file', f('issues.json', {}), '--now', at(3), '--run-number', '103'],
    '--prior-set-aside',
    f('prior.json', {
      ref: 'refs/heads/main',
      ...(priorIncomplete ? { incomplete: true } : {}),
      steps: [{ step: freeStep, since: 102, sinceAt: at(2), state: 'passed' }],
    }),
    ...(target ? ['--target', target] : []),
  ];
  const env = { ...process.env, GITHUB_STEP_SUMMARY: '' };
  delete env.GITHUB_REF;
  delete env.JOURNEYS_TARGET;
  if (ref) env.GITHUB_REF = ref;
  return spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8' }).status;
}

test('off main the set-aside excuses nothing: a branch, targeted or offline run with a carried active entry is red when the step fails', () => {
  assert.ok(freeStep, 'a real step the guard allows to be set aside');
  // Only CI's own full run on main reading main's runs counts as on main.
  assert.equal(runIsOnMain({ target: null, fetch: true, ref: 'refs/heads/main' }), true, 'the control');
  assert.equal(runIsOnMain({ target: null, fetch: true, ref: 'refs/heads/feature' }), false, 'a branch run');
  assert.equal(runIsOnMain({ target: null, fetch: true, ref: 'refs/pull/7363/merge' }), false, 'a pull request run');
  assert.equal(runIsOnMain({ target: new Set(['J-a-01.pw.mjs']), fetch: true, ref: 'refs/heads/main' }), false, 'a targeted run');
  assert.equal(runIsOnMain({ target: null, fetch: false, ref: 'refs/heads/main' }), false, 'an offline run, GITHUB_REF or not');
  assert.equal(runIsOnMain({ target: null, fetch: true, ref: undefined }), false, 'no GITHUB_REF');
  assert.equal(
    runIsOnMain({ target: null, fetch: true, ref: 'refs/heads/main', priorFile: true }),
    false,
    'a given --prior-set-aside file, even with --fetch on main (review R1)',
  );
  // The CLI offline: a given prior file excuses nothing, whatever GITHUB_REF says.
  for (const ref of ['refs/heads/main', 'refs/heads/feature', 'refs/pull/7363/merge', undefined])
    assert.equal(cli({ ref }), 1, `offline, ${ref ?? 'no ref'}`);
  assert.equal(cli({ ref: 'refs/heads/main', target: `${freeStep.split('#')[0]}.pw.mjs` }), 1, 'a targeted run');
  assert.deepEqual(excusedSetAside({ setAside: { a: 1 }, onMain: false, incomplete: false }), {});
  assert.deepEqual(excusedSetAside({ setAside: { a: 1 }, onMain: true, incomplete: false }), { a: 1 });
});

test('no complete earlier list: fail closed, never fresh; fresh only when main never had a list', () => {
  const runs = [1, 2, 3].map((n) => ({ id: n, run_number: n }));
  const incomplete = () => ({ ref: 'refs/heads/main', incomplete: true, steps: [] });
  // Every list in the window incomplete or missing, on commits that write lists: unreadable, not fresh.
  assert.equal(priorSetAside(runs, incomplete).unreadable, true);
  assert.equal(
    priorSetAside(
      runs,
      () => null,
      () => false,
    ).unreadable,
    true,
  );
  const many = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, run_number: i + 1 }));
  assert.equal(
    priorSetAside(many, (id) => (id === 1 ? { ref: 'refs/heads/main', steps: [] } : null)).unreadable,
    true,
    'past the lookback',
  );
  // A run from before the set-aside reached first: main never had a list, so it starts fresh.
  assert.deepEqual(
    priorSetAside(
      runs,
      () => null,
      (r) => r.id <= 2,
    ),
    { steps: [], from: null, previous: false, fresh: true },
  );
  assert.equal(priorSetAside([], () => null).fresh, true);
  // An incomplete list from a run that predates nothing stays unreadable, even if `predates` would say yes.
  assert.equal(priorSetAside(runs, incomplete, () => true).unreadable, true);
  // A step in cool-down keeps it: no fresh 7 days. The CLI with no complete list excuses nothing, even a flaky step.
  assert.equal(excusedSetAside({ setAside: { a: 1 }, onMain: true, incomplete: true }).a, undefined);
  assert.equal(cli({ ref: 'refs/heads/main', state: 'flaky', priorIncomplete: true }), 1, 'no complete list: the flaky step is red');
  assert.equal(cli({ ref: 'refs/heads/main', priorIncomplete: true }), 1, 'no complete list: the failure is red');
});

test('isAncestor and writesSetAside throw on a git error, and say no only on git exit 1', () => {
  const sha = 'a'.repeat(40);
  const exitWith = (status) => () => {
    throw Object.assign(new Error('git'), { status });
  };
  assert.equal(
    isAncestor(sha, () => ''),
    true,
  );
  assert.equal(isAncestor(sha, exitWith(1)), false);
  assert.throws(() => isAncestor(sha, exitWith(128)), /git merge-base failed \(128\)/);
  assert.throws(
    () =>
      isAncestor(sha, () => {
        throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
      }),
    /ENOENT/,
  );
  assert.throws(() => isAncestor('main', () => ''), /not a commit/);
  assert.equal(writesSetAside(sha, exitWith(1)), false);
  assert.throws(() => writesSetAside(sha, exitWith(128)), /failed/);
  // Against this checkout: HEAD is its own ancestor, and HEAD's workflow writes the list.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(isAncestor(head), true);
  assert.equal(writesSetAside(head), true);
  assert.throws(() => isAncestor('0'.repeat(40)), /failed/, 'a commit this clone lacks (a shallow clone) is an error');
});

test('the verdict job has full history, and a shallow clone fails', () => {
  assert.throws(() => assertFullHistory(() => 'true\n'), /shallow/);
  assert.throws(() => assertFullHistory(() => ''), /shallow/);
  assert.doesNotThrow(() => assertFullHistory(() => 'false\n'));
  const wf = readFileSync(join(ROOT, '.github/workflows/real-app-journeys.yml'), 'utf8');
  const job = wf.slice(wf.indexOf('\n  scoreboard:\n'));
  assert.ok(job.includes('journey-verdict.mjs --report'), 'the verdict runs in the scoreboard job');
  const checkout = job.slice(job.indexOf('actions/checkout@'), job.indexOf('\n      - uses:', job.indexOf('actions/checkout@')));
  assert.match(checkout, /fetch-depth: 0\b/);
  const src = readFileSync(join(ROOT, 'tooling/ci/journey-verdict.mjs'), 'utf8');
  assert.match(
    src.slice(src.indexOf('} else if (fetch) {\n      assertFullHistory')),
    /^\} else if \(fetch\) \{\n      assertFullHistory\(\);/,
  );
});

test('the pass history counts a pass only on the retry: an unbuilt step that passed that way is red when it fails (CI review on #7363, 1fbf031)', () => {
  const passedSince = passesSince([[101, readReport(report(flaky('J-a-01 #2')))]]);
  assert.equal(passedSince['J-a-01#2'], 101, 'a pass on the retry means the step was built');
  const v = run(report(ok('J-a-01 #1'), bad('J-a-01 #2')), { passedSince });
  assert.match(v.red.map((r) => r.why).join('\n'), /called unbuilt, but passed on main in run 101/);
  assert.deepEqual(run(report(ok('J-a-01 #1'), bad('J-a-01 #2'))).red, [], 'without that pass, the unbuilt entry holds (the control)');
});

test('a step id two files share: the run lists both files, and a targeted run of one of them still judges the step', () => {
  // judge's inScope reads the step-to-file map, which keeps one file a step. It only decides a step the newest run has no
  // state for, and a run that ran either file has that step's state, so a shared id is never judged missing by it.
  const spec = (title, status, file) => ({ title, file, tests: [{ status }] });
  const rep = (...specs) => readReport({ suites: [{ specs }] });
  const named2 = rep(
    spec("J-w-04 #7 (the bank's half)", 'expected', 'J-w-04.pw.mjs'),
    spec("J-w-04 #7 (identity's half)", 'expected', 'J-w-04-lock.pw.mjs'),
  );
  assert.deepEqual(named2.ran, ['J-w-04-lock.pw.mjs', 'J-w-04.pw.mjs']);
  assert.equal(named2.files['J-w-04#7'], 'J-w-04.pw.mjs', 'the map keeps the first file only');
  const onlyLock = rep(spec("J-w-04 #7 (identity's half)", 'expected', 'J-w-04-lock.pw.mjs'));
  const v = judge({
    newest: onlyLock,
    named: named2,
    baseline: { run: { number: 1 }, steps: [] },
    money: { 'J-w-04#7': false },
    target: new Set(onlyLock.ran),
  });
  assert.deepEqual([v.red, v.failing], [[], 0], 'run in the other file, the step passed and nothing is missing');
  const lockFails = rep(spec("J-w-04 #7 (identity's half)", 'unexpected', 'J-w-04-lock.pw.mjs'));
  const red = judge({
    newest: lockFails,
    named: named2,
    baseline: { run: { number: 1 }, steps: [] },
    money: { 'J-w-04#7': false },
    target: new Set(lockFails.ran),
  });
  assert.deepEqual(
    red.red.map((r) => r.step),
    ['J-w-04#7'],
    'and a failure there is red',
  );
});
