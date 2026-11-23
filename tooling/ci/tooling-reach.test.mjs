import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classify, narrowed } from './ci-affected.mjs';
import { CANARY, journeyTouch, mayBeQuiet, pullPick, quietTooling } from './journey-touch.mjs';
import { checkoutTree, commitTree, covers, jobsText, namedPaths, reachOf, readersOf, scanReach } from './tooling-reach.mjs';

// This checkout's tree, scanned once: the answer the journeys run's planner and ci.yml's changes job compute at run time.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const own = checkoutTree(ROOT);
const scan = () => reachOf(own);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1e9 });

test("the seal's tree is the commit's: its files and their text, read through git; an unreadable tree narrows nothing", () => {
  const sha = git('rev-parse', 'HEAD').trim();
  const t = commitTree(ROOT, sha);
  try {
    assert.deepEqual([...t.files].sort(), git('ls-tree', '-r', '-z', '--name-only', sha).split('\0').filter(Boolean).sort());
    for (const f of ['package.json', '.github/workflows/ci.yml', 'tooling/ci/journey-touch.mjs'])
      assert.equal(t.read(f), git('show', `${sha}:${f}`), f);
  } finally {
    t.cleanup();
  }
  assert.throws(() => commitTree(ROOT, 'main'), /a commit sha is needed/);
  assert.equal(reachOf(null), null);
  assert.equal(reachOf({ files: null, read: () => '' }), null, 'a tree whose files cannot be listed is unscanned');
  // Only a change holding tooling no rule places is scanned at all.
  assert.equal(mayBeQuiet(['tooling/design/RECIPE.md']), true);
  assert.equal(mayBeQuiet(['tooling/ci/gates.mjs', 'apps/customer/src/a.ts', 'docs/a.md']), false);
});

test('the scan finds what the journeys run and the unit-test jobs are known to use, and not what they are known not to', () => {
  const { journeys, tests } = scan();
  // A journey helper the app's pay portal imports, a config every package's vitest reads, and the tooling workspace
  // package the image builds. T3's worktree setup is not one: a journeys run installs with pnpm, never through it.
  for (const f of ['tooling/uiproof/playwright-browsers.mjs', 'tooling/vitest/budget.mjs', 'tooling/pay-sim/src/cli.ts'])
    assert.ok(covers(journeys, f), `the journeys run reaches ${f}`);
  for (const f of [
    'tooling/design/RECIPE.md',
    'tooling/design/volt-recipe.mjs',
    'tooling/codemod/call-records/index.mjs',
    'tooling/beta/beta-host.mjs',
    'tooling/t3/setup-worktree.mjs',
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
  const t = journeyTouch([reached], undefined, null, null, scan().journeys);
  assert.equal(t.mode, 'full');
  assert.deepEqual(
    t.full.map((x) => x.path),
    [reached],
  );
  const pick = pullPick([reached], t, { reach: { journeyFiles: new Set(CANARY) } });
  assert.deepEqual(pick.files, [...CANARY].sort(), 'its bounded set (the CANARY here), as today');
  const quiet = ['tooling/design/RECIPE.md', 'tooling/design/volt-recipe.mjs'];
  assert.deepEqual(journeyTouch(quiet, undefined, null, null, scan().journeys), { mode: 'none', full: [], files: [] });
  // Unscanned (no tree, or a scan that failed): today's pick.
  assert.equal(journeyTouch(quiet).mode, 'full');
});

test('planted fault 3: a pull request that adds a journey test import of a tooling file, and changes that file, still runs journeys', () => {
  const journey = 'apps/customer/tests/real-app/J-a-01.pw.mjs';
  const head = tree({ ...BASE, [journey]: `import { h } from '../../../../tooling/design/helper.mjs';\n${BASE[journey]}` });
  const changed = [journey, 'tooling/design/helper.mjs'];
  // The head's scan sees the new import; the base's would not, and the journey file itself is never quiet either way.
  const atHead = scanReach(head).journeys;
  assert.ok(covers(atHead, 'tooling/design/helper.mjs'), "the head's tree reaches the helper");
  for (const [name, reach] of [
    ['by the head', atHead],
    ['by the base', scanReach(tree(BASE)).journeys],
  ]) {
    const t = journeyTouch(changed, undefined, null, null, reach);
    assert.notEqual(t.mode, 'none', `${name}: ${JSON.stringify(t)}`);
  }
  assert.equal(
    journeyTouch(['tooling/design/helper.mjs'], undefined, null, null, atHead).mode,
    'full',
    'the helper alone, at the head: the safe default',
  );
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
  const reach = scan();
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
    assert.deepEqual(narrowed(files, { reach }), [], JSON.stringify(files));
    assert.deepEqual(classify(files, { reach }), classify(files, { reach: null }), `${JSON.stringify(files)}: as with no scan`);
  }
  // A tree that can't be scanned narrows nothing.
  assert.deepEqual(narrowed(['tooling/ci/gates.mjs'], { reach: null }), []);
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
    assert.equal(journeyTouch(files, undefined, null, null, scan().journeys).mode, 'none', JSON.stringify(files));
    assert.equal(classify(files, { tree: own, reach: scan() }).full, false, JSON.stringify(files));
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

test('jobsText keeps only the jobs it is asked for', () => {
  const yml = 'on: push\njobs:\n  gates:\n    a: 1\n  changes:\n    b: 2\n  build:\n    c: 3\n';
  assert.equal(jobsText(yml, ['changes']), '  changes:\n    b: 2');
  assert.equal(jobsText(yml), '  changes:\n    b: 2\n  build:\n    c: 3\n');
});
