/**
 * Unit tests for merge-gate.mjs. No network: `gh` is a fake that answers from fixture JSON and log excerpts shaped like
 * the real output (captured 2026-10-13 from `gh pr checks --json`, `gh run list --json`, `gh run view --json jobs`,
 * `gh run view --job <id> --log`).
 * Run: node --test tooling/scripts/merge-gate.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GitHubRefusalError } from './gate-gh.mjs';
import {
  AGENT_RULE_PATTERNS,
  CI_PR_PATHS,
  KNOWN_PR_ONLY_RED,
  MAIN_WINDOW,
  collapseChecks,
  ciWouldRun,
  evaluate,
  mainCopyProblem,
  makeLogStore,
  mergeCommand,
  parseDoctrineFailures,
  parseFailedTests,
  parseTurboFailures,
  renderComment,
  runGate,
  selectMainRun,
  selectMainWindow,
} from './merge-gate.mjs';

const HEAD = 'a'.repeat(40);
const REPO = 'Phantom-X-007/intafaced';
const FIX = new URL('./fixtures/merge-gate/', import.meta.url);
const fx = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, FIX), 'utf8'));
const log = (name) => readFileSync(new URL(`${name}.log`, FIX), 'utf8');
let nextJob = 9000;
const jobIds = new Map();
const chk = (name, bucket, workflow = 'CI', completedAt = '2026-10-13T12:00:00Z') => {
  const k = `${workflow}/${name}`;
  if (!jobIds.has(k)) jobIds.set(k, ++nextJob);
  return {
    name,
    bucket,
    workflow,
    completedAt,
    state: bucket.toUpperCase(),
    link: `https://github.com/o/r/actions/runs/1/job/${jobIds.get(k)}`,
  };
};
const prJobId = (name, workflow = 'CI') => jobIds.get(`${workflow}/${name}`);
const REQ_OK = [chk('Gitleaks', 'pass', 'PR checks'), chk('Dependency audit', 'pass', 'PR checks')];
const K = (name) => `CI/${name}`;

/** A fake gh. `world` holds the fixture answers; `calls` records every invocation. */
function fakeGh(world) {
  const calls = [];
  const gh = (args, opts = {}) => {
    calls.push({ args, input: opts.input });
    const k = args.join(' ');
    const ok = (v) => ({ status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
    if (world.refuse && k.startsWith(world.refuse)) throw new GitHubRefusalError('GitHub refused: HTTP 403');
    if (k.startsWith('pr view')) return ok(typeof world.pr === 'function' ? world.pr() : world.pr);
    if (k.includes('/files')) return ok(world.files.join('\n'));
    if (k.startsWith('pr checks')) {
      const v = typeof world.checks === 'function' ? world.checks() : world.checks;
      return v === null
        ? { status: 1, stdout: '', stderr: "no checks reported on the 'x' branch" }
        : { status: 1, stdout: JSON.stringify(v), stderr: '' };
    }
    if (k.startsWith('run list') && k.includes('--commit')) return ok(world.prRuns ?? []);
    if (k.startsWith('run list')) return ok(world.mainRuns ?? []);
    if (k.startsWith('run view --job')) {
      const id = args[3];
      if (!(id in (world.logs ?? {}))) throw new Error(`no log fixture for job ${id}`);
      return ok(world.logs[id]);
    }
    if (k.startsWith('run view')) return ok({ jobs: world.mainJobs[args[2]] ?? [] });
    if (k.startsWith('pr comment')) return ok('');
    throw new Error(`unexpected gh call: ${k}`);
  };
  return { gh, calls };
}
const basePr = (extra = {}) => ({
  number: 7,
  state: 'OPEN',
  isDraft: false,
  headRefOid: HEAD,
  baseRefName: 'main',
  title: 'fix(trade): thing',
  mergeable: 'MERGEABLE',
  url: 'u',
  ...extra,
});
const opts = (extra = {}) => ({ pr: 7, head: HEAD, repo: REPO, timeoutMin: 5, pollSec: 1, ciGraceSec: 60, comment: true, ...extra });
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
};
const mainWorld = { mainRuns: fx('main-runs'), mainJobs: { 300: fx('main-jobs-300'), 200: fx('main-jobs-200') } };
const mainJobId = (name) => fx('main-jobs-200').find((j) => j.name === name).databaseId;
const PASSRUN = [{ workflowName: 'CI', status: 'completed' }];

test('collapseChecks keeps the latest attempt per workflow+name, and does not merge same-named jobs of different workflows', () => {
  const out = collapseChecks([
    chk('A', 'fail', 'CI', '2026-10-13T10:00:00Z'),
    chk('A', 'pass', 'CI', '2026-10-13T11:00:00Z'),
    chk('B', 'pending', 'CI', '0001-01-01T00:00:00Z'),
    chk('A', 'fail', 'Other', '2026-10-13T12:00:00Z'),
  ]);
  assert.equal(out.length, 3);
  assert.equal(out.find((c) => c.name === 'A' && c.workflow === 'CI').bucket, 'pass');
  assert.equal(out.find((c) => c.name === 'B').bucket, 'pending');
});

test('ci path filter: docs-only runs, and so do code and the doctrine file', () => {
  assert.equal(ciWouldRun(['docs/a.md', 'README.md', 'NOTICE', 'LICENSE', 'docs/deep/x.png']), true);
  assert.equal(ciWouldRun(['docs/a.md', 'services/svc-pay/src/a.ts']), true);
  assert.equal(ciWouldRun(['INTAFACED_DEFINITIVE_BUILD.md']), true);
  assert.equal(ciWouldRun(['packages/x/README.md']), true);
});

test('agent-rule files are never docs-only, even though they are markdown', () => {
  for (const f of [
    'AGENTS.md',
    'CLAUDE.md',
    'apps/x/AGENTS.md',
    'tooling/agent-protocol/AGENT_PROTOCOL.md',
    'tooling/agent-protocol/other.md',
    '.agents/skills/foo/SKILL.md',
    'docs/some/SKILL.md',
    '.cursor/rules/inta.md',
  ]) {
    assert.equal(ciWouldRun([f]), true, f);
    assert.equal(ciWouldRun([f], ['**', '!**/*.md']), true, `${f} even if the mirrored filter were wrong`);
  }
  const r = evaluate({ checks: REQ_OK, mainFailing: new Set(), files: ['AGENTS.md'], title: 'docs: rules', ciPresent: false });
  assert.equal(r.pass, false);
  assert.match(r.reasons.join(), /CI never started/);
});

// The one test that reads the repo. It skips where the repo is absent (the empty-denominator gate runs this suite in a
// tree that holds only tooling/), and it must run in any real checkout.
const CI_YML = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url));
test(
  'CI_PR_PATHS mirrors ci.yml on.pull_request.paths (drift guard)',
  { skip: !existsSync(CI_YML) && 'ci.yml not present (empty-tree run)' },
  () => {
    const yml = readFileSync(CI_YML, 'utf8');
    const block = yml.match(/pull_request:\n {4}paths:\n((?: {6}(?:- .*|#.*)\n)+)/)?.[1] ?? '';
    const paths = block
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => l.replace(/^ +- /, '').replace(/^'|'$/g, ''));
    assert.deepEqual(paths, CI_PR_PATHS);
    assert.ok(AGENT_RULE_PATTERNS.every((p) => paths.includes(p)));
  },
);

test('ratchet: failure also on main is excused; failure absent from main is new', () => {
  const checks = [...REQ_OK, chk('Doctrine gates', 'fail'), chk('Format', 'pass'), chk('Typecheck & build', 'fail')];
  const r = evaluate({
    checks,
    mainFailing: new Set([K('Doctrine gates'), K('Tests (full)')]),
    mainJobs: new Set([K('Doctrine gates'), K('Tests (full)'), K('Format'), K('Typecheck & build')]),
    files: ['a.ts'],
    title: 'fix: x',
    ciPresent: true,
  });
  assert.equal(r.pass, false);
  assert.deepEqual(
    r.excusedOnMain.map((c) => c.name),
    ['Doctrine gates'],
  );
  assert.deepEqual(
    r.newFailures.map((c) => c.name),
    ['Typecheck & build'],
  );
});

test('a red PR test shard is never excused, even while main "Tests (full)" is red (shards print no ids)', () => {
  const r = evaluate({
    checks: [...REQ_OK, chk('Tests (money)', 'fail')],
    mainFailing: new Set([K('Tests (full)')]),
    files: ['a.ts'],
    title: 'fix: x',
    ciPresent: true,
  });
  assert.deepEqual(
    r.newFailures.map((c) => c.name),
    ['Tests (money)'],
  );
  assert.equal(r.pass, false);
});

test('a same-named job in another workflow neither hides nor is excused', () => {
  const evil = chk('Doctrine gates', 'fail', 'Some other workflow');
  const r = evaluate({
    checks: [...REQ_OK, evil],
    mainFailing: new Set([K('Doctrine gates')]),
    files: ['a.ts'],
    title: 'fix: x',
    ciPresent: true,
  });
  assert.deepEqual(
    r.newFailures.map((c) => c.workflow),
    ['Some other workflow'],
  );
  // and a fake "Gitleaks" in another workflow does not satisfy the required check
  const fake = evaluate({
    checks: [chk('Gitleaks', 'pass', 'Not Gitleaks'), chk('Dependency audit', 'pass', 'PR checks')],
    mainFailing: new Set(),
    files: ['docs/a.md'],
    title: 'docs: x',
    ciPresent: false,
  });
  assert.equal(fake.pass, false);
  assert.match(fake.reasons.join(), /"Gitleaks" \(workflow "PR checks"\) never reported/);
});

test('ratchet passes when every failure is also on main (name level)', () => {
  const r = evaluate({
    checks: [...REQ_OK, chk('Doctrine gates', 'fail')],
    mainFailing: new Set([K('Doctrine gates')]),
    files: ['a.ts'],
    title: 'fix: x',
    ciPresent: true,
  });
  assert.equal(r.pass, true);
  assert.equal(r.excusedOnMain.length, 1);
});

test('known PR-only red (CX-8) is allowed, but only because it is listed and absent from main', () => {
  assert.ok('Order-path CX-8/CX-8 assembled smoke' in KNOWN_PR_ONLY_RED);
  const checks = [...REQ_OK, chk('CX-8 assembled smoke', 'fail', 'Order-path CX-8'), chk('Other PR job', 'fail', 'Other')];
  const r = evaluate({ checks, mainFailing: new Set(), mainJobs: new Set(), files: ['a.ts'], title: 'fix: x', ciPresent: true });
  assert.deepEqual(
    r.knownRed.map((c) => c.name),
    ['CX-8 assembled smoke'],
  );
  assert.deepEqual(
    r.newFailures.map((c) => c.name),
    ['Other PR job'],
  );
  assert.equal(r.pass, false);
  // same job name under a different workflow is not the known one
  const other = evaluate({
    checks: [...REQ_OK, chk('CX-8 assembled smoke', 'fail', 'Elsewhere')],
    mainFailing: new Set(),
    files: ['a.ts'],
    title: 'fix: x',
    ciPresent: true,
  });
  assert.equal(other.knownRed.length, 0);
});

test('required checks are never excused, even if main "fails" a job of the same name', () => {
  const r = evaluate({
    checks: [chk('Gitleaks', 'fail', 'PR checks'), chk('Dependency audit', 'pass', 'PR checks')],
    mainFailing: new Set(['PR checks/Gitleaks']),
    files: ['a.md'],
    title: 'docs: x',
    ciPresent: false,
  });
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /Gitleaks/);
});

test('a cancelled check on the PR counts as failing', () => {
  const r = evaluate({
    checks: [...REQ_OK, chk('Tests (full)', 'cancel')],
    mainFailing: new Set(),
    files: ['a.ts'],
    title: 'fix: x',
    ciPresent: true,
  });
  assert.equal(r.pass, false);
});

test('docs-only PR with CI absent fails, and a failing Docs format check still blocks', () => {
  const r = evaluate({ checks: REQ_OK, mainFailing: new Set(), files: ['docs/x.md'], title: 'docs: x', ciPresent: false });
  assert.equal(r.pass, false);
  assert.equal(r.docsOnly, false);
  assert.match(r.reasons.join(), /CI never started/);
  const bad = evaluate({
    checks: [...REQ_OK, chk('Prettier (docs)', 'fail', 'Docs format')],
    mainFailing: new Set(),
    files: ['docs/x.md'],
    title: 'docs: x',
    ciPresent: true,
  });
  assert.equal(bad.pass, false);
  assert.deepEqual(
    bad.newFailures.map((c) => c.name),
    ['Prettier (docs)'],
  );
});

test('a code PR with no CI at all is a failure, not a docs-only pass', () => {
  const r = evaluate({ checks: REQ_OK, mainFailing: new Set(), files: ['services/a.ts'], title: 'fix: x', ciPresent: false });
  assert.equal(r.pass, false);
  assert.match(r.reasons.join(), /CI never started/);
});

test('an undeclared gate-file change fails; a declared one passes', () => {
  const bad = evaluate({
    checks: REQ_OK,
    mainFailing: new Set(),
    files: ['tooling/ci/dependency-audit.mjs', 'docs/a.md'],
    title: 'fix(db): migration',
    ciPresent: true,
  });
  assert.equal(bad.pass, false);
  const ok = evaluate({
    checks: REQ_OK,
    mainFailing: new Set(),
    files: ['tooling/ci/dependency-audit.mjs'],
    title: 'ci: widen allowlist',
    ciPresent: true,
  });
  assert.equal(ok.pass, true);
});

test('verdict names the jobs main ran that were skipped or absent on the PR', () => {
  const r = evaluate({
    checks: [...REQ_OK, chk('Format', 'pass'), chk('Tests (money)', 'skipping')],
    mainFailing: new Set(),
    mainJobs: new Set([K('Format'), K('Tests (money)'), K('Tests (trade)')]),
    files: ['a.ts'],
    title: 'fix: x',
    ciPresent: true,
  });
  assert.deepEqual(r.notCompared.sort(), ['Tests (money) (skipped)', 'Tests (trade) (absent)']);
  assert.match(
    renderComment({ verdict: 'PASS', head: HEAD, pr: 7, main: null, checks: REQ_OK, evalResult: r }),
    /Not compared.*Tests \(money\) \(skipped\).*Tests \(trade\) \(absent\)/,
  );
});

test('log parsers read the real log format', () => {
  assert.deepEqual([...parseDoctrineFailures(log('doctrine-main'))].sort(), [
    'money-skip-honesty',
    'secrets',
    'skip-honesty',
    'test-db',
    'workspace',
  ]);
  assert.deepEqual([...parseTurboFailures(log('turbo-main'))].sort(), [
    '@intafaced/svc-indexer#test',
    '@intafaced/svc-notify#test',
    '@intafaced/svc-ops#test',
    '@intafaced/svc-support#test',
  ]);
  assert.equal(parseDoctrineFailures('nothing here').size, 0);
  assert.equal(parseTurboFailures('').size, 0);
});

test('selectMainRun skips cancelled runs and runs that ran no jobs, and keys jobs by workflow/name', async () => {
  const { gh, calls } = fakeGh(mainWorld);
  const m = await selectMainRun(gh, REPO);
  assert.equal(m.run.databaseId, 200); // 400 cancelled, 300 had only skipped jobs, 200 is the first real one
  assert.deepEqual([...m.failing].sort(), [K('CI merge seal'), K('Doctrine gates'), K('Tests (full)')]);
  assert.ok(
    calls.some((c) => c.args.includes('300')),
    'looked at the jobs-less run before skipping it',
  );
});

test('selectMainRun returns null when no run ran jobs', async () => {
  const { gh } = fakeGh({ mainRuns: fx('main-runs').filter((r) => r.conclusion === 'cancelled'), mainJobs: {} });
  assert.equal(await selectMainRun(gh, REPO), null);
});

const DOCTRINE_STEP = 'Doctrine gates (the same list `pnpm verify` runs)';
const STEPS = {
  'Doctrine gates': [DOCTRINE_STEP],
  'Tests (full)': ['Run pnpm test --continue', 'Every infrastructure-backed suite actually ran'],
};
/** `extraSteps`: { 'Tests (full)': ['Foundry fuzz (S-A8)'] } adds failing steps main does not have. */
function logWorld({ doctrinePr, turboPr, checks, extraSteps = {} }) {
  const logs = {
    [mainJobId('Doctrine gates')]: log('doctrine-main'),
    [mainJobId('Tests (full)')]: log('turbo-main'),
  };
  const all = [...REQ_OK, ...checks];
  if (doctrinePr) logs[prJobId('Doctrine gates')] = log(doctrinePr);
  if (turboPr) logs[prJobId('Tests (full)')] = log(turboPr);
  // The PR run's jobs, as `gh run view 1 --json jobs` returns them (the check links point at run 1).
  const prJobs = all
    .filter((c) => c.bucket === 'fail')
    .map((c) => ({
      databaseId: prJobId(c.name, c.workflow),
      name: c.name,
      steps: [...(STEPS[c.name] ?? [`Run ${c.name}`]), ...(extraSteps[c.name] ?? [])].map((name) => ({ name, conclusion: 'failure' })),
    }));
  return {
    pr: basePr(),
    files: ['services/svc-pay/a.ts'],
    checks: all,
    prRuns: PASSRUN,
    ...mainWorld,
    mainJobs: { ...mainWorld.mainJobs, 1: prJobs },
    logs,
  };
}

test('runGate: PASS posts one comment and prints the merge command, never merges', async () => {
  const doctrine = chk('Doctrine gates', 'fail');
  const world = logWorld({ doctrinePr: 'doctrine-main', checks: [doctrine, chk('Format', 'pass'), chk('Definition of Done', 'skipping')] });
  const { gh, calls } = fakeGh(world);
  const r = await runGate(opts(), { gh, ...clock() });
  assert.equal(r.code, 0, r.evalResult.reasons.join());
  assert.equal(r.mergeCommand, `gh pr merge 7 --match-head-commit ${HEAD} -R ${REPO} --squash`);
  assert.equal(r.mergeCommand, mergeCommand(7, HEAD));
  const comments = calls.filter((x) => x.args[0] === 'pr' && x.args[1] === 'comment');
  assert.equal(comments.length, 1);
  assert.match(comments[0].input, /Merge gate: PASS/);
  assert.match(comments[0].input, /Compared against.*main CI push run/);
  assert.match(comments[0].input, /Log comparison.*Doctrine gates: 5 failing doctrine gate\(s\), all also failing on main/);
  assert.equal(
    calls.some((x) => x.args.includes('merge')),
    false,
    'the gate must never merge',
  );
});

test('runGate: a NEW doctrine gate failing inside an already-red "Doctrine gates" is a FAIL (the blocker case)', async () => {
  const world = logWorld({ doctrinePr: 'doctrine-pr-new', checks: [chk('Doctrine gates', 'fail')] });
  const { gh, calls } = fakeGh(world);
  const r = await runGate(opts(), { gh, ...clock() });
  assert.equal(r.code, 1);
  assert.equal(r.mergeCommand, undefined);
  assert.match(r.evalResult.reasons.join(), /new failing doctrine gate\(s\) not failing on main: brand/);
  assert.match(calls.find((x) => x.args[1] === 'comment').input, /NEW failures.*Doctrine gates.*brand/);
});

test('runGate: a NEW failing test task inside an already-red "Tests (full)" is a FAIL; a subset passes', async () => {
  const bad = fakeGh(logWorld({ turboPr: 'turbo-pr-new', checks: [chk('Tests (full)', 'fail')] }));
  const r1 = await runGate(opts(), { gh: bad.gh, ...clock() });
  assert.equal(r1.code, 1);
  assert.match(r1.evalResult.reasons.join(), /svc-pay#test/);
  const good = fakeGh(logWorld({ turboPr: 'turbo-pr-subset', checks: [chk('Tests (full)', 'fail')] }));
  const r2 = await runGate(opts(), { gh: good.gh, ...clock() });
  assert.equal(r2.code, 0, r2.evalResult.reasons.join());
});

test('runGate: every red PR shard blocks, whatever its log says', async () => {
  const w = logWorld({ checks: [chk('Tests (money)', 'fail')] });
  w.logs[prJobId('Tests (money)')] = log('turbo-pr-subset');
  const r = await runGate(opts(), { gh: fakeGh(w).gh, ...clock() });
  assert.equal(r.code, 1);
  assert.match(r.evalResult.reasons.join(), /Tests \(money\)/);
});

test('runGate: a new failing STEP inside an already-red "Tests (full)" blocks, even when the task ids are a subset', async () => {
  const w = logWorld({
    turboPr: 'turbo-pr-subset',
    checks: [chk('Tests (full)', 'fail')],
    extraSteps: { 'Tests (full)': ['Foundry fuzz (S-A8)'] },
  });
  const r = await runGate(opts(), { gh: fakeGh(w).gh, ...clock() });
  assert.equal(r.code, 1);
  assert.match(r.evalResult.reasons.join(), /new failing step\(s\) not failing on main: Foundry fuzz \(S-A8\)/);
  const ok = await runGate(opts(), {
    gh: fakeGh(logWorld({ turboPr: 'turbo-pr-subset', checks: [chk('Tests (full)', 'fail')] })).gh,
    ...clock(),
  });
  assert.equal(ok.code, 0, ok.evalResult.reasons.join());
  assert.ok(ok.evalResult.logChecks.some((l) => /failing step\(s\).*all also fail on main/.test(l)));
});

test('runGate: a red job that lists no failing step is not excused', async () => {
  const w = logWorld({ doctrinePr: 'doctrine-main', checks: [chk('Doctrine gates', 'fail')] });
  w.mainJobs[1] = w.mainJobs[1].map((j) => ({ ...j, steps: [] }));
  const r = await runGate(opts(), { gh: fakeGh(w).gh, ...clock() });
  assert.equal(r.code, 1);
  assert.match(r.evalResult.reasons.join(), /no failing step is listed/);
});

test('runGate: ids that cannot be read from the log count as new, never as excused', async () => {
  const w = logWorld({ checks: [chk('Doctrine gates', 'fail')] });
  w.logs[prJobId('Doctrine gates')] = 'the job died before printing a summary\n';
  const r = await runGate(opts(), { gh: fakeGh(w).gh, ...clock() });
  assert.equal(r.code, 1);
  assert.match(r.evalResult.reasons.join(), /could not read the failing doctrine gate ids/);
  delete w.logs[prJobId('Doctrine gates')];
  const r2 = await runGate(opts(), { gh: fakeGh(w).gh, ...clock() });
  assert.equal(r2.code, 1);
  assert.match(r2.evalResult.reasons.join(), /could not compare inside the job/);
});

test('runGate: a new failure outside any ratcheted job is a FAIL (code 1), comment posted, no merge command', async () => {
  const world = logWorld({ checks: [chk('Typecheck & build', 'fail')] });
  const { gh, calls } = fakeGh(world);
  const r = await runGate(opts(), { gh, ...clock() });
  assert.equal(r.code, 1);
  assert.equal(r.mergeCommand, undefined);
  assert.match(calls.find((x) => x.args[1] === 'comment').input, /NEW failures.*Typecheck & build/);
});

test('runGate: wrong head stops before checking anything', async () => {
  const { gh, calls } = fakeGh({ pr: basePr({ headRefOid: 'b'.repeat(40) }), files: ['a.ts'], checks: [] });
  await assert.rejects(runGate(opts(), { gh, ...clock() }), /not the reviewed/);
  assert.equal(
    calls.some((x) => x.args[0] === 'pr' && x.args[1] === 'checks'),
    false,
  );
});

test('runGate: head moving while waiting aborts', async () => {
  let n = 0;
  const { gh } = fakeGh({
    pr: () => basePr({ headRefOid: ++n > 2 ? 'c'.repeat(40) : HEAD }),
    files: ['a.ts'],
    checks: [...REQ_OK, chk('Format', 'pending')],
    prRuns: [{ workflowName: 'CI', status: 'in_progress' }],
  });
  await assert.rejects(runGate(opts(), { gh, ...clock() }), /head moved/);
});

test('runGate: waits for pending checks, then judges', async () => {
  let polls = 0;
  const done = [...REQ_OK, chk('Format', 'pass')];
  const { gh } = fakeGh({
    pr: basePr(),
    files: ['a.ts'],
    checks: () => (++polls < 3 ? [...REQ_OK, chk('Format', 'pending')] : done),
    prRuns: PASSRUN,
    ...mainWorld,
  });
  const r = await runGate(opts(), { gh, ...clock() });
  assert.equal(r.code, 0);
  assert.ok(polls >= 4, 'needed two settled polls after the pending ones');
});

test('runGate: times out instead of hanging', async () => {
  const { gh } = fakeGh({
    pr: basePr(),
    files: ['a.ts'],
    checks: [...REQ_OK, chk('Format', 'pending')],
    prRuns: [{ workflowName: 'CI', status: 'in_progress' }],
  });
  await assert.rejects(runGate(opts({ timeoutMin: 1 }), { gh, ...clock() }), /not finished after 1 min.*Format/);
});

test('runGate: a docs-only PR whose CI never ran does not pass', async () => {
  const { gh } = fakeGh({ pr: basePr({ title: 'docs: notes' }), files: ['docs/notes.md'], checks: REQ_OK, prRuns: [] });
  const r = await runGate(opts({ ciGraceSec: 10 }), { gh, ...clock() });
  assert.equal(r.code, 1);
  assert.equal(r.evalResult.docsOnly, false);
  assert.match(r.evalResult.reasons.join(), /CI never started/);
});

test('runGate: an AGENTS.md-only PR whose CI never ran does not pass as docs-only', async () => {
  const { gh } = fakeGh({ pr: basePr({ title: 'docs: rules' }), files: ['AGENTS.md'], checks: REQ_OK, prRuns: [] });
  const r = await runGate(opts({ ciGraceSec: 10 }), { gh, ...clock() });
  assert.equal(r.code, 1);
  assert.match(r.evalResult.reasons.join(), /CI never started/);
});

test('runGate: no checks at all never hangs; fails once the required checks are overdue', async () => {
  const { gh } = fakeGh({ pr: basePr({ title: 'docs: notes' }), files: ['docs/notes.md'], checks: null, prRuns: [] });
  const r = await runGate(opts({ ciGraceSec: 10 }), { gh, ...clock() });
  assert.equal(r.code, 1);
  assert.match(r.evalResult.reasons.join(), /"Gitleaks".*never reported/);
});

test('runGate: a code PR whose CI never appears fails after the grace period', async () => {
  const { gh } = fakeGh({ pr: basePr(), files: ['services/a.ts'], checks: REQ_OK, prRuns: [] });
  const r = await runGate(opts({ ciGraceSec: 10 }), { gh, ...clock() });
  assert.equal(r.code, 1);
  assert.match(r.evalResult.reasons.join(), /CI never started/);
});

test('runGate: a 403 or 429 stops at once, with no retry', async () => {
  const { gh, calls } = fakeGh({ pr: basePr(), files: ['a.ts'], checks: [], refuse: 'pr checks' });
  await assert.rejects(runGate(opts(), { gh, ...clock() }), GitHubRefusalError);
  assert.equal(calls.filter((x) => x.args[1] === 'checks').length, 1);
});

test('runGate: merge conflict, draft and closed PRs do not pass', async () => {
  const world = { files: ['a.ts'], checks: [...REQ_OK, chk('Format', 'pass')], prRuns: PASSRUN, ...mainWorld };
  const conflict = await runGate(opts(), { gh: fakeGh({ ...world, pr: basePr({ mergeable: 'CONFLICTING' }) }).gh, ...clock() });
  assert.equal(conflict.code, 1);
  await assert.rejects(runGate(opts(), { gh: fakeGh({ ...world, pr: basePr({ isDraft: true }) }).gh, ...clock() }), /draft/);
  await assert.rejects(runGate(opts(), { gh: fakeGh({ ...world, pr: basePr({ state: 'MERGED' }) }).gh, ...clock() }), /MERGED/);
});

test('mainCopyProblem: runs only when tooling/scripts and tooling/ci equal origin/main', () => {
  const mk =
    (diffStatus, fetchStatus = 0) =>
    (args) => ({ status: args[0] === 'fetch' ? fetchStatus : diffStatus, stderr: 'boom' });
  assert.equal(mainCopyProblem(mk(0)), null);
  assert.match(mainCopyProblem(mk(1)), /up-to-date origin\/main checkout/);
  assert.match(mainCopyProblem(mk(0, 128)), /could not fetch/);
  assert.match(mainCopyProblem(mk(129)), /git diff against origin\/main failed/);
  const seen = [];
  mainCopyProblem((args) => (seen.push(args.join(' ')), { status: 0, stderr: '' }));
  assert.deepEqual(seen, ['fetch -q origin main', 'diff --quiet origin/main -- tooling/scripts tooling/ci']);
});

test('a FAIL verdict never says the docs-only PR "passed"', () => {
  const r = evaluate({
    checks: [...REQ_OK, chk('Prettier (docs)', 'fail', 'Docs format')],
    mainFailing: new Set(),
    files: ['docs/x.md'],
    title: 'docs: x',
    ciPresent: true,
  });
  const text = renderComment({
    verdict: 'FAIL',
    head: HEAD,
    pr: 7,
    main: null,
    checks: [...REQ_OK, chk('Prettier (docs)', 'fail', 'Docs format')],
    evalResult: r,
  });
  assert.match(text, /Merge gate: FAIL/);
  assert.doesNotMatch(text, /Passed on the checks/);
  assert.match(text, /NEW failures/);
});

// ---- "Tests (full)": the test-name ratchet against a window of main's recent runs ---------------------------------------
// Fixtures tests-full-main-<run>.log and tests-full-pr-*.log are built in the shape of `gh run view --job <id> --log`
// (turbo grouped output, ANSI colours, vitest FAIL lines). tests-full-real-excerpt.log is the header / FAIL / unhandled-error /
// endgroup / Failed lines of the real "Tests (full)" log of PR #4722 (2026-10-14), caret-form colour codes and BOM included.
// Every FAIL line below is `<file> > some suite > does the thing` unless a fixture says otherwise.
//   run 206 cancelled | 205 red: ops a,b  notify n  matching(unhandled error, no file)  crash(exit code only)
//   204 red: p2p flaky  ops a + unhandled in a | 203 red: p2p flaky + suite-level flaky2 | 202 green | 201 red: ops c
//   200 red: p2p old  (200 is outside the window of 5)
const SEC = '@intafaced/';
const T = (pkg) => `${SEC}${pkg}#test`;
const N = (file, test = 'does the thing') => `${file} > some suite > ${test}`;
const MAIN_CONCLUSION = { 205: 'failure', 204: 'failure', 203: 'failure', 202: 'success', 201: 'failure', 200: 'failure' };
const winJobId = (run) => 7000 + Number(run);

function windowWorld(prLog, { conclusions = MAIN_CONCLUSION, extraRuns = [] } = {}) {
  const w = logWorld({ checks: [chk('Tests (full)', 'fail')] });
  const failStep = (run) => [
    { name: 'Run pnpm test --continue', conclusion: conclusions[run] === 'failure' ? 'failure' : 'success' },
    { name: 'Every infrastructure-backed suite actually ran', conclusion: conclusions[run] === 'failure' ? 'failure' : 'success' },
  ];
  const runs = [
    { databaseId: 206, headSha: '6'.repeat(40), conclusion: 'cancelled', createdAt: '2026-10-14T06:00:00Z', url: 'https://x/runs/206' },
    ...Object.keys(conclusions)
      .sort((a, b) => b - a)
      .map((id) => ({
        databaseId: Number(id),
        headSha: String(id).padEnd(40, '0'),
        conclusion: conclusions[id],
        createdAt: '2026-10-14T05:00:00Z',
        url: `https://x/runs/${id}`,
      })),
    ...extraRuns,
  ];
  w.mainRuns = runs;
  w.mainJobs = { 1: w.mainJobs[1] };
  w.logs = { [prJobId('Tests (full)')]: log(prLog) };
  for (const id of Object.keys(conclusions)) {
    w.mainJobs[id] = [
      { name: 'Format', databaseId: 6000 + Number(id), conclusion: 'success', steps: [] },
      { name: 'Tests (full)', databaseId: winJobId(id), conclusion: conclusions[id], steps: failStep(id) },
    ];
    w.logs[winJobId(id)] = log(`tests-full-main-${id}`);
  }
  return w;
}
const runWin = (prLog, o) => {
  const world = windowWorld(prLog, o);
  const g = fakeGh(world);
  return runGate(opts(), { gh: g.gh, ...clock() }).then((r) => ({ r, calls: g.calls, world }));
};
const comment = (calls) => calls.find((x) => x.args[1] === 'comment').input;

test('parseFailedTests: names per package from the real PR #4722 log excerpt (FAIL lines, suite failures, unhandled errors)', () => {
  const { byTask, orphans } = parseFailedTests(log('tests-full-real-excerpt'));
  assert.deepEqual(orphans, []);
  assert.deepEqual([...byTask.keys()].sort(), [
    T('svc-bank'),
    T('svc-indexer'),
    T('svc-market'),
    T('svc-matching'),
    T('svc-notify'),
    T('svc-ops'),
    T('svc-pay'),
    T('svc-protocol'),
    T('svc-support'),
  ]);
  const support = byTask.get(T('svc-support'));
  assert.equal(support.size, 8, 'vitest said "Failed Suites 8" for svc-support');
  assert.ok(support.has('scripts/migrate.one-tx.test.ts'), 'a suite that failed to load: FAIL file [ file ] is the file-level name');
  assert.ok(support.has('src/unpublish-bumps-revision.pg.test.ts > L1247 postgres unpublish bumps revision'));
  // three failing tests of one file are three names, not one
  assert.equal(byTask.get(T('svc-market')).size, 3);
  assert.ok(
    byTask
      .get(T('svc-market'))
      .has(
        'scripts/migrate.down.test.ts > actual market migration runner down transactions > refuses known periods without clearing terms or the applied marker',
      ),
  );
  // svc-matching printed no FAIL line, only "Unhandled Error: Timeout calling onTaskUpdate" and "Errors 1 error"
  assert.deepEqual([...byTask.get(T('svc-matching'))], [`(unhandled) ${T('svc-matching')}`]);
});

test('parseFailedTests: a header counts only for a failing task; stray lines, orphans and project tags', () => {
  const L = (...t) => t.map((x) => `Tests (full)\tRun pnpm test --continue\t2026-10-14T01:00:00.0000000Z ${x}`).join('\n');
  const failed = 'Failed:    @intafaced/svc-ops#test, @intafaced/svc-p2p#test, mobile#test';
  // block mode: Error:boom is not a failing task, so it does not switch the block
  const block = parseFailedTests(
    L('@intafaced/svc-ops:test', ' FAIL  src/a.test.ts > s > t1', 'Error:boom', ' FAIL  src/b.test.ts > s > t2', '##[endgroup]', failed),
  );
  assert.deepEqual([...block.byTask.get(T('svc-ops'))], ['src/a.test.ts > s > t1', 'src/b.test.ts > s > t2']);
  assert.deepEqual(block.orphans, []);
  // an unknown header after ##[endgroup] is not a header either; a FAIL there has no package
  const lost = parseFailedTests(
    L(
      '@intafaced/svc-ops:test',
      ' FAIL  src/a.test.ts > s > t',
      '##[endgroup]',
      '@intafaced/other:test',
      ' FAIL  src/x.test.ts > s > t',
      failed,
    ),
  );
  assert.deepEqual(lost.orphans, ['FAIL  src/x.test.ts > s > t']);
  // stream mode: the per-line prefix wins; project tags are dropped; FAIL of a package not on the Failed: line is an orphan
  const stream = parseFailedTests(
    L(
      '@intafaced/svc-ops:test:  FAIL  src/a.test.ts > suite > test',
      '@intafaced/svc-p2p:test: \u001b[41m FAIL \u001b[49m |unit| src/b.test.ts [ src/b.test.ts ]',
      'mobile:test: FAIL app/c.test.tsx > x',
      '@intafaced/svc-edge:test: FAIL src/e.test.ts > x',
      ' FAIL  src/orphan.test.ts > outside any block',
      ' FAIL  not a file',
      failed,
    ),
  );
  assert.deepEqual([...stream.byTask.get(T('svc-ops'))], ['src/a.test.ts > suite > test']);
  assert.deepEqual([...stream.byTask.get(T('svc-p2p'))], ['src/b.test.ts']);
  assert.deepEqual([...stream.byTask.get('mobile#test')], ['app/c.test.tsx > x']);
  assert.equal(stream.orphans.length, 3, 'svc-edge not failing, no block at all, and a FAIL line that names no file');
  // unhandled errors: one per section, with or without the file vitest says it originated in; Errors N catches the rest
  const unh = parseFailedTests(
    L(
      '@intafaced/svc-ops:test',
      '⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯',
      'Vitest caught 3 unhandled errors during the test run.',
      '⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯',
      'Error: one',
      'This error originated in "src/u.test.ts" test file. It does not mean',
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
      '⎯⎯⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯⎯⎯',
      'Error: two',
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
      '     Errors  3 errors',
      '##[endgroup]',
      failed,
    ),
  );
  assert.deepEqual([...unh.byTask.get(T('svc-ops'))].sort(), [`(unhandled) ${T('svc-ops')}`, '(unhandled) src/u.test.ts']);
  assert.equal(parseFailedTests('').byTask.size, 0);
});

test('selectMainWindow: the last MAIN_WINDOW runs in which Tests (full) ran; cancelled and green-less runs do not count', async () => {
  assert.equal(MAIN_WINDOW, 5);
  const world = windowWorld('tests-full-pr-flaky');
  const { gh } = fakeGh(world);
  const main = await selectMainRun(gh, REPO);
  assert.equal(main.run.databaseId, 205);
  const win = selectMainWindow(gh, REPO, { main });
  assert.deepEqual(
    win.map((w) => w.run.databaseId),
    [205, 204, 203, 202, 201],
  );
  assert.equal(win[0].job.databaseId, winJobId(205));
  // a run whose Tests (full) was skipped or cancelled is not in the window
  const skipped = windowWorld('tests-full-pr-flaky');
  skipped.mainJobs[203][1].conclusion = 'skipped';
  const g2 = fakeGh(skipped);
  const m2 = await selectMainRun(g2.gh, REPO);
  assert.deepEqual(
    selectMainWindow(g2.gh, REPO, { main: m2 }).map((w) => w.run.databaseId),
    [205, 204, 202, 201, 200],
  );
});

test('makeLogStore: a log is fetched once per gate run and cached in the temp dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-test-'));
  try {
    let n = 0;
    const store = makeLogStore((args) => (n++, { status: 0, stdout: `log of ${args[3]}`, stderr: '' }), REPO, dir);
    assert.equal(store(5), 'log of 5');
    assert.equal(store(5), 'log of 5');
    assert.equal(n, 1);
    assert.deepEqual(readdirSync(dir), ['job-5.log']);
    const mem = makeLogStore((args) => (n++, { status: 0, stdout: 'x', stderr: '' }), REPO);
    mem(1);
    mem(1);
    assert.equal(n, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const nameRuns = (r) => Object.fromEntries(r.evalResult.flaky.map((f) => [`${f.task} ${f.name}`, f.runs]));

test('test ratchet: tests that flaked on main in the window are excused, even in a package main does not fail right now', async () => {
  const { r, calls } = await runWin('tests-full-pr-flaky');
  assert.equal(r.code, 0, r.evalResult.reasons.join());
  assert.deepEqual(nameRuns(r), {
    [`${T('svc-p2p')} ${N('src/flaky.test.ts')}`]: [204, 203], // svc-p2p is NOT failing in main's latest run (205)
    [`${T('svc-p2p')} src/flaky2.test.ts`]: [203], // a suite-level failure stays file-level
    [`${T('svc-ops')} ${N('src/a.test.ts')}`]: [205, 204],
    [`${T('svc-ops')} ${N('src/c.test.ts')}`]: [201], // only in the oldest run of the window
  });
  const text = comment(calls);
  assert.match(text, /Merge gate: PASS/);
  assert.match(text, /known flaky on main: @intafaced\/svc-p2p#test src\/flaky\.test\.ts > some suite > does the thing \(runs 204, 203\)/);
  assert.match(text, /known flaky on main: @intafaced\/svc-p2p#test src\/flaky2\.test\.ts \(runs 203\)/);
  assert.match(text, /known flaky on main: @intafaced\/svc-ops#test src\/a\.test\.ts > some suite > does the thing \(runs 205, 204\)/);
  assert.match(text, /all 4 failing test\(s\) or suite\(s\).*in the last 5 run\(s\) \(205, 204, 203, 202, 201\)/);
  // the run outside the window (200) was never fetched, and every window log once
  const logCalls = calls.filter((x) => x.args[0] === 'run' && x.args[1] === 'view' && x.args[2] === '--job').map((x) => x.args[3]);
  assert.equal(logCalls.includes(String(winJobId(200))), false);
  assert.equal(logCalls.length, new Set(logCalls).size, 'no log fetched twice');
  assert.equal(logCalls.length, 1 + MAIN_WINDOW, 'the PR log plus the five window logs');
});

test('test ratchet: the same file with a DIFFERENT test name blocks; the same name passes', async () => {
  const other = await runWin('tests-full-pr-other-test-name');
  assert.equal(other.r.code, 1);
  assert.match(
    other.r.evalResult.reasons.join(),
    /svc-ops#test: 1 new failing test\(s\).*src\/a\.test\.ts > some suite > a different test/,
  );
  assert.doesNotMatch(other.r.evalResult.reasons.join(), /does the thing/, 'the name main did fail is not blamed');
  const same = await runWin('tests-full-pr-flaky');
  assert.equal(same.r.code, 0);
});

test('test ratchet: a NEW test inside a package that is red on main blocks, and the verdict names it', async () => {
  const { r, calls } = await runWin('tests-full-pr-newfile');
  assert.equal(r.code, 1);
  const why = r.evalResult.reasons.join();
  assert.match(why, /@intafaced\/svc-ops#test: 1 new failing test\(s\).*: src\/new\.test\.ts > some suite > does the thing/);
  assert.doesNotMatch(why, /a\.test\.ts/, 'the test that did fail on main is not blamed');
  assert.match(comment(calls), /NEW failures.*Tests \(full\).*src\/new\.test\.ts/);
  assert.equal(r.evalResult.flaky.length, 0, 'a blocked job excuses nothing');
});

test('test ratchet: an unhandled error main never had blocks, even next to FAIL lines main did have', async () => {
  const mixed = await runWin('tests-full-pr-unhandled-new');
  assert.equal(mixed.r.code, 1);
  assert.match(mixed.r.evalResult.reasons.join(), /svc-ops#test: 1 new failing test\(s\).*\(unhandled\) src\/x\.test\.ts/);
  const only = await runWin('tests-full-pr-unhandled-only-new'); // no FAIL line at all, svc-ops IS red in main's latest run
  assert.equal(only.r.code, 1, 'an unhandled-only package no longer falls back to "also red on main"');
  assert.match(only.r.evalResult.reasons.join(), /\(unhandled\) src\/zzz\.test\.ts/);
  // unhandled errors that main had (with a file in run 204, without one in run 205) are excused and listed
  const known = await runWin('tests-full-pr-unhandled-known');
  assert.equal(known.r.code, 0, known.r.evalResult.reasons.join());
  const seen = nameRuns(known.r);
  assert.deepEqual(seen[`${T('svc-ops')} (unhandled) src/a.test.ts`], [204]);
  assert.deepEqual(seen[`${T('svc-matching')} (unhandled) ${T('svc-matching')}`], [205]);
  assert.match(
    comment(known.calls),
    /known flaky on main: @intafaced\/svc-matching#test \(unhandled\) @intafaced\/svc-matching#test \(runs 205\)/,
  );
});

test("test ratchet: a FAIL after a stray header-looking line is still svc-ops' and blocks; a FAIL no failing package owns blocks", async () => {
  const stray = await runWin('tests-full-pr-stray-header');
  assert.equal(stray.r.code, 1);
  assert.match(stray.r.evalResult.reasons.join(), /svc-ops#test: 1 new failing test\(s\).*src\/new\.test\.ts/);
  for (const [fixture, line] of [
    ['tests-full-pr-orphan-fail', 'src/lost.test.ts'], // after the block closed
    ['tests-full-pr-fail-in-green-package', 'src/hidden.test.ts'], // inside a package that did not fail
  ]) {
    const { r } = await runWin(fixture);
    assert.equal(r.code, 1, fixture);
    assert.match(
      r.evalResult.reasons.join(),
      new RegExp(`1 FAIL line\\(s\\).*belong to no failing package.*${line.replace('.', '\\.')}`),
      fixture,
    );
  }
});

test("test ratchet: a new package with nothing readable blocks; one that is red in main's latest run is excused, and says so", async () => {
  const fresh = await runWin('tests-full-pr-newpkg');
  assert.equal(fresh.r.code, 1);
  assert.match(
    fresh.r.evalResult.reasons.join(),
    /@intafaced\/svc-fresh#test: no failing test could be read from the log, and the package is not failing on main's latest run/,
  );
  const known = await runWin('tests-full-pr-crash-known');
  assert.equal(known.r.code, 0, known.r.evalResult.reasons.join());
  assert.ok(
    known.r.evalResult.logChecks.some((l) =>
      /svc-crash#test has no readable FAIL line.*excused only because it also fails in main's latest run 205/.test(l),
    ),
  );
  assert.match(
    comment(known.calls),
    /no readable FAIL line or unhandled error \(exit code only\); excused only because it also fails in main's latest run 205/,
  );
});

test('test ratchet: a test only seen on main OUTSIDE the window, or only in another package, is new', async () => {
  const old = await runWin('tests-full-pr-outside-window'); // p2p src/old.test.ts failed in run 200 only
  assert.equal(old.r.code, 1);
  assert.match(old.r.evalResult.reasons.join(), /svc-p2p#test: 1 new failing test\(s\).*src\/old\.test\.ts/);
  const wrong = await runWin('tests-full-pr-wrong-package'); // flaky.test.ts is a svc-p2p file; here it fails in svc-ops
  assert.equal(wrong.r.code, 1);
  assert.match(wrong.r.evalResult.reasons.join(), /svc-ops#test: 1 new failing test\(s\).*src\/flaky\.test\.ts/);
});

test("test ratchet: the job is still excused only if main's latest Tests (full) is red (job-level rule unchanged)", async () => {
  const { r } = await runWin('tests-full-pr-flaky', { conclusions: { ...MAIN_CONCLUSION, 205: 'success' } });
  assert.equal(r.code, 1);
  assert.match(r.evalResult.reasons.join(), /new failing check\(s\).*Tests \(full\)/);
});

test('test ratchet: a window log that cannot be read is skipped; the remaining runs still decide', async () => {
  const world = windowWorld('tests-full-pr-flaky');
  delete world.logs[winJobId(204)];
  const r = await runGate(opts(), { gh: fakeGh(world).gh, ...clock() });
  assert.equal(r.code, 0, r.evalResult.reasons.join());
  const seen = nameRuns(r);
  assert.deepEqual(seen[`${T('svc-p2p')} ${N('src/flaky.test.ts')}`], [203], 'run 204 was unreadable, run 203 still shows it');
  assert.deepEqual(seen[`${T('svc-ops')} ${N('src/a.test.ts')}`], [205]);
  assert.match(r.evalResult.logChecks.join(), /in the last 4 run\(s\) \(205, 203, 202, 201\)/);
  // a test seen only in the unreadable runs is new
  const p = windowWorld('tests-full-pr-flaky');
  delete p.logs[winJobId(203)];
  delete p.logs[winJobId(204)];
  const r2 = await runGate(opts(), { gh: fakeGh(p).gh, ...clock() });
  assert.equal(r2.code, 1);
  assert.match(
    r2.evalResult.reasons.join(),
    /svc-p2p#test: 2 new failing test\(s\).*src\/flaky\.test\.ts > some suite > does the thing; src\/flaky2\.test\.ts/,
  );
});

test('test ratchet: a 403 while fetching a window log stops the gate, never skipped', async () => {
  const world = windowWorld('tests-full-pr-flaky');
  await assert.rejects(
    runGate(opts(), { gh: fakeGh({ ...world, refuse: `run view --job ${winJobId(203)}` }).gh, ...clock() }),
    GitHubRefusalError,
  );
});
