/**
 * Unit tests for main-auto-revert.mjs: the bisect, the green-to-red rule, the loop guards and the order of side effects.
 * No network and no real git: `gh` and `git` are fakes.
 * Run: node --test tooling/scripts/main-auto-revert.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_PER_DAY,
  bisect,
  buildPrBody,
  buildRevertMessage,
  classifyTransition,
  isRevertCommit,
  prNumberFromSubject,
  ranJobs,
  runAutoRevert,
  waitForRequired,
} from './main-auto-revert.mjs';

const job = (name, conclusion) => ({ name, conclusion, status: 'completed', url: `https://example/job/${encodeURIComponent(name)}` });

test('classifyTransition: green to red, already red, not comparable', () => {
  const prev = [job('A', 'success'), job('B', 'failure'), job('C', 'skipped'), job('D', 'success')];
  const now = [job('A', 'failure'), job('B', 'failure'), job('C', 'failure'), job('D', 'success'), job('E', 'timed_out')];
  assert.deepEqual(classifyTransition(now, prev), { newlyRed: ['A'], alreadyRed: ['B'], unknown: ['C', 'E'] });
});

test('ranJobs: a run with only skipped jobs ran nothing', () => {
  assert.equal(ranJobs([job('a', 'skipped')]), false);
  assert.equal(ranJobs([]), false);
  assert.equal(ranJobs([job('a', 'skipped'), job('b', 'failure')]), true);
});

test('never revert a revert, ours included', () => {
  assert.equal(isRevertCommit('Revert "fix(trade): x (#1)" [auto-revert] (#2)'), true);
  assert.equal(isRevertCommit('Revert "feat: y" (#9)'), true);
  assert.equal(isRevertCommit('revert(pay): undo'), true);
  assert.equal(isRevertCommit('fix(pay): [auto-revert] in the middle'), true);
  assert.equal(isRevertCommit('fix(trade): reverts nothing (#4)'), false);
});

test('PR number comes from the squash subject suffix only', () => {
  assert.equal(prNumberFromSubject('fix(identity): x (#4617)'), '4617');
  assert.equal(prNumberFromSubject('fix: mentions (#12) in the middle'), null);
});

// Every position of the culprit in every range up to 12, every pattern of commits that have no run.
test('bisect: finds the exact first red commit whenever the answer is knowable (exhaustive)', async () => {
  for (let n = 1; n <= 8; n++) {
    const commits = Array.from({ length: n }, (_, i) => `c${i}`);
    for (let culprit = 0; culprit < n; culprit++) {
      for (let mask = 0; mask < 1 << n; mask++) {
        const noRun = (i) => i !== n - 1 && Boolean(mask & (1 << i)); // the red run's own commit always has a run
        const probes = [];
        const probe = async (sha) => {
          const i = Number(sha.slice(1));
          probes.push(i);
          if (noRun(i)) return 'unknown';
          return i >= culprit ? 'fail' : 'pass';
        };
        const r = await bisect(commits, probe);
        // First known-red index at or after the culprit, and last known-green before it:
        let firstRed = culprit;
        while (firstRed < n - 1 && noRun(firstRed)) firstRed++;
        let lastGreen = culprit - 1;
        while (lastGreen >= 0 && noRun(lastGreen)) lastGreen--;
        const expected = commits.slice(lastGreen + 1, firstRed + 1);
        const got = r.kind === 'culprit' ? [r.sha] : r.batch;
        assert.deepEqual(got, expected, `n=${n} culprit=${culprit} mask=${mask}`);
        assert.equal(r.kind, expected.length === 1 ? 'culprit' : 'ambiguous');
        assert.ok(got.includes(commits[culprit]), 'the true culprit is always inside the answer');
        assert.ok(!probes.includes(n - 1), 'the red run is never probed');
      }
    }
  }
});

test('bisect: log-many probes on a clean range', async () => {
  const commits = Array.from({ length: 64 }, (_, i) => `c${i}`);
  let calls = 0;
  const r = await bisect(commits, async (sha) => ((calls++, Number(sha.slice(1)) >= 40) ? 'fail' : 'pass'));
  assert.deepEqual(r, { kind: 'culprit', sha: 'c40' });
  assert.ok(calls <= 7, `used ${calls} probes`);
});

test('bisect: no completed run anywhere in the range is ambiguous, never a guess', async () => {
  const r = await bisect(['a', 'b', 'c'], async () => 'unknown');
  assert.deepEqual(r, { kind: 'ambiguous', batch: ['a', 'b', 'c'] });
});

// ---- the orchestrator with fakes ------------------------------------------------------------------------------

const sha = (c) => c.repeat(40);
const URL_OF = (id) => `https://github.com/o/r/actions/runs/${id}`;
const run = (id, c, conclusion, extra = {}) => ({
  databaseId: id,
  headSha: sha(c),
  conclusion,
  createdAt: '2026-10-13T00:00:00Z',
  url: URL_OF(id),
  attempt: 1,
  event: 'push',
  headBranch: 'main',
  workflowName: 'CI',
  status: 'completed',
  ...extra,
});
const GREEN = [job('Format', 'success'), job('Tests (full)', 'success'), job('Doctrine gates', 'success')];
const REDFMT = [job('Format', 'failure'), job('Tests (full)', 'success'), job('Doctrine gates', 'success')];

function world(over = {}) {
  const w = {
    // Newest first. Run 50 (commit e) is red on Format, attempt 2. Run 20 (commit b) is the last green. Nothing in between:
    // the baseline is always the ADJACENT comparable run, so the usual range is the one commit e (or a batch whose runs were cancelled).
    runs: [run(50, 'e', 'failure', { attempt: 2 }), run(20, 'b', 'success'), run(10, 'a', 'success')],
    jobs: { 50: REDFMT, 20: GREEN, 10: GREEN },
    commits: { range: [sha('e')], subjects: { [sha('c')]: 'fix: c (#3)', [sha('d')]: 'fix(pay): d (#4)', [sha('e')]: 'fix: e (#5)' } },
    openAuto: [],
    recentAuto: [],
    alreadyReverted: '',
    mergeResult: { status: 0 },
    checks: [
      { name: 'Gitleaks', bucket: 'pass' },
      { name: 'Dependency audit', bucket: 'pass' },
    ],
    issues: [],
    ...over,
  };
  const ghCalls = [];
  const gitCalls = [];
  const gh = (args, opts = {}) => {
    ghCalls.push(args);
    const k = args.join(' ');
    const ok = (v) => ({ status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
    if (k.startsWith('run list')) return ok(w.runs);
    if (k.startsWith('run view')) return ok({ jobs: w.jobs[args[2]] ?? [] });
    if (k.startsWith('pr list')) return ok(w.openAuto);
    if (k.startsWith('run rerun')) return ok('');
    if (k.startsWith('pr create')) return ok('https://github.com/o/r/pull/900\n');
    if (k.startsWith('workflow run')) return ok('');
    if (k.startsWith('pr checks')) return ok(w.checks);
    if (k.startsWith('pr merge')) return { ...w.mergeResult, stdout: '', stderr: w.mergeResult.status ? 'blocked' : '' };
    if (k.startsWith('issue list')) return ok(w.issues);
    if (k.startsWith('issue create')) return ok('https://github.com/o/r/issues/901\n');
    throw new Error(`unexpected gh: ${k}`);
  };
  const git = (args, opts = {}) => {
    gitCalls.push({ args, input: opts.input });
    const k = args.join(' ');
    const out = (stdout, status = 0) => ({ status, stdout, stderr: '' });
    if (k.startsWith('log origin/main --since')) return out(w.recentAuto.join('\n'));
    if (k.startsWith('merge-base')) return out('');
    if (k.startsWith('rev-list')) return out(w.commits.range.join('\n'));
    if (k.startsWith('log -1 --format=%s')) return out(`${w.commits.subjects[args.at(-1)]}\n`);
    if (k.startsWith('log origin/main --fixed-strings --grep=This reverts')) return out(w.alreadyReverted);
    if (k.startsWith('revert --no-commit')) return out('', w.revertStatus ?? 0);
    if (k.includes('rev-parse HEAD')) return out(`${sha('f')}\n`);
    return out('');
  };
  return { gh, git, ghCalls, gitCalls, w };
}
const opts = (extra = {}) => ({ runId: '50', dryRun: false, confirmRerun: true, repo: 'o/r', ...extra });
const ctx = (wd) => ({ gh: wd.gh, git: wd.git, now: () => 0, sleep: async () => {} });

test('attempt 1: only re-runs the failed jobs, changes nothing else', async () => {
  const wd = world({ runs: [run(50, 'e', 'failure'), run(20, 'b', 'success')] });
  const r = await runAutoRevert(opts(), ctx(wd));
  assert.equal(r.outcome, 'rerun-requested');
  assert.deepEqual(wd.ghCalls.filter((a) => a[0] === 'run' && a[1] === 'rerun').length, 1);
  assert.equal(
    wd.ghCalls.some((a) => a[0] === 'pr' && (a[1] === 'create' || a[1] === 'merge')),
    false,
  );
  assert.equal(
    wd.gitCalls.some((c) => ['push', 'commit', 'checkout'].includes(c.args[0])),
    false,
  );
});

test('attempt 2 with a one-commit range: branch, revert commit, PR, required workflows, merge; in that order', async () => {
  const wd = world();
  const r = await runAutoRevert(opts(), ctx(wd));
  assert.equal(r.outcome, 'done');
  assert.equal(r.done[0].done, true);
  assert.equal(r.done[0].sha, sha('e'));
  const order = wd.gitCalls.map((c) => c.args.find((x) => ['fetch', 'checkout', 'revert', 'commit', 'push'].includes(x))).filter(Boolean);
  assert.deepEqual(order, ['fetch', 'checkout', 'revert', 'commit', 'push']);
  const msg = wd.gitCalls.find((c) => c.args.includes('commit')).input;
  assert.match(msg, /^Revert "fix: e \(#5\)" \[auto-revert\]/);
  assert.match(msg, /This reverts commit e{40}\./);
  assert.match(msg, /Main went red on: Format\./);
  const names = wd.ghCalls.map((a) => a.slice(0, 2).join(' '));
  assert.ok(names.indexOf('pr create') < names.indexOf('workflow run') && names.lastIndexOf('workflow run') < names.indexOf('pr merge'));
  const merge = wd.ghCalls.find((a) => a[1] === 'merge');
  assert.ok(merge.includes('--squash') && merge.includes('--match-head-commit') && !merge.includes('--admin') && !merge.includes('--auto'));
  const create = wd.ghCalls.find((a) => a[1] === 'create');
  assert.ok(create.includes('auto-revert/eeeeeee') && create.includes('main'));
  assert.deepEqual(
    wd.ghCalls.filter((a) => a[0] === 'workflow').map((a) => a[2]),
    ['gitleaks.yml', 'supply-chain.yml'],
  );
});

test('a commit whose run was cancelled but whose job finished is still evidence (job by job)', async () => {
  // Range c,d,e. c's run was cancelled after Format passed, d's after Format failed => culprit is d, not the batch.
  const wd = world({
    runs: [run(50, 'e', 'failure', { attempt: 2 }), run(40, 'd', 'cancelled'), run(30, 'c', 'cancelled'), run(20, 'b', 'success')],
    jobs: { 50: REDFMT, 40: REDFMT, 30: [job('Format', 'success')], 20: GREEN },
    commits: {
      range: [sha('c'), sha('d'), sha('e')],
      subjects: { [sha('c')]: 'fix: c (#3)', [sha('d')]: 'fix(pay): d (#4)', [sha('e')]: 'fix: e (#5)' },
    },
  });
  const r = await runAutoRevert(opts({ dryRun: true }), ctx(wd));
  assert.equal(r.actions[0].sha, sha('d'));
});

test('attempt 2 with commits that have no run in front of the first red run: ambiguous, opens an issue, reverts nothing', async () => {
  const wd = world({
    commits: {
      range: [sha('c'), sha('d'), sha('e')],
      subjects: { [sha('c')]: 'fix: c (#3)', [sha('d')]: 'fix(pay): d (#4)', [sha('e')]: 'fix: e (#5)' },
    },
  });
  const r = await runAutoRevert(opts(), ctx(wd));
  assert.equal(r.outcome, 'done');
  assert.equal(r.done[0].type, 'issue');
  assert.equal(r.actions[0].batch.length, 3);
  assert.ok(wd.ghCalls.some((a) => a[0] === 'issue' && a[1] === 'create'));
  assert.equal(
    wd.gitCalls.some((c) => c.args[0] === 'push'),
    false,
  );
  assert.equal(
    wd.ghCalls.some((a) => a[0] === 'pr' && a[1] === 'create'),
    false,
  );
});

test('already red on the previous run: nothing happens (main is already red on that job)', async () => {
  const wd = world({
    runs: [run(50, 'e', 'failure', { attempt: 2 }), run(20, 'b', 'failure'), run(10, 'a', 'success')],
    jobs: { 50: REDFMT, 20: REDFMT, 10: GREEN },
  });
  const r = await runAutoRevert(opts(), ctx(wd));
  assert.equal(r.outcome, 'skip');
  assert.match(r.reason, /no green-to-red transition/);
  assert.deepEqual(r.transition.alreadyRed, ['Format']);
});

test('baseline skips cancelled runs and runs that ran no jobs', async () => {
  const wd = world({
    runs: [run(50, 'e', 'failure', { attempt: 2 }), run(45, 'd', 'cancelled'), run(40, 'c', 'failure'), run(20, 'b', 'success')],
    jobs: { 50: REDFMT, 40: [job('Format', 'skipped')], 20: GREEN },
  });
  const r = await runAutoRevert(opts({ dryRun: true }), ctx(wd));
  assert.equal(r.baseline, 20);
});

test('never revert a revert', async () => {
  const wd = world({ commits: { range: [sha('e')], subjects: { [sha('e')]: 'Revert "fix: something" [auto-revert] (#8)' } } });
  const r = await runAutoRevert(opts(), ctx(wd));
  assert.equal(r.done[0].done, false);
  assert.match(r.actions[0].reason, /never revert a revert/);
  assert.equal(
    wd.gitCalls.some((c) => c.args[0] === 'push'),
    false,
  );
});

test('guards: one in flight, circuit breaker, already reverted', async () => {
  const base = {};
  const inflight = await runAutoRevert(opts(), ctx(world({ ...base, openAuto: [{ number: 5, headRefName: 'auto-revert/abc1234' }] })));
  assert.match(inflight.reason, /already open/);
  const breaker = await runAutoRevert(opts(), ctx(world({ ...base, recentAuto: Array.from({ length: MAX_PER_DAY }, (_, i) => `h${i}`) })));
  assert.match(breaker.reason, /circuit breaker/);
  const wd = world({ ...base, alreadyReverted: sha('9') });
  const reverted = await runAutoRevert(opts(), ctx(wd));
  assert.match(reverted.actions[0].reason, /already reverted/);
  assert.equal(
    wd.gitCalls.some((c) => c.args[0] === 'push'),
    false,
  );
});

test('dry run touches nothing: no rerun, no git write, no PR, no issue', async () => {
  const attempt1 = world({ runs: [run(50, 'e', 'failure'), run(20, 'b', 'success')] });
  const a = await runAutoRevert(opts({ dryRun: true }), ctx(attempt1));
  assert.equal(a.outcome, 'would-rerun');
  const wd = world();
  const r = await runAutoRevert(opts({ dryRun: true }), ctx(wd));
  assert.equal(r.outcome, 'dry-run');
  assert.equal(r.actions[0].type, 'revert');
  for (const x of [attempt1, wd]) {
    assert.equal(
      x.ghCalls.some((c) => ['rerun', 'create', 'merge'].includes(c[1]) || c[0] === 'workflow'),
      false,
    );
    assert.equal(
      x.gitCalls.some((c) => ['push', 'commit', 'checkout', 'revert', 'fetch'].includes(c.args[0])),
      false,
    );
  }
});

test('a revert that conflicts is abandoned without pushing', async () => {
  const wd = world({ revertStatus: 1 });
  const r = await runAutoRevert(opts(), ctx(wd));
  assert.equal(r.done[0].done, false);
  assert.match(r.done[0].reason, /conflicts/);
  assert.equal(
    wd.gitCalls.some((c) => c.args[0] === 'push'),
    false,
  );
});

test('a refused merge leaves the PR open and reports it', async () => {
  const wd = world({ mergeResult: { status: 1 } });
  const r = await runAutoRevert(opts(), ctx(wd));
  assert.equal(r.done[0].done, false);
  assert.match(r.done[0].reason, /not merged/);
  assert.equal(r.done[0].pr, 'https://github.com/o/r/pull/900');
});

test('not a failed push run of ci on main: skipped', async () => {
  const wd = world({ runs: [run(50, 'e', 'success')] });
  assert.equal((await runAutoRevert(opts(), ctx(wd))).outcome, 'skip');
  assert.equal((await runAutoRevert(opts({ runId: '999' }), ctx(world()))).outcome, 'skip');
});

test('waitForRequired: stops at a failure, passes on success, gives up at the deadline without throwing', async () => {
  let t = 0;
  const mk = (checks) => () => ({ status: 0, stdout: JSON.stringify(checks), stderr: '' });
  const clock = { now: () => t, sleep: async (ms) => void (t += ms) };
  assert.deepEqual(await waitForRequired(mk([{ name: 'Gitleaks', bucket: 'fail' }]), 'o/r', 1, clock), { failed: ['Gitleaks'] });
  assert.deepEqual(
    await waitForRequired(
      mk([
        { name: 'Gitleaks', bucket: 'pass' },
        { name: 'Dependency audit', bucket: 'pass' },
      ]),
      'o/r',
      1,
      clock,
    ),
    { failed: [] },
  );
  assert.deepEqual(await waitForRequired(mk([]), 'o/r', 1, { ...clock, timeoutMs: 60_000, pollMs: 30_000 }), { failed: [] });
});

test('messages name the failing jobs and both runs', () => {
  const a = {
    sha: sha('d'),
    subject: 'fix(pay): d (#4)',
    pr: '4',
    jobs: ['Format'],
    run: run(50, 'e', 'failure'),
    baseline: run(20, 'b', 'success'),
    jobLinks: { Format: 'https://x/job/1' },
  };
  assert.match(buildRevertMessage(a), /Main went red on: Format\./);
  const body = buildPrBody(a);
  assert.match(body, /\[Format\]\(https:\/\/x\/job\/1\)/);
  assert.match(body, /runs\/50/);
  assert.match(body, /runs\/20/);
  assert.match(body, /#4/);
});
