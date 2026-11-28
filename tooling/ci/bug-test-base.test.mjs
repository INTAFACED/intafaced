// A bug fix's test, shown failing on the code before the fix (bug-test-base.mjs, #11267): what counts as the test's own
// check, what is told apart from it, and the whole run on a throwaway repository with a real fix and planted faults.
// Run by tooling/scripts/tooling-tests.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  bugCandidates,
  bugOf,
  importProblems,
  isTestPath,
  judgeNode,
  judgeVitest,
  kindOf,
  verdict,
  vitestConfigs,
} from './bug-test-base.mjs';

const SCRIPT = fileURLToPath(new URL('./bug-test-base.mjs', import.meta.url));

test('the bug a pull request fixes: its closing words, then its claim branch, once each', () => {
  assert.deepEqual(bugCandidates({ body: 'Fixes #11106.\n\nAlso closes #12, resolves: #12', headRef: 'fix/11106' }), [11106, 12]);
  assert.deepEqual(bugCandidates({ body: 'Fixed INTAFACED/intafaced#7', headRef: 't3/x' }), [7]);
  assert.deepEqual(bugCandidates({ body: 'see #5, part of #6', headRef: 'fix/ps-4100' }), []);
  assert.deepEqual(bugCandidates({ body: null, headRef: 'fix/11267' }), [11267]);
});

test('which candidate is a bug; one that cannot be read, refused or unreachable, is checked as a bug', async () => {
  const answer = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
  const issues = {
    1: answer({ labels: [{ name: 'hunt' }] }),
    2: answer({ labels: [{ name: 'bug' }], pull_request: {} }),
    3: answer({ labels: ['bug'] }),
  };
  assert.equal(await bugOf([1, 2, 3], async (n) => issues[n]), '3');
  assert.equal(await bugOf([1, 2], async (n) => issues[n]), '');
  const warned = [];
  assert.equal(
    await bugOf(
      [1, 4],
      async (n) => (n === 4 ? answer({}, false, 502) : issues[n]),
      (l) => warned.push(l),
    ),
    '4',
  );
  assert.equal(
    await bugOf(
      [5],
      async () => {
        throw new Error('fetch failed');
      },
      (l) => warned.push(l),
    ),
    '5',
  );
  assert.deepEqual(warned, [
    'could not read #4 (GitHub answered 502); the bug test runs for it',
    'could not read #5 (fetch failed); the bug test runs for it',
  ]);
});

test('test paths stay at the head; everything else goes back to the base', () => {
  for (const p of [
    'packages/a/src/x.test.ts',
    'apps/customer/src/y.render.test.tsx',
    'tooling/ci/z.test.mjs',
    'apps/customer/tests/real-app/J-bank-01.pw.mjs',
    'crates/svc-tax/tests/it.rs',
    'packages/a/src/__snapshots__/x.test.ts.snap',
    'tooling/ci/fixtures/case.json',
  ])
    assert.equal(isTestPath(p), true, p);
  for (const p of [
    'packages/a/src/x.ts',
    'packages/venue-hyperliquid/recordings/order.json',
    'packages/ledger-client/src/testing/conformance.ts',
    '.github/workflows/ci.yml',
  ])
    assert.equal(isTestPath(p), false, p);
});

test('how each test runs here, and the kinds named as a gap', () => {
  assert.equal(kindOf('tooling/ci/a.test.mjs', "import { test } from 'node:test';", {}), 'node');
  assert.equal(kindOf('packages/a/src/a.test.ts', "import { it } from 'vitest';", { scripts: { test: 'vitest run' } }), 'vitest');
  assert.equal(
    kindOf('apps/customer/src/a.test.tsx', '', { scripts: { test: 'node ../../tooling/vitest/run-all.mjs vite.config.ts' } }),
    'vitest',
  );
  assert.match(kindOf('apps/customer/tests/real-app/J-x.pw.mjs', '', {}).gap, /real-app journey test/);
  assert.match(kindOf('crates/a/tests/it.rs', '', {}).gap, /Rust/);
  assert.match(kindOf('apps/invitation/a.test.js', '', { scripts: { test: 'node a.golden.js' } }).gap, /neither vitest nor node:test/);
  assert.equal(kindOf('tooling/ci/fixtures/case.json', '', {}), null);
  assert.deepEqual(vitestConfigs('node ../../tooling/vitest/run-all.mjs vite.config.ts vitest.render.config.ts'), [
    'vite.config.ts',
    'vitest.render.config.ts',
  ]);
  assert.deepEqual(vitestConfigs('vitest run'), [null]);
  assert.deepEqual(vitestConfigs('vitest run --config vitest.unit.config.ts'), ['vitest.unit.config.ts']);
});

const vitestFile = '/r/packages/a/src/a.test.ts';
const report = (entry) => ({ testResults: [{ name: vitestFile, status: 'failed', message: '', assertionResults: [], ...entry }] });

test("vitest: only a test's own expect failing counts; a missing module, a TypeError and a skip do not", () => {
  const caught = report({
    assertionResults: [
      { fullName: 'a', status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2 // Object.is equality\n  at x'] },
    ],
  });
  assert.equal(judgeVitest(vitestFile, [caught]).state, 'caught');
  const query = report({
    assertionResults: [{ fullName: 'q', status: 'failed', failureMessages: ['TestingLibraryElementError: Unable to find an element'] }],
  });
  assert.equal(judgeVitest(vitestFile, [query]).state, 'caught');
  const missing = report({ message: "Cannot find module './nope' imported from /r/packages/a/src/a.test.ts" });
  assert.deepEqual(judgeVitest(vitestFile, [missing]), {
    state: 'not-loaded',
    why: "Cannot find module './nope' imported from /r/packages/a/src/a.test.ts",
  });
  const typeError = report({
    assertionResults: [{ fullName: 't', status: 'failed', failureMessages: ['TypeError: b is not a function'] }],
  });
  assert.deepEqual(judgeVitest(vitestFile, [typeError]), { state: 'other-error', why: 't: TypeError: b is not a function' });
  const skipped = report({ status: 'skipped', assertionResults: [{ fullName: 's', status: 'skipped', failureMessages: [] }] });
  assert.equal(judgeVitest(vitestFile, [skipped]).state, 'no-tests');
  const passes = report({ status: 'passed', assertionResults: [{ fullName: 'p', status: 'passed', failureMessages: [] }] });
  assert.equal(judgeVitest(vitestFile, [passes]).state, 'passes');
  // A config that does not hold the file reports nothing for it; another file whose path holds this one's is not it.
  assert.equal(judgeVitest(vitestFile, [null, { testResults: [] }, passes]).state, 'passes');
  assert.equal(judgeVitest(vitestFile, [{ testResults: [{ ...caught.testResults[0], name: `${vitestFile}x` }] }]).state, 'no-tests');
});

test('node:test: an assertion counts; a file that fails to load, a thrown error and a describe failing with its test do not', () => {
  const f = '/r/tooling/ci/a.test.mjs';
  const assertion = {
    passed: false,
    name: 'a',
    file: f,
    skipped: false,
    error: { name: 'AssertionError', code: 'ERR_ASSERTION', message: 'x' },
  };
  const suite = { passed: false, name: 'd', file: f, skipped: false, error: { name: 'Error', code: null, message: '1 subtest failed' } };
  assert.equal(judgeNode(f, [assertion, suite]).state, 'caught');
  const load = { passed: false, name: 'a.test.mjs', file: f, skipped: false, error: { name: 'Error', code: null, message: 'test failed' } };
  assert.equal(judgeNode(f, [load]).state, 'not-loaded');
  const thrown = { passed: false, name: 't', file: f, skipped: false, error: { name: 'TypeError', code: null, message: 'no' } };
  assert.deepEqual(judgeNode(f, [thrown, suite]), { state: 'other-error', why: 't: TypeError: no' });
  assert.equal(judgeNode(f, [{ passed: true, name: 's', file: f, skipped: true, error: null }]).state, 'no-tests');
  assert.equal(judgeNode(f, [{ passed: true, name: 'p', file: f, skipped: false, error: null }]).state, 'passes');
});

test("the compiler's import errors in the test file only, leaving type-only imports and other files out", () => {
  const text = [
    "import { it } from 'vitest';",
    "import { added } from './lib.js';",
    "import type { Shape } from './types.js';",
    "import { type Other, kept } from './more.js';",
    'import type {',
    '  Spread,',
    "} from './spread.js';",
  ].join('\n');
  const out = [
    "src/a.test.ts(2,10): error TS2305: Module '\"./lib.js\"' has no exported member 'added'.",
    "src/a.test.ts(3,15): error TS2305: Module '\"./types.js\"' has no exported member 'Shape'.",
    "src/a.test.ts(4,15): error TS2305: Module '\"./more.js\"' has no exported member 'Other'.",
    "src/a.test.ts(6,3): error TS2305: Module '\"./spread.js\"' has no exported member 'Spread'.",
    "src/a.test.ts(4,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/other.ts(1,1): error TS2307: Cannot find module 'x' or its corresponding type declarations.",
  ].join('\n');
  assert.deepEqual(importProblems(out, 'src/a.test.ts', text), ["TS2305: Module '\"./lib.js\"' has no exported member 'added'."]);
});

test('the verdict: one test shown failing passes it; a test passing on the base is named with the fix; no test fails it', () => {
  const pass = verdict({
    issue: 9,
    results: [
      { file: 'a.test.ts', state: 'caught', why: 'x' },
      { file: 'b.test.ts', state: 'passes', why: '1' },
    ],
  });
  assert.equal(pass.ok, true);
  assert.deepEqual(
    pass.lines.map((l) => l.level),
    ['notice', 'warning'],
  );
  const fail = verdict({ issue: 9, results: [{ file: 'b.test.ts', state: 'passes', why: '1' }] });
  assert.equal(fail.ok, false);
  assert.equal(fail.lines[0].text, '`b.test.ts` passes on the code before this fix, so it does not catch #9. Make it fail on the base.');
  assert.equal(verdict({ issue: 9, results: [] }).ok, false);
  const gap = verdict({ issue: 9, results: [{ file: 'J-x.pw.mjs', state: 'gap', why: 'a real-app journey test' }] });
  assert.equal(gap.ok, true);
  assert.equal(gap.lines[0].level, 'warning');
  assert.equal(verdict({ issue: 9, results: [{ file: 'a.test.ts', state: 'not-loaded', why: 'TS2305' }] }).ok, false);
});

// ── The whole run, on a throwaway repository ───────────────────────────────────────────────────────────────────────

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'bug-test-base-test-'));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  const write = (files) => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
  };
  const commit = (files, message) => {
    write(files);
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', message);
  };
  // Before the fix: a sum that is off by one, and a test of something else.
  commit(
    {
      'lib/sum.mjs': 'export const sum = (a, b) => a + b + 1;\n',
      'lib/sum.test.mjs':
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('two', () => assert.equal(2, 2));\n",
    },
    'base',
  );
  const run = () => spawnSync('node', [SCRIPT, '--issue', '9', '--base', 'HEAD^1'], { cwd: dir, encoding: 'utf8' });
  return { dir, git, commit, run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const FIX = { 'lib/sum.mjs': 'export const sum = (a, b) => a + b;\n' };
const header = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";

test('a real fix: its changed test fails on the base by its own assertion, so the job passes and the checkout is back', () => {
  const r = repo();
  try {
    r.commit(
      { ...FIX, 'lib/sum.test.mjs': `${header}import { sum } from './sum.mjs';\ntest('sum', () => assert.equal(sum(1, 2), 3));\n` },
      'fix',
    );
    const out = r.run();
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /`lib\/sum\.test\.mjs` fails on the code before this fix, by its own check \(sum: AssertionError/);
    assert.equal(r.git('status', '--porcelain'), '');
    assert.equal(readFileSync(join(r.dir, 'lib/sum.mjs'), 'utf8'), FIX['lib/sum.mjs']);
  } finally {
    r.done();
  }
});

test('planted: a test that also passes on the base fails the job, naming the fix', () => {
  const r = repo();
  try {
    r.commit(
      { ...FIX, 'lib/other.test.mjs': `${header}test('always', () => assert.equal(1, 1));\n` },
      'fix with a test that catches nothing',
    );
    const out = r.run();
    assert.equal(out.status, 1, out.stdout);
    assert.match(
      out.stdout,
      /::error::`lib\/other\.test\.mjs` passes on the code before this fix, so it does not catch #9\. Make it fail on the base\./,
    );
  } finally {
    r.done();
  }
});

test('planted: a test that fails on the base only because it imports what the fix adds fails the job', () => {
  const r = repo();
  try {
    r.commit(
      {
        'lib/sum.mjs': 'export const sum = (a, b) => a + b + 1;\nexport const answer = 3;\n',
        'lib/answer.test.mjs': `${header}import { answer } from './sum.mjs';\ntest('answer', () => assert.equal(answer, 3));\n`,
      },
      'fix whose test needs a new export',
    );
    const out = r.run();
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stdout, /::error::`lib\/answer\.test\.mjs` does not load on the code before this fix/);
    // A file the fix added goes too: its test then fails to load, not by its assertion.
    r.commit(
      {
        'lib/new.mjs': 'export const n = 1;\n',
        'lib/new.test.mjs': `${header}import { n } from './new.mjs';\ntest('n', () => assert.equal(n, 1));\n`,
      },
      'a new module and its test',
    );
    const added = spawnSync('node', [SCRIPT, '--issue', '9', '--base', 'HEAD^1'], { cwd: r.dir, encoding: 'utf8' });
    assert.equal(added.status, 1, added.stdout);
    assert.match(added.stdout, /`lib\/new\.test\.mjs` does not load/);
    assert.equal(r.git('status', '--porcelain'), '');
  } finally {
    r.done();
  }
});

test('a fix with no test fails; one whose only test is a journey test passes with the gap named', () => {
  const r = repo();
  try {
    r.commit(FIX, 'fix with no test');
    const none = r.run();
    assert.equal(none.status, 1, none.stdout);
    assert.match(none.stdout, /adds or changes no test file/);
    r.commit(
      { 'apps/customer/tests/real-app/J-x.pw.mjs': '// a journey\n', 'lib/sum.mjs': 'export const sum = (a, b) => b + a;\n' },
      'journey only',
    );
    const journey = r.run();
    assert.equal(journey.status, 0, journey.stdout);
    assert.match(
      journey.stdout,
      /::warning::`apps\/customer\/tests\/real-app\/J-x\.pw\.mjs` is not run on the base here: a real-app journey test/,
    );
  } finally {
    r.done();
  }
});
