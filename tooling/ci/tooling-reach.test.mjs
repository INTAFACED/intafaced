import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, narrowed } from './ci-affected.mjs';
import { CANARY, journeyTouch, pullPick, quietTooling } from './journey-touch.mjs';
import { covers, jobsText, loadReach, missing, namedPaths, readersOf, render, scanReach } from './tooling-reach.mjs';

let fresh;
const scan = () => (fresh ??= scanReach());

test('tooling-reach.json holds every reach the tree shows (node tooling/ci/tooling-reach.mjs --write)', () => {
  const committed = loadReach();
  assert.ok(committed, 'tooling-reach.json is readable');
  const miss = missing(committed, scan());
  assert.deepEqual(
    miss.map((m) => `${m.list}: ${m.entry} (from ${m.from})`),
    [],
    'tooling-reach.json misses a reach: run node tooling/ci/tooling-reach.mjs --write',
  );
});

test('the scan finds what the journeys run and the unit-test jobs are known to use, and not what they are known not to', () => {
  const { journeys, tests } = scan();
  // A journey helper the app's pay portal imports, a config every package's vitest reads, the type-check wrapper's
  // worktree setup, and the tooling workspace package the image builds.
  for (const f of [
    'tooling/uiproof/playwright-browsers.mjs',
    'tooling/vitest/budget.mjs',
    'tooling/t3/setup-worktree.mjs',
    'tooling/pay-sim/src/cli.ts',
  ])
    assert.ok(covers(journeys, f), `the journeys run reaches ${f}`);
  for (const f of [
    'tooling/design/RECIPE.md',
    'tooling/design/volt-recipe.mjs',
    'tooling/codemod/call-records/index.mjs',
    'tooling/beta/beta-host.mjs',
  ])
    assert.ok(!covers(journeys, f), `no journeys run reaches ${f}`);
  // What ci.yml's test jobs run: the classifier, the shard plan, the tooling tests that need the build and what they import.
  for (const f of [
    '.github/workflows/ci.yml',
    'tooling/ci/ci-affected.mjs',
    'tooling/ci/test-shards.mjs',
    'tooling/ci/cross-package-reads.mjs',
    'tooling/ci/test-read-edges.json',
    'tooling/ci/test-typecheck.mjs',
    'tooling/scripts/tooling-tests.mjs',
    'tooling/preview/outreach/fixture.test.mjs',
    'tooling/preview/outreach/fixture.mjs',
    'tooling/pay-sim/src/cli.ts',
  ])
    assert.ok(covers(tests, f), `the unit-test jobs run or read ${f}`);
  for (const f of ['tooling/ci/gates.mjs', 'tooling/ci/ci-review.mjs', '.github/workflows/merge-seal.yml', 'tooling/design/RECIPE.md'])
    assert.ok(!covers(tests, f), `no unit-test job runs ${f}`);
});

// ---- Planted faults, on a tree of their own ----

const tree = (entries) => {
  const files = new Set(Object.keys(entries));
  return {
    files,
    read: (f) =>
      f in entries
        ? entries[f]
        : (() => {
            throw new Error(`ENOENT ${f}`);
          })(),
  };
};
const BASE = {
  'package.json': JSON.stringify({ scripts: {} }),
  '.github/workflows/real-app-journeys.yml': 'jobs:\n  touch:\n    steps:\n      - run: node tooling/ci/journey-touch.mjs\n',
  '.github/workflows/ci.yml':
    'jobs:\n  gates:\n    steps:\n      - run: node tooling/ci/gates.mjs\n  changes:\n    steps:\n      - run: node tooling/ci/ci-affected.mjs\n',
  'tooling/ci/ci-affected.mjs': "import { x } from './test-shards.mjs';\n",
  'tooling/ci/test-shards.mjs': '',
  'tooling/ci/gates.mjs': "import './brand-scan.mjs';\nconst page = 'tooling/design/RECIPE.md';\n",
  'tooling/ci/brand-scan.mjs': '',
  'tooling/design/RECIPE.md': 'see volt-recipe.mjs\n',
  'tooling/design/volt-recipe.mjs': '',
  'tooling/design/helper.mjs': 'export const h = 1; // tooling/design/other.mjs is only named in a comment\n',
  'tooling/design/other.mjs': '',
  'apps/customer/package.json': '{}',
  'apps/customer/tests/real-app/J-a-01.pw.mjs': "import { test } from '@playwright/test';\ntest('J-a-01 #1 x', () => {});\n",
};

test('planted fault 1: a tooling file a journey test imports still picks journeys; the rest of its folder does not', () => {
  const clean = scanReach(tree(BASE));
  assert.ok(!covers(clean.journeys, 'tooling/design/helper.mjs'), 'before the import, no journey reaches the helper');
  const planted = scanReach(
    tree({
      ...BASE,
      'apps/customer/tests/real-app/J-a-01.pw.mjs': `import { h } from '../../../../tooling/design/helper.mjs';\n${BASE['apps/customer/tests/real-app/J-a-01.pw.mjs']}`,
    }),
  );
  assert.ok(covers(planted.journeys, 'tooling/design/helper.mjs'), 'the journey test imports it, so the journeys run reaches it');
  assert.ok(!covers(planted.journeys, 'tooling/design/other.mjs'), 'a file only a comment names stays unreached');
  assert.ok(!covers(planted.journeys, 'tooling/design/RECIPE.md'), 'a page a gate names stays unreached: gates run in no journeys run');
  // And the planner: reached, the file stays the safe default, so the change runs its bounded set, never nothing.
  assert.equal(quietTooling('tooling/design/helper.mjs', planted.journeys), false);
  assert.equal(quietTooling('tooling/design/helper.mjs', clean.journeys), true);
  // A path the planner can't place by the file (an entry for its folder, or a path start) is reached too.
  for (const spelling of ["join(root, 'tooling', 'design')", '`tooling/design/${name}.mjs`', "'tooling/design/'"]) {
    const r = scanReach(tree({ ...BASE, 'apps/customer/src/a.ts': `const p = ${spelling};\n`, 'apps/customer/src/b.ts': '' }));
    assert.ok(covers(r.journeys, 'tooling/design/new-file.mjs'), `app code naming ${spelling} reaches every file there, a new one too`);
  }
});

test('planted fault 1, the planner on this tree: a reached tooling file runs the bounded set; an unreached one runs no journeys', () => {
  const reached = 'tooling/uiproof/playwright-browsers.mjs';
  const t = journeyTouch([reached]);
  assert.equal(t.mode, 'full');
  assert.deepEqual(
    t.full.map((x) => x.path),
    [reached],
  );
  const pick = pullPick([reached], t, { reach: { journeyFiles: new Set(CANARY) } });
  assert.deepEqual(pick.files, [...CANARY].sort(), 'its bounded set (the CANARY here), as today');
  assert.deepEqual(journeyTouch(['tooling/design/RECIPE.md', 'tooling/design/volt-recipe.mjs']), { mode: 'none', full: [], files: [] });
});

test('planted fault 2: a tooling file a package test reads still runs that test; one nothing reads runs none', () => {
  const t = tree({
    'apps/customer/package.json': '{}',
    'packages/config/package.json': '{}',
    'packages/config/src/copy.test.ts': "const recipe = readFileSync(join(root, 'tooling/design/RECIPE.md'), 'utf8');\n",
    'packages/ui/package.json': '{}',
    'packages/ui/src/look.test.ts': "import { recipe } from '../../../tooling/design/volt-recipe.mjs';\n",
    'packages/ui/src/all.test.ts': "for (const f of readdirSync('tooling/codemod')) read(f);\n",
    'packages/ui/src/note.test.ts': '// tooling/beta/beta-host.mjs is named in a comment only\n',
    'tooling/design/RECIPE.md': '',
    'tooling/design/volt-recipe.mjs': '',
    'tooling/codemod/call-records/index.mjs': '',
    'tooling/beta/beta-host.mjs': '',
  });
  const r = readersOf(
    ['tooling/design/RECIPE.md', 'tooling/design/volt-recipe.mjs', 'tooling/codemod/call-records/index.mjs', 'tooling/beta/beta-host.mjs'],
    t,
  );
  assert.deepEqual(r, {
    'packages/config': ['tooling/design/RECIPE.md'],
    'packages/ui': ['tooling/design/volt-recipe.mjs', 'tooling/codemod/call-records/index.mjs'],
  });
  // classify with those readers: affected, never full, never neither.
  const reach = { journeys: [], tests: [] };
  assert.deepEqual(classify(['tooling/design/RECIPE.md'], { reach, readers: r, edges: {} }), { full: false, affected: true, rust: false });
  assert.deepEqual(classify(['tooling/beta/beta-host.mjs'], { reach, readers: r, edges: {} }), {
    full: false,
    affected: false,
    rust: false,
  });
});

test("a change that touches a journey path, product code or the unit-test jobs keeps today's tests", () => {
  const reach = loadReach();
  for (const files of [
    ['tooling/ci/journey-touch.mjs'], // JOURNEY_CI
    ['tooling/scripts/local-test-stack.mjs'], // the stack
    ['tooling/ci/gates.mjs', 'services/svc-bank/src/a.ts'], // product code beside it
    ['tooling/ci/gates.mjs', 'apps/customer/tests/real-app/J-bank-13.pw.mjs'], // a journey beside it
    ['tooling/ci/gates.mjs', 'crates/svc-tax/src/lib.rs'], // Rust beside it (out of scope)
    ['.github/workflows/ci.yml'], // the unit-test jobs themselves
    ['tooling/ci/test-shards.mjs'],
    ['tooling/pay-sim/src/simulator.ts'], // a tooling workspace package
  ]) {
    assert.deepEqual(narrowed(files, reach), [], JSON.stringify(files));
    assert.deepEqual(classify(files), classify(files, { reach: null }), `${JSON.stringify(files)}: as with no tooling-reach.json`);
  }
  // An unreadable tooling-reach.json narrows nothing.
  assert.deepEqual(narrowed(['tooling/ci/gates.mjs'], null), []);
  assert.equal(classify(['tooling/ci/gates.mjs'], { reach: null }).full, true);
});

test('#9552 and the factory pull requests: tooling that reaches no journey runs no journeys and no unit shard', () => {
  for (const files of [
    // #9552's own files (two of them new on its branch, so on no list).
    [
      'tooling/design/RECIPE.md',
      'tooling/design/volt-keep-ids.json',
      'tooling/design/volt-keep-ids.mjs',
      'tooling/design/volt-keep-ids.test.mjs',
    ],
    ['tooling/codemod/call-records/report.mjs'],
    ['tooling/beta/beta-host.mjs', 'tooling/beta/beta-host.test.mjs'],
    ['tooling/ci/ci-review.mjs', 'tooling/ci/ci-review.test.mjs', '.github/workflows/ci-review.yml', 'AGENTS.md'],
  ]) {
    assert.equal(journeyTouch(files).mode, 'none', JSON.stringify(files));
    assert.equal(classify(files).full, false, JSON.stringify(files));
  }
});

test('namedPaths: a path, a folder, a relative path; a comment, a bare top or a missing relative path names nothing', () => {
  const files = new Set(['tooling/design/RECIPE.md', 'tooling/design/x.mjs', 'tooling/ci/a.mjs']);
  assert.deepEqual([...namedPaths('apps/a/src/b.ts', "read('tooling/design/RECIPE.md')", files)], ['tooling/design/RECIPE.md']);
  assert.deepEqual([...namedPaths('tooling/ci/b.mjs', "import './a.mjs';", files)], ['tooling/ci/a.mjs']);
  assert.deepEqual([...namedPaths('apps/a/src/b.ts', "readdirSync('tooling/design')", files)], ['tooling/design/']);
  assert.deepEqual([...namedPaths('apps/a/src/b.ts', '`tooling/design/v-${n}.mjs`', files)], ['tooling/design/v-*']);
  assert.deepEqual([...namedPaths('apps/a/src/b.ts', '// tooling/design/RECIPE.md', files)], []);
  assert.deepEqual([...namedPaths('tooling/ci/x.mjs', "const ALL = ['tooling/', '.github/'];", files)], []);
  assert.deepEqual([...namedPaths('tooling/ci/x.mjs', "import '../nowhere/x.mjs';", files)], []);
});

test('jobsText keeps only the jobs it is asked for; render writes what loadReach reads', () => {
  const yml = 'on: push\njobs:\n  gates:\n    a: 1\n  changes:\n    b: 2\n  build:\n    c: 3\n';
  assert.equal(jobsText(yml, ['changes']), '  changes:\n    b: 2');
  assert.equal(jobsText(yml), '  changes:\n    b: 2\n  build:\n    c: 3\n');
  const out = JSON.parse(render({ journeys: ['tooling/x/'], tests: ['a'] }));
  assert.deepEqual([out.journeys, out.tests], [['tooling/x/'], ['a']]);
  assert.deepEqual(
    missing({ journeys: ['tooling/x/'], tests: [] }, { journeys: ['tooling/x/y.mjs'], tests: ['b'] }).map((m) => m.entry),
    ['b'],
  );
});
