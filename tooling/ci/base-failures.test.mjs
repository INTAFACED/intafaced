// The Tests job's rule for failures main already has (base-failures.mjs): what it excuses, what it never excuses, and
// the Tests job's wiring that keeps main's own runs red on every failing test. Run by tooling/scripts/tooling-tests.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECORD_VERSION,
  artifactName,
  compare,
  explainPackage,
  failureId,
  latestSummary,
  mainState,
  manifestsAtRev,
  manifestsOf,
  moneyDirsOf,
  needsMain,
  protectedWhy,
  readReports,
  recordOf,
  verdictText,
  vitestRuns,
} from './base-failures.mjs';
import { REPORT_VERSION, errorLine, reportOf } from './test-results-reporter.mjs';
import { plan } from '../vitest/run-all.mjs';
import { manifestsAt, moneyCodeDirs } from './journey-verdict.mjs';

const BASE = 'b'.repeat(40);
const moneyDirs = new Set(['services/svc-bank', 'packages/ledger-client']);

/** One vitest run's report with the given failed tests: [[file, name, reason], ...]. */
const report = (pkg, failed, extra = {}) => ({
  v: REPORT_VERSION,
  package: pkg,
  dir: `packages/${pkg.split('/')[1]}`,
  reason: failed.length ? 'failed' : 'passed',
  modules: 3,
  tests: 9,
  unhandled: [],
  failed: failed.map(([file, name, reason]) => ({ file, state: 'failed', errors: [], suites: [], tests: [{ name, errors: [reason] }] })),
  ...extra,
});

/** A pull request job's record holding one package's failures. */
const prRecord = (pkg, dir, failed, { script = 'vitest run', reports } = {}) => ({
  v: RECORD_VERSION,
  sha: 'm'.repeat(40),
  event: 'pull_request',
  shard: 'changed',
  attempt: 1,
  outcome: 'failure',
  problems: [],
  packages: [explainPackage({ name: pkg, dir, exit: 1, script, reports: reports ?? [{ ...report(pkg, failed), dir }] })],
});

/** Main's run on BASE, finished, with one Tests job whose record names these failures. */
function mainWith(failures, { runOver = {}, jobOver = {}, recordOver = {} } = {}) {
  const run = { id: 77, head_sha: BASE, event: 'push', head_branch: 'main', status: 'completed', conclusion: 'failure', ...runOver };
  const job = {
    name: 'Tests (3/16)',
    status: 'completed',
    conclusion: failures.length ? 'failure' : 'success',
    run_attempt: 2,
    ...jobOver,
  };
  const packages = failures.map(([pkg, dir, file, name, reason]) => ({
    name: pkg,
    dir,
    exit: 1,
    explained: true,
    failures: [{ package: pkg, dir, file, kind: 'test', name, reason }],
  }));
  const rec = {
    v: RECORD_VERSION,
    sha: BASE,
    event: 'push',
    shard: '3/16',
    attempt: 2,
    outcome: failures.length ? 'failure' : 'success',
    problems: [],
    packages,
    ...recordOver,
  };
  return { base: BASE, run, jobs: [job], records: new Map([[artifactName('3/16', 2), rec]]) };
}

const REGISTRY = [
  '@intafaced/contracts',
  'packages/contracts',
  'packages/contracts/src/procedure-registry.test.ts',
  'the written records of calls > the registry is every `defineProcedure` in src/',
  "AssertionError: expected [Function] to not throw an error but 'Error: Command failed: node scripts/p…' was thrown",
];
const [pkg, dir, file, name, reason] = REGISTRY;

test('(a) a failure main recorded the same way on the base, in a test of nothing protected, is excused', () => {
  const v = compare({ pr: prRecord(pkg, dir, [[file, name, reason]]), main: mainState(mainWith([REGISTRY])), moneyDirs });
  assert.equal(v.pass, true, JSON.stringify(v.held));
  assert.deepEqual(
    v.excused.map((e) => failureId(e.f)),
    [`${pkg} › ${file} › ${name}`],
  );
  const text = verdictText({ verdict: v, base: BASE, runUrl: 'https://github.com/o/r/actions/runs/77' }).join('\n');
  assert.match(text, /Excused: 1 failure/);
  assert.match(text, /actions\/runs\/77/);
  assert.match(text, /procedure-registry\.test\.ts/);
});

test('(b) a failure only the pull request has fails, beside one main has', () => {
  const other = [file, 'the written records of calls > a new test this pull request broke', 'AssertionError: expected 1 to be 2'];
  const v = compare({ pr: prRecord(pkg, dir, [[file, name, reason], other]), main: mainState(mainWith([REGISTRY])), moneyDirs });
  assert.equal(v.pass, false);
  assert.equal(v.excused.length, 1);
  assert.deepEqual(
    v.held.map((h) => h.why),
    ['main did not fail it: only this pull request does'],
  );
  // and alone, with main green on the base:
  const alone = compare({ pr: prRecord(pkg, dir, [other]), main: mainState(mainWith([])), moneyDirs });
  assert.equal(alone.pass, false);
});

test('(c) a shared failure in a test of money, custody, sign-in or permissions, or a journey test, still fails', () => {
  const cases = [
    // money code, by the repo's own list (moneyCodeDirs)
    ['@intafaced/svc-bank', 'services/svc-bank', 'services/svc-bank/src/x.test.ts', 'statements > lists them'],
    // sign-in and permissions packages
    ['@intafaced/auth', 'packages/auth', 'packages/auth/src/x.test.ts', 'parses a header'],
    ['@intafaced/admin', 'apps/admin', 'apps/admin/src/app/api/ops-desks-wire.test.ts', 'bank desk > reads'],
    // the words, outside those packages: a real one from 22 Nov (roles and grants are permissions)
    [
      '@intafaced/customer',
      'apps/customer',
      'apps/customer/src/features/more/agents-team-grant.dom.test.tsx',
      'AgentsTeam roles > keeps a saved tick shown and locked',
    ],
    [
      '@intafaced/customer',
      'apps/customer',
      'apps/customer/src/features/pay/portal/settings/onboarding/category.test.tsx',
      'business category > saves',
    ],
    ['@intafaced/customer', 'apps/customer', 'apps/customer/src/app/x.test.tsx', 'the sign-in form > keeps the email'],
    ['@intafaced/customer', 'apps/customer', 'apps/customer/src/app/x.test.tsx', 'a custody hold > shows'],
    // a journey test
    ['@intafaced/customer', 'apps/customer', 'apps/customer/tests/real-app/j-x.pw.mjs', 'step 1'],
    ['@intafaced/customer', 'apps/customer', 'apps/customer/src/app/x.test.tsx', 'J-agents-11 #6 > holds'],
  ];
  for (const [p, d, f, n] of cases) {
    const why = 'AssertionError: expected null not to be null';
    const v = compare({ pr: prRecord(p, d, [[f, n, why]]), main: mainState(mainWith([[p, d, f, n, why]])), moneyDirs });
    assert.equal(v.pass, false, `${f} › ${n} was excused`);
    assert.match(v.held[0].why, /^never excused: a (test in|money|sign-in|permissions|journey)/, `${f} › ${n}: ${v.held[0].why}`);
  }
  // and the same shape outside them is excused, so the words above are what held each:
  const plain = [
    '@intafaced/customer',
    'apps/customer',
    'apps/customer/src/app/volt-count.test.ts',
    'customer rooms in Volt > starts no room off the kit',
  ];
  const why = 'AssertionError: a room not in Volt';
  assert.equal(
    compare({ pr: prRecord(plain[0], plain[1], [[plain[2], plain[3], why]]), main: mainState(mainWith([[...plain, why]])), moneyDirs })
      .pass,
    true,
  );
});

test('(d) an unknown main state excuses nothing', () => {
  const pr = prRecord(pkg, dir, [[file, name, reason]]);
  const unknowns = {
    'no run on the base': { ...mainWith([REGISTRY]), run: null },
    'a run still going': mainWith([REGISTRY], { runOver: { status: 'in_progress', conclusion: null } }),
    'a cancelled run': mainWith([REGISTRY], { runOver: { conclusion: 'cancelled' } }),
    'a run for another commit': mainWith([REGISTRY], { runOver: { head_sha: 'c'.repeat(40) } }),
    'a run not on main': mainWith([REGISTRY], { runOver: { head_branch: 'feature' } }),
    'a pull request run': mainWith([REGISTRY], { runOver: { event: 'pull_request' } }),
    'a missing artifact': { ...mainWith([REGISTRY]), records: new Map() },
    "an earlier attempt's artifact": mainWith([REGISTRY], { jobOver: { run_attempt: 3 } }),
    'a record of another commit': mainWith([REGISTRY], { recordOver: { sha: 'c'.repeat(40) } }),
    'a record of another version': mainWith([REGISTRY], { recordOver: { v: RECORD_VERSION + 1 } }),
    'a cancelled Tests job': mainWith([REGISTRY], { jobOver: { conclusion: 'cancelled' } }),
    'a red job whose record names nothing': mainWith([REGISTRY], {
      recordOver: { packages: [], problems: ['turbo wrote no run summary'] },
    }),
    'no Tests job at all': { ...mainWith([REGISTRY]), jobs: [] },
  };
  for (const [label, m] of Object.entries(unknowns)) {
    const state = mainState(m);
    assert.equal(state.known, false, label);
    const v = compare({ pr, main: state, moneyDirs });
    assert.equal(v.pass, false, label);
    assert.equal(v.excused.length, 0, label);
    assert.match(v.held[0].why, /^main's result is unknown/, label);
  }
  // only a run that is still going is worth waiting for
  assert.equal(mainState(unknowns['a run still going']).waiting, true);
  assert.equal(mainState(unknowns['a cancelled run']).waiting, undefined);
  // not read at all
  assert.equal(compare({ pr, main: null, moneyDirs }).pass, false);
});

test('(e) the same test id with a different reason fails', () => {
  const v = compare({
    pr: prRecord(pkg, dir, [[file, name, 'AssertionError: expected 3 to be 4']]),
    main: mainState(mainWith([REGISTRY])),
    moneyDirs,
  });
  assert.equal(v.pass, false);
  assert.match(v.held[0].why, /^main failed it for another reason: AssertionError: expected \[Function\]/);
  // and the same reason on another test of the same file:
  const w = compare({ pr: prRecord(pkg, dir, [[file, `${name} (again)`, reason]]), main: mainState(mainWith([REGISTRY])), moneyDirs });
  assert.equal(w.pass, false);
});

test('a package whose red is not read test by test is held, whatever main has', () => {
  const main = mainState(mainWith([REGISTRY]));
  const held = (label, rec) => {
    const v = compare({ pr: rec, main, moneyDirs });
    assert.equal(v.pass, false, label);
    assert.match(v.held[0].why, /^its failure is not read test by test/, label);
  };
  const r = report(pkg, [[file, name, reason]]);
  held('an unhandled error beside the shared failure', prRecord(pkg, dir, [], { reports: [{ ...r, dir, unhandled: ['Error: leaked'] }] }));
  held('an interrupted run', prRecord(pkg, dir, [], { reports: [{ ...r, dir, reason: 'interrupted' }] }));
  held(
    'one of two vitest runs never reported',
    prRecord(pkg, dir, [], { script: 'vitest run && vitest run --config x.config.ts', reports: [{ ...r, dir }] }),
  );
  held(
    'a command after vitest that a red run skipped',
    prRecord(pkg, dir, [], { script: 'vitest run && node scripts/linked-roundtrip.mjs', reports: [{ ...r, dir }] }),
  );
  held('no report at all (vitest crashed)', prRecord(pkg, dir, [], { reports: [] }));
  held(
    'a file failed with nothing recorded',
    prRecord(pkg, dir, [], { reports: [{ ...r, dir, failed: [{ file, state: 'failed', errors: [], suites: [], tests: [] }] }] }),
  );
  held('a report of another version', prRecord(pkg, dir, [], { reports: [{ ...r, dir, v: REPORT_VERSION + 1 }] }));
  // turbo's own failures
  const rec = recordOf({
    summary: {
      tasks: [
        { taskId: '@intafaced/db#build', task: 'build', package: '@intafaced/db', directory: 'packages/db', execution: { exitCode: 1 } },
      ],
    },
    reports: new Map(),
    scriptOf: () => 'vitest run',
    outcome: 'failure',
    sha: 'x',
    event: 'pull_request',
    shard: 'changed',
    attempt: '1',
  });
  assert.deepEqual(rec.problems, ['@intafaced/db#build failed (exit 1): not a test run']);
  assert.equal(compare({ pr: rec, main, moneyDirs }).pass, false);
  const none = recordOf({
    summary: null,
    reports: new Map(),
    scriptOf: () => '',
    outcome: 'failure',
    sha: 'x',
    event: 'pull_request',
    shard: 'changed',
    attempt: 1,
  });
  assert.equal(compare({ pr: none, main, moneyDirs }).pass, false);
  // a passing job records nothing to compare
  assert.deepEqual(
    recordOf({
      summary: null,
      reports: new Map(),
      scriptOf: () => '',
      outcome: 'success',
      sha: 'x',
      event: 'push',
      shard: '1/16',
      attempt: 1,
    }).packages,
    [],
  );
});

test('main is read only when it can change the verdict', () => {
  const shared = compare({ pr: prRecord(pkg, dir, [[file, name, reason]]), main: null, moneyDirs });
  assert.equal(needsMain(shared.held), true);
  const money = compare({
    pr: prRecord('@intafaced/svc-bank', 'services/svc-bank', [['services/svc-bank/src/x.test.ts', 'x', reason]]),
    main: null,
    moneyDirs,
  });
  assert.equal(needsMain(money.held), false);
});

test('the test script reader counts vitest runs and refuses what it cannot read', () => {
  assert.deepEqual(vitestRuns('vitest run'), { runs: 1 });
  assert.deepEqual(vitestRuns('pnpm --filter @intafaced/sbe-codec run build:jar && vitest run'), { runs: 1 });
  assert.deepEqual(vitestRuns('node scripts/run-mvn.mjs test && vitest run'), { runs: 1 });
  assert.deepEqual(vitestRuns('node ../../tooling/vitest/run-all.mjs vite.config.ts vitest.render.config.ts'), { runs: 2 });
  assert.deepEqual(vitestRuns('vitest run && vitest run --config vitest.render.config.ts'), { runs: 2 });
  for (const s of [
    'vitest run; true',
    'vitest run || true',
    'vitest run | tee x',
    'vitest run && node x.mjs',
    'node --test x.test.mjs',
    '',
    'vitest run & wait',
  ])
    assert.ok(vitestRuns(s).why, s);
});

test("each workspace package's test script reads as runs or a named reason, and customer's runs both its configs", () => {
  const customer = JSON.parse(readFileSync(join(process.cwd(), 'apps/customer/package.json'), 'utf8')).scripts.test;
  assert.deepEqual(vitestRuns(customer), { runs: 2 });
  assert.deepEqual(plan(['vite.config.ts', 'vitest.render.config.ts', '--shard=1/2']), [
    ['run', '--config', 'vite.config.ts', '--shard=1/2'],
    ['run', '--config', 'vitest.render.config.ts', '--shard=1/2'],
  ]);
  assert.throws(() => plan(['--shard=1/2']), /name at least one vitest config/);
});

test('the reporter writes failed tests, suites, file errors and unhandled errors, and lists no passing test', () => {
  const mod = (file, state, tests, { errors = [], suites = [] } = {}) => ({
    moduleId: join(process.cwd(), file),
    state: () => state,
    errors: () => errors,
    children: {
      *allSuites() {
        yield* suites;
      },
      *allTests() {
        yield* tests;
      },
    },
  });
  const t = (fullName, state, errors = []) => ({ fullName, result: () => ({ state, errors }) });
  const r = reportOf({
    dir: 'packages/x',
    name: '@intafaced/x',
    reason: 'failed',
    unhandledErrors: [{ name: 'Error', message: 'leaked\nstack' }],
    testModules: [
      mod('packages/x/src/a.test.ts', 'failed', [
        t('a > fails', 'failed', [{ name: 'AssertionError', message: `expected 1 to be 2\n  at ${process.cwd()}/x` }]),
        t('a > passes', 'passed'),
      ]),
      mod('packages/x/src/b.test.ts', 'passed', [t('b > passes', 'passed')]),
      mod('packages/x/src/c.test.ts', 'failed', [], {
        errors: [{ name: 'Error', message: `Cannot find module './y' imported from ${process.cwd()}/packages/x/src/c.test.ts` }],
      }),
      mod('packages/x/src/d.test.ts', 'failed', [t('d > skipped', 'skipped')], {
        suites: [{ fullName: 'd', errors: () => [{ name: 'Error', message: 'beforeAll threw' }] }],
      }),
    ],
  });
  assert.equal(r.tests, 4);
  assert.deepEqual(r.unhandled, ['Error: leaked']);
  assert.deepEqual(
    r.failed.map((m) => [m.file, m.tests.map((x) => x.name), m.errors, m.suites.map((s) => s.name)]),
    [
      ['packages/x/src/a.test.ts', ['a > fails'], [], []],
      ['packages/x/src/c.test.ts', [], ["Error: Cannot find module './y' imported from packages/x/src/c.test.ts"], []],
      ['packages/x/src/d.test.ts', [], [], ['d']],
    ],
  );
  assert.equal(errorLine({ name: 'AssertionError', message: '\nexpected 1\nmore' }), 'AssertionError: expected 1');
  // read back as a package: a file error and a suite error are failures of their own, with ids
  const p = explainPackage({ name: '@intafaced/x', dir: 'packages/x', exit: 1, script: 'vitest run', reports: [{ ...r, unhandled: [] }] });
  assert.equal(p.explained, true);
  assert.deepEqual(
    p.failures.map((f) => f.name),
    ['a > fails', '(file)', '(suite) d'],
  );
});

test('records and summaries are read from disk as CI writes them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'base-failures-test-'));
  try {
    mkdirSync(join(dir, 'res'));
    mkdirSync(join(dir, 'runs'));
    writeFileSync(join(dir, 'res', 'a.1.json'), JSON.stringify(report('@intafaced/contracts', [[file, name, reason]])));
    writeFileSync(join(dir, 'res', 'a.2.json'), JSON.stringify(report('@intafaced/contracts', [])));
    writeFileSync(join(dir, 'runs', 'old.json'), JSON.stringify({ execution: { startTime: 1 }, tasks: [] }));
    writeFileSync(join(dir, 'runs', 'new.json'), JSON.stringify({ execution: { startTime: 2 }, tasks: [{ taskId: 'n' }] }));
    assert.equal(readReports(join(dir, 'res')).get('@intafaced/contracts').length, 2);
    assert.equal(latestSummary(join(dir, 'runs')).tasks[0].taskId, 'n');
    assert.equal(latestSummary(join(dir, 'none')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('protected tests: the repo money list wins over a plain name, and plain tests stay plain', () => {
  const word = (n) => protectedWhy({ dir: 'packages/i18n', file: 'packages/i18n/src/x.test.ts', name: n }, { moneyDirs });
  for (const n of ['the fee is shown', 'fees are kept', 'tax lots', 'access control', 'an otp code', 'roles', 'a payout'])
    assert.ok(word(n), `${n} is protected`);
  for (const n of ['the notice feed', 'accessible names', 'taxonomy', 'options', 'repaints']) assert.equal(word(n), null, `${n} is not`);
  assert.match(
    protectedWhy({ dir: 'services/svc-bank', file: 'services/svc-bank/src/a.test.ts', name: 'formats a date' }, { moneyDirs }),
    /money code/,
  );
  assert.equal(
    protectedWhy(
      {
        dir: 'packages/contracts',
        file: 'packages/contracts/src/procedure-registry.test.ts',
        name: 'the registry is every `defineProcedure`',
      },
      { moneyDirs },
    ),
    null,
  );
  // a word inside another word is not that word
  assert.equal(
    protectedWhy({ dir: 'packages/i18n', file: 'packages/i18n/src/x.test.ts', name: 'repaints the display' }, { moneyDirs }),
    null,
  );
  assert.match(
    protectedWhy({ dir: 'packages/i18n', file: 'packages/i18n/src/x.test.ts', name: 'shows the payout copy' }, { moneyDirs }),
    /money/,
  );
});

// ── the Tests job's wiring (ci.yml), read as text ───────────────────────────────────────────────────────────────────

const CI = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const testsJob = CI.slice(CI.indexOf('\n  test-full:\n'), CI.indexOf('\n  look:\n'));
const step = (name) => {
  const at = testsJob.indexOf(`- name: ${name}\n`);
  assert.ok(at > 0, `no step "${name}" in the Tests job`);
  const rest = testsJob.slice(at + 1);
  return rest.slice(0, rest.search(/\n {6}- (name|uses|id|run):|\n {6}# |$/) + 1 || undefined);
};

test("the Tests job: main's own run fails on every failing test; only a pull request's tests are judged by the rule", () => {
  const run = step('Run pnpm test --continue');
  // The one step that may let a red test pass on: only on a pull request.
  assert.match(run, /\n {8}continue-on-error: \$\{\{ github\.event_name == 'pull_request' \}\}\n/);
  assert.match(run, /pnpm test --continue --concurrency=3 --summarize /);
  assert.match(run, /INTAFACED_TEST_RESULTS: \$\{\{ runner\.temp \}\}\/test-results/);
  const verdict = step('Failures main already has');
  assert.match(verdict, /github\.event_name == 'pull_request' && steps\.test\.outcome == 'failure'/);
  assert.doesNotMatch(verdict, /continue-on-error/);
  // Nothing else in the job is allowed to swallow a failure on a pull request.
  const swallowing = [...testsJob.matchAll(/continue-on-error: (.+)/g)].map((m) => m[1]);
  assert.deepEqual(swallowing, ["${{ github.event_name == 'pull_request' }}", "${{ github.event_name != 'pull_request' }}"]);
  // The record keeps main's copy of the rules on a pull request: base-failures.mjs and every file it imports, by name
  // (a folder named here would make every tooling/ci change run the unit tests: tooling-reach.mjs).
  const record = step("Record this job's test results");
  const archived = /git archive origin\/main ([^|]+)\|/
    .exec(record.replace(/\\\n\s*/g, ' '))[1]
    .trim()
    .split(/\s+/)
    .sort();
  const closure = new Set();
  const visit = (f) => {
    if (closure.has(f)) return;
    closure.add(f);
    for (const m of readFileSync(join(process.cwd(), f), 'utf8').matchAll(/^import .* from '\.\/([^']+)';$/gm)) visit(`tooling/ci/${m[1]}`);
  };
  visit('tooling/ci/base-failures.mjs');
  assert.deepEqual(archived, [...closure].sort(), 'the archive step must name exactly base-failures.mjs and what it imports');
  assert.match(record, /if ! git cat-file -e origin\/main:tooling\/ci\/base-failures\.mjs/);
  assert.match(record, /\n {12}bf="\$RUNNER_TEMP\/main-rules\/\$bf"\n {10}fi\n/, "a pull request runs main's copy, never its own");
  assert.match(record, /continue-on-error: \$\{\{ github\.event_name != 'pull_request' \}\}/);
  // Main keeps its records, named as the verdict reads them.
  const keep = step("Keep this job's test results");
  assert.match(keep, /github\.event_name == 'push'/);
  assert.match(record, /test-results-\$\{SHARD\/\/\\\/\/-of-\}-\$\{GITHUB_RUN_ATTEMPT\}/);
  assert.equal(artifactName('3/16', 2), 'test-results-3-of-16-2');
  // A Maven repository is saved only from a job whose tests all passed.
  for (const m of testsJob.matchAll(/- name: Save .*Maven repository\n {8}if: (.+)/g))
    assert.match(m[1], /steps\.test\.outcome == 'success'/);
  // The job may read main's run (and nothing more).
  assert.match(testsJob, /\n {4}permissions:\n {6}contents: read\n {6}actions: read/);
  // turbo hands the folder to each vitest run.
  assert.ok(JSON.parse(readFileSync(join(process.cwd(), 'turbo.json'), 'utf8')).globalPassThroughEnv.includes('INTAFACED_TEST_RESULTS'));
});

test("money code here is the repo's list, as the journeys run reads it, at the head and through git at a commit", () => {
  const here = moneyDirsOf(manifestsOf(process.cwd()));
  assert.deepEqual([...here].sort(), [...moneyCodeDirs(manifestsAt(process.cwd()))].sort());
  assert.ok(here.has('services/svc-bank') && here.has('packages/ledger-client') && here.has('services/svc-edge'));
  const files = {
    'services/svc-x/package.json': { name: '@intafaced/svc-x', dependencies: { '@intafaced/ledger-client': 'workspace:*' } },
    'packages/y/package.json': { name: '@intafaced/y' },
  };
  const git = (args) =>
    args[0] === 'ls-tree' ? `${Object.keys(files).join('\n')}\ncrates/svc-z/Cargo.toml\n` : JSON.stringify(files[args[1].split(':')[1]]);
  const at = manifestsAtRev('abc', git);
  assert.deepEqual([...at.keys()], ['services/svc-x', 'packages/y']);
  assert.ok(moneyDirsOf(at).has('services/svc-x'));
  assert.ok(!moneyDirsOf(at).has('packages/y'));
});
