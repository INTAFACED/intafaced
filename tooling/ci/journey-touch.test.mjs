// node --test tooling/ci/journey-touch.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOURNEY_CI, RUN_FILE, journeyTouch, pathKind } from './journey-touch.mjs';
import { JOURNEYS_WORKFLOW, isSharedSetup, judgeTouchedRun, sealPull } from './journey-seal.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO = 'INTAFACED/intafaced';
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const run = (id, over = {}) => ({
  id,
  head_sha: HEAD,
  path: JOURNEYS_WORKFLOW,
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  created_at: `2026-11-08T0${id % 10}:00:00Z`,
  run_started_at: `2026-11-08T0${id % 10}:00:00Z`,
  head_repository: { full_name: REPO },
  repository: { full_name: REPO },
  ...over,
});
const clean = { red: [], failing: 0, missing: [] };
const red = (step) => ({ red: [{ step, why: 'failing, not in the baseline' }], failing: 1, missing: [] });

// ---- The classifier ----

test('pathKind: what needs the full run, what touches only its own journey file, and what touches none', () => {
  for (const p of [
    'tooling/scripts/local-test-market.mjs', // the TEST maker, shared setup
    'tooling/scripts/local-test-world.mjs',
    'tooling/scripts/journey-world.mjs', // world-restore's state
    'tooling/scripts/local-founder-seed.mjs', // imported by journeys, not on SHARED_SETUP
    'tooling/scripts/journey-shards.mjs',
    'apps/customer/tests/real-app/world-restore.mjs',
    'apps/customer/tests/real-app/journey.mjs',
    'apps/customer/tests/real-app/real-app.playwright.config.mjs',
    'apps/customer/tests/real-app/sub/J-bank-13.pw.mjs', // not a file the run takes by name
    '.github/workflows/real-app-journeys.yml',
    '.github/actions/test-infra/action.yml',
    'tooling/ci/journey-seal.mjs',
    'tooling/ci/journey-touch.mjs',
    'tooling/ci/journey-verdict.mjs',
    'docs/runbooks/journey-baseline.json',
    'docs/roadmap/journeys.json',
    'docs/runbooks/INCIDENT-MONEY-PATH-RUNBOOK.md', // J-ops-console-01-service-page reads it
    'tooling/profiles/test-owner-values/trade.json',
    'pnpm-lock.yaml',
    'package.json',
    'docker-compose.apps.yml',
    '.env.example',
    'services/svc-bank/src/cards.ts',
    'services/svc-bank/package.json',
    'apps/customer/src/features/more/Support.tsx',
    'apps/customer/src/styles.css',
    'apps/admin/app/page.tsx',
    'packages/ledger-client/src/recipes.ts',
    'packages/ui/src/tokens.ts',
    'services/svc-protocol/contracts/out/TestToken.json', // a journey reads it
    'AGENTS.md',
    'README.md',
    'somewhere/new.txt',
  ])
    assert.equal(pathKind(p).kind, 'full', p);
  for (const p of [
    '.github/workflows/ci.yml',
    '.github/CODEOWNERS',
    'tooling/ci/ci-review.mjs',
    'tooling/ci/gates.mjs',
    'services/svc-bank/src/cards.test.ts',
    'apps/customer/src/features/more/Support.test.tsx',
    'packages/money-math/src/add.spec.ts',
  ])
    assert.equal(pathKind(p).kind, 'none', p);
  assert.deepEqual(pathKind('apps/customer/tests/real-app/J-bank-13.pw.mjs'), { kind: 'file', file: 'J-bank-13.pw.mjs' });
  assert.deepEqual(pathKind('apps/customer/tests/real-app/J-ops-console-02-documents.pw.mjs'), {
    kind: 'file',
    file: 'J-ops-console-02-documents.pw.mjs',
  });
  // A look sweep holds no journey steps, so no report's `ran` lists it: a files verdict could never seal it.
  assert.equal(pathKind('apps/customer/tests/real-app/look-sweep-390.pw.mjs').kind, 'full');
  assert.equal(pathKind('apps/customer/tests/real-app/registry-blockers.pw.mjs').kind, 'full');
});

test('a path with a control character is full and is printed without it (no workflow command from a file name)', () => {
  const evil = 'apps/customer/tests/real-app/J-a-01\n::error::x.pw.mjs';
  assert.equal(pathKind(evil).kind, 'full');
  const t = journeyTouch([evil]);
  assert.equal(t.mode, 'full');
  assert.equal(t.full[0].path.includes('\n'), false);
});

test('journeyTouch: the most demanding path decides; a removed journey file runs nothing', () => {
  assert.deepEqual(journeyTouch(['.github/workflows/ci.yml']), { mode: 'none', full: [], files: [] });
  assert.deepEqual(journeyTouch([]), { mode: 'none', full: [], files: [] });
  const two = journeyTouch([
    'apps/customer/tests/real-app/J-bank-14.pw.mjs',
    'apps/customer/tests/real-app/J-bank-13.pw.mjs',
    'tooling/ci/gates.mjs',
  ]);
  assert.deepEqual([two.mode, two.files], ['files', ['J-bank-13.pw.mjs', 'J-bank-14.pw.mjs']]);
  const mixed = journeyTouch(['apps/customer/tests/real-app/J-bank-13.pw.mjs', 'services/svc-bank/src/cards.ts']);
  assert.equal(mixed.mode, 'full', 'a journey test with the product code it proves needs the full run');
  assert.deepEqual(
    mixed.full.map((x) => x.path),
    ['services/svc-bank/src/cards.ts'],
  );
  const gone = journeyTouch(['apps/customer/tests/real-app/J-old-01.pw.mjs'], () => false);
  assert.deepEqual(gone, { mode: 'none', full: [], files: [] }, 'a file the head removed has nothing to run');
  // A rename counts by both names (pullFilePaths): the old one is gone at the head, the new one runs.
  const renamed = journeyTouch(['apps/customer/tests/real-app/J-a-01.pw.mjs', 'apps/customer/tests/real-app/J-a-01-x.pw.mjs'], (f) =>
    f.endsWith('-x.pw.mjs'),
  );
  assert.deepEqual(renamed.files, ['J-a-01-x.pw.mjs']);
});

test('every SHARED_SETUP path is full, and RUN_FILE never takes a shared helper', () => {
  for (const f of execFileSync('git', ['ls-files', 'apps/customer/tests/real-app', 'tooling/scripts'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)) {
    if (isSharedSetup(f)) assert.equal(pathKind(f).kind, 'full', f);
    if (RUN_FILE.test(f)) assert.equal(isSharedSetup(f), false, f);
  }
});

/**
 * What the journeys run executes or reads, found from the repository itself: the real-app folder, the journeys
 * workflow and its actions, the tooling/scripts files the workflow names and the CI files JOURNEY_CI lists, followed
 * through every relative import and `new URL('…', import.meta.url)` reference. Every tooling/ci or .github file in that
 * set must be full: a none rule that let one through would let a change to it skip the run.
 */
function journeysRunSurface() {
  const ls = (...p) =>
    execFileSync('git', ['ls-files', ...p], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  const wf = readFileSync(join(ROOT, JOURNEYS_WORKFLOW), 'utf8');
  const actions = ls('.github/actions');
  const named = new Set();
  for (const t of [wf, ...actions.map((a) => readFileSync(join(ROOT, a), 'utf8'))])
    for (const m of t.matchAll(/(?:tooling|\.github|apps|services|packages)\/[A-Za-z0-9_./-]+/g)) {
      const p = m[0].replace(/[.]+$/, '');
      if (existsSync(join(ROOT, p)) && !p.endsWith('/')) named.add(p);
    }
  const roots = [...ls('apps/customer/tests/real-app'), JOURNEYS_WORKFLOW, ...actions, ...named, ...JOURNEY_CI];
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!/\.(m?js|ts|tsx|cjs)$/.test(f) || !existsSync(join(ROOT, f))) continue;
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/(?:from\s+|import\(\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const to = normalize(join(dirname(f), m[1]));
      if (!to.startsWith('..') && existsSync(join(ROOT, to))) queue.push(relative('.', to));
    }
  }
  return seen;
}

test('drift: every tooling/ci and .github file the journeys run executes or reads is full, never none', () => {
  const surface = journeysRunSurface();
  const ci = [...surface].filter((f) => f.startsWith('tooling/ci/') || f.startsWith('.github/'));
  assert.ok(ci.includes('tooling/ci/journey-verdict.mjs'), 'the surface reaches the verdict (sanity)');
  assert.ok(ci.includes('.github/actions/test-infra/action.yml') || ci.some((f) => f.startsWith('.github/actions/')), 'and the actions');
  for (const f of ci) assert.equal(pathKind(f).kind, 'full', `${f} is part of the journeys run but would touch no journey`);
  for (const f of surface) if (/^(apps|services|packages)\//.test(f)) assert.notEqual(pathKind(f).kind, 'none', f);
});

test('drift, planted: a CI file outside JOURNEY_CI is none, so the drift check above would catch an import of it', () => {
  assert.equal(pathKind('tooling/ci/new-helper.mjs').kind, 'none');
  assert.equal(JOURNEY_CI.includes('tooling/ci/new-helper.mjs'), false);
});

// ---- The touched-journeys verdict (journey-seal.mjs judgeTouchedRun) ----

const rep = (ran) => ({ states: {}, ran });
const touchedRun = (over) =>
  judgeTouchedRun({
    sha: HEAD,
    repo: REPO,
    files: ['J-bank-13.pw.mjs', 'J-bank-14.pw.mjs'],
    runs: [run(1)],
    reportOf: async (r) =>
      ({ 1: rep(['J-bank-13.pw.mjs', 'J-bank-14.pw.mjs']), 2: rep(['J-bank-13.pw.mjs']), 3: rep(['J-bank-14.pw.mjs']) })[r.id],
    verdictOf: async () => clean,
    ...over,
  });

test('judgeTouchedRun: every touched file run clean on the exact head passes, across one run or several', async () => {
  assert.equal((await touchedRun()).ok, true);
  assert.equal((await touchedRun({ runs: [run(2), run(3)] })).ok, true, 'two targeted runs between them cover both files');
});

test('judgeTouchedRun, planted: a missed touched file, a red step, an older head, a run going, an unreadable report', async () => {
  const miss = await touchedRun({ runs: [run(2)] });
  assert.equal(miss.ok, false, 'a run that missed a touched journey fails');
  assert.match(miss.lines.join('\n'), /ran J-bank-14\.pw\.mjs/);
  assert.match(miss.lines.join('\n'), /-f journeys="J-bank-13\.pw\.mjs J-bank-14\.pw\.mjs"/);
  assert.equal((await touchedRun({ runs: [] })).ok, false, 'no run fails');
  assert.equal((await touchedRun({ verdictOf: async () => red('J-bank-13#2') })).ok, false, 'a red step fails');
  const newerRed = await touchedRun({ runs: [run(1), run(2)], verdictOf: async (_r, r) => (r.id === 2 ? red('J-bank-13#1') : clean) });
  assert.equal(newerRed.ok, false, 'a newer red run is not hidden behind an older clean one');
  assert.equal((await touchedRun({ runs: [run(1, { head_sha: OLD })] })).ok, false, 'a run on an older head counts for nothing');
  assert.equal((await touchedRun({ runs: [run(1), run(2, { status: 'in_progress' })] })).state, 'wait');
  assert.equal((await touchedRun({ runs: [run(1, { conclusion: 'cancelled' })] })).ok, false, 'a cancelled run says nothing');
  assert.equal((await touchedRun({ reportOf: async () => ({ error: 'no report' }) })).ok, false);
  assert.equal((await touchedRun({ reportOf: async () => Promise.reject(new Error('HTTP 500')) })).ok, false);
  assert.equal((await touchedRun({ verdictOf: async () => Promise.reject(new Error('HTTP 403')) })).ok, false);
});

// ---- The seal on a pull request: the four planted cases the gate must hold, and their passing twins ----

const BANK13 = "const J = 'J-bank-13';\ntest(`${J} #1 x`, () => {});\ntest(`${J} #2 y`, () => {});\n";
const BANK14 = "const J = 'J-bank-14';\ntest(`${J} #1 x`, () => {});\n";
const FULL = ['J-bank-13.pw.mjs', 'J-bank-14.pw.mjs', 'J-wallet-05.pw.mjs'];
const seal = ({
  title = 'x',
  body = '',
  files,
  runs,
  reports,
  verdict = async (r) => (r.ran.length < FULL.length ? { ...clean, missing: FULL.filter((f) => !r.ran.includes(f)) } : clean),
}) =>
  sealPull({
    repo: REPO,
    number: 9,
    sha: HEAD,
    io: {
      pull: async () => ({ state: 'open', head: { sha: HEAD }, base: { sha: OLD }, title, body }),
      runs: async () => runs,
      reportOf: async (r) => reports[r.id],
      files: async () => files,
      text: async (f, ref) =>
        ref === HEAD
          ? ({ 'apps/customer/tests/real-app/J-bank-13.pw.mjs': BANK13, 'apps/customer/tests/real-app/J-bank-14.pw.mjs': BANK14 }[f] ??
            null)
          : null,
      verdictOf: verdict,
    },
  });
const fullRun = { states: {}, ran: FULL };
const partial = { states: {}, ran: ['J-bank-13.pw.mjs'] };

test('planted 1: a shared-setup pull request with only a partial run fails the seal; with a clean full run it passes', async () => {
  const files = ['tooling/scripts/local-test-market.mjs'];
  const bad = await seal({ files, runs: [run(1)], reports: { 1: partial } });
  assert.equal(bad.ok, false);
  assert.equal(bad.fullOk, false);
  assert.match(bad.lines.join('\n'), /is not a full run/);
  const good = await seal({ files, runs: [run(1)], reports: { 1: fullRun } });
  assert.equal(good.ok, true, good.lines.join('\n'));
});

test('planted 2: a product pull request whose run misses a journey it touches fails the seal; with every one run it passes', async () => {
  // Product code: no map says which journeys reach it, so it touches every journey and needs the full run.
  const product = ['services/svc-bank/src/cards.ts', 'apps/customer/src/features/bank/Cards.tsx'];
  const bad = await seal({
    title: 'svc-bank: cards (J-bank-13 #1 #2)',
    files: product,
    runs: [run(1)],
    reports: { 1: { ...partial, states: { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'passed' } } },
  });
  assert.equal(bad.ok, false, 'green named steps in a targeted run do not cover the journeys product code can reach');
  assert.equal(bad.stepsOk, true);
  assert.equal(bad.fullOk, false);
  assert.match(bad.lines.join('\n'), /it changes what can reach any journey/);
  const good = await seal({
    title: 'svc-bank: cards (J-bank-13 #1 #2)',
    files: product,
    runs: [run(1)],
    reports: { 1: { ...fullRun, states: { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'passed' } } },
  });
  assert.equal(good.ok, true, good.lines.join('\n'));
  // Journey test files only: the run must hold each changed file.
  const tests = ['apps/customer/tests/real-app/J-bank-13.pw.mjs', 'apps/customer/tests/real-app/J-bank-14.pw.mjs'];
  const states = { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'passed', 'J-bank-14#1': 'passed' };
  const missed = await seal({
    title: 'test(journeys): J-bank-13 #1, J-bank-14 #1',
    files: tests,
    runs: [run(1)],
    reports: { 1: { states, ran: ['J-bank-13.pw.mjs'] } },
  });
  assert.equal(missed.ok, false, 'a run that missed a touched journey file fails');
  assert.match(missed.lines.join('\n'), /no finished Real-app journeys run on this exact head ran J-bank-14\.pw\.mjs/);
  const both = await seal({
    title: 'test(journeys): J-bank-13 #1, J-bank-14 #1',
    files: tests,
    runs: [run(1)],
    reports: { 1: { states, ran: ['J-bank-13.pw.mjs', 'J-bank-14.pw.mjs'] } },
  });
  assert.equal(both.ok, true, both.lines.join('\n'));
});

test('the seal still needs every titled step passing: a clean full run with a titled step red fails', async () => {
  const v = await seal({
    title: 'svc-bank: cards (J-bank-13 #1 #2)',
    files: ['services/svc-bank/src/cards.ts'],
    runs: [run(1)],
    reports: { 1: { ...fullRun, states: { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'failed' } } },
  });
  assert.equal(v.ok, false);
  assert.equal(v.stepsOk, false);
});

test("GitHub's Revert form of a product change needs no run; a revert of shared setup still needs the full run", async () => {
  const revert = { title: 'Revert "svc-bank: cards"', body: 'Reverts INTAFACED/intafaced#7400' };
  assert.equal((await seal({ ...revert, files: ['services/svc-bank/src/cards.ts'], runs: [], reports: {} })).ok, true);
  assert.equal((await seal({ ...revert, files: ['tooling/scripts/local-test-market.mjs'], runs: [], reports: {} })).ok, false);
  assert.equal(
    (await seal({ ...revert, files: ['tooling/scripts/local-test-market.mjs'], runs: [run(1)], reports: { 1: fullRun } })).ok,
    true,
    'a revert of shared setup with its clean full run seals (its runs are read)',
  );
  assert.equal(
    (await seal({ title: 'Revert "svc-bank: cards"', body: 'undo', files: ['services/svc-bank/src/cards.ts'], runs: [], reports: {} })).ok,
    false,
    'a Revert title without GitHub’s body line is no revert',
  );
});
