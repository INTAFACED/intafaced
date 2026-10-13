/**
 * Unit tests for merge-gate.mjs. No network: `gh` is a fake that answers from fixture JSON shaped like the real output
 * (captured 2026-10-13 from `gh pr checks --json`, `gh run list --json`, `gh run view --json jobs`).
 * Run: node --test tooling/scripts/merge-gate.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GitHubRefusalError } from './gate-gh.mjs';
import {
  CI_PR_PATHS,
  KNOWN_PR_ONLY_RED,
  collapseChecks,
  ciWouldRun,
  evaluate,
  mergeCommand,
  renderComment,
  runGate,
  selectMainRun,
} from './merge-gate.mjs';

const HEAD = 'a'.repeat(40);
const REPO = 'Phantom-X-007/intafaced';
const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/merge-gate/${name}.json`, import.meta.url), 'utf8'));
const chk = (name, bucket, workflow = 'CI', completedAt = '2026-10-13T12:00:00Z') => ({
  name,
  bucket,
  workflow,
  completedAt,
  state: bucket.toUpperCase(),
  link: `https://example/${encodeURIComponent(name)}`,
});
const REQ_OK = [chk('Gitleaks', 'pass', 'Gitleaks'), chk('Dependency audit', 'pass', 'Supply chain')];

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
    if (k.startsWith('run view')) return ok({ jobs: world.mainJobs[args[2]] });
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

test('collapseChecks keeps the latest attempt per name', () => {
  const out = collapseChecks([
    chk('A', 'fail', 'CI', '2026-10-13T10:00:00Z'),
    chk('A', 'pass', 'CI', '2026-10-13T11:00:00Z'),
    chk('B', 'pending', 'CI', '0001-01-01T00:00:00Z'),
  ]);
  assert.equal(out.find((c) => c.name === 'A').bucket, 'pass');
  assert.equal(out.find((c) => c.name === 'B').bucket, 'pending');
});

test('ci path filter: docs-only is skipped, code and the doctrine file are not', () => {
  assert.equal(ciWouldRun(['docs/a.md', 'README.md', 'NOTICE', 'LICENSE', 'docs/deep/x.png']), false);
  assert.equal(ciWouldRun(['docs/a.md', 'services/svc-pay/src/a.ts']), true);
  assert.equal(ciWouldRun(['INTAFACED_DEFINITIVE_BUILD.md']), true);
  assert.equal(ciWouldRun(['packages/x/README.md']), false);
});

test('CI_PR_PATHS mirrors ci.yml on.pull_request.paths (drift guard)', () => {
  const yml = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
  const block = yml.match(/pull_request:\n {4}paths:\n((?: {6}- .*\n)+)/)?.[1] ?? '';
  const paths = block
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(/^ +- /, '').replace(/^'|'$/g, ''));
  assert.deepEqual(paths, CI_PR_PATHS);
});

test('ratchet: failure also on main is excused; failure absent from main is new', () => {
  const checks = [...REQ_OK, chk('Doctrine gates', 'fail'), chk('Format', 'pass'), chk('Tests (money)', 'fail')];
  const r = evaluate({
    checks,
    mainFailing: new Set(['Doctrine gates', 'Tests (full)']),
    mainJobs: new Set(['Doctrine gates', 'Tests (full)', 'Format']),
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
    ['Tests (money)'],
  ); // a shard is not excused by a red "Tests (full)"
});

test('ratchet passes when every failure is also on main', () => {
  const r = evaluate({
    checks: [...REQ_OK, chk('Doctrine gates', 'fail')],
    mainFailing: new Set(['Doctrine gates']),
    files: ['a.ts'],
    title: 'fix: x',
    ciPresent: true,
  });
  assert.equal(r.pass, true);
  assert.equal(r.excusedOnMain.length, 1);
});

test('known PR-only red (CX-8) is allowed, but only because it is listed and absent from main', () => {
  assert.ok('CX-8 assembled smoke' in KNOWN_PR_ONLY_RED);
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
});

test('required checks are never excused, even if main "fails" a job of the same name', () => {
  const r = evaluate({
    checks: [chk('Gitleaks', 'fail', 'Gitleaks'), chk('Dependency audit', 'pass', 'Supply chain')],
    mainFailing: new Set(['Gitleaks']),
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

test('docs-only PR with CI skipped passes on the two required checks and says so', () => {
  const r = evaluate({ checks: REQ_OK, mainFailing: new Set(), files: ['docs/x.md'], title: 'docs: x', ciPresent: false });
  assert.equal(r.pass, true);
  assert.equal(r.docsOnly, true);
  assert.match(
    renderComment({ verdict: 'PASS', head: HEAD, pr: 7, main: null, checks: REQ_OK, evalResult: r }),
    /Docs-only PR.*no tests ran.*Gitleaks and Dependency audit/,
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

test('selectMainRun skips cancelled runs and runs that ran no jobs', async () => {
  const { gh, calls } = fakeGh(mainWorld);
  const m = await selectMainRun(gh, REPO);
  assert.equal(m.run.databaseId, 200); // 400 cancelled, 300 had only skipped jobs, 200 is the first real one
  assert.deepEqual([...m.failing].sort(), ['CI merge seal', 'Doctrine gates', 'Tests (full)']);
  assert.ok(
    calls.some((c) => c.args.includes('300')),
    'looked at the jobs-less run before skipping it',
  );
});

test('selectMainRun returns null when no run ran jobs', async () => {
  const { gh } = fakeGh({ mainRuns: fx('main-runs').filter((r) => r.conclusion === 'cancelled'), mainJobs: {} });
  assert.equal(await selectMainRun(gh, REPO), null);
});

test('runGate: PASS posts one comment and prints the merge command, never merges', async () => {
  const checks = [...REQ_OK, chk('Doctrine gates', 'fail'), chk('Format', 'pass'), chk('Definition of Done', 'skipping')];
  const { gh, calls } = fakeGh({
    pr: basePr(),
    files: ['services/svc-pay/a.ts'],
    checks,
    prRuns: [{ workflowName: 'CI', status: 'completed' }],
    ...mainWorld,
  });
  const c = clock();
  const r = await runGate(opts(), { gh, ...c });
  assert.equal(r.code, 0);
  assert.equal(r.mergeCommand, `gh pr merge 7 --match-head-commit ${HEAD} -R ${REPO} --squash`);
  assert.equal(r.mergeCommand, mergeCommand(7, HEAD));
  const comments = calls.filter((x) => x.args[0] === 'pr' && x.args[1] === 'comment');
  assert.equal(comments.length, 1);
  assert.match(comments[0].input, /Merge gate: PASS/);
  assert.match(comments[0].input, /Compared against.*main CI push run/);
  assert.equal(
    calls.some((x) => x.args.includes('merge')),
    false,
    'the gate must never merge',
  );
});

test('runGate: a new failure is FAIL (code 1), comment posted, no merge command', async () => {
  const checks = [...REQ_OK, chk('Tests (money)', 'fail')];
  const { gh, calls } = fakeGh({
    pr: basePr(),
    files: ['services/svc-pay/a.ts'],
    checks,
    prRuns: [{ workflowName: 'CI', status: 'completed' }],
    ...mainWorld,
  });
  const r = await runGate(opts(), { gh, ...clock() });
  assert.equal(r.code, 1);
  assert.equal(r.mergeCommand, undefined);
  assert.match(calls.find((x) => x.args[1] === 'comment').input, /NEW failures.*Tests \(money\)/);
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
    prRuns: [{ workflowName: 'CI', status: 'completed' }],
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

test('runGate: docs-only PR reporting only the two required checks passes', async () => {
  const { gh, calls } = fakeGh({ pr: basePr({ title: 'docs: notes' }), files: ['docs/notes.md'], checks: REQ_OK, prRuns: [] });
  const r = await runGate(opts(), { gh, ...clock() });
  assert.equal(r.code, 0);
  assert.equal(r.evalResult.docsOnly, true);
  assert.equal(
    calls.some((x) => x.args[0] === 'run' && x.args.includes('ci.yml')),
    false,
    'no main lookup needed',
  );
});

test('runGate: no checks at all never hangs; fails once the required checks are overdue', async () => {
  const { gh } = fakeGh({ pr: basePr({ title: 'docs: notes' }), files: ['docs/notes.md'], checks: null, prRuns: [] });
  const r = await runGate(opts({ ciGraceSec: 10 }), { gh, ...clock() });
  assert.equal(r.code, 1);
  assert.match(r.evalResult.reasons.join(), /"Gitleaks" never reported/);
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
  const world = {
    files: ['a.ts'],
    checks: [...REQ_OK, chk('Format', 'pass')],
    prRuns: [{ workflowName: 'CI', status: 'completed' }],
    ...mainWorld,
  };
  const conflict = await runGate(opts(), { gh: fakeGh({ ...world, pr: basePr({ mergeable: 'CONFLICTING' }) }).gh, ...clock() });
  assert.equal(conflict.code, 1);
  await assert.rejects(runGate(opts(), { gh: fakeGh({ ...world, pr: basePr({ isDraft: true }) }).gh, ...clock() }), /draft/);
  await assert.rejects(runGate(opts(), { gh: fakeGh({ ...world, pr: basePr({ state: 'MERGED' }) }).gh, ...clock() }), /MERGED/);
});
