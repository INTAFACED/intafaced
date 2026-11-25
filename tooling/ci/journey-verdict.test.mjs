// Tests of the journeys verdict (tooling/ci/journey-verdict.mjs): each rule shown both ways, on small reports.
//   node --test tooling/ci/journey-verdict.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SET_ASIDE_DAYS,
  historyRuns,
  readHistory,
  historyThrough,
  toDownload,
  HISTORY_MAX,
  findStored,
  storedRuns,
  passedSteps,
  HISTORY_VERSION,
  issueProblem,
  judge,
  moneyCodeDirs,
  moneyRule,
  passesSince,
  priorSetAside,
  readReport,
  notOnBeta,
  betaScreensOf,
  betaHidden,
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
  branchRuns,
  passedTests,
  testKey,
  downloadReport,
  fetchInputs,
  HISTORY_FILE,
  HISTORY_ARTIFACT,
  JOURNEYS_ARTIFACT,
  offBetaSteps,
  TESTER_PATH,
  BETA_GATE,
  BETA_GATE_UNTIL,
} from './journey-verdict.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// ---- A stand-in `gh` on PATH: fetchInputs and main() run as written, and every gh call they make is answered from a
// scenario and logged, so a test reads which API path and which artifact each read asked for, and what it made of it. ----
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const sc = JSON.parse(fs.readFileSync(process.env.FAKE_GH, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const opt = (...names) => { for (const n of names) { const i = args.indexOf(n); if (i >= 0) return args[i + 1]; } };
const fail = (stderr) => { process.stderr.write(stderr + '\\n'); process.exit(1); };
if (args[0] === 'api') {
  const at = args[args.length - 1].replace(/^\\//, '');
  const [where, query = ''] = at.split('?');
  const q = new URLSearchParams(query);
  const hit = sc.api.find((e) => new RegExp(e.path).test(at));
  if (!hit) fail('HTTP 404: Not Found (' + at + ')');
  let out = hit.json;
  if (hit.items) {
    const per = Number(q.get('per_page') || 30);
    const page = Number(q.get('page') || 1);
    const items = hit.items.slice((page - 1) * per, page * per);
    out = hit.key ? { [hit.key]: items } : items;
  }
  process.stdout.write(JSON.stringify(out));
} else if (args[0] === 'run' && args[1] === 'download') {
  const got = sc.downloads[args[2] + '/' + opt('--name', '-n')];
  if (!got) fail('no valid artifacts found to download');
  if (got.stderr) fail(got.stderr);
  const dir = opt('--dir', '-D');
  for (const [name, body] of Object.entries(got.files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
} else fail('fake gh: no such command ' + args.join(' '));
`;
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
/** A folder with the stand-in gh (and, `shallow`, a git that calls this checkout shallow and is real git otherwise). */
function fakeGh(scenario, { shallow = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-gh-'));
  const file = join(dir, 'scenario.json');
  writeFileSync(file, JSON.stringify(scenario));
  writeFileSync(join(dir, 'gh'), FAKE_GH);
  chmodSync(join(dir, 'gh'), 0o755);
  if (shallow) {
    writeFileSync(join(dir, 'git'), `#!/bin/sh\ncase "$*" in *--is-shallow-repository*) echo true;; *) exec "${REAL_GIT}" "$@";; esac\n`);
    chmodSync(join(dir, 'git'), 0o755);
  }
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  return {
    dir,
    env: { PATH: `${dir}:${process.env.PATH}`, FAKE_GH: file, FAKE_GH_LOG: log },
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}
/** `fn()` with the stand-in's env set in this process (execFileSync reads PATH from it), restored after. */
function underGh(gh, fn) {
  const before = Object.fromEntries(Object.keys(gh.env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, gh.env);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}
/** The run downloads a scenario's gh was asked for, as "<run id>/<artifact>". */
const downloadsAsked = (calls) => calls.filter((a) => a[0] === 'run').map((a) => `${a[2]}/${a[a.indexOf('--name') + 1]}`);
const V_NAMED = { id: 1, run_number: 0, created_at: '2026-11-09T00:00:00Z' };
/** Main's run number `n` of the journeys workflow: id 5000 + n, a minute apart from 10 Nov. */
const vRun = (n, over = {}) => ({
  id: 5000 + n,
  run_number: n,
  run_attempt: 1,
  head_sha: n.toString(16).padStart(40, '0'),
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  created_at: new Date(Date.UTC(2026, 10, 10) + n * 60_000).toISOString(),
  head_repository: { full_name: REPO },
  ...over,
});
const vRuns = (count, over) => Array.from({ length: count }, (_, i) => vRun(i + 1, over));
/** The scenario fetchInputs reads: the named run, main's runs since it, a compare, and the downloads given. */
const vScenario = ({ runs, compare = null, downloads = {}, extra = [] }) => ({
  api: [
    { path: `^repos/${REPO}/actions/runs/1$`, json: V_NAMED },
    { path: `^repos/${REPO}/actions/workflows/real-app-journeys\\.yml/runs\\?`, items: [...runs].reverse(), key: 'workflow_runs' },
    ...(compare ? [{ path: `^repos/${REPO}/compare/`, json: compare }] : []),
    ...extra,
  ],
  downloads: { [`1/${JOURNEYS_ARTIFACT}`]: { files: { 'report.json': report(ok('J-a-01 #1')) } }, ...downloads },
});
const storedFile = (from, runs) => ({
  version: HISTORY_VERSION,
  run: from,
  runs: Object.fromEntries(runs.map((r) => [r.id, { number: r.run_number, attempt: 1, passed: ['J-a-01#1'] }])),
});
const vBaseline = { run: { number: 0, id: 1 }, steps: [] };
const vThisMain = () => ({ ...vRun(200), id: 9999, created_at: '2026-11-20T00:00:00Z' });
const vThisBranch = () => ({ ...vThisMain(), head_branch: 'feature', event: 'pull_request', head_sha: 'f'.repeat(40) });
/** fetchInputs under the stand-in, with its log lines kept. */
function readUnder(gh, thisRun) {
  const lines = [];
  const got = underGh(gh, () => fetchInputs({ repo: REPO, baseline: vBaseline, thisRun, log: (l) => lines.push(l) }));
  return { ...got, lines, calls: gh.calls() };
}

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

// A run off main is held only to main's runs on commits its head contains (branchRuns). Built from intafaced #8284 at
// 49bd7d4 (job 132308157438, 14 Nov 2026): its only reds were J-agents-09 #1 to #6, "called unbuilt, but passed on main
// in run 4914", and run 4914 was on 0748fc0 (#8282's merge), after the branch was cut. GitHub's compare of
// 49bd7d4...0748fc0 listed 75a6698 (run 4911) and 0748fc0 (run 4914) as the commits the head lacks.
const sha = (c) => c.repeat(40);
const REPO = 'INTAFACED/intafaced';
const mainRun = (n, c) => ({
  id: 43000 + n,
  run_number: n,
  head_sha: sha(c),
  head_branch: 'main',
  event: 'push',
  head_repository: { full_name: REPO },
});
const prRun = (c) => ({
  id: 1,
  run_number: 4917,
  head_sha: sha(c),
  head_branch: 'cut-1',
  event: 'pull_request',
  head_repository: { full_name: REPO },
});
const history = [mainRun(4910, 'a'), mainRun(4911, 'b'), mainRun(4914, 'c')];
const lacks = (...cs) => {
  const calls = [];
  const compare = (head, base) => {
    calls.push([head, base]);
    return { total_commits: cs.length, commits: cs.map((c) => ({ sha: sha(c) })) };
  };
  return { compare, calls };
};
const historyReports = {
  4910: readReport(report(bad('J-a-01 #2'))),
  4911: readReport(report(bad('J-a-01 #2'))),
  4914: readReport(report(ok('J-a-01 #2'))),
};
const verdictOn = (runs) =>
  run(report(ok('J-a-01 #1'), bad('J-a-01 #2')), {
    passedSince: passesSince(runs.map((r) => [r.run_number, historyReports[r.run_number]])),
  });

test("green: a branch cut before a step was built on main is not held to main's later pass (#8284 at 49bd7d4)", () => {
  const { compare, calls } = lacks('b', 'c');
  const own = branchRuns(history, { run: prRun('d'), repo: REPO, compare });
  assert.deepEqual(calls, [[sha('d'), sha('c')]], "one compare, against the newest history run's commit");
  assert.deepEqual(own.left, [4911, 4914]);
  assert.deepEqual(
    own.runs.map((r) => r.run_number),
    [4910],
  );
  assert.equal(own.kept, null);
  assert.deepEqual(verdictOn(own.runs).red, []);
  // The old reading, every run on main: red on the step the branch never had.
  assert.match(verdictOn(history).red[0].why, /called unbuilt, but passed on main in run 4914/);
});

test('red: a branch that contains the commit whose main run passed the step, and fails it, is still red (the planted fault)', () => {
  // #8284 after merging main (97a822c): GitHub's compare 97a822c...0748fc0 is "behind", 0 commits.
  const own = branchRuns(history, { run: prRun('e'), repo: REPO, compare: lacks().compare });
  assert.deepEqual(own.left, []);
  assert.match(verdictOn(own.runs).red[0].why, /called unbuilt, but passed on main in run 4914/);
  // Only the runs the head lacks are left out: a pass in a run it contains still binds.
  const older = branchRuns(history, { run: prRun('f'), repo: REPO, compare: lacks('b').compare });
  assert.deepEqual(older.left, [4911]);
  assert.match(verdictOn(older.runs).red[0].why, /called unbuilt, but passed on main in run 4914/);
});

test("main's own runs keep the whole history, and nothing is compared", () => {
  const { compare, calls } = lacks('b', 'c');
  const own = branchRuns(history, { run: { ...mainRun(4917, 'd') }, repo: REPO, compare });
  assert.deepEqual(own, { runs: history, left: [], kept: null });
  assert.deepEqual(calls, []);
  // A fork's branch named main is not main: it is compared like any branch.
  const fork = branchRuns(history, { run: { ...mainRun(4917, 'd'), head_repository: { full_name: 'x/y' } }, repo: REPO, compare });
  assert.deepEqual(fork.left, [4911, 4914]);
});

test('a compare that cannot be read, or lists less than all it counts, keeps the whole history (the stricter reading) and says why', () => {
  const thrown = branchRuns(history, {
    run: prRun('d'),
    repo: REPO,
    compare: () => {
      throw new Error('HTTP 502: Bad Gateway');
    },
  });
  assert.equal(thrown.runs, history);
  assert.match(thrown.kept, /couldn't be read \(HTTP 502/);
  const short = branchRuns(history, { run: prRun('d'), repo: REPO, compare: () => ({ total_commits: 300, commits: [{ sha: sha('c') }] }) });
  assert.equal(short.runs, history);
  assert.match(short.kept, /lists 1 of 300 commits/);
  for (const bad of [null, {}, { commits: [] }, { total_commits: 0 }])
    assert.equal(branchRuns(history, { run: prRun('d'), repo: REPO, compare: () => bad }).runs, history);
  const noHead = branchRuns(history, { run: { ...prRun('d'), head_sha: undefined }, repo: REPO, compare: lacks('c').compare });
  assert.equal(noHead.runs, history);
  assert.match(noHead.kept, /no commit to compare/);
  assert.deepEqual(branchRuns([], { run: prRun('d'), repo: REPO, compare: lacks('c').compare }).runs, []);
});

test("fetchInputs holds a run off main only to main's runs its head contains, and still finds the stored history among all", () => {
  // 151 runs on main since the named run; the branch's head holds only the oldest (GitHub's compare lists the other 150).
  const runs = vRuns(HISTORY_MAX + 1);
  const newest = runs.at(-1);
  const compare = { total_commits: HISTORY_MAX, commits: runs.slice(1).map((r) => ({ sha: r.head_sha })) };
  // No stored history: the cap counts every run on main left to download, before the branch's are narrowed to one.
  const bare = fakeGh(vScenario({ runs, compare }));
  try {
    const got = readUnder(bare, vThisBranch());
    assert.match(
      got.problems.join('\n'),
      new RegExp(
        `${HISTORY_MAX + 1} of ${HISTORY_MAX + 1} finished runs on main since run 0 are not in a stored pass history, more than ${HISTORY_MAX}`,
      ),
      'the history cap counts what is left to download among every run on main, before a run off main is narrowed',
    );
    assert.ok(!got.calls.some((a) => a[0] === 'api' && /\/compare\//.test(a.at(-1))), 'the cap refuses before any compare');
  } finally {
    bare.done();
  }
  // A stored history in the newest run on main, which the branch's head lacks, covers the rest: it is found among all
  // of main's runs, and the head is compared with the newest history run's commit.
  const covered = fakeGh(
    vScenario({
      runs,
      compare,
      downloads: { [`${newest.id}/${HISTORY_ARTIFACT}`]: { files: { [HISTORY_FILE]: storedFile(newest.run_number, runs.slice(0, -1)) } } },
    }),
  );
  try {
    const got = readUnder(covered, vThisBranch());
    assert.deepEqual(got.problems, []);
    const compared = got.calls.filter((a) => a[0] === 'api' && /\/compare\//.test(a.at(-1))).map((a) => a.at(-1));
    assert.deepEqual(compared, [`/repos/${REPO}/compare/${'f'.repeat(40)}...${newest.head_sha}`]);
    assert.deepEqual(
      got.leftOut,
      runs.slice(1).map((r) => r.run_number),
      "main's runs on commits the head lacks are left out",
    );
    assert.match(got.lines.join('\n'), new RegExp(`from run ${newest.run_number}'s stored history; downloaded 0`));
    assert.deepEqual(
      downloadsAsked(got.calls).filter((d) => d.endsWith(`/${JOURNEYS_ARTIFACT}`)),
      [`1/${JOURNEYS_ARTIFACT}`],
      "only the named run's report is downloaded: the branch's one run is in the stored history",
    );
  } finally {
    covered.done();
  }
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

test("a money-flag mismatch main's rule made is passed only when the head's own rule agrees with the baseline, and only the stricter way (#9601)", () => {
  const failingNow = readReport(report(ok('J-a-01 #1'), bad('J-a-02 #1')));
  const mainSays = { ...money, 'J-a-02#1': true }; // #9539: main's rule now calls a baseline money-false step money
  const at = (extra) => judge({ newest: failingNow, named, baseline, money: mainSays, issues: { 9: parkedIssue }, ...extra });
  // Main's rule alone (main's own runs, the journeys verdict): red, and marked so the seal can read the head's rule.
  const alone = at({});
  assert.deepEqual(
    alone.red.map((r) => [r.step, r.why, r.money, r.mismatch]),
    [['J-a-02#1', 'the baseline says money false, the money rule at this commit says true', true, true]],
  );
  // Planted fix (#9601): the head's own rule agrees with the baseline, so the entry is read under its flag: a parked regression.
  const fixed = at({ headMoney: { ...money, 'J-a-02#1': false } });
  assert.deepEqual(fixed.red, []);
  assert.deepEqual(fixed.moneyByHead, ['J-a-02#1']);
  // The same mismatch on a head that does not fix it, or a step the head's rule doesn't know (money), stays red.
  for (const headMoney of [{ ...money, 'J-a-02#1': true }, {}]) {
    const v = at({ headMoney });
    assert.match(v.red[0]?.why ?? '', /money false, the money rule at this commit says true/);
    assert.deepEqual(v.moneyByHead, []);
  }
  // Agreeing never loosens: a red the step still gives counts as money, so the seal never passes it over as inherited.
  const closed = { ...parkedIssue, issue: { ...parkedIssue.issue, state: 'closed' } };
  const still = at({ headMoney: { ...money, 'J-a-02#1': false }, issues: { 9: closed } });
  assert.deepEqual(
    still.red.map((r) => [r.step, r.money]),
    [['J-a-02#1', true]],
  );
  assert.match(still.red[0].why, /is closed/);
  // The other way round: a money-true unbuilt entry main's rule calls non-money is read as unbuilt (a money step) when
  // the head agrees; a head's rule matching main's changes nothing.
  const unbuilt = { ...baseline, steps: [{ step: 'J-a-02#1', state: 'unbuilt', money: true }] };
  const back = judge({ newest: failingNow, named, baseline: unbuilt, money, headMoney: { ...money, 'J-a-02#1': true } });
  assert.deepEqual(back.red, []);
  const same = judge({ newest: failingNow, named, baseline, money, headMoney: { ...money, 'J-a-02#1': true }, issues: { 9: parkedIssue } });
  assert.deepEqual(same.red, [], "a head whose rule disagrees with the baseline where main's agrees is not read by it");
});

test("a change whose own money rule makes a baselined step money is red as money, though main's rule agrees (#9539)", () => {
  const failingNow = readReport(report(ok('J-a-01 #1'), bad('J-a-02 #1')));
  const headSays = { ...money, 'J-a-02#1': true }; // #9539's head: its admin manifest made the step money
  const at = (extra) => judge({ newest: failingNow, named, baseline, money, issues: { 9: parkedIssue }, headMoney: headSays, ...extra });
  assert.deepEqual(
    at({ headBaseline: baseline }).red.map((r) => [r.step, r.why, r.money]),
    [['J-a-02#1', 'with this pull request, the baseline says money false, the money rule at its head says true', true]],
  );
  // The pull request moves the entry with its rule (money, unbuilt): nothing to stop.
  const movedEntry = { ...baseline, steps: [{ step: 'J-a-02#1', state: 'unbuilt', money: true }] };
  assert.deepEqual(at({ headBaseline: movedEntry }).red, []);
  // A machine set-aside never keeps such a step out of the red.
  const setAside = { 'J-a-02#1': { active: true, before: 'passed' } };
  const aside = at({ headBaseline: baseline, setAside, issues: {} });
  assert.deepEqual(aside.setAside, []);
  assert.match(aside.red[0]?.why ?? '', /the money rule at its head says true/);
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
  // J-b-01 #1 is a step on the journey list (money has every listed step), so missing from a full run it is red.
  assert.match(judge({ newest, named: named2, baseline, money: { ...money, 'J-b-01#1': false }, target: null }).red[0].why, /missing now/);
  const broken = readReport(report(bad('J-a-01 #1')));
  assert.equal(judge({ newest: broken, named: named2, baseline, money, target: new Set(['J-a-01.pw.mjs']) }).red.length, 1);
});

// ---- A retired step (#10592: the owner retired J-bank-05 #4 and #5, OWNER 291; its verdict, run 45304484379, read them as
// "passed in run 1719, missing now"). The journey list at the judged commit decides: a step it no longer lists may be
// missing, named as retired; a step it still lists stays red when missing, money or not. ----
const bankSteps = (...ns) => [{ id: 'J-bank-05', module: 'bank', steps: ns.map((n) => ({ n, slices: ['BK-xfer-03'] })) }];
const bankSlices = [{ id: 'BK-xfer-03', touches: ['svc-bank'] }];
const bankManifests = new Map([
  ['services/svc-bank', { name: '@intafaced/svc-bank', dependencies: { '@intafaced/ledger-client': 'workspace:*' } }],
]);
const bankMoney = (...ns) => moneyRule({ journeys: bankSteps(...ns), slices: bankSlices, manifests: bankManifests });
const bankFile = 'J-bank-05.pw.mjs';
const bankReport = (...ns) => ({ suites: [{ file: bankFile, specs: ns.map((n) => ok(`J-bank-05 #${n}`, bankFile)) }] });
const named1719 = readReport(bankReport(1, 2, 3, 4, 5));
const head10592 = readReport(bankReport(1, 2, 3));
const baseline1719 = { run: { number: 1719, id: 42357098806 }, steps: [], notBaselined: [] };

test('replay #10592: J-bank-05 #4 and #5, retired from the journey list with their tests, are named as retired, not red', () => {
  const money3 = bankMoney(1, 2, 3);
  assert.deepEqual(Object.keys(money3), ['J-bank-05#1', 'J-bank-05#2', 'J-bank-05#3']);
  const v = judge({ newest: head10592, named: named1719, baseline: baseline1719, money: money3 });
  assert.deepEqual(v.red, [], 'not red: the steps left the list');
  assert.deepEqual(v.retired, ['J-bank-05#4', 'J-bank-05#5'], 'named as retired, not dropped');
  assert.equal(v.failing, 0);
});

test('a step still on the journey list stays red when missing: a money step, and a non-money one', () => {
  const money5 = bankMoney(1, 2, 3, 4, 5);
  assert.equal(money5['J-bank-05#4'], true, 'J-bank-05 is money by the rule (svc-bank depends on the ledger client)');
  const v = judge({ newest: head10592, named: named1719, baseline: baseline1719, money: money5 });
  assert.deepEqual(
    v.red.map((r) => [r.step, r.money, r.why]),
    [
      ['J-bank-05#4', true, 'passed in run 1719, missing now'],
      ['J-bank-05#5', true, 'passed in run 1719, missing now'],
    ],
  );
  assert.deepEqual(v.retired, []);
  const plain = Object.fromEntries(Object.keys(money5).map((k) => [k, false]));
  const w = judge({ newest: head10592, named: named1719, baseline: baseline1719, money: plain });
  assert.deepEqual(
    w.red.map((r) => [r.step, r.money]),
    [
      ['J-bank-05#4', false],
      ['J-bank-05#5', false],
    ],
  );
  assert.deepEqual(w.retired, []);
  // One retired, one still listed: only the listed one is red.
  const x = judge({ newest: head10592, named: named1719, baseline: baseline1719, money: bankMoney(1, 2, 3, 4) });
  assert.deepEqual(
    x.red.map((r) => r.step),
    ['J-bank-05#4'],
  );
  assert.deepEqual(x.retired, ['J-bank-05#5']);
});

test('a retired step whose test still runs and is skipped or fails stays red: only absence is the retirement', () => {
  const money3 = bankMoney(1, 2, 3);
  const skipped = readReport({
    suites: [{ file: bankFile, specs: [...bankReport(1, 2, 3).suites[0].specs, skip('J-bank-05 #4', bankFile)] }],
  });
  const v = judge({ newest: skipped, named: named1719, baseline: baseline1719, money: money3 });
  assert.deepEqual(
    v.red.map((r) => [r.step, r.money, r.why]),
    [['J-bank-05#4', true, 'passed in run 1719, skipped now']],
  );
  assert.deepEqual(v.retired, ['J-bank-05#5']);
  const failed = readReport({
    suites: [{ file: bankFile, specs: [...bankReport(1, 2, 3).suites[0].specs, bad('J-bank-05 #5', bankFile)] }],
  });
  const w = judge({ newest: failed, named: named1719, baseline: baseline1719, money: money3 });
  assert.deepEqual(
    w.red.map((r) => [r.step, r.money, r.why]),
    [['J-bank-05#5', true, 'failing, not in the baseline']],
  );
});

test('a renamed or deleted journey file: judged by step, so a step still listed is red; a journey retired whole leaves with every step', () => {
  // The file deleted while J-bank-05 is still on the list: every step it held is missing and red.
  const gone = readReport(report(ok('J-a-01 #1')));
  const named2 = readReport({ suites: [{ file: bankFile, specs: bankReport(1, 2).suites[0].specs }, ...report(ok('J-a-01 #1')).suites] });
  const listed = { ...money, ...bankMoney(1, 2) };
  assert.deepEqual(
    judge({ newest: gone, named: named2, baseline: baseline1719, money: listed }).red.map((r) => r.step),
    ['J-bank-05#1', 'J-bank-05#2'],
  );
  // Renamed: the steps run from the new file, so nothing is missing.
  const renamed = readReport({
    suites: [
      { file: 'J-bank-05-abroad.pw.mjs', specs: bankReport(1, 2).suites[0].specs.map((s) => ({ ...s, file: 'J-bank-05-abroad.pw.mjs' })) },
      ...report(ok('J-a-01 #1')).suites,
    ],
  });
  assert.deepEqual(judge({ newest: renamed, named: named2, baseline: baseline1719, money: listed }).red, []);
  // The journey retired whole: off the list with its file, so its steps are retired.
  const v = judge({ newest: gone, named: named2, baseline: baseline1719, money });
  assert.deepEqual(v.red, []);
  assert.deepEqual(v.retired, ['J-bank-05#1', 'J-bank-05#2']);
});

test("the head's own list decides when the head's rule is given (the merge seal on the retiring pull request); main's alone otherwise", () => {
  // The seal judges with main's rule and, for a pull request that changes journeys.json, the head's (journey-seal.mjs).
  const onMain = bankMoney(1, 2, 3, 4, 5);
  const v = judge({ newest: head10592, named: named1719, baseline: baseline1719, money: onMain, headMoney: bankMoney(1, 2, 3) });
  assert.deepEqual(v.red, []);
  assert.deepEqual(v.retired, ['J-bank-05#4', 'J-bank-05#5']);
  // A head that still lists them: red, whatever main's list says.
  const w = judge({ newest: head10592, named: named1719, baseline: baseline1719, money: bankMoney(1, 2, 3), headMoney: onMain });
  assert.deepEqual(
    w.red.map((r) => r.step),
    ['J-bank-05#4', 'J-bank-05#5'],
  );
});

test("replay #10592 through the verdict's own run: green and naming the retired steps; red with them still on the list", () => {
  const verdict = fileURLToPath(new URL('./journey-verdict.mjs', import.meta.url));
  const at = (ns) => {
    const dir = mkdtempSync(join(tmpdir(), 'verdict-retired-'));
    try {
      mkdirSync(join(dir, 'docs/roadmap'), { recursive: true });
      mkdirSync(join(dir, 'services/svc-bank'), { recursive: true });
      mkdirSync(join(dir, 'history'));
      writeFileSync(join(dir, 'docs/roadmap/journeys.json'), JSON.stringify(bankSteps(...ns)));
      writeFileSync(join(dir, 'docs/roadmap/slices.json'), JSON.stringify(bankSlices));
      writeFileSync(join(dir, 'services/svc-bank/package.json'), JSON.stringify(bankManifests.get('services/svc-bank')));
      const f = (name, body) => (writeFileSync(join(dir, name), JSON.stringify(body)), join(dir, name));
      const env = { ...process.env, GITHUB_STEP_SUMMARY: '' };
      delete env.JOURNEYS_TARGET;
      const args = [
        verdict,
        '--report',
        f('report.json', bankReport(1, 2, 3)),
        '--named-report',
        f('named.json', bankReport(1, 2, 3, 4, 5)),
      ];
      args.push('--history-dir', join(dir, 'history'), '--baseline', f('baseline.json', baseline1719));
      return spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const retired = at([1, 2, 3]);
  assert.equal(retired.status, 0, retired.stdout + retired.stderr);
  assert.match(retired.stdout, /outside the list or against its rules: \*\*0\*\*/);
  assert.match(retired.stdout, /### Retired: passed in run 1719, no longer on the journey list, missing now: 2/);
  assert.match(retired.stdout, /^- J-bank-05#4: retired, missing now$/m);
  assert.match(retired.stdout, /^- J-bank-05#5: retired, missing now$/m);
  const listed = at([1, 2, 3, 4, 5]);
  assert.equal(listed.status, 1, listed.stdout + listed.stderr);
  assert.match(listed.stdout, /^- J-bank-05#4 \(money\): passed in run 1719, missing now$/m);
  assert.match(listed.stdout, /^- J-bank-05#5 \(money\): passed in run 1719, missing now$/m);
  assert.match(listed.stdout, /missing now: 0/);
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

test('the money rule: a Rust service crate is money, so a service stays money when its TypeScript is deleted', () => {
  const slices = [
    { id: 'S1', touches: ['svc-academy', 'customer: more'] },
    { id: 'S2', touches: ['svc-docs'] },
  ];
  const journeys = [
    {
      id: 'J-a-01',
      steps: [
        { n: 1, slices: ['S1'] },
        { n: 2, slices: ['S2'] },
      ],
    },
  ];
  // svc-academy in TypeScript, depending on the ledger client: money.
  const ts = new Map([['services/svc-academy', { dependencies: { '@intafaced/ledger-client': '*' } }]]);
  assert.deepEqual(moneyRule({ journeys, slices, manifests: ts }), { 'J-a-01#1': true, 'J-a-01#2': false });
  // The same service as a Rust crate, its TypeScript gone: still money (the planted fault is the crate entry missing).
  const rust = new Map([['crates/svc-academy', { name: 'svc-academy', rustService: true }]]);
  assert.deepEqual(moneyRule({ journeys, slices, manifests: rust }), { 'J-a-01#1': true, 'J-a-01#2': false });
  assert.deepEqual(moneyRule({ journeys, slices, manifests: new Map() }), { 'J-a-01#1': false, 'J-a-01#2': false });
  // manifestsAt reads the repository's crates: both Rust services are there, and neither is in the reach's money folders.
  const read = manifestsAt(fileURLToPath(new URL('../..', import.meta.url)));
  for (const svc of ['svc-academy', 'svc-tax']) assert.equal(read.get(`crates/${svc}`)?.rustService, true, svc);
  assert.equal(
    [...moneyCodeDirs(read)].some((d) => d.startsWith('crates/')),
    false,
  );
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
  const runs = vRuns(3);
  const [noArtifact, noReport, kept] = runs;
  const history = {
    // run 1 kept no artifact at all (the stand-in answers gh's own "no valid artifacts" words); run 2's has no report.json.
    [`${noReport.id}/${JOURNEYS_ARTIFACT}`]: { files: { 'set-aside.json': { steps: [] } } },
    [`${kept.id}/${JOURNEYS_ARTIFACT}`]: { files: { 'report.json': report(ok('J-a-01 #2')) } },
  };
  const read = (downloads) => {
    const gh = fakeGh({ ...vScenario({ runs }), downloads: { ...vScenario({ runs }).downloads, ...downloads } });
    try {
      return readUnder(gh, vThisMain());
    } finally {
      gh.done();
    }
  };
  const got = read(history);
  assert.deepEqual(got.problems, []);
  assert.deepEqual(got.skipped, [noArtifact.run_number, noReport.run_number], 'a missing artifact and a missing report.json skip');
  assert.equal(got.passedSince['J-a-01#2'], kept.run_number);
  assert.ok(got.named.states['J-a-01#1'], "the named run's report is read");
  // Any other failed download of a history run is unreadable, never a skip.
  const refused = read({ ...history, [`${noArtifact.id}/${JOURNEYS_ARTIFACT}`]: { stderr: 'HTTP 403: Forbidden' } });
  assert.match(refused.problems.join('\n'), /the pass history couldn't be read: run 1's report couldn't be read \(.*HTTP 403: Forbidden/);
  // The named run's report is required: no artifact, or an artifact without report.json, is a problem, not a skip.
  const unnamed = read({ ...history, [`1/${JOURNEYS_ARTIFACT}`]: undefined });
  assert.match(
    unnamed.problems.join('\n'),
    /the baseline's named run 0 \(1\) report couldn't be read: .*no valid artifacts found to download/,
  );
  assert.equal(unnamed.named, null);
  const empty = read({ ...history, [`1/${JOURNEYS_ARTIFACT}`]: { files: { 'set-aside.json': {} } } });
  assert.match(
    empty.problems.join('\n'),
    /the baseline's named run 0 \(1\) report couldn't be read: run 1's real-app-journeys artifact has no report\.json/,
  );
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

/** main() with --fetch under the stand-in gh, on main's runs at this checkout's HEAD (so isAncestor holds). */
function verdictMain({ ref = 'refs/heads/main', history = {}, shallow = false } = {}) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const runs = vRuns(3, { head_sha: head });
  const current = { ...vThisMain(), head_sha: head };
  const kept = { 'report.json': report(ok('J-a-01 #1')), 'set-aside.json': { ref: 'refs/heads/main', steps: [] } };
  const gh = fakeGh(
    vScenario({
      runs,
      downloads: Object.fromEntries(runs.map((r) => [`${r.id}/${JOURNEYS_ARTIFACT}`, history[r.run_number] ?? { files: kept }])),
      extra: [{ path: `^repos/${REPO}/actions/runs/${current.id}$`, json: current }],
    }),
    { shallow },
  );
  try {
    const f = (name, body) => (writeFileSync(join(gh.dir, name), JSON.stringify(body)), join(gh.dir, name));
    const out = join(gh.dir, 'pass-history-out.json');
    const env = {
      ...process.env,
      ...gh.env,
      GITHUB_REPOSITORY: REPO,
      GITHUB_RUN_ID: String(current.id),
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_STEP_SUMMARY: '',
    };
    delete env.JOURNEYS_TARGET;
    env.GITHUB_REF = ref;
    const args = ['tooling/ci/journey-verdict.mjs', '--fetch', '--report', f('report.json', report(ok('J-a-01 #1')))];
    args.push('--baseline', f('baseline.json', vBaseline), '--history-out', out);
    const r = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8' });
    return { ...r, runs, current, written: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null };
  } finally {
    gh.done();
  }
}

test("fetchInputs finds the stored history among main's own history runs and writes only on main from a whole read", () => {
  // The stored history is HISTORY_FILE in the newest run's HISTORY_ARTIFACT, and only the runs it does not cover download.
  const runs = vRuns(3);
  const newest = runs.at(-1);
  const gh = fakeGh(
    vScenario({
      runs,
      downloads: {
        [`${newest.id}/${HISTORY_ARTIFACT}`]: { files: { [HISTORY_FILE]: storedFile(newest.run_number, runs.slice(0, 2)) } },
        [`${newest.id}/${JOURNEYS_ARTIFACT}`]: { files: { 'report.json': report(ok('J-a-01 #3')) } },
      },
    }),
  );
  try {
    const got = readUnder(gh, vThisMain());
    assert.deepEqual(got.problems, []);
    assert.deepEqual(downloadsAsked(got.calls), [
      `1/${JOURNEYS_ARTIFACT}`,
      `${newest.id}/${HISTORY_ARTIFACT}`,
      `${newest.id}/${JOURNEYS_ARTIFACT}`,
    ]);
    assert.match(got.lines.join('\n'), /from run 3's stored history; downloaded 1/);
    assert.deepEqual(
      Object.keys(got.entries).sort(),
      runs.map((r) => String(r.id)),
    );
    assert.equal(got.passedSince['J-a-01#1'], 2, 'a pass the stored history holds counts');
    assert.equal(got.passedSince['J-a-01#3'], 3);
  } finally {
    gh.done();
  }
  // main() writes the next stored history only on main, and only from a whole read of the history.
  const onMain = verdictMain();
  assert.equal(onMain.status, 0, onMain.stdout + onMain.stderr);
  assert.equal(onMain.written?.version, HISTORY_VERSION, 'on main the stored history is written');
  assert.equal(onMain.written.run, onMain.current.run_number);
  assert.deepEqual(Object.keys(onMain.written.runs).sort(), [...onMain.runs.map((r) => String(r.id)), String(onMain.current.id)].sort());
  assert.deepEqual(onMain.written.runs[onMain.current.id].passed, ['J-a-01#1'], "this run's own entry is its report");
  assert.equal(verdictMain({ ref: 'refs/heads/feature' }).written, null, 'off main nothing is written');
  const partial = verdictMain({ history: { 2: { stderr: 'HTTP 403: Forbidden' } } });
  assert.match(partial.stdout, /the pass history couldn't be read/);
  assert.equal(partial.written, null, 'a history that could not be read whole writes nothing');
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

test('a pass on its retry is a pass, money or not: on main it is listed for its one flaky issue; failing outright is still red', () => {
  const v = run(report(ok('J-a-01 #1'), flaky('J-a-05 #1')), { money: moneyToo, onMain: true });
  assert.deepEqual(v.red, [], 'a money step that passed on its retry is not red');
  assert.deepEqual(v.flaky, ['J-a-05#1'], 'listed for its flaky issue, never proven');
  assert.deepEqual(v.setAside, [], 'never set aside');
  assert.deepEqual(run(report(ok('J-a-01 #1'), flaky('J-a-05 #1')), { money: moneyToo }).flaky, [], 'off main: no issue');
  // The planted break: the same money step failing outright on main is red.
  const broke = run(report(ok('J-a-01 #1'), bad('J-a-05 #1')), { money: moneyToo, onMain: true });
  assert.deepEqual(
    broke.red.map((r) => [r.step, r.money]),
    [['J-a-05#1', true]],
  );
  assert.deepEqual(broke.flaky, []);
  // A non-money step with no set-aside that passed on its retry is a pass too, listed for its issue.
  const plain = run(report(flaky('J-a-01 #1')), { onMain: true });
  assert.deepEqual([plain.red, plain.flaky], [[], ['J-a-01#1']]);
  // A set-aside step's own issue tracks it: it is not listed twice.
  assert.deepEqual(run(report(flaky('J-a-01 #1')), { onMain: true, setAside: aside({ 'J-a-01#1': 'flaky' }, 3) }).flaky, []);
});
test('never set aside: a money step is never set aside, so its outright failure is red whatever a list says', () => {
  const v = run(report(ok('J-a-01 #1'), bad('J-a-05 #1')), { money: moneyToo, setAside: aside({ 'J-a-05#1': 'flaky' }, 3) });
  assert.deepEqual(
    v.red.map((r) => [r.step, r.money]),
    [['J-a-05#1', true]],
  );
  assert.match(v.red[0].why, /failing, not in the baseline/);
  // Even a hand-made list naming it changes nothing: the verdict reads the money rule itself.
  const forged = { 'J-a-05#1': { active: true, before: 'passed', until: at(30) } };
  assert.equal(run(report(ok('J-a-01 #1'), bad('J-a-05 #1')), { money: moneyToo, setAside: forged }).red.length, 1);
});
test('a pass only on the retry is judged as a failure: excused only where a failure would be', () => {
  // J-a-01#2 is unbuilt in the baseline, so failing is excused; passing only on its retry is excused the same way.
  assert.deepEqual(run(report(ok('J-a-01 #1'), flaky('J-a-01 #2')), { money: { ...money, 'J-a-01#2': false } }).red, []);
});

test('after the end date: a failure is red again; a pass on the retry is a pass, listed for its flaky issue', () => {
  const setAside = aside({}, 2 + SET_ASIDE_DAYS, rows(aside({ 'J-a-01#1': 'flaky' }, 2)));
  assert.match(run(report(bad('J-a-01 #1')), { setAside }).red[0].why, /failing, not in the baseline/);
  const v = run(report(flaky('J-a-01 #1')), { setAside, onMain: true });
  assert.deepEqual([v.red, v.flaky], [[], ['J-a-01#1']]);
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

test('never set aside: a wallet step the baseline rule calls non-money gets no set-aside, and its outright failure is red', () => {
  const guard = { ...money, 'J-wallet-01#1': true };
  const states = readReport(report(flaky('J-wallet-01 #1'))).states;
  assert.deepEqual(setAsideSteps({ states, money: guard, run: { number: 103, at: at(3) } }), {});
  const v = judge({
    newest: readReport(report(ok('J-a-01 #1'), bad('J-wallet-01 #1'))),
    named,
    baseline,
    money: { ...money, 'J-wallet-01#1': false },
    guard,
    setAside: { 'J-wallet-01#1': { active: true, before: 'passed', until: at(30) } },
  });
  assert.deepEqual(
    v.red.map((r) => r.step),
    ['J-wallet-01#1'],
    'a guarded step is never excused by a set-aside',
  );
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

test("the reviewer's case: J-wallet-01 #1 and J-pay-01 #1, non-money by the slice rule, are never set aside; a pass on the retry is a pass, an outright failure red", () => {
  for (const step of ['J-wallet-01#1', 'J-pay-01#1']) {
    assert.equal(realMoney[step], false, `${step}: the slice rule alone calls it non-money (the hole)`);
    assert.equal(realGuard[step], true, `${step}: the set-aside guard calls it money`);
  }
  const states = { 'J-wallet-01#1': 'flaky', 'J-pay-01#1': 'flaky' };
  assert.deepEqual(setAsideSteps({ states, money: realGuard, run: { number: 103, at: at(3) } }), {});
  const judged = (newest) =>
    judge({
      newest,
      named: readReport(report()),
      baseline: { run: { number: 100 }, steps: [] },
      money: realMoney,
      guard: realGuard,
      setAside: {},
      onMain: true,
    });
  const v = judged(readReport(report(flaky('J-wallet-01 #1'), flaky('J-pay-01 #1'))));
  assert.deepEqual([v.red, v.flaky], [[], ['J-pay-01#1', 'J-wallet-01#1']]);
  const broke = judged(readReport(report(bad('J-wallet-01 #1'), bad('J-pay-01 #1'))));
  assert.deepEqual(broke.red.map((r) => r.step).sort(), ['J-pay-01#1', 'J-wallet-01#1']);
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
  const asked = [];
  /** A stand-in for execFileSync's `gh run download`: writes `files` into --dir, or fails with `stderr`. */
  const gh =
    ({ files, stderr }) =>
    (cmd, args) => {
      asked.push([cmd, ...args]);
      if (stderr) throw Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}`), { stderr: Buffer.from(stderr) });
      const dir = args[args.indexOf('--dir') + 1];
      for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(body));
    };
  const opts = (answer) => ({ run: gh(answer), wait: () => {}, tries: 2, waitFor: () => null });
  const list = { ref: 'refs/heads/main', steps: [] };
  assert.deepEqual(downloadReport(REPO, 7, 'set-aside.json', true, opts({ files: { 'set-aside.json': list } })), list);
  assert.deepEqual(asked[0], ['gh', 'run', 'download', '7', '--repo', REPO, '--name', JOURNEYS_ARTIFACT, '--dir', asked[0][9]]);
  // Optional: a run with no such artifact, or an artifact without the file, is null.
  assert.equal(downloadReport(REPO, 7, 'set-aside.json', true, opts({ stderr: 'no valid artifacts found to download\n' })), null);
  assert.equal(downloadReport(REPO, 7, 'set-aside.json', true, opts({ files: { 'report.json': {} } })), null);
  // Any other failure throws, optional or not: a refusal, a rate limit, a server error after its tries.
  for (const stderr of ['HTTP 403: Forbidden', 'HTTP 403: API rate limit exceeded for user ID 1', 'HTTP 502: Bad Gateway'])
    assert.throws(() => downloadReport(REPO, 7, 'set-aside.json', true, opts({ stderr })), new RegExp(stderr.slice(0, 12)));
  // Required (report.json by default): a missing artifact or file throws.
  assert.throws(
    () => downloadReport(REPO, 7, 'report.json', undefined, opts({ stderr: 'no valid artifacts found to download' })),
    /no valid artifacts/,
  );
  assert.throws(
    () => downloadReport(REPO, 7, 'report.json', undefined, opts({ files: {} })),
    /run 7's real-app-journeys artifact has no report\.json/,
  );
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
  // A step in cool-down keeps it: no fresh 7 days. The CLI with no complete list excuses no failure (a pass on the
  // retry is a pass whatever the list says).
  assert.equal(excusedSetAside({ setAside: { a: 1 }, onMain: true, incomplete: true }).a, undefined);
  assert.equal(
    cli({ ref: 'refs/heads/main', state: 'flaky', priorIncomplete: true }),
    0,
    'no complete list: a pass on the retry is a pass',
  );
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
  // main() with --fetch checks the clone before it reads main's set-aside list: a shallow one is red and names why.
  const shallow = verdictMain({ shallow: true });
  assert.equal(shallow.status, 1);
  assert.match(
    shallow.stdout,
    /the last run on main's set-aside list couldn't be read: this checkout is shallow \(true\): the verdict job needs fetch-depth: 0/,
  );
  const full = verdictMain();
  assert.equal(full.status, 0, full.stdout + full.stderr);
  assert.doesNotMatch(full.stdout, /shallow/);
  assert.match(full.stdout, /set-aside list carried on from run 3/, 'the control: a full clone reads the list');
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

test('the history cap counts runs left to download, not runs since the baseline (14 Nov 2026: 151 runs since run 1719)', () => {
  const runs = Array.from({ length: 400 }, (_, i) => ({ id: 1000 + i, run_number: 1720 + i, run_attempt: 1 }));
  const entry = (r, attempt = 1) => [String(r.id), { number: r.run_number, attempt, passed: [] }];
  // A stored file holding all but the newest 3: 3 to download, however old the baseline.
  const stored = { from: runs[396].run_number, runs: Object.fromEntries(runs.slice(0, 397).map((r) => entry(r))) };
  assert.deepEqual(
    toDownload(runs, stored).map((r) => r.run_number),
    runs.slice(397).map((r) => r.run_number),
  );
  // A run re-run since the file read it counts; so does a run the file never held (one that kept no report).
  const rerun = runs.map((r, i) => (i === 10 ? { ...r, run_attempt: 2 } : r));
  delete stored.runs[String(runs[20].id)];
  assert.deepEqual(
    toDownload(rerun, stored).map((r) => r.run_number),
    [runs[10], runs[20], ...runs.slice(397)].map((r) => r.run_number),
  );
  // No stored file: every run, so the cap still trips past HISTORY_MAX, as before.
  assert.equal(toDownload(runs, null).length, 400);
  assert.ok(toDownload(runs, null).length > HISTORY_MAX);
  // The same 400 with the file: under the cap.
  assert.ok(toDownload(runs, stored).length <= HISTORY_MAX);
});

// Tests with no step title in a journey file (project-state #2232, the lead's call under row d69). Built from intafaced
// main's runs 4890 to 5011: J-derivatives-01's custodial checks beside its venue steps passed in every run, and 7 tests
// of work not built yet (J-agents-12 outside:, J-pay-03 part of #1 (blocked), …) failed in every run.
const KEEP = 'J-a-01, part of #1: our own ledger holds the margin';
const UNBUILT = 'J-a-01 starts: from a notice nobody built';
const k = (t) => testKey('J-a-01.pw.mjs', t);

test('a test with no step title is keyed by its journey, file and title, never as a step', () => {
  const r = readReport(report(ok('J-a-01 #1'), ok(KEEP), bad(UNBUILT), flaky('J-a-01 ends: back home')));
  assert.deepEqual(Object.keys(r.states), ['J-a-01#1']);
  assert.deepEqual(r.tests, { [k(KEEP)]: 'passed', [k(UNBUILT)]: 'failed', [k('J-a-01 ends: back home')]: 'flaky' });
  assert.equal(k(KEEP).split('#')[0], 'J-a-01', "its journey is what comes before the '#', as a step's is");
  assert.equal(testKey('J-x-07-venue.pw.mjs', 'setup: the venue').split('#')[0], 'J-x-07', "a title without an id takes the file's");
  assert.deepEqual(
    passedTests(r),
    [k('J-a-01 ends: back home'), k(KEEP)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
  );
});

test('red: a test with no step title that passed in the named run fails or is skipped now', () => {
  const named2 = readReport(report(ok('J-a-01 #1'), ok(KEEP), bad(UNBUILT)));
  for (const now of [bad(KEEP), skip(KEEP)]) {
    const v = judge({ newest: readReport(report(ok('J-a-01 #1'), now, bad(UNBUILT))), named: named2, baseline, money });
    assert.deepEqual(
      v.red.map((r) => [r.step, r.why]),
      [[k(KEEP), `a test with no step title: passed on main in run 100, ${now.tests[0].status === 'skipped' ? 'skipped' : 'failed'} now`]],
    );
    assert.equal(v.testsFailing, 1);
  }
});

test('red: a test with no step title that passed on main after the named run fails now; a pass on its retry counted', () => {
  for (const pass of [ok(KEEP), flaky(KEEP)]) {
    const passedSince = passesSince([
      [101, readReport(report(pass))],
      [102, readReport(report(bad(KEEP)))],
    ]);
    assert.equal(passedSince[k(KEEP)], 101);
    const v = run(report(ok('J-a-01 #1'), bad(KEEP)), { passedSince });
    assert.deepEqual(
      v.red.map((r) => [r.step, r.why, r.money]),
      [[k(KEEP), 'a test with no step title: passed on main in run 101, failed now', false]],
    );
  }
});

test('green: a test with no step title that never passed on main stays out until it first passes', () => {
  const passedSince = passesSince([[101, readReport(report(bad(UNBUILT)))]]);
  const v = run(report(ok('J-a-01 #1'), bad(UNBUILT), ok(KEEP)), { passedSince });
  assert.deepEqual(v.red, []);
  assert.equal(v.testsFailing, 0);
  // Retitled: the old title passed, the new one never did. Missing is no failure, so a retitle alone is not red.
  assert.deepEqual(
    judge({ newest: readReport(report(ok('J-a-01 #1'))), named: readReport(report(ok('J-a-01 #1'), ok(KEEP))), baseline, money }).red,
    [],
  );
});

test("a step's rule is unchanged by the tests beside it", () => {
  const withTests = (...specs) => run(report(...specs, ok(KEEP), bad(UNBUILT)));
  assert.deepEqual(withTests(ok('J-a-01 #1'), bad('J-a-01 #2'), bad('J-a-02 #1'), ok('J-a-03 #1')).red, []);
  assert.deepEqual(
    withTests(bad('J-a-01 #1'), bad('J-a-01 #2')).red.map((r) => [r.step, r.why]),
    [['J-a-01#1', 'failing, not in the baseline']],
  );
  assert.match(withTests(bad('J-a-01 #2')).red[0].why, /passed in run 100, missing now/);
});

test("a test's money is its journey's: money when a step of it is, or no step of it is known", () => {
  const named2 = readReport(report(ok('J-a-01 #1'), ok(KEEP)));
  const red = (m) => judge({ newest: readReport(report(ok('J-a-01 #1'), bad(KEEP))), named: named2, baseline, money: m }).red[0].money;
  assert.equal(red(money), false);
  assert.equal(red({ ...money, 'J-a-01#2': true }), true);
  assert.equal(red({ 'J-b-01#1': false }), true, 'a journey the money rule does not know is money');
});

test('the stored pass history keeps the passes of tests with no step title, and an entry from before them still reads', () => {
  const runs = [
    { id: 1, run_number: 101, run_attempt: 1 },
    { id: 2, run_number: 102, run_attempt: 1 },
  ];
  const reports = { 1: readReport(report(ok('J-a-01 #1'), ok(KEEP))), 2: readReport(report(ok('J-a-01 #1'), bad(KEEP))) };
  const first = historyThrough(runs, { stored: null, read: (r) => reports[r.id] });
  assert.deepEqual(first.entries[1], { number: 101, attempt: 1, passed: ['J-a-01#1'], tests: [k(KEEP)] });
  const stored = { from: 102, runs: storedRuns({ version: HISTORY_VERSION, runs: first.entries }) };
  const again = historyThrough(runs, { stored, read: () => assert.fail('everything is stored') });
  assert.deepEqual(passesSince(again.reports), passesSince(first.reports));
  assert.equal(passesSince(again.reports)[k(KEEP)], 101);
  // An entry written before 14 Nov 2026 has no `tests`: it reads, and counts none of them as passed.
  const old = storedRuns({ version: HISTORY_VERSION, runs: { 1: { number: 101, attempt: 1, passed: ['J-a-01#1'] } } });
  assert.ok(old);
  assert.equal(storedRuns({ version: HISTORY_VERSION, runs: { 1: { number: 101, attempt: 1, passed: [], tests: 'x' } } }), null);
  const via = historyThrough(runs.slice(0, 1), { stored: { from: 101, runs: old }, read: () => assert.fail('stored') });
  assert.deepEqual(passesSince(via.reports), { 'J-a-01#1': 101 });
});

// The seal's reads (22 Nov 2026): one seal step on #9630 judged 9 runs with the same baseline, and each fetchInputs read
// main's whole run history since the named run (13 pages), the named run and all three regression issues again: 218
// calls, the largest spender of the workflow token's hourly budget. With a memo each is read once per process.
test('fetchInputs with a memo reads main history, the named run and each issue once, however many runs it judges', async () => {
  const { fetchInputs: read } = await import('./journey-verdict.mjs');
  const calls = [];
  const mainRun = (id, n, at) => ({
    id,
    run_number: n,
    run_attempt: 1,
    head_sha: String(n).padStart(40, 'a'),
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    created_at: at,
    head_repository: { full_name: REPO },
  });
  const named = { id: 1, run_number: 10, created_at: '2026-11-07T08:49:26Z' };
  const get = (path) => {
    calls.push(`get ${path}`);
    if (path.endsWith('/actions/runs/1')) return named;
    if (/\/issues\/\d+$/.test(path)) return { number: Number(path.split('/').pop()), state: 'open' };
    throw new Error(`unexpected ${path}`);
  };
  const pages = (path) => {
    calls.push(`pages ${path}`);
    if (path.includes('/comments')) return [];
    return [mainRun(11, 11, '2026-11-08T00:00:00Z'), mainRun(12, 12, '2026-11-09T00:00:00Z')];
  };
  const baseline = {
    run: { id: 1, number: 10 },
    steps: [
      { step: 'J-a-01#1', state: 'regression', issue: 6750 },
      { step: 'J-a-02#1', state: 'regression', issue: 6853 },
    ],
  };
  const reports = new Map([
    [1, { states: {}, ran: [] }],
    [11, { states: {}, ran: [] }],
    [12, { states: {}, ran: [] }],
  ]);
  const memo = new Map();
  const judged = (id, at) => ({ ...mainRun(id, id, at), head_branch: 'feature', event: 'pull_request', head_sha: 'b'.repeat(40) });
  const opts = {
    repo: REPO,
    baseline,
    reports,
    log: () => {},
    get,
    pages,
    memo,
    readStored: () => null,
    compare: () => ({ commits: [], total_commits: 0 }),
  };
  const first = read({ ...opts, thisRun: judged(901, '2026-11-22T01:00:00Z') });
  const second = read({ ...opts, thisRun: judged(902, '2026-11-22T02:00:00Z') });
  assert.deepEqual(first.problems, []);
  assert.deepEqual(second.problems, []);
  assert.deepEqual(Object.keys(second.issues), ['6750', '6853']);
  // Each read once: the named run, main's history and the two issues with their comments.
  assert.equal(calls.length, 6, calls.join('\n'));
  assert.equal(calls.filter((c) => c.includes('/actions/workflows/')).length, 1);
  // Without a memo (journey-verdict.mjs's own run, one verdict) nothing is kept: each call reads afresh.
  calls.length = 0;
  read({ ...opts, memo: null, thisRun: judged(903, '2026-11-22T03:00:00Z') });
  read({ ...opts, memo: null, thisRun: judged(904, '2026-11-22T03:00:00Z') });
  assert.equal(calls.length, 12);
  // A read that failed is not kept: the next run reads it again, and it is a problem there too, never an answer.
  let down = true;
  const flaky = (path) => {
    if (down && path.endsWith('/actions/runs/1')) throw new Error('HTTP 502');
    return get(path);
  };
  const m2 = new Map();
  assert.match(read({ ...opts, get: flaky, memo: m2, thisRun: judged(905, '2026-11-22T03:00:00Z') }).problems.join(), /HTTP 502/);
  down = false;
  assert.deepEqual(read({ ...opts, get: flaky, memo: m2, thisRun: judged(906, '2026-11-22T03:00:00Z') }).problems, []);
});

// #10704: a step whose test showed a screen the hosted beta hides is not proven from the run.
const shown = (title, paths, f = bankFile, where = 'test') => {
  const a = paths ? [{ type: 'beta screens', description: JSON.stringify(paths) }] : [];
  return {
    title,
    file: f,
    tests: [where === 'test' ? { status: 'expected', annotations: a } : { status: 'expected', results: [{ annotations: a }] }],
  };
};

test("#10704: each step reads its screens from its tests' annotations, on the test or on a result; none without", () => {
  const r = readReport({
    suites: [
      {
        file: bankFile,
        specs: [
          shown('J-bank-05 #1', ['/money', '/trade/spot/BTC-USDT']),
          shown('J-bank-05 #2', ['/pay'], bankFile, 'result'),
          shown('J-bank-05 #3', null),
        ],
      },
    ],
  });
  assert.deepEqual([...r.screens['J-bank-05#1']], ['/money', '/trade/spot/BTC-USDT']);
  assert.deepEqual([...r.screens['J-bank-05#2']], ['/pay']);
  assert.equal(r.screens['J-bank-05#3'], undefined);
  assert.deepEqual([...betaScreensOf([{ annotations: [{ type: 'beta screens', description: 'not json' }] }])], []);
});

test('#10704: a step that visited a hidden path is not on the beta; one on shown rooms only, or with no page, is', () => {
  const screens = { 'J-a-01#2': new Set(['/home', '/dex/pools']), 'J-a-01#1': new Set(['/home']), 'J-a-01#10': new Set(['/dex/pools']) };
  const asked = [];
  const got = notOnBeta(screens, (paths) => (asked.push(paths), paths.filter((p) => p === '/dex/pools')));
  assert.deepEqual(asked, [['/dex/pools', '/home']], 'one call with every path');
  assert.deepEqual(got, {
    steps: [
      { step: 'J-a-01#2', paths: ['/dex/pools'] },
      { step: 'J-a-01#10', paths: ['/dex/pools'] },
    ],
  });
  assert.deepEqual(
    notOnBeta({}, () => assert.fail('no paths, no call')),
    { steps: [] },
  );
});

test('#10704: a beta rule that throws or gives no list is unread', () => {
  const screens = { 'J-a-01#1': new Set(['/home']) };
  assert.deepEqual(
    notOnBeta(screens, () => {
      throw new Error('Cannot find module dist/t.js\nstack');
    }),
    { steps: [], unread: 'Cannot find module dist/t.js' },
  );
  assert.equal(notOnBeta(screens, () => undefined).unread, 'the rule gave no list');
  assert.match(
    (() => {
      try {
        betaHidden(['/home'], { rule: '/nonexistent/beta-rule.mjs' });
      } catch (e) {
        return e.message;
      }
    })(),
    /Cannot find module/,
  );
});

test("#10704: the verdict's own run lists hidden-screen steps in notOnBeta, apart from notProven; an unread rule says so", () => {
  const verdict = fileURLToPath(new URL('./journey-verdict.mjs', import.meta.url));
  const run = (rule) => {
    const dir = mkdtempSync(join(tmpdir(), 'verdict-beta-'));
    try {
      mkdirSync(join(dir, 'docs/roadmap'), { recursive: true });
      mkdirSync(join(dir, 'services/svc-bank'), { recursive: true });
      mkdirSync(join(dir, 'history'));
      writeFileSync(join(dir, 'docs/roadmap/journeys.json'), JSON.stringify(bankSteps(1, 2, 3)));
      writeFileSync(join(dir, 'docs/roadmap/slices.json'), JSON.stringify(bankSlices));
      writeFileSync(join(dir, 'services/svc-bank/package.json'), JSON.stringify(bankManifests.get('services/svc-bank')));
      writeFileSync(join(dir, 'rule.mjs'), rule);
      const f = (name, body) => (writeFileSync(join(dir, name), JSON.stringify(body)), join(dir, name));
      const env = { ...process.env, GITHUB_STEP_SUMMARY: '' };
      delete env.JOURNEYS_TARGET;
      const report = {
        suites: [
          {
            file: bankFile,
            specs: [shown('J-bank-05 #1', ['/home']), shown('J-bank-05 #2', ['/home', '/hidden/room']), shown('J-bank-05 #3', null)],
          },
        ],
      };
      const args = [verdict, '--report', f('report.json', report), '--named-report', f('named.json', bankReport(1, 2, 3))];
      args.push('--history-dir', join(dir, 'history'), '--baseline', f('baseline.json', baseline1719));
      args.push('--set-aside-out', join(dir, 'set-aside.json'), '--beta-rule', join(dir, 'rule.mjs'));
      const r = spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8' });
      return { ...r, out: JSON.parse(readFileSync(join(dir, 'set-aside.json'), 'utf8')) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const hides = run(
    "import { readFileSync } from 'node:fs'; const p = JSON.parse(readFileSync(0, 'utf8')); process.stdout.write(JSON.stringify({ hidden: p.filter((x) => x.startsWith('/hidden')) }));",
  );
  assert.equal(hides.status, 0, hides.stdout + hides.stderr);
  assert.deepEqual(hides.out.notOnBeta, [{ step: 'J-bank-05#2', paths: ['/hidden/room'] }]);
  assert.deepEqual(hides.out.notProven, [], 'apart from notProven, which a reader sends to the flaky issue');
  assert.equal(hides.out.betaUnread, undefined);
  assert.equal(hides.out.incomplete, undefined, 'the set-aside list itself stays complete');
  assert.match(hides.stdout, /### On a screen the hosted beta hides: 1\n\n[^\n]*\n\n- J-bank-05#2: \/hidden\/room$/m);
  const broken = run("throw new Error('no dist');");
  assert.equal(broken.status, 0, 'an unread rule never turns the verdict red');
  assert.deepEqual(broken.out.notProven, []);
  assert.deepEqual(broken.out.notOnBeta, []);
  assert.match(broken.out.betaUnread, /no dist|Command failed/);
  assert.match(broken.stdout, /On a screen the hosted beta hides: unknown/);
  assert.match(broken.stdout, /no step of this run is known to be on the beta/);
});

// The beta gate (project-state decision PR #4060): on a pull request's run, a failing step on a screen the hosted beta
// hides holds nothing when it is neither money nor on the tester path; a money step, a tester-path step, main's own runs, an
// unread rule and a run after the gate lapses all gate as before.
test('the beta gate: only a known non-money step outside the tester path, from a readable rule, before it lapses', () => {
  assert.equal(BETA_GATE, 'narrow');
  assert.deepEqual([...TESTER_PATH].sort(), ['cex-spot', 'charts-desk', 'derivatives', 'home-ia', 'identity', 'portfolio', 'wallet']);
  const beta = {
    steps: ['J-algo-dev-01#1', 'J-identity-01#1', 'J-bank-05#1', 'J-x-01#1', 'J-algo-dev-01#2'].map((step) => ({ step, paths: ['/h'] })),
  };
  const guard = { 'J-algo-dev-01#1': false, 'J-identity-01#1': false, 'J-bank-05#1': true, 'J-x-01#1': false };
  const modules = { 'J-algo-dev-01': 'algo-dev', 'J-identity-01': 'identity', 'J-bank-05': 'bank' };
  const at = '2026-11-25T06:00:00Z';
  const got = (over = {}) => [...offBetaSteps({ beta, guard, modules, at, ...over })];
  // J-algo-dev-01#2 has no guard entry (unknown is money); J-x-01 has no module (unknown journey): both gate.
  assert.deepEqual(got(), ['J-algo-dev-01#1']);
  assert.deepEqual(got({ beta: { steps: [], unread: 'no dist' } }), [], 'an unread rule gates everything');
  assert.deepEqual(got({ beta: { unread: 'no list' } }), []);
  assert.deepEqual(got({ beta: undefined }), []);
  assert.deepEqual(got({ mode: 'full' }), [], "BETA_GATE 'full' switches it back");
  assert.deepEqual(got({ at: BETA_GATE_UNTIL }), [], 'a run created once it lapses gates everything');
  assert.deepEqual(got({ at: 'not a time' }), []);
});

test('the beta gate in judge: a non-money red it names is listed apart; a money red never is', () => {
  const named = readReport(report(ok('J-a-01 #1'), ok('J-a-01 #2')));
  const newest = readReport(report(bad('J-a-01 #1'), bad('J-a-01 #2')));
  const money = { 'J-a-01#1': false, 'J-a-01#2': true };
  const v = judge({ newest, named, baseline: { run: { number: 1 }, steps: [] }, money, offBeta: new Set(['J-a-01#1', 'J-a-01#2']) });
  assert.deepEqual(
    v.red.map((r) => r.step),
    ['J-a-01#2'],
    'the money step still gates, even if named',
  );
  assert.deepEqual(v.offBeta, [{ step: 'J-a-01#1', why: 'failing, not in the baseline', money: false }]);
  const none = judge({ newest, named, baseline: { run: { number: 1 }, steps: [] }, money });
  assert.deepEqual(
    none.red.map((r) => r.step),
    ['J-a-01#1', 'J-a-01#2'],
    'without the gate both are red',
  );
});

test('the beta gate, planted faults through the verdict itself: a hidden non-money step no longer holds; money, tester path, main, an unread rule and a lapsed gate do', () => {
  const verdict = fileURLToPath(new URL('./journey-verdict.mjs', import.meta.url));
  const journeys = [
    { id: 'J-algo-dev-01', module: 'algo-dev', steps: [{ n: 1, slices: ['AD-01'] }] },
    { id: 'J-identity-01', module: 'identity', steps: [{ n: 1, slices: ['ID-01'] }] },
    ...bankSteps(1),
  ];
  const slices = [{ id: 'AD-01', touches: ['customer: algo'] }, { id: 'ID-01', touches: ['customer: identity'] }, ...bankSlices];
  const hides =
    "import { readFileSync } from 'node:fs'; const p = JSON.parse(readFileSync(0, 'utf8')); process.stdout.write(JSON.stringify({ hidden: p.filter((x) => x.startsWith('/hidden')) }));";
  const step = (title, file, status, paths) => ({
    title,
    file,
    tests: [{ status, annotations: [{ type: 'beta screens', description: JSON.stringify(paths) }] }],
  });
  const run = ({ fail, paths = ['/hidden/room'], rule = hides, ref, now = '2026-11-25T06:00:00Z' }) => {
    const dir = mkdtempSync(join(tmpdir(), 'verdict-gate-'));
    try {
      mkdirSync(join(dir, 'docs/roadmap'), { recursive: true });
      mkdirSync(join(dir, 'services/svc-bank'), { recursive: true });
      mkdirSync(join(dir, 'history'));
      writeFileSync(join(dir, 'docs/roadmap/journeys.json'), JSON.stringify(journeys));
      writeFileSync(join(dir, 'docs/roadmap/slices.json'), JSON.stringify(slices));
      writeFileSync(join(dir, 'services/svc-bank/package.json'), JSON.stringify(bankManifests.get('services/svc-bank')));
      writeFileSync(join(dir, 'rule.mjs'), rule);
      const f = (name, body) => (writeFileSync(join(dir, name), JSON.stringify(body)), join(dir, name));
      const all = [
        ['J-algo-dev-01 #1', 'J-algo-dev-01.pw.mjs'],
        ['J-identity-01 #1', 'J-identity-01.pw.mjs'],
        ['J-bank-05 #1', bankFile],
      ];
      const rep = (failing) => ({
        suites: all.map(([title, file]) => ({
          file,
          specs: [step(title, file, title === failing ? 'unexpected' : 'expected', title === failing ? paths : ['/home'])],
        })),
      });
      const env = { ...process.env, GITHUB_STEP_SUMMARY: '' };
      delete env.JOURNEYS_TARGET;
      delete env.GITHUB_REF;
      if (ref) env.GITHUB_REF = ref;
      const args = [verdict, '--report', f('report.json', rep(fail)), '--named-report', f('named.json', rep(null))];
      args.push('--history-dir', join(dir, 'history'), '--baseline', f('baseline.json', baseline1719), '--now', now);
      args.push('--set-aside-out', join(dir, 'set-aside.json'), '--beta-rule', join(dir, 'rule.mjs'));
      const r = spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8' });
      return { ...r, out: JSON.parse(readFileSync(join(dir, 'set-aside.json'), 'utf8')) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const hidden = run({ fail: 'J-algo-dev-01 #1' });
  assert.equal(hidden.status, 0, `a hidden non-money step's red holds no pull request: ${hidden.stdout}${hidden.stderr}`);
  assert.match(
    hidden.stdout,
    /### Failing on a screen the hosted beta hides, not holding this pull request: 1\n\n[^\n]*\n\n- J-algo-dev-01#1: failing, not in the baseline$/m,
    'still listed',
  );
  assert.deepEqual(hidden.out.notOnBeta, [{ step: 'J-algo-dev-01#1', paths: ['/hidden/room'] }], 'still not proven');
  const tester = run({ fail: 'J-identity-01 #1' });
  assert.equal(tester.status, 1, 'a failing tester-path step blocks');
  assert.match(tester.stdout, /^- J-identity-01#1: failing, not in the baseline$/m);
  const moneyShown = run({ fail: 'J-bank-05 #1', paths: ['/home'] });
  assert.equal(moneyShown.status, 1, 'a failing money step on a beta screen blocks');
  assert.match(moneyShown.stdout, /^- J-bank-05#1 \(money\): failing, not in the baseline$/m);
  assert.equal(run({ fail: 'J-bank-05 #1' }).status, 1, 'a failing money step on a hidden screen blocks too');
  const unread = run({ fail: 'J-algo-dev-01 #1', rule: "throw new Error('no dist');" });
  assert.equal(unread.status, 1, 'an unread beta rule: everything gates as before');
  assert.match(unread.out.betaUnread, /no dist|Command failed/);
  const main = run({ fail: 'J-algo-dev-01 #1', ref: 'refs/heads/main' });
  assert.equal(main.status, 1, "main's own run judges every step as before");
  assert.deepEqual(
    [main.out.notOnBeta, main.out.notProven],
    [hidden.out.notOnBeta, hidden.out.notProven],
    'what the proof count reads is the same with the gate and without it',
  );
  assert.equal(run({ fail: 'J-algo-dev-01 #1', now: '2026-11-25T16:00:00Z' }).status, 1, 'a run after the gate lapses gates everything');
});
