// node --test tooling/ci/journey-touch.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANARY,
  DOCS_READ,
  FACTORY_SCRIPTS,
  HELPER,
  STACK_CANARY,
  STACK_HELPERS,
  JOURNEY_CI,
  ROOT_DEPLOY_FILE,
  RUN_FILE,
  STACK_FILE,
  afterReuse,
  checkoutJourneyTexts,
  reusableRuns,
  journeyTouch,
  namedInputs,
  namedJourneyIds,
  pathKind,
  stackImporters,
} from './journey-touch.mjs';
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

// ---- Factory scripts and git hooks (FACTORY_SCRIPTS, .githooks): what no journeys run reaches ----

/** A file's text with its comment lines and trailing comments removed (a name in a comment executes nothing). */
const codeOf = (f, text) =>
  /\.(m?[jt]sx?|cjs|mts|ya?ml|sh)$/.test(f) || !/\.[a-z]+$/i.test(f)
    ? text
        .split('\n')
        .map((l) =>
          l
            .replace(/^\s*(\/\/|\*|\/\*|#).*$/, '')
            .replace(/\s\/\/.*$/, '')
            .replace(/\s#\s.*$/, ''),
        )
        .join('\n')
    : text;

/** Whether `text` reaches the tooling/scripts file `s`: by its path below tooling/scripts or its file name. */
const names = (text, s) => {
  const rel = s.slice('tooling/scripts/'.length);
  const esc = (x) => x.replace(/[.]/g, '\\.');
  return new RegExp(`(?<![\\w.-])(${esc(rel)}|${esc(rel.split('/').pop())})(?![\\w-])`).test(text);
};

/**
 * Every tooling/scripts file the journeys run, the stack or the app's build can reach, from the repository itself. The
 * roots: the journeys workflow and its actions, every app, service and package file that is not a unit test (the
 * journey files and their helpers, the apps' and services' sources, configs and package.json scripts, which the app's
 * build runs), the root build and deploy files, the stack's environment (tooling/profiles, tooling/infra), the CI files
 * JOURNEY_CI lists and the stack's shared setup. A script is reached when a root's code (comments left out) names it by
 * its path below tooling/scripts or its file name, or runs a root `pnpm` script whose command names it (pnpm's install
 * scripts and each script's pre and post scripts included); a reached script is followed in turn.
 */
let reachedOnce;
function scriptsReached() {
  reachedOnce ??= scanScripts();
  return reachedOnce;
}

function scanScripts(read = (f) => readFileSync(join(ROOT, f), 'utf8')) {
  const all = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1e8 }).split('\n').filter(Boolean);
  const scripts = all.filter((f) => f.startsWith('tooling/scripts/'));
  const unit = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) && !f.startsWith('apps/customer/tests/real-app/');
  const roots = all.filter(
    (f) =>
      f === JOURNEYS_WORKFLOW ||
      f.startsWith('.github/actions/') ||
      (/^(apps|services|packages)\//.test(f) && !unit(f)) ||
      /^(turbo\.json|pnpm-workspace\.yaml|docker-compose[^/]*\.ya?ml|Dockerfile[^/]*|\.env\.example)$/.test(f) ||
      /^tooling\/(profiles|infra)\//.test(f) ||
      JOURNEY_CI.includes(f) ||
      isSharedSetup(f),
  );
  // One pass a file: every script's path below tooling/scripts and its file name in one pattern (what `names` matches).
  const byName = new Map();
  for (const sc of scripts)
    for (const n of [sc.slice('tooling/scripts/'.length), sc.split('/').pop()]) byName.set(n, [...(byName.get(n) ?? []), sc]);
  const alt = [...byName.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.]/g, '\\.'));
  const anyName = new RegExp(`(?<![\\w.-])(${alt.join('|')})(?![\\w-])`, 'g');
  const pnpm = JSON.parse(read('package.json')).scripts ?? {};
  const queue = [...roots];
  const runScript = (n) => {
    for (const k of [`pre${n}`, n, `post${n}`]) if (pnpm[k]) queue.push(`pnpm:${k}`);
  };
  for (const n of ['preinstall', 'install', 'postinstall', 'prepare']) runScript(n);
  const reached = new Map();
  const seen = new Set();
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    let text;
    try {
      text = f.startsWith('pnpm:') ? pnpm[f.slice(5)] : statSync(join(ROOT, f)).isFile() ? codeOf(f, read(f)) : '';
      // The list itself names its entries and runs none of them.
      if (f === 'tooling/ci/journey-touch.mjs') text = text.replace(/export const FACTORY_SCRIPTS = \[[^\]]*\];/, '');
    } catch {
      text = '';
    }
    for (const m of text.matchAll(anyName))
      for (const sc of byName.get(m[1]))
        if (!reached.has(sc)) {
          reached.set(sc, f);
          queue.push(sc);
        }
    for (const m of text.matchAll(/\bpnpm(?:\s+-\S+)*(?:\s+run)?(?:\s+-\S+)*\s+([\w:.][\w:.-]*)/g)) runScript(m[1]);
  }
  return { reached, seen };
}

test('FACTORY_SCRIPTS: nothing the journeys run, the stack or the app build reaches any of them, so they run no journeys', () => {
  const { reached, seen } = scriptsReached();
  assert.ok(seen.size > 1000, `followed the journeys run, the stack and the app sources (${seen.size})`);
  // Sanity: the scan finds what the run is known to use.
  for (const s of [
    'tooling/scripts/local-test-stack.mjs',
    'tooling/scripts/roadmap.mjs',
    'tooling/scripts/journey-fund.mjs',
    'tooling/scripts/local-founder-seed.mjs',
    'tooling/scripts/owner-settings.mjs',
  ])
    assert.ok(reached.has(s), `the scan reaches ${s}`);
  const wrong = FACTORY_SCRIPTS.filter((s) => reached.has(s)).map((s) => `${s} (reached from ${reached.get(s)})`);
  assert.deepEqual(wrong, [], 'a listed factory script is reached by the journeys run, the stack or the app build');
  for (const s of FACTORY_SCRIPTS) {
    assert.ok(existsSync(join(ROOT, s)), `${s} exists`);
    assert.ok(!/\.d\.[cm]?ts$|\/fixtures\//.test(s), `${s}: type declarations and fixtures stay full`);
    assert.equal(pathKind(s).kind, 'none', s);
  }
});

test('FACTORY_SCRIPTS, planted: a script the run reaches, a new script and the app build’s inputs stay full', () => {
  // The same matcher catches a reach in code and ignores a name in a comment.
  assert.equal(names(codeOf('a.mjs', "import { x } from '../../tooling/scripts/ci-checks.mjs';"), 'tooling/scripts/ci-checks.mjs'), true);
  assert.equal(names(codeOf('a.mjs', "spawn('node', [join(dir, 'ci-checks.mjs')]);"), 'tooling/scripts/ci-checks.mjs'), true);
  assert.equal(names(codeOf('a.yml', 'run: node tooling/scripts/ci-checks.mjs'), 'tooling/scripts/ci-checks.mjs'), true);
  assert.equal(
    names(codeOf('a.ts', ' * the pre-push hook picks (tooling/scripts/ci-checks.mjs `ruleTest`).'), 'tooling/scripts/ci-checks.mjs'),
    false,
  );
  assert.equal(names(codeOf('a.ts', "x('my-ci-checks.mjs')"), 'tooling/scripts/ci-checks.mjs'), false);
  for (const p of [
    'tooling/scripts/local-test-stack.mjs',
    'tooling/scripts/journey-fund.mjs',
    'tooling/scripts/journey-fund.d.mts', // the app's type check reads it
    'tooling/scripts/look-codemod.mjs', // writes app sources
    'tooling/scripts/sdk-from-openapi.ts', // writes app sources
    'tooling/scripts/fixtures/fail-fast-retries/plain.pw.mjs',
    'tooling/scripts/new-tool.mjs', // new and unlisted: full until shown unreached
    'tooling/scripts/ci-checks.mjs.bak',
  ])
    assert.equal(pathKind(p).kind, 'full', p);
});

test('git hooks run no journeys: nothing the journeys run executes commits, pushes or reads .githooks', () => {
  const { seen } = scriptsReached();
  const hits = [];
  for (const f of seen) {
    if (f.startsWith('pnpm:') || !/\.(m?[jt]sx?|cjs|mts|ya?ml|sh)$/.test(f) || !existsSync(join(ROOT, f))) continue;
    const code = codeOf(f, readFileSync(join(ROOT, f), 'utf8'));
    if (
      /\.githooks|\bgit(\s+(-C|-c)\s+\S+|\s+--?[\w-]+(=\S+)?)*\s+(commit|push)\b|['"`]git['"`]\s*,\s*\[[^\]]*['"`](commit|push)['"`]/.test(
        code,
      )
    )
      hits.push(f);
  }
  // `prepare` points git at .githooks on install; the hooks then run only on a commit or a push. The known ones are
  // outside a pull request's journeys run, so running its journeys would not exercise a hook either: journeys-revert.mjs
  // pushes a revert branch only in main-bisect.yml after a red main run (its `early` step in the journeys workflow
  // starts that workflow by the API), factory-builder.mjs pushes with --no-verify from the factory's own jobs (and names
  // `git push failed` in a message), and journey-touch.mjs is this rule.
  const KNOWN = ['tooling/ci/factory-builder.mjs', 'tooling/ci/journey-touch.mjs', 'tooling/ci/journeys-revert.mjs'];
  assert.deepEqual(hits.sort(), KNOWN, 'a file the journeys run executes commits, pushes or reads a git hook');
  assert.match(readFileSync(join(ROOT, 'tooling/ci/factory-builder.mjs'), 'utf8'), /'push', '-q', '--no-verify'/);
  const wf = readFileSync(join(ROOT, JOURNEYS_WORKFLOW), 'utf8');
  assert.deepEqual(
    [...new Set([...wf.matchAll(/journeys-revert\.mjs (\w+)/g)].map((m) => m[1]))],
    ['early'],
    'the journeys run starts the revert, never pushes it',
  );
  // The proof covers the commit and push hooks only: a hook git runs on a checkout or a merge would run in the journeys
  // run after install, so a new hook name fails here until it is shown never to fire there.
  assert.deepEqual(readdirSync(join(ROOT, '.githooks')).sort(), ['pre-commit', 'pre-push'], 'only the commit and push hooks exist');
  assert.equal(pathKind('.githooks/pre-push').kind, 'none');
  assert.equal(pathKind('.githooks/pre-commit').kind, 'none');
});

test('a factory-only pull request (#8284’s file set) runs no journeys; app code or a journey file beside it still runs them', () => {
  const factory = [
    '.githooks/pre-commit',
    '.githooks/pre-push',
    '.github/workflows/ci.yml',
    'AGENTS.md',
    'tooling/scripts/ci-checks.mjs',
    'tooling/scripts/ci-checks.test.mjs',
    'tooling/scripts/pre-push-hook.test.mjs',
  ];
  assert.deepEqual(journeyTouch(factory), { mode: 'none', full: [], files: [] });
  const app = journeyTouch([...factory, 'apps/customer/src/features/more/Support.tsx']);
  assert.equal(app.mode, 'full', 'app code beside factory files needs the full run');
  assert.deepEqual(
    app.full.map((x) => x.path),
    ['apps/customer/src/features/more/Support.tsx'],
  );
  const journey = journeyTouch([...factory, 'apps/customer/tests/real-app/J-bank-13.pw.mjs']);
  assert.deepEqual([journey.mode, journey.files], ['files', ['J-bank-13.pw.mjs']], 'a journey file beside them runs that journey');
  const helper = journeyTouch([...factory, 'apps/customer/tests/real-app/journey.mjs']);
  assert.equal(helper.mode, 'full', 'a journey helper beside them needs the full run');
  const stack = journeyTouch([...factory, 'tooling/scripts/local-test-stack.mjs']);
  assert.equal(stack.mode, 'full', 'the stack beside them needs the full run');
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
  branch = 'b',
  io = {},
}) =>
  sealPull({
    repo: REPO,
    number: 9,
    sha: HEAD,
    io: {
      pull: async () => ({ state: 'open', head: { sha: HEAD, ref: branch }, base: { sha: OLD }, title, body }),
      runs: async () => runs,
      reportOf: async (r) => reports[r.id],
      files: async () => files,
      text: async (f, ref) =>
        ref === HEAD
          ? ({ 'apps/customer/tests/real-app/J-bank-13.pw.mjs': BANK13, 'apps/customer/tests/real-app/J-bank-14.pw.mjs': BANK14 }[f] ??
            null)
          : null,
      verdictOf: verdict,
      ...io,
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
  // Product code: no map says which journeys reach it, and the head's journey files can't be read (this io has no
  // journeyFiles), so even a title that names a journey can't narrow it: it touches every journey and needs the full run.
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

// theo-01 part 1 (OWNER 296): a product pull request that names a journey is judged on that journey, its changed journey
// files, the same list its run is given (journey-touch.mjs --reach with TITLE and GITHUB_HEAD_REF); main's full run
// after the merge judges the rest, the map's always-run list (its `full` journeys) included (project-state#2332).
const HEAD_FILES = new Set(['J-bank-13.pw.mjs', 'J-bank-14.pw.mjs', 'J-wallet-05.pw.mjs', 'J-agents-12.pw.mjs']);
const ALWAYS_MAP = { mode: 'reach', full: { 'J-agents-12.pw.mjs': 'no run speaks for it', 'J-gone-01.pw.mjs': 'removed since' } };
const namedIo = { journeyFiles: async () => HEAD_FILES, reachMap: async () => ALWAYS_MAP };
const product = ['services/svc-bank/src/cards.ts', 'apps/customer/src/features/bank/Cards.tsx'];

test('journeyTouch, named: product code runs the named journey only, not the always-run list; another full path or no name stays full', () => {
  const named = namedInputs({
    ids: namedJourneyIds({ title: 'svc-bank: cards (J-bank-13 #1 #2)' }),
    journeyFiles: HEAD_FILES,
    map: ALWAYS_MAP,
  });
  // The map's always-run journey (J-agents-12, at the head) is not run: main's full run judges it.
  assert.deepEqual(named, { ids: ['J-bank-13'], files: ['J-bank-13.pw.mjs'], journeyFiles: HEAD_FILES });
  const t = journeyTouch([...product, 'apps/customer/tests/real-app/J-bank-14.pw.mjs'], () => true, null, named);
  assert.equal(t.mode, 'files');
  assert.deepEqual(t.files, ['J-bank-13.pw.mjs', 'J-bank-14.pw.mjs']);
  assert.match(t.named, /it names J-bank-13/);
  assert.doesNotMatch(t.named, /always-run/);
  assert.equal(journeyTouch([...product, 'pnpm-lock.yaml'], () => true, null, named).mode, 'full', 'a root build file stays full');
  assert.equal(journeyTouch([...product, 'tooling/scripts/local-stack-services/bank.mjs'], () => true, null, named).mode, 'full');
  assert.equal(journeyTouch(product, () => true, null, null).mode, 'full', 'no name: product code is full');
  assert.equal(journeyTouch(['docs/x.md'], () => true, null, named).mode, 'none', 'a name adds nothing to a change that reaches none');
  // Names read from the title or the branch, in the seal's case; a name with no file at the head, or unreadable files, is no name.
  assert.deepEqual(namedJourneyIds({ title: 'x', branch: 'agents-j-agents-19-sign' }), ['J-agents-19']);
  assert.deepEqual(namedJourneyIds({ title: 'test(customer): J-Portfolio-05 #1 (#7907)', branch: 'fix/7907' }), ['J-portfolio-05']);
  assert.equal(namedInputs({ ids: ['J-bank-99'], journeyFiles: HEAD_FILES, map: ALWAYS_MAP }), null);
  assert.equal(namedInputs({ ids: ['J-bank-13'], journeyFiles: null, map: ALWAYS_MAP }), null);
});

test('planted 3 (theo-01): a named-journey product pull request merges on its own journey alone, and is held when it breaks its own journey', async () => {
  const title = 'svc-bank: cards (J-bank-13 #1 #2)';
  const states = { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'passed' };
  const ran = ['J-bank-13.pw.mjs', 'J-agents-12.pw.mjs'];
  const good = await seal({
    title,
    files: product,
    runs: [run(1)],
    reports: { 1: { states, ran } },
    verdict: async () => clean,
    io: namedIo,
  });
  assert.equal(good.ok, true, good.lines.join('\n'));
  assert.match(good.lines.join('\n'), /because it names J-bank-13/);
  // A breaks A: its own journey red on its run holds it.
  const broke = await seal({
    title,
    files: product,
    runs: [run(1)],
    reports: { 1: { states: { 'J-bank-13#1': 'failed', 'J-bank-13#2': 'passed' }, ran } },
    verdict: async () => red('J-bank-13#1'),
    io: namedIo,
  });
  assert.equal(broke.ok, false, 'a named journey it breaks holds it');
  // A run of its own journey file alone seals it: the map's always-run list (J-agents-12) is not demanded
  // (project-state#2332: 1 shard and about 10 minutes, not 8 shards and 24 to 26).
  const own = await seal({
    title,
    files: product,
    runs: [run(1)],
    reports: { 1: { states, ran: ['J-bank-13.pw.mjs'] } },
    verdict: async () => clean,
    io: namedIo,
  });
  assert.equal(own.ok, true, own.lines.join('\n'));
  assert.doesNotMatch(own.lines.join('\n'), /J-agents-12/);
  // Named by its branch only (no steps in the title): the same.
  const byBranch = await seal({
    title: 'svc-bank: cards',
    branch: 'j/j-bank-13',
    files: product,
    runs: [run(1)],
    reports: { 1: { states: {}, ran } },
    verdict: async () => clean,
    io: namedIo,
  });
  assert.equal(byBranch.ok, true, byBranch.lines.join('\n'));
  // Naming no journey, or adding a root build file, still needs the full run.
  const unnamed = await seal({
    title: 'svc-bank: cards',
    files: product,
    runs: [run(1)],
    reports: { 1: { states: {}, ran } },
    io: namedIo,
  });
  assert.equal(unnamed.ok, false);
  assert.match(unnamed.lines.join('\n'), /it changes what can reach any journey/);
  const lock = await seal({
    title,
    files: [...product, 'pnpm-lock.yaml'],
    runs: [run(1)],
    reports: { 1: { states, ran } },
    io: namedIo,
  });
  assert.equal(lock.ok, false);
  // The head's journey files can't be read: no narrowing.
  const blind = await seal({
    title,
    files: product,
    runs: [run(1)],
    reports: { 1: { states, ran } },
    io: { ...namedIo, journeyFiles: async () => Promise.reject(new Error('HTTP 502')) },
  });
  assert.equal(blind.ok, false);
});

const STACK = 'tooling/scripts/local-stack-services/bank.mjs';
const STACK_VALUES = 'tooling/profiles/test-owner-values/bank.json';
const IMPORTS = new Map([
  ['J-wallet-05.pw.mjs', "import { X } from '../../../../tooling/scripts/local-stack-services/bank.mjs';"],
  ['J-cex-spot-17.pw.mjs', "readFileSync(path.join(REPO, 'tooling', 'profiles', 'test-owner-values', 'bank.json'))"],
  ['J-pay-05.pw.mjs', '// the reminder rule (tooling/profiles/test-owner-values/bank.json)'],
  ['staff.mjs', '// the roster (tooling/profiles/test-owner-values/\n// bank.json, read only on test)'],
  ['J-ops-01.pw.mjs', "import { staff } from './staff.mjs';"],
  ['J-ops-02.pw.mjs', "import { x } from './helper.mjs';"],
  ['helper.mjs', "import { staff } from './staff.mjs';"],
  ['J-other-01.pw.mjs', "// local-stack-services/trade.mjs, test-owner-values/bank2.json; import './unrelated.mjs'"],
  ['unrelated.mjs', '// nothing'],
]);

test('STACK_FILE: a service’s own stack file and nothing wider', () => {
  for (const p of [STACK, STACK_VALUES, 'tooling/scripts/local-stack-services/mining-pool.mjs']) assert.equal(STACK_FILE.test(p), true, p);
  // The stack itself is no service's own file; it narrows by the canary instead (STACK_CANARY, tested below).
  assert.equal(STACK_FILE.test('tooling/scripts/local-test-stack.mjs'), false);
  for (const p of [
    'tooling/scripts/local-test-market.mjs',
    'tooling/scripts/local-stack-services/zz-planted.test.mjs',
    'tooling/scripts/local-stack-services/sub/bank.mjs',
    'tooling/scripts/local-stack-fixtures/bank.mjs',
    'tooling/profiles/test-owner-values/identity-breached-passwords.sha1',
    'tooling/profiles/test-owner-values.json',
    'xtooling/scripts/local-stack-services/bank.mjs',
  ]) {
    assert.equal(STACK_FILE.test(p), false, p);
    assert.equal(pathKind(p).stack, undefined, p);
  }
  assert.deepEqual({ kind: pathKind(STACK).kind, stack: pathKind(STACK).stack }, { kind: 'full', stack: true });
});

test('stackImporters: by import, split path, comment or a helper, and only that service', () => {
  assert.deepEqual(stackImporters([STACK], IMPORTS), ['J-wallet-05.pw.mjs']);
  assert.deepEqual(stackImporters([STACK_VALUES], IMPORTS), [
    'J-cex-spot-17.pw.mjs',
    'J-ops-01.pw.mjs',
    'J-ops-02.pw.mjs',
    'J-pay-05.pw.mjs',
  ]);
  assert.deepEqual(stackImporters([STACK, STACK_VALUES], new Map()), [], 'no importers is an answer, not an error');
  // The real folder: the importers the code above should find.
  const real = checkoutJourneyTexts(ROOT);
  assert.ok(stackImporters([STACK], real).includes('J-wallet-05.pw.mjs'));
  assert.ok(stackImporters([STACK_VALUES], real).includes('J-cex-spot-17.pw.mjs'));
});

test('journeyTouch, stack (theo-01 part 2): a named change to a stack file runs the journeys importing it; anything else stays full', () => {
  const importers = (ps) => stackImporters(ps, IMPORTS);
  const named = namedInputs({ ids: ['J-bank-13'], journeyFiles: HEAD_FILES, map: ALWAYS_MAP, importers });
  const t = journeyTouch([STACK, ...product], () => true, null, named);
  assert.equal(t.mode, 'files');
  assert.deepEqual(t.files, ['J-bank-13.pw.mjs', 'J-wallet-05.pw.mjs']);
  assert.deepEqual(t.stack, [STACK]);
  assert.deepEqual(t.importers, ['J-wallet-05.pw.mjs']);
  assert.match(t.named, /1 stack file\(s\) run J-bank-13\.pw\.mjs/);
  // A stack file and no product code: the same list.
  assert.deepEqual(journeyTouch([STACK], () => true, null, named).files, t.files);
  for (const [paths, why] of [
    [[STACK, 'tooling/scripts/local-test-stack.mjs'], 'a stack-wide file'],
    [[STACK, 'apps/customer/tests/real-app/journey.mjs'], 'a shared helper'],
    [[STACK, 'pnpm-lock.yaml'], 'a root build file'],
    [[STACK, 'tooling/ci/journey-seal.mjs'], 'the judging code'],
    [[STACK_VALUES, '.github/workflows/real-app-journeys.yml'], 'the journeys workflow'],
  ]) {
    const v = journeyTouch(paths, () => true, null, named);
    assert.equal(v.mode, 'full', why);
    assert.ok(
      v.full.some((x) => x.path === paths[0]),
      `${why}: the stack file is listed too`,
    );
  }
  assert.equal(journeyTouch([STACK], () => true, null, null).mode, 'full', 'no name');
  const blind = namedInputs({ ids: ['J-bank-13'], journeyFiles: HEAD_FILES, map: ALWAYS_MAP });
  assert.equal(journeyTouch([STACK], () => true, null, blind).mode, 'full', 'journey files unreadable');
});

test('planted 4 (theo-01 part 2): a named stack-file pull request seals on the list its run was given, and is held when an importer is missing or red', async () => {
  const title = 'svc-bank: cards (J-bank-13 #1)';
  const files = [...product, STACK];
  const states = { 'J-bank-13#1': 'passed' };
  const ran = ['J-bank-13.pw.mjs', 'J-agents-12.pw.mjs', 'J-wallet-05.pw.mjs'];
  const io = { ...namedIo, journeyTexts: async () => IMPORTS };
  const opts = { title, files, runs: [run(1)], io };
  const good = await seal({ ...opts, reports: { 1: { states, ran } }, verdict: async () => clean });
  assert.equal(good.ok, true, good.lines.join('\n'));
  assert.match(good.lines.join('\n'), /journey file\(s\) using them/);
  const short = await seal({ ...opts, reports: { 1: { states, ran: ran.slice(0, 2) } }, verdict: async () => clean });
  assert.equal(short.ok, false, 'a run without the importer is held');
  assert.match(short.lines.join('\n'), /ran J-wallet-05\.pw\.mjs/);
  const broke = await seal({ ...opts, reports: { 1: { states, ran } }, verdict: async () => red('J-wallet-05#1') });
  assert.equal(broke.ok, false, 'the stack change breaking an importer holds it');
  // Fail closed: the full run stays what is needed, and this run is not one.
  const short4 = async () => ({ ...clean, missing: ['J-bank-14.pw.mjs'] });
  const blind = await seal({
    ...opts,
    reports: { 1: { states, ran } },
    verdict: short4,
    io: { ...io, journeyTexts: async () => Promise.reject(new Error('HTTP 502')) },
  });
  assert.equal(blind.ok, false);
  assert.match(blind.lines.join('\n'), /local-stack-services\/bank\.mjs/);
  const noIo = await seal({ ...opts, reports: { 1: { states, ran } }, verdict: short4, io: namedIo });
  assert.equal(noIo.ok, false, 'an io with no way to read texts narrows nothing');
  const stackWide = await seal({
    ...opts,
    files: [...files, 'tooling/scripts/local-test-stack.mjs'],
    reports: { 1: { states, ran } },
    verdict: short4,
  });
  assert.equal(stackWide.ok, false, 'a stack-wide file still needs the full run');
  // Naming no journey: as before.
  const unnamed = await seal({ ...opts, title: 'svc-bank: cards', reports: { 1: { states: {}, ran } }, verdict: short4 });
  assert.equal(unnamed.ok, false);
  // A revert of a stack file still needs the full run as shared setup.
  const asRevert = await seal({
    ...opts,
    title: 'Revert "svc-bank: cards (J-bank-13 #1)"',
    body: 'Reverts INTAFACED/intafaced#1',
    files: [STACK],
    reports: { 1: { states: {}, ran } },
    verdict: short4,
  });
  assert.equal(asRevert.ok, false, 'a revert is judged as it was before this part');
});

// ---- 14 Nov 2026 (project-state rows d64, d68): the four paths that sent named journey pull requests to all 32 shards ----

const VENUE_READS = 'apps/customer/tests/real-app/venue-reads.mjs';
const LOOK_FIXTURES = 'apps/customer/tests/real-app/look-fixtures.mjs';
const SDK_SPEC = 'sdks/python/openapi/payments.openapi.json';
const HELPERS = new Map([
  ...IMPORTS,
  ['venue-reads.mjs', 'export const readVenue = () => 1;'],
  ['J-cex-spot-01.pw.mjs', "import { readVenue } from './venue-reads.mjs';"],
  ['J-cex-spot-03.pw.mjs', "import { x } from './spot-chain.mjs';"],
  ['spot-chain.mjs', "export { readVenue as x } from './venue-reads.mjs';"],
  ['look-fixtures.mjs', '// look answers'],
  ['J-home-ia-01.pw.mjs', "import { answers } from './look-fixtures.mjs';"],
  ...CANARY.map((f) => [f, `// ${f}`]).filter(([f]) => !['J-cex-spot-01.pw.mjs', 'J-home-ia-01.pw.mjs'].includes(f)),
]);
const namedWith = (texts, ids = ['J-bank-13']) =>
  namedInputs({ ids, journeyFiles: HEAD_FILES, importers: (ps) => stackImporters(ps, texts) });

test('14 Nov, #8321: an SDK file (sdks/python) runs no journeys', () => {
  assert.equal(pathKind(SDK_SPEC).kind, 'none');
  assert.equal(pathKind('sdks/python/intafaced_pay/operations.py').kind, 'none');
  assert.deepEqual(journeyTouch([...product, SDK_SPEC], () => true, null, namedWith(HELPERS)).files, ['J-bank-13.pw.mjs']);
});

test('14 Nov, #8322: a named change to venue-reads.mjs runs the journeys importing it, directly or through a helper', () => {
  const v = journeyTouch([VENUE_READS], () => true, null, namedWith(HELPERS));
  assert.equal(v.mode, 'files');
  assert.deepEqual(v.files, ['J-bank-13.pw.mjs', 'J-cex-spot-01.pw.mjs', 'J-cex-spot-03.pw.mjs']);
  assert.deepEqual(v.stack, [VENUE_READS]);
  // The real folder: the two spot journeys that import it.
  const real = checkoutJourneyTexts(ROOT);
  assert.deepEqual(stackImporters([VENUE_READS], real), ['J-cex-spot-01.pw.mjs', 'J-cex-spot-03.pw.mjs']);
});

test('14 Nov, #8310: a named change to look-fixtures.mjs with product code runs the named journey and its importers', () => {
  const l = journeyTouch([...product, LOOK_FIXTURES], () => true, null, namedWith(HELPERS));
  assert.deepEqual([l.mode, l.files], ['files', ['J-bank-13.pw.mjs', 'J-home-ia-01.pw.mjs']]);
});

test('14 Nov, #8320: a named change to local-test-stack.mjs runs the named journeys and the canary, never the full suite', () => {
  const s = journeyTouch([...product, STACK_CANARY, STACK], () => true, null, namedWith(HELPERS));
  assert.equal(s.mode, 'files');
  assert.deepEqual(s.files, [...new Set(['J-bank-13.pw.mjs', 'J-wallet-05.pw.mjs', ...CANARY])].sort());
  assert.deepEqual(s.stack, [STACK_CANARY, STACK].sort());
  const real = checkoutJourneyTexts(ROOT);
  for (const f of CANARY) assert.ok(real.has(f), `${f}: a canary journey file at this checkout`);
  assert.deepEqual(stackImporters([STACK_CANARY], real), [...CANARY].sort());
  // A canary journey split over files (J-home-ia-01 #1 to #3 live in J-home-ia-01-venue.pw.mjs since #8310) runs whole:
  // the verdict reads a missing step as red when its baseline file ran (#8320, run 43600611635).
  const ids = new Set(CANARY.map((f) => f.replace(/\.pw\.mjs$/, '')));
  const split = [...real.keys()].filter((f) => [...ids].some((id) => f.startsWith(`${id}-`) && f.endsWith('.pw.mjs')));
  assert.ok(split.includes('J-home-ia-01-venue.pw.mjs'), 'the venue file is a sibling at this checkout');
  for (const f of split) assert.ok(stackImporters([STACK_CANARY], real).includes(f), `${f}: a canary journey's other file runs with it`);
});

test('planted: what still runs the full suite after the four paths narrow', () => {
  const named = namedWith(HELPERS);
  const full = (paths, n = named, why) => assert.equal(journeyTouch(paths, () => true, null, n).mode, 'full', why ?? paths.join(' '));
  // Unnamed, or the journey texts unreadable: as before.
  for (const p of [VENUE_READS, LOOK_FIXTURES, STACK_CANARY]) {
    full([p], null, `${p}: no name`);
    full([p], namedInputs({ ids: ['J-bank-13'], journeyFiles: HEAD_FILES }), `${p}: texts unreadable`);
  }
  // A helper outside code reaches, or that reaches the config, a look sweep or one of those.
  full(['apps/customer/tests/real-app/journey.mjs']);
  full(['apps/customer/tests/real-app/real-app.playwright.config.mjs']);
  full(
    [VENUE_READS],
    namedWith(new Map([...HELPERS, ['look-sweep-390.pw.mjs', "import './venue-reads.mjs';"]])),
    'a look sweep imports it',
  );
  full([VENUE_READS], namedWith(new Map([...HELPERS, ['journey.mjs', "import './venue-reads.mjs';"]])), 'a stack helper imports it');
  full(
    [VENUE_READS],
    namedWith(new Map([...HELPERS, ['fixture.config.mjs', "reporter: ['./venue-reads.mjs']"]])),
    'an entry point names it',
  );
  // The canary missing at the head.
  full([STACK_CANARY], namedWith(new Map([...HELPERS].filter(([f]) => f !== CANARY[0]))), 'a canary file removed');
  // The stack's siblings and another full path stay full.
  full(['tooling/scripts/local-test-market.mjs']);
  full(['tooling/scripts/local-test-seed.mjs']);
  full([STACK_CANARY, 'tooling/scripts/local-test-market.mjs']);
  full([VENUE_READS, 'pnpm-lock.yaml']);
  full([SDK_SPEC, '.github/workflows/real-app-journeys.yml']);
  // A helper in a subfolder or a non-module beside the journeys is no HELPER.
  for (const p of ['apps/customer/tests/real-app/sub/venue-reads.mjs', 'apps/customer/tests/real-app/fixtures.json']) {
    assert.equal(HELPER.test(p) && !p.includes('/sub/'), false, p);
    full([p]);
  }
});

test('STACK_HELPERS holds every helper that code outside the journey files names, so the rest reach only journeys', () => {
  const dir = 'apps/customer/tests/real-app';
  const helpers = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.mjs') && !f.endsWith('.pw.mjs'));
  assert.ok(helpers.includes('venue-reads.mjs') && helpers.includes('journey.mjs'), 'sanity');
  const outside = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    // What runs: not docs, Markdown, unit tests, the reach map's data, or a CI check outside the journeys run.
    .filter((f) => !f.startsWith(`${dir}/`) && !f.startsWith('docs/') && !/\.md$/.test(f) && !/\.(test|spec)\./.test(f))
    // This classifier names helpers only as its own data.
    .filter((f) => !['tooling/ci/journey-reach-map.json', 'tooling/ci/journey-touch.mjs'].includes(f))
    .filter((f) => !f.startsWith('tooling/ci/') || JOURNEY_CI.includes(f))
    .filter((f) => !/\.(png|jpe?g|webp|gif|ico|woff2?|ttf|pdf|zip|gz|wasm|sha1)$/i.test(f) && statSync(join(ROOT, f)).size < 4e6);
  const texts = outside.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]);
  const named = (h) => texts.filter(([, t]) => new RegExp(`(^|[^A-Za-z0-9_-])${h.replace(/[.]/g, '\\.')}`).test(t)).map(([f]) => f);
  for (const h of helpers) {
    const by = named(h);
    if (by.length) assert.ok(STACK_HELPERS.includes(h), `${h} is named by ${by.slice(0, 3).join(', ')}: add it to STACK_HELPERS`);
  }
  // Planted: the same matcher finds a stack script naming a helper by path.
  assert.deepEqual(
    [['tooling/scripts/x.mjs', "import '../../apps/customer/tests/real-app/venue-reads.mjs';"]]
      .filter(([, t]) => /(^|[^A-Za-z0-9_-])venue-reads\.mjs/.test(t))
      .map(([f]) => f),
    ['tooling/scripts/x.mjs'],
  );
  for (const h of ['venue-reads.mjs', 'look-fixtures.mjs']) assert.equal(STACK_HELPERS.includes(h), false, h);
});

test('planted 6: a named helper or stack change seals on its list, and is held when an importer or the canary is missing or red', async () => {
  const title = 'customer: spot (J-bank-13 #1)';
  const states = { 'J-bank-13#1': 'passed' };
  const io = { ...namedIo, journeyTexts: async () => HELPERS };
  const helper = { title, files: [VENUE_READS], runs: [run(1)], io };
  const ran = ['J-bank-13.pw.mjs', 'J-cex-spot-01.pw.mjs', 'J-cex-spot-03.pw.mjs'];
  // Not a full run (another journey missing): main's code held these for the full suite.
  const partial = async () => ({ ...clean, missing: ['J-bank-14.pw.mjs'] });
  const good = await seal({ ...helper, reports: { 1: { states, ran } }, verdict: partial });
  assert.equal(good.ok, true, good.lines.join('\n'));
  const short = await seal({ ...helper, reports: { 1: { states, ran: ran.slice(0, 2) } }, verdict: async () => clean });
  assert.equal(short.ok, false, 'a run without an importer is held');
  const broke = await seal({ ...helper, reports: { 1: { states, ran } }, verdict: async () => red('J-cex-spot-03#1') });
  assert.equal(broke.ok, false, 'breaking an importer holds it');
  const stack = { title, files: [...product, STACK_CANARY], runs: [run(1)], io };
  const canaryRan = ['J-bank-13.pw.mjs', ...CANARY];
  const sGood = await seal({ ...stack, reports: { 1: { states, ran: canaryRan } }, verdict: partial });
  assert.equal(sGood.ok, true, sGood.lines.join('\n'));
  const sShort = await seal({ ...stack, reports: { 1: { states, ran: canaryRan.slice(0, 3) } }, verdict: async () => clean });
  assert.equal(sShort.ok, false, 'a run without the whole canary is held');
  const sBroke = await seal({ ...stack, reports: { 1: { states, ran: canaryRan } }, verdict: async () => red('J-p2p-01#1') });
  assert.equal(sBroke.ok, false, 'a red canary holds it');
  const short4 = async () => ({ ...clean, missing: ['J-bank-14.pw.mjs'] });
  const unnamed = await seal({ ...stack, title: 'stack: x', reports: { 1: { states: {}, ran: canaryRan } }, verdict: short4 });
  assert.equal(unnamed.ok, false, 'unnamed: the full run is still needed');
});

// A root deploy file (compose, .env.example): `pnpm local:stack` never reads one, so a named journey build
// that adds its service's env there runs the journeys that name it, like a stack file; unnamed, it stays full.
const COMPOSE = 'docker-compose.apps.yml';
const READS_COMPOSE = new Map([
  ...IMPORTS,
  ['J-home-ia-11.pw.mjs', "const COMPOSE = ['docker-compose.yml', 'docker-compose.apps.yml']; read('.env.example');"],
]);

test('ROOT_DEPLOY_FILE: the root compose files and .env.example, and nothing wider', () => {
  for (const p of ['docker-compose.yml', COMPOSE, 'docker-compose.outreach.yml', '.env.example']) {
    assert.equal(ROOT_DEPLOY_FILE.test(p), true, p);
    assert.deepEqual({ kind: pathKind(p).kind, stack: pathKind(p).stack }, { kind: 'full', stack: true }, p);
  }
  for (const p of [
    'pnpm-lock.yaml',
    'package.json',
    'turbo.json',
    '.env',
    '.env.tester.local',
    'Dockerfile', // J-home-ia-11 builds the app image from it without naming it, so it stays full
    'apps/edge/Dockerfile',
    'infra/docker-compose.yml',
    'docker-compose.yml.bak',
    'Dockerfile.dev',
  ]) {
    assert.equal(ROOT_DEPLOY_FILE.test(p), false, p);
    assert.equal(pathKind(p).stack, undefined, p);
  }
});

test('journeyTouch, root deploy file: a named build runs the journeys naming it; unnamed, a root build file beside it, or unread journeys stay full', () => {
  const importers = (ps) => stackImporters(ps, READS_COMPOSE);
  const named = namedInputs({ ids: ['J-bank-13'], journeyFiles: HEAD_FILES, map: ALWAYS_MAP, importers });
  const t = journeyTouch([...product, COMPOSE, '.env.example', STACK], () => true, null, named);
  assert.equal(t.mode, 'files');
  assert.deepEqual(t.files, ['J-bank-13.pw.mjs', 'J-home-ia-11.pw.mjs', 'J-wallet-05.pw.mjs']);
  assert.deepEqual(t.stack, ['.env.example', COMPOSE, STACK]);
  // Planted: the journey that reads the compose file is in the list (it would be missed if the file ran none).
  assert.ok(t.files.includes('J-home-ia-11.pw.mjs'));
  assert.equal(journeyTouch([...product, COMPOSE], () => true, null, null).mode, 'full', 'no name');
  assert.equal(journeyTouch([...product, COMPOSE, 'pnpm-lock.yaml'], () => true, null, named).mode, 'full', 'a root build file');
  assert.equal(
    journeyTouch([...product, COMPOSE, 'tooling/scripts/local-test-stack.mjs'], () => true, null, named).mode,
    'full',
    'stack-wide setup',
  );
  const blind = namedInputs({ ids: ['J-bank-13'], journeyFiles: HEAD_FILES, map: ALWAYS_MAP });
  assert.equal(journeyTouch([...product, COMPOSE], () => true, null, blind).mode, 'full', 'journey texts unreadable');
});

test('planted 5: a named build changing a root deploy file seals on its list, and is held when the journey reading it is missing or red', async () => {
  const title = 'svc-bank: cards (J-bank-13 #1)';
  const states = { 'J-bank-13#1': 'passed' };
  const ran = ['J-bank-13.pw.mjs', 'J-agents-12.pw.mjs', 'J-home-ia-11.pw.mjs'];
  const io = { ...namedIo, journeyTexts: async () => READS_COMPOSE };
  const opts = { title, files: [...product, COMPOSE], runs: [run(1)], io };
  const good = await seal({ ...opts, reports: { 1: { states, ran } }, verdict: async () => clean });
  assert.equal(good.ok, true, good.lines.join('\n'));
  const short = await seal({ ...opts, reports: { 1: { states, ran: ran.slice(0, 2) } }, verdict: async () => clean });
  assert.equal(short.ok, false, 'a run without the journey reading the compose file is held');
  assert.match(short.lines.join('\n'), /ran J-home-ia-11\.pw\.mjs/);
  const broke = await seal({ ...opts, reports: { 1: { states, ran } }, verdict: async () => red('J-home-ia-11#1') });
  assert.equal(broke.ok, false, 'breaking the journey that reads it holds it');
  const short4 = async () => ({ ...clean, missing: ['J-bank-14.pw.mjs'] });
  const unnamed = await seal({ ...opts, title: 'svc-bank: cards', reports: { 1: { states: {}, ran } }, verdict: short4 });
  assert.equal(unnamed.ok, false, 'unnamed: the full run is still needed');
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

test('the seal: a factory-only pull request (#8284’s file set) merges with no journeys run; app code or a journey file beside it is held', async () => {
  const factory = [
    '.githooks/pre-commit',
    '.githooks/pre-push',
    '.github/workflows/ci.yml',
    'AGENTS.md',
    'tooling/scripts/ci-checks.mjs',
    'tooling/scripts/ci-checks.test.mjs',
    'tooling/scripts/pre-push-hook.test.mjs',
  ];
  assert.equal((await seal({ files: factory, runs: [], reports: {} })).ok, true, 'factory files alone need no journeys run');
  const app = [...factory, 'services/svc-bank/src/cards.ts'];
  assert.equal((await seal({ files: app, runs: [], reports: {} })).ok, false, 'planted: app code beside them needs its run');
  assert.equal((await seal({ files: app, runs: [run(1)], reports: { 1: partial } })).ok, false, 'and a partial run is not it');
  assert.equal((await seal({ files: app, runs: [run(1)], reports: { 1: fullRun } })).ok, true, 'a clean full run seals it');
  const journey = [...factory, 'apps/customer/tests/real-app/J-bank-13.pw.mjs'];
  const title = 'test(journeys): J-bank-13 #1';
  const own = { states: { 'J-bank-13#1': 'passed', 'J-bank-13#2': 'passed' }, ran: ['J-bank-13.pw.mjs'] };
  assert.equal(
    (await seal({ title, files: journey, runs: [], reports: {} })).ok,
    false,
    'planted: a journey file beside them needs its run',
  );
  const sealed = await seal({ title, files: journey, runs: [run(1)], reports: { 1: own } });
  assert.equal(sealed.ok, true, sealed.lines.join('\n'));
  const fixture = [...factory, 'apps/customer/tests/real-app/world-restore.mjs'];
  assert.equal((await seal({ files: fixture, runs: [run(1)], reports: { 1: partial } })).ok, false, 'a journey helper needs the full run');
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
  const at = t.indexOf('\n        id: pick\n');
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

// One journeys run per head (project-state#2065 row d32 part (b)).
const byHand = (id, title, over = {}) => run(id, { event: 'workflow_dispatch', display_title: title, ...over });
const AT_HEAD = new Set(['J-a-01.pw.mjs', 'J-b-02.pw.mjs', 'J-c-03.pw.mjs']);
const reuse = (runs, ranShards = new Set(runs.map((r) => r.id))) =>
  reusableRuns(runs, { sha: HEAD, repo: REPO, journeyFiles: AT_HEAD, ranShards });

test("a pull request's run leaves out the journey files a targeted run by hand on its exact head already runs, and the rest still runs", () => {
  const r = reuse([byHand(1, 'Real-app journeys by hand, J-a-01.pw.mjs,J-b-02.pw.mjs', { status: 'in_progress', conclusion: null })]);
  assert.deepEqual(afterReuse('J-a-01.pw.mjs J-c-03.pw.mjs', r), {
    target: 'J-c-03.pw.mjs',
    mode: 'run',
    why: '1 of its 2 journey file(s) already run by hand on this head (run 1), so this run leaves them out',
  });
  assert.equal(afterReuse('J-a-01.pw.mjs J-b-02.pw.mjs', r).mode, 'none');
  // A finished red run by hand counts too: its red stands for this head, and the seal reads it.
  assert.equal(
    afterReuse('J-a-01.pw.mjs', reuse([byHand(2, 'Real-app journeys by hand, J-a-01.pw.mjs', { conclusion: 'failure' })])).mode,
    'none',
  );
});

test('planted: nothing is left out for a full run, or a run by hand that ran no shard, is cancelled, or is not on this exact head', () => {
  const same = (runs, target = 'J-a-01.pw.mjs', ranShards) =>
    assert.deepEqual(afterReuse(target, reuse(runs, ranShards)), { target, mode: 'run', why: '' });
  // The full suite is never narrowed, and a full run by hand stands in for nothing: it may have been deferred and run
  // nothing (main-first.mjs), and it fails fast where a pull request's run keeps the ordinary limits.
  same([byHand(1, 'Real-app journeys by hand, J-a-01.pw.mjs')], '');
  same([byHand(1, 'Real-app journeys by hand, full')]);
  same([byHand(1, 'Real-app journeys by hand, full')], '');
  // A finished run whose shards never ran (its touch job failed, or it stopped before them).
  same([byHand(1, 'Real-app journeys by hand, J-a-01.pw.mjs')], 'J-a-01.pw.mjs', new Set());
  same([byHand(1, 'Real-app journeys by hand, J-a-01.pw.mjs', { head_sha: OLD })]);
  same([byHand(1, 'Real-app journeys by hand, J-a-01.pw.mjs', { conclusion: 'cancelled' })]);
  same([byHand(1, 'Real-app journeys by hand, J-a-01.pw.mjs', { conclusion: 'skipped' })]);
  same([byHand(1, 'Real-app journeys by hand, J-a-01.pw.mjs', { repository: { full_name: 'x/y' } })]);
  same([byHand(1, 'Real-app journeys by hand, J-a-01.pw.mjs', { head_repository: { full_name: 'x/y' } })]);
  same([byHand(1, 'Real-app journeys by hand, J-a-01.pw.mjs', { path: '.github/workflows/other.yml' })]);
  same([run(1, { event: 'pull_request', display_title: 'Real-app journeys by hand, J-a-01.pw.mjs' })]);
  same([byHand(1, 'Real-app journeys')]);
  // A name that is not a journey file at the head makes the whole run count for nothing.
  same([byHand(1, 'Real-app journeys by hand, J-a-01.pw.mjs J-zz-99.pw.mjs')]);
  same([byHand(1, 'Real-app journeys by hand, J-a-01.pw.mjs;rm')]);
  assert.equal(
    reusableRuns([byHand(1, 'Real-app journeys by hand, J-a-01.pw.mjs')], {
      sha: HEAD,
      repo: REPO,
      journeyFiles: null,
      ranShards: new Set([1]),
    }).size,
    0,
  );
});

test("real-app-journeys.yml's one-run-per-head step: off a pull request, or when the base copy can't reuse, the pick stands", () => {
  const t = readFileSync(join(ROOT, '.github/workflows/real-app-journeys.yml'), 'utf8');
  const at = t.indexOf('\n        id: touch\n');
  assert.ok(at > 0 && t.indexOf('\n        id: pick\n') < at, 'the step comes after the pick');
  const from = t.indexOf('\n        run: |\n', at) + '\n        run: |\n'.length;
  const lines = [];
  for (const l of t.slice(from).split('\n')) {
    if (l !== '' && !l.startsWith('          ')) break;
    lines.push(l.slice(10));
  }
  const dir = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
  try {
    const step = (env) => {
      const out = join(dir, `out-${Math.random().toString(36).slice(2)}`);
      execFileSync('bash', ['-c', lines.join('\n')], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, GITHUB_WORKSPACE: dir, ...env },
      });
      return Object.fromEntries(
        readFileSync(out, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      );
    };
    const pick = { MODE: 'run', TARGET: 'J-a-01.pw.mjs' };
    assert.deepEqual(step({ ...pick, EVENT: 'push' }), { mode: 'run', target: 'J-a-01.pw.mjs' });
    // No base copy of journey-touch.mjs here (as on the run of the pull request that adds --reuse): the pick stands.
    assert.deepEqual(step({ ...pick, EVENT: 'pull_request' }), { mode: 'run', target: 'J-a-01.pw.mjs' });
    // A base copy that says a run by hand covers it: nothing runs here.
    const base = join(dir, '.base/tooling/ci');
    mkdirSync(base, { recursive: true });
    const says = (json) => writeFileSync(join(base, 'journey-touch.mjs'), `console.log(${JSON.stringify(JSON.stringify(json))})`);
    says({ target: '', mode: 'none', why: 'covered' });
    assert.deepEqual(step({ ...pick, EVENT: 'pull_request' }), { mode: 'none', target: '' });
    // Planted: a target that is not journey file names never reaches the outputs; the pick stands.
    says({ target: 'J-a-01.pw.mjs\nmode=none', mode: 'run', why: '' });
    assert.deepEqual(step({ ...pick, EVENT: 'pull_request' }), { mode: 'run', target: 'J-a-01.pw.mjs' });
    says({ target: '', mode: 'full', why: '' });
    assert.deepEqual(step({ ...pick, EVENT: 'pull_request' }), { mode: 'run', target: 'J-a-01.pw.mjs' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(t, /\nrun-name: \$\{\{ github\.event_name == 'workflow_dispatch' && format\('Real-app journeys by hand, \{0\}'/);
});

// ---- 14 Nov 2026 (project-state row d64): a selection runs every file of each journey it selects ----

test('14 Nov, #8320: a named change to the stack runs both J-home-ia-01 files, never the canary file alone', () => {
  // #8320 at 91cdf2846: a named (J-merchant-04) pull request that changed the stack ran J-home-ia-01.pw.mjs for the canary and
  // not J-home-ia-01-venue.pw.mjs, where #1 #2 #3 live; its verdict read those money steps as missing.
  const real = checkoutJourneyTexts(ROOT);
  const files = new Set([...real.keys()].filter((f) => /^J-.*\.pw\.mjs$/.test(f)));
  assert.ok(files.has('J-home-ia-01-venue.pw.mjs'), 'J-home-ia-01 keeps steps in a second file at this checkout');
  const named = namedInputs({ ids: ['J-wallet-05'], journeyFiles: files, importers: (ps) => stackImporters(ps, real) });
  const t = journeyTouch(['services/svc-pay/src/router.ts', STACK_CANARY], () => true, null, named);
  assert.equal(t.mode, 'files');
  for (const f of ['J-home-ia-01.pw.mjs', 'J-home-ia-01-venue.pw.mjs']) assert.ok(t.files.includes(f), `${f} runs`);
});

test('a journey selected by name, the canary, an importer, the map or its own changed file runs all its files at the head', () => {
  const head = new Set(['J-bank-13.pw.mjs', 'J-a-01.pw.mjs', 'J-a-01-venue.pw.mjs', 'J-a-02.pw.mjs', 'J-a-010.pw.mjs']);
  const texts = new Map([...head].map((f) => [f, f === 'J-a-01.pw.mjs' ? "import './x-helper.mjs';" : '']).concat([['x-helper.mjs', '']]));
  const named = namedInputs({ ids: ['J-bank-13'], journeyFiles: head, importers: (ps) => stackImporters(ps, texts) });
  // An importer: only J-a-01.pw.mjs imports the helper; its sibling runs with it, and J-a-02 and J-a-010 do not.
  const h = journeyTouch(['apps/customer/tests/real-app/x-helper.mjs'], () => true, null, named);
  assert.deepEqual(h.files, ['J-a-01-venue.pw.mjs', 'J-a-01.pw.mjs', 'J-bank-13.pw.mjs']);
  // A changed journey file: its sibling runs too.
  assert.deepEqual(journeyTouch(['apps/customer/tests/real-app/J-a-01.pw.mjs'], () => true, null, named).files, [
    'J-a-01-venue.pw.mjs',
    'J-a-01.pw.mjs',
  ]);
  // The head's journey files unknown: the selection is left as it was (no name, no map).
  assert.deepEqual(journeyTouch(['apps/customer/tests/real-app/J-a-01.pw.mjs']).files, ['J-a-01.pw.mjs']);
});
