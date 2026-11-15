import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JUDGE_ONLY, shardRetries, touchedJourneys } from './journey-retries.mjs';
import { JOURNEY_CI, checkoutJourneyFiles } from './journey-touch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = '.github/workflows/real-app-journeys.yml';
const journeyFiles = checkoutJourneyFiles(ROOT);

// Tonight's pull requests (14 Nov 2026), their changed paths as GitHub lists them.
const PR_8385 = ['tooling/ci/journey-verdict.mjs', 'tooling/ci/journeys-revert.mjs', 'tooling/ci/post-merge-trust.mjs'];
const PR_8391 = ['tooling/ci/gates.mjs', 'tooling/ci/journeys-revert-probe.mjs', 'tooling/ci/journeys-revert.mjs'];
const PR_8383 = ['apps/customer/tests/real-app/J-algo-dev-07.pw.mjs', 'apps/customer/tests/real-app/venue.mjs'];
const PLAN = ['J-agents-01.pw.mjs J-merchant-02.pw.mjs', 'J-cex-spot-03.pw.mjs', 'J-algo-dev-07.pw.mjs J-charts-desk-09.pw.mjs'];

test('a full run of CI code that only plans, judges or reverts retries on every shard, as main does', () => {
  for (const changed of [PR_8385, PR_8391]) {
    assert.deepEqual(touchedJourneys({ changed, journeyFiles }), []);
    assert.deepEqual(shardRetries(PLAN, touchedJourneys({ changed, journeyFiles })), ['none', '1', '1', '1']);
  }
});

test('a journey file the pull request changes keeps no retry on its shard; the other shards retry', () => {
  const changed = ['tooling/ci/journey-verdict.mjs', 'apps/customer/tests/real-app/J-cex-spot-03.pw.mjs'];
  assert.deepEqual(touchedJourneys({ changed, journeyFiles }), ['J-cex-spot-03.pw.mjs']);
  assert.deepEqual(shardRetries(PLAN, touchedJourneys({ changed, journeyFiles })), ['none', '1', 'none', '1']);
});

test('a journey the title names keeps no retry, and neither do its sibling files', () => {
  const files = new Set(['J-home-ia-01.pw.mjs', 'J-home-ia-01-venue.pw.mjs', 'J-agents-01.pw.mjs']);
  assert.deepEqual(touchedJourneys({ changed: PR_8385, named: ['J-home-ia-01.pw.mjs'], journeyFiles: files }), [
    'J-home-ia-01-venue.pw.mjs',
    'J-home-ia-01.pw.mjs',
  ]);
  const plan = ['J-agents-01.pw.mjs', 'J-home-ia-01-venue.pw.mjs'];
  assert.deepEqual(
    shardRetries(plan, touchedJourneys({ changed: ['apps/customer/tests/real-app/J-home-ia-01.pw.mjs'], journeyFiles: files })),
    ['none', '1', 'none'],
  );
});

test('a change a shard can run touches every journey: no shard retries', () => {
  for (const p of [
    'apps/customer/tests/real-app/venue.mjs', // a shared journey helper (#8383)
    'apps/customer/tests/real-app/real-app.playwright.config.mjs',
    'apps/customer/tests/real-app/fail-fast-once.mjs',
    'tooling/scripts/local-test-stack.mjs',
    'tooling/scripts/journey-fail-fast.mjs',
    'tooling/ci/assert-test-db-env.mjs', // the test-infra action runs it in every shard
    'tooling/ci/test-judge.mjs', // a CI file the run uses that JUDGE_ONLY does not list
    'services/svc-ledger/src/index.ts',
    'packages/money-math/src/index.ts',
    WORKFLOW,
    '.github/actions/browser/action.yml',
    'package.json',
    'pnpm-lock.yaml',
  ]) {
    assert.equal(touchedJourneys({ changed: ['tooling/ci/journey-verdict.mjs', p], journeyFiles }), 'all', p);
    assert.deepEqual(shardRetries(PLAN, 'all'), ['none', 'none', 'none', 'none'], p);
  }
  assert.equal(touchedJourneys({ changed: PR_8383, journeyFiles }), 'all');
});

test('no list, an empty list, or no plan: no shard retries', () => {
  assert.equal(touchedJourneys({ changed: [], journeyFiles }), 'all');
  assert.equal(touchedJourneys({ changed: null, journeyFiles }), 'all');
  assert.throws(() => shardRetries([], []), /no shard plan/);
});

test('every judge-only file is one the journeys run uses (JOURNEY_CI) and exists', () => {
  for (const f of JUDGE_ONLY) {
    assert.ok(JOURNEY_CI.includes(f), `${f} is on JOURNEY_CI`);
    assert.ok(existsSync(join(ROOT, f)), `${f} exists`);
  }
});

/**
 * What a shard runs, from the repository: the build and journeys jobs of the workflow, its actions, the real-app
 * folder, and every product file that is not a unit test, followed through each relative import (`from`, `import()`,
 * `new URL()`, `require()`) and each repository path the code names where it can run (pathsNamed: tooling/…, apps/…).
 */
function shardJobsText() {
  const lines = readFileSync(join(ROOT, WORKFLOW), 'utf8').split('\n');
  const start = lines.indexOf('  build:');
  const journeys = lines.indexOf('  journeys:');
  const end = lines.findIndex((l, i) => i > journeys && /^ {2}[a-z][\w-]*:$/.test(l));
  assert.ok(start > 0 && journeys > start && end > journeys, 'the workflow has its build and journeys jobs');
  return lines.slice(start, end).join('\n');
}
/**
 * The text of a file where a repository path it names can run: without comments, and in JavaScript or TypeScript only
 * its string literals (a path in a JSX paragraph or a comment runs nothing; one in `node tooling/…` or `'./x.mjs'` may).
 */
function pathsNamed(f, text) {
  if (/\.(ya?ml|sh)$/.test(f) || f === WORKFLOW) return text.replace(/(^|\s)#.*$/gm, '$1');
  if (!/\.[cm]?[jt]sx?$/.test(f)) return text;
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  return [...code.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)].map((m) => m[2]).join('\n');
}
function shardSurface(extra = '') {
  const all = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1e8 }).split('\n').filter(Boolean);
  const unit = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) && !f.startsWith('apps/customer/tests/real-app/');
  const code = /\.([cm]?[jt]sx?|json|ya?ml|sh)$/;
  const roots = all.filter(
    (f) =>
      f.startsWith('.github/actions/') ||
      (/^(apps|services|packages)\//.test(f) && code.test(f) && !unit(f) && !f.includes('/node_modules/')),
  );
  const seen = new Set();
  const queue = [{ f: WORKFLOW, text: shardJobsText() + extra }, ...roots.map((f) => ({ f }))];
  while (queue.length) {
    const { f, text: given } = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    let text = given;
    if (text === undefined) {
      if (!existsSync(join(ROOT, f)) || !statSync(join(ROOT, f)).isFile()) continue;
      text = readFileSync(join(ROOT, f), 'utf8');
    }
    for (const m of text.matchAll(/(?:from\s+|import\(\s*|new URL\(\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const to = normalize(join(dirname(f), m[1]));
      if (!to.startsWith('..')) queue.push({ f: to });
    }
    for (const m of pathsNamed(f, text).matchAll(/(?<![\w./-])(?:tooling|apps|services|packages)\/[A-Za-z0-9_./-]+/g)) {
      const p = m[0].replace(/[.]+$/, '');
      if (all.includes(p)) queue.push({ f: p });
    }
  }
  return seen;
}

test('drift: nothing a shard runs imports or names a judge-only file', () => {
  const surface = shardSurface();
  assert.ok(surface.has('tooling/scripts/local-test-stack.mjs'), 'the surface reaches the stack (sanity)');
  assert.ok(surface.has('tooling/ci/assert-test-db-env.mjs'), 'and the CI file the test-infra action runs');
  for (const f of JUDGE_ONLY) assert.equal(surface.has(f), false, `${f} is reached from a shard, so it is not judge-only`);
});

test('drift, planted: a shard step that ran the verdict would be caught', () => {
  assert.ok(shardSurface('\n        run: node tooling/ci/journey-verdict.mjs\n').has('tooling/ci/journey-verdict.mjs'));
});

test('the workflow: a shard retries on main, or on the plan the Retries step gives a full pull-request run', () => {
  const wf = readFileSync(join(ROOT, WORKFLOW), 'utf8');
  assert.match(
    wf,
    /JOURNEY_RETRIES: \$\{\{ \(github\.ref == 'refs\/heads\/main' \|\| fromJSON\(needs\.touch\.outputs\.retries \|\| '\[\]'\)\[matrix\.shard\] == '1'\) && '1' \|\| '0' \}\}/,
  );
  assert.match(wf, /retries: \$\{\{ steps\.retries\.outputs\.retries \}\}/);
  const step = wf.slice(wf.indexOf('- name: Retries off main'), wf.indexOf('- name: Fail-fast plan'));
  // Only a pull request's full run, whose changed paths were read whole, with its shard plan.
  assert.match(step, /github\.event_name == 'pull_request'/);
  assert.match(step, /steps\.pick\.outputs\.scope == 'full'/);
  assert.match(step, /steps\.touch\.outputs\.target == ''/);
  assert.match(step, /steps\.plan\.outputs\.shards != ''/);
  // The pick sets the scope only where it read every changed path and judged them (never in its full() fallback).
  const pick = wf.slice(wf.indexOf('- name: What this run runs'), wf.indexOf('- name: One journeys run per head'));
  assert.equal((pick.match(/scope=full/g) ?? []).length, 1);
  assert.ok(pick.indexOf('scope=full') > pick.indexOf('journey-touch.mjs" --json --reach'), 'after journey-touch judged the paths');
});
