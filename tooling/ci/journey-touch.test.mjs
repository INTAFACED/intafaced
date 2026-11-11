// node --test tooling/ci/journey-touch.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_READ, JOURNEY_CI, RUN_FILE, journeyTouch, pathKind } from './journey-touch.mjs';
import { JOURNEYS_WORKFLOW, fullVerdict, isSharedSetup, judgeFullRun, judgeTouchedRun, sealPull } from './journey-seal.mjs';

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
    'docs/runbooks/INCIDENT-MONEY-PATH-RUNBOOK.md', // a journey reads it
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
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    'docs/ci/checks-counted-2026-11-09.md', // a doc no code reads (#7766 paid for a full run)
    'docs/ARCHITECTURE.md',
    'docs/adr/2026-08-04-bank-vertical-law.md',
  ])
    assert.equal(pathKind(p).kind, 'none', p);
  // Planted: the docs code reads stay full, by file and by folder.
  for (const p of ['docs/roadmap/journeys.json', 'docs/runbooks/journey-baseline.json', 'docs/RUNNING.md', 'docs/audits/a.md'])
    assert.equal(pathKind(p).kind, 'full', p);
  assert.equal(pathKind('docs/RUNNING.md.bak').kind, 'none', 'a listed file covers only itself');
  // Planted: Markdown below the root stays full, where journeys read it.
  for (const p of ['docs/runbooks/INCIDENT-MONEY-PATH-RUNBOOK.md', 'docs/roadmap/x.md', 'apps/customer/public/developers/index.md'])
    assert.equal(pathKind(p).kind, 'full', p);
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

// ---- U4 C3 piece 1: a pull request runs what it touches, with no dispatch ----

test('--json --files-from: a pull request file list, judged against this checkout of its head', () => {
  const dir = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
  const run = (lines) => {
    const f = join(dir, 'changed.txt');
    execFileSync('sh', ['-c', `printf '%s' "$1" > "$2"`, 'sh', lines.join('\n') + '\n', f]);
    return JSON.parse(
      execFileSync('node', [join(ROOT, 'tooling/ci/journey-touch.mjs'), '--json', '--files-from', f], { cwd: ROOT, encoding: 'utf8' }),
    );
  };
  assert.equal(run(['services/svc-bank/src/a.ts']).mode, 'full', 'product code: the full suite');
  const files = run(['.github/workflows/ci.yml', 'apps/customer/tests/real-app/J-bank-13.pw.mjs']);
  assert.deepEqual([files.mode, files.files], ['files', ['J-bank-13.pw.mjs']], 'a journey test file: only it');
  assert.equal(run(['.github/workflows/ci.yml', 'services/svc-bank/src/a.test.ts']).mode, 'none', 'nothing a journeys run reads');
  assert.equal(run(['apps/customer/tests/real-app/J-zzz-99.pw.mjs']).mode, 'none', 'a journey file the head removed runs nothing');
  rmSync(dir, { recursive: true, force: true });
});

test('real-app-journeys.yml runs on ready pull requests, tests their head, and an empty plan says nothing', () => {
  const t = readFileSync(join(ROOT, '.github/workflows/real-app-journeys.yml'), 'utf8');
  assert.match(t, /\n  pull_request:\n    types: \[opened, synchronize, reopened, ready_for_review\]\n/);
  // Every checkout tests the pull request's head (the seal reads runs by head), never GitHub's merge commit, except the
  // default branch's copy of the rules the touch job judges with.
  const checkouts = [...t.matchAll(/uses: actions\/checkout@[^\n]*\n((?: {8}[^\n]*\n)+)/g)].map((m) => m[1]);
  assert.ok(checkouts.length >= 5);
  for (const c of checkouts) if (!/path: \.base/.test(c)) assert.match(c, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.ok(checkouts.some((c) => /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/.test(c) && /path: \.base/.test(c)));
  assert.match(
    t,
    /node "\$GITHUB_WORKSPACE\/\.base\/tooling\/ci\/journey-touch\.mjs" --json --reach --files-from/,
    "the base's copy, with the touched-journeys map",
  );
  // A pull request run keeps the ordinary limits, as a targeted run does.
  assert.match(
    t,
    /JOURNEY_FAIL_FAST: \$\{\{ env\.JOURNEYS_TARGET == '' && github\.event_name != 'schedule' && github\.event_name != 'pull_request'/,
  );
  // A draft or a fork runs nothing; files that can't be read whole run the full suite; a manual input is names only.
  assert.match(t, /if \[ "\$DRAFT" = true \] \|\| \[ "\$SAME_REPO" != true \]/);
  assert.match(t, /\|\| full "this pull request's files couldn't be read"/);
  assert.match(t, /-ge 3000 \]; then full /);
  assert.match(t, /=~ \^\[A-Za-z0-9\._,\\ -\]\*\$ \]\]/);
  // The steps the title names and no Left-or-replaced line leaves run too, by the seal's own readers (council R3/G1).
  assert.match(t, /m\.exemptions\(process\.env\.BODY\)\.steps/);
  assert.match(t, /m\.titleSteps\(process\.env\.TITLE\)/);
  assert.match(t, /none\) if \[ -n "\$named" \]; then \{ echo "mode=run"; echo "target=\$named"; \}/);
  // A failed touch job on a fork or a draft never falls through to the full suite (council R4).
  assert.equal(
    t.split('github.event.pull_request.head.repo.full_name == github.repository && !github.event.pull_request.draft').length - 1,
    3,
  );
  // Nothing to run: no plan, no build, no shard, and an empty report that the seal reads as saying nothing. The plan
  // runs in the touch job, so each of its steps checks the touch step's decision and PLANS (never a draft or a fork).
  assert.match(
    t,
    /\n {6}PLANS: \$\{\{ github\.event_name != 'pull_request' \|\| \(github\.event\.pull_request\.head\.repo\.full_name == github\.repository && !github\.event\.pull_request\.draft\) \}\}\n/,
  );
  for (const name of ["Last finished runs' reports", 'Plan', 'Fail-fast plan'])
    assert.match(
      t,
      new RegExp(
        `\\n {6}- name: ${name}\\n(?: {8}[^\\n]*\\n)*? {8}if: \\$\\{\\{ !cancelled\\(\\) && env\\.PLANS == 'true' && steps\\.touch\\.outputs\\.mode != 'none' && steps\\.first\\.outputs\\.deferred != 'true' \\}\\}\\n`,
      ),
    );
  assert.doesNotMatch(t, /\n  plan:\n/);
  assert.match(
    t,
    /\n  build:\n(?: {4}[^\n]*\n)*? {4}if: \$\{\{ !cancelled\(\) && needs\.touch\.result == 'success' && needs\.touch\.outputs\.mode != 'none' && \(github\.event_name != 'pull_request'/,
  );
  // The shards wait on a touch job that succeeded: a targeted run without its plan fails that job, so no shard runs.
  assert.match(
    t,
    /\n  journeys:\n(?: {4}[^\n]*\n)*? {4}if: \$\{\{ !cancelled\(\) && needs\.touch\.result == 'success' && needs\.touch\.outputs\.mode != 'none' && /,
  );
  assert.match(t, /JOURNEYS_TARGET: \$\{\{ needs\.touch\.outputs\.target \}\}/);
});

test('real-app-journeys.yml on main: the touch step decides nothing, so a push, a scheduled run or a dispatch with a journeys input keeps an empty target and the full suite', () => {
  const t = readFileSync(join(ROOT, '.github/workflows/real-app-journeys.yml'), 'utf8');
  // The touch step's own script, run as GitHub runs it.
  const at = t.indexOf('\n        id: touch\n');
  assert.ok(at > 0, 'the touch step');
  const from = t.indexOf('\n        run: |\n', at) + '\n        run: |\n'.length;
  const lines = [];
  for (const l of t.slice(from).split('\n')) {
    if (l !== '' && !l.startsWith('          ')) break;
    lines.push(l.slice(10));
  }
  const script = lines.join('\n');
  const dir = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
  try {
    const touch = (env) => {
      const out = join(dir, `out-${Math.random().toString(36).slice(2)}`);
      execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, RUNNER_TEMP: dir, ...env },
      });
      return Object.fromEntries(
        readFileSync(out, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      );
    };
    // Planted: the journeys input reaches the step on main (as if the workflow-level guard were lost).
    for (const EVENT of ['push', 'schedule', 'workflow_dispatch'])
      assert.deepEqual(
        touch({ GITHUB_REF: 'refs/heads/main', EVENT, JOURNEYS_TARGET: 'j-wallet-01.pw.mjs' }),
        { mode: 'run', target: '' },
        EVENT,
      );
    // Off main a dispatch's input still targets its journeys.
    assert.deepEqual(touch({ GITHUB_REF: 'refs/heads/x', EVENT: 'workflow_dispatch', JOURNEYS_TARGET: 'j-wallet-01.pw.mjs' }), {
      mode: 'run',
      target: 'j-wallet-01.pw.mjs',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // And every way a target leaves the touch job is empty on main: the workflow's input, the job's output and the plan's.
  assert.match(
    t,
    /\n  JOURNEYS_TARGET: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.ref != 'refs\/heads\/main' && inputs\.journeys \|\| '' \}\}\n/,
  );
  assert.match(
    t,
    /\n {6}target: \$\{\{ github\.ref != 'refs\/heads\/main' && steps\.first\.outputs\.deferred != 'true' && steps\.touch\.outputs\.target \|\| '' \}\}\n/,
  );
  assert.match(
    t,
    /\n {6}- name: Plan\n(?: {8}[^\n]*\n)*? {10}JOURNEYS_TARGET: \$\{\{ github\.ref != 'refs\/heads\/main' && steps\.touch\.outputs\.target \|\| '' \}\}\n/,
  );
});

test('an empty report (nothing to run) seals nothing and blocks nothing', async () => {
  const { readReport } = await import('./journey-verdict.mjs');
  const empty = readReport({ suites: [], errors: [], stats: { expected: 0, unexpected: 0 } });
  assert.deepEqual([Object.keys(empty.states).length, [...(empty.ran ?? [])].length], [0, 0]);
  const HEAD = 'a'.repeat(40);
  const REPO = 'INTAFACED/intafaced';
  const r = (id, over = {}) => ({
    id,
    head_sha: HEAD,
    path: JOURNEYS_WORKFLOW,
    status: 'completed',
    conclusion: 'success',
    created_at: `2026-11-08T0${id}:00:00Z`,
    run_started_at: `2026-11-08T0${id}:00:00Z`,
    head_repository: { full_name: REPO },
    repository: { full_name: REPO },
    ...over,
  });
  // A newer empty run never hides an older run's red, and never stands in for a run of the touched file.
  const reports = { 1: { states: { 'J-a-01#1': 'failed' }, ran: ['J-a-01.pw.mjs'] }, 2: empty };
  const v = await judgeTouchedRun({
    sha: HEAD,
    repo: REPO,
    files: ['J-a-01.pw.mjs'],
    runs: [r(1), r(2)],
    reportOf: async (x) => reports[x.id],
    verdictOf: async (rep) => ({ red: rep.states['J-a-01#1'] === 'failed' ? [{ step: 'J-a-01#1', why: 'failing' }] : [], missing: [] }),
  });
  assert.equal(v.ok, false);
  const alone = await judgeTouchedRun({
    sha: HEAD,
    repo: REPO,
    files: ['J-a-01.pw.mjs'],
    runs: [r(2)],
    reportOf: async () => empty,
    verdictOf: async () => ({ red: [], missing: [] }),
  });
  assert.equal(alone.ok, false, 'an empty run does not prove a touched file');
});

test('CI review: an empty run (nothing to run, or a draft) never stands in for the full run product code needs', async () => {
  const { readReport } = await import('./journey-verdict.mjs');
  const spec = (title, file) => ({ title, file, tests: [{ status: 'expected' }] });
  const named = readReport({
    suites: [{ file: 'J-a-01.pw.mjs', specs: [spec('J-a-01 #1', 'J-a-01.pw.mjs'), spec('J-b-01 #1', 'J-b-01.pw.mjs')] }],
  });
  const empty = readReport({ suites: [], errors: [], stats: { expected: 0, unexpected: 0 } });
  const inputs = { baseline: { run: { number: 100, id: 1, sha: 'c'.repeat(40) }, steps: [] }, money: {}, reports: new Map() };
  const read = () => ({ named, passedSince: {}, issues: {}, problems: [], shas: {} });
  const HEAD = 'a'.repeat(40);
  const REPO = 'INTAFACED/intafaced';
  const run = {
    id: 9,
    head_sha: HEAD,
    path: JOURNEYS_WORKFLOW,
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-11-08T05:00:00Z',
    run_started_at: '2026-11-08T05:00:00Z',
    head_repository: { full_name: REPO },
    repository: { full_name: REPO },
  };
  // The seal's own full-run rule, with its real verdict: a green run whose report ran no journey file is short of
  // every file, so it is passed over, and with no full run the seal fails.
  const v = await judgeFullRun({
    sha: HEAD,
    repo: REPO,
    shared: [],
    because: 'it changes product code',
    runs: [run],
    reportOf: async () => empty,
    verdictOf: async (report, r) => fullVerdict({ repo: REPO, report, run: r, inputs, read }),
  });
  assert.equal(v.ok, false);
  assert.match(v.lines.join('\n'), /none has finished/);
  assert.match(v.lines.join('\n'), /not a full run \(no step from 2 journey file/);
});

test('root Markdown runs no journeys because nothing the journeys run executes reads a root Markdown file (CI review on c8dccd77)', () => {
  // What the Real-app journeys run executes: its workflow, the actions it uses, every script the workflow runs, and the
  // journey files, followed through their relative imports. If any of them reads a root Markdown file (a read call
  // and the file's name on one line of code, not a comment), a change to that file could break a journey, and the rule
  // that root Markdown runs none would be wrong. A name in a message or a path list is not a read.
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const rootMd = git('ls-files').filter((f) => /^[^/]+\.md$/.test(f));
  assert.ok(rootMd.includes('AGENTS.md') && rootMd.includes('README.md'), 'the root Markdown files are listed');
  const WORKFLOW = '.github/workflows/real-app-journeys.yml';
  const workflow = readFileSync(join(ROOT, WORKFLOW), 'utf8');
  const scripts = [...workflow.matchAll(/\b((?:tooling|apps|services|packages)\/[\w./-]+\.(?:mjs|cjs|js|ts))\b/g)].map((m) => m[1]);
  assert.ok(scripts.includes('tooling/scripts/local-test-stack.mjs'), 'the workflow runs the stack script');
  const queue = [WORKFLOW, ...git('ls-files', '.github/actions'), ...scripts, ...git('ls-files', 'apps/customer/tests/real-app')];
  const seen = new Set();
  const names = new RegExp(`(^|[^\\w/.-])(${rootMd.map((f) => f.replace(/\./g, '\\.')).join('|')})`);
  const reads =
    /\b(readFile|readFileSync|createReadStream|existsSync|statSync|openSync)\(|\bfetch\(|(^|[;&|]|\$\(|run:)\s*(cat|cp|head|tail|grep|sed|git show)\s|<\s*\S+\.md\b/;
  const named = [];
  while (queue.length) {
    const f = normalize(queue.shift());
    if (seen.has(f) || !existsSync(join(ROOT, f))) continue;
    seen.add(f);
    const text = readFileSync(join(ROOT, f), 'utf8');
    text.split('\n').forEach((line, i) => {
      const code = line.replace(/^\s*(\/\/|\*|\/\*|#).*$/, '').replace(/\s\/\/.*$/, '');
      if (names.test(code) && reads.test(code)) named.push(`${f}:${i + 1}`);
    });
    for (const m of text.matchAll(/(?:from\s+|import\(\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g))
      queue.push(relative(ROOT, join(ROOT, dirname(f), m[1])));
  }
  assert.ok(seen.size > 50, `followed the journeys run's files (${seen.size})`);
  assert.deepEqual(named, [], 'nothing the journeys run executes reads a root Markdown file');
});

test('DOCS_READ holds every doc the journeys run, the stack or a service names by path, so the rest of docs/ runs none', () => {
  // What the journeys run executes or the stack serves: its workflow and actions, the scripts it runs and the journey files
  // (followed through their relative imports), and every non-test source under apps/, services/ and packages/. A doc
  // named in code (not a comment), as a path or as a call's 'docs' argument (join(…, 'docs', '<folder>', …)), must be in DOCS_READ.
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const WORKFLOW = '.github/workflows/real-app-journeys.yml';
  const workflow = readFileSync(join(ROOT, WORKFLOW), 'utf8');
  const scripts = [...workflow.matchAll(/\b((?:tooling|apps|services|packages)\/[\w./-]+\.(?:mjs|cjs|js|ts))\b/g)].map((m) => m[1]);
  const product = git('ls-files', 'apps', 'services', 'packages').filter(
    (f) => /\.(m?[jt]sx?|cjs|json|ya?ml|sh)$/.test(f) && !/\.(test|spec)\.|\/tests?\/|__tests__/.test(f),
  );
  const queue = [
    WORKFLOW,
    ...git('ls-files', '.github/actions'),
    ...scripts,
    ...git('ls-files', 'apps/customer/tests/real-app'),
    ...product,
  ];
  // A `pnpm <name>` the scanned code runs is followed to the files its root package.json script names (the stack, the
  // seed, world-restore and the TEST market maker are reached that way too; CI review on cb864ce1).
  const pnpmScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
  const scriptFiles = (name, depth = 0) => {
    const cmd = pnpmScripts[name];
    if (!cmd || depth > 5) return [];
    return [
      ...[...cmd.matchAll(/\b((?:tooling|apps|services|packages)\/[\w./-]+\.(?:mjs|cjs|js|ts|sh))\b/g)].map((m) => m[1]),
      ...[...cmd.matchAll(/\bpnpm\s+(?:run\s+)?([\w:.-]+)/g)].flatMap((m) => scriptFiles(m[1], depth + 1)),
    ];
  };
  // Its own inline cases (paths a rule is tested on, never read): the review marker's, and this rule's own.
  const SELF_CASES = new Set(['tooling/ci/review-marker.mjs', 'tooling/ci/journey-touch.mjs']);
  const covered = (n) => DOCS_READ.some((d) => n === d || `${n}/` === d || n.startsWith(d));
  const seen = new Set();
  const missed = [];
  while (queue.length) {
    const f = normalize(queue.shift());
    if (seen.has(f) || !existsSync(join(ROOT, f)) || !statSync(join(ROOT, f)).isFile()) continue;
    seen.add(f);
    const text = readFileSync(join(ROOT, f), 'utf8');
    const code = text
      .split('\n')
      .map((line) => line.replace(/^\s*(\/\/|\*|\/\*|#).*$/, '').replace(/\s\/\/.*$/, ''))
      .join('\n');
    const names = [
      ...[...code.matchAll(/(?<![\w.-])docs\/\w[\w./*-]*/g)].map((m) => m[0].replace(/[.*/]+$/, '')),
      ...[...code.matchAll(/['"`]docs\/['"`]/g)].map(() => 'docs'),
      // 'docs' as a call argument (join(…, 'docs', 'roadmap'), however deeply the call nests), with the next one.
      ...[...code.matchAll(/[(,]\s*['"`]docs['"`](\s*,\s*['"`]([\w.-]+)['"`])?/g)].map((m) => (m[2] ? `docs/${m[2]}` : 'docs')),
    ];
    if (!SELF_CASES.has(f)) for (const n of names) if (!covered(n)) missed.push(`${f}: ${n}`);
    for (const m of code.matchAll(/\bpnpm\s+(?:run\s+)?([\w:.-]+)/g)) queue.push(...scriptFiles(m[1]));
    if (/\.(m?[jt]sx?|cjs)$/.test(f))
      for (const m of text.matchAll(/(?:from\s+|import\(\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g))
        queue.push(relative(ROOT, join(ROOT, dirname(f), m[1])));
  }
  assert.ok(seen.size > 1000, `followed the journeys run's files and the product sources (${seen.size})`);
  assert.deepEqual(missed, [], 'a doc this code names is missing from DOCS_READ');
});

test('DOCS_READ drift, planted: a doc named in code and not listed is caught by the same matcher', () => {
  const covered = (n) => DOCS_READ.some((d) => n === d || `${n}/` === d || n.startsWith(d));
  for (const n of ['docs/new-thing.md', 'docs/ci', 'docs']) assert.equal(covered(n), false, n);
  for (const n of ['docs/roadmap', 'docs/runbooks/journey-baseline.json', 'docs/RUNNING.md']) assert.equal(covered(n), true, n);
});

// RULING 8 (project-state#2065): a pull request's journeys run really runs only what it touches. The map below is the
// shape journey-reach-map.mjs builds: svc-agents subscribes to bus events and is on the money list.
{
  const journeys = ['J-a-01.pw.mjs', 'J-b-01.pw.mjs', 'J-c-01.pw.mjs', 'J-d-01.pw.mjs'];
  const map = {
    v: 1,
    mode: 'reach',
    runs: [1, 2, 3].map((id) => ({ id, head: 'x', created: '2026-11-10T00:00:00Z' })),
    journeys,
    full: {},
    services: { 'services/svc-agents': [0, 1], 'services/svc-ledger': [1, 2], 'services/svc-edge': [0, 1, 2, 3] },
    packages: { 'packages/ledger-client': [0, 1, 2, 3], 'packages/venue-contracts': [1, 2] },
    customer: {},
    consumers: { 'packages/ledger-client': ['services/svc-ledger'], 'packages/venue-contracts': ['services/svc-agents'] },
    dependents: {},
    harness: ['packages/ledger-client'],
    subscribers: ['services/svc-agents'],
    money: ['packages/ledger-client', 'packages/venue-contracts', 'services/svc-agents', 'services/svc-ledger'],
  };
  const touch = (paths, subscribes = () => false) =>
    journeyTouch(paths, () => true, { map, behind: 0, journeyFiles: new Set(journeys), subscribes, mode: 'reach' });

  test('RULING 8: a change only to services/svc-agents, which subscribes to bus events, is targeted (#7876 ran all 32 shards)', () => {
    const t = touch(['services/svc-agents/src/oplog/routes.ts', 'services/svc-agents/src/oplog/store.ts']);
    assert.equal(t.mode, 'files');
    assert.deepEqual(t.files, ['J-a-01.pw.mjs', 'J-b-01.pw.mjs']);
  });

  test('RULING 8: the changed file that holds a bus handler stays full', () => {
    const t = touch(['services/svc-agents/src/crew-events.ts'], (p) => p.endsWith('crew-events.ts'));
    assert.equal(t.mode, 'full');
    assert.match(t.full[0].why, /it subscribes to bus events/);
  });

  test('RULING 8: a money path still runs every journey it reaches today', () => {
    // A money service: exactly its recorded journeys.
    assert.deepEqual(touch(['services/svc-ledger/src/x.ts']).files, ['J-b-01.pw.mjs', 'J-c-01.pw.mjs']);
    // Every journey recorded reaching a money service that subscribes still runs.
    assert.deepEqual(touch(['services/svc-agents/src/x.ts']).files, ['J-a-01.pw.mjs', 'J-b-01.pw.mjs']);
    // A money package used by a subscribing service stays full, as it was.
    const pkg = touch(['packages/venue-contracts/src/x.ts']);
    assert.equal(pkg.mode, 'full');
    assert.match(pkg.full[0].why, /depends on packages\/venue-contracts and subscribes/);
    // A money package the journey harness imports stays full, as it was.
    assert.equal(touch(['packages/ledger-client/src/x.ts']).mode, 'full');
  });

  test('RULING 8: what truly reaches every journey stays full', () => {
    for (const p of [
      'tooling/scripts/local-test-stack.mjs',
      'tooling/scripts/local-stack-services/bank.mjs',
      'apps/customer/tests/real-app/journey.mjs',
      'tooling/profiles/test-owner-values/bank.json',
      '.github/workflows/real-app-journeys.yml',
      'tooling/ci/journey-seal.mjs',
      'pnpm-lock.yaml',
      'package.json',
    ])
      assert.equal(touch([p]).mode, 'full', p);
    // A service every journey was recorded reaching: the selection holds every journey, which is the full run.
    assert.equal(touch(['services/svc-edge/src/x.ts']).mode, 'full');
  });
}
