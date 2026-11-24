// tooling-tests.mjs names each failed tooling test, with the first lines of its error, before the whole TAP output, and
// gates.mjs keeps all of that output. On 14 Nov the Doctrine gates job of two journey builds (CI runs 43623577056 and
// 43623998224) printed "TOOLING TESTS FAILED: 1 failed, 984 passed" and then the TAP output cut at 1 MB, before its one
// `not ok` line, so each builder spent a push finding journey-navigation.test.mjs.
// Run: node --test tooling/scripts/tooling-tests.test.mjs (also by the tooling-tests Doctrine gate).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildFilters, classify, readEdges } from '../ci/ci-affected.mjs';
import { NEEDS_BUILD, failedTests, failureSummary, runFiles, runsAlone, testFiles } from './tooling-tests.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'tooling/scripts/tooling-tests.mjs');

// The TAP that head 2334d99 (J-merchant-01) gives, replayed on the Mac: a passing test, then journey-navigation.test.mjs,
// which throws outside any test(), so its message is in the `# ` lines before it and its own error says only `test failed`.
const REPLAY_2334D99 = `TAP version 13
# Subtest: the longer stop line is still a refusal, so the tick still stops and is never retried
ok 5 - the longer stop line is still a refusal, so the tick still stops and is never retried
  ---
  duration_ms: 0.084334
  type: 'test'
  ...
# node:internal/modules/run_main:107
#     triggerUncaughtException(
#     ^
# AssertionError [ERR_ASSERTION]: a response wait set up before a goto or reload, which the old page can answer; read it with responseAfterNavigation (navigation.mjs) instead:
# apps/customer/tests/real-app/J-merchant-01-settings.pw.mjs:99 (viewerPrefsRead)
# + actual - expected
# + [
# +   'apps/customer/tests/real-app/J-merchant-01-settings.pw.mjs:99 (viewerPrefsRead)'
# + ]
# - []
#     at file:///repo/tooling/scripts/journey-navigation.test.mjs:85:8
#     at ModuleJob.run (node:internal/modules/esm/module_job:439:25)
# Node.js v26.3.1
# Subtest: tooling/scripts/journey-navigation.test.mjs
not ok 6 - tooling/scripts/journey-navigation.test.mjs
  ---
  duration_ms: 99.728709
  type: 'test'
  location: '/repo/tooling/scripts/journey-navigation.test.mjs:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..6
# tests 6
# pass 5
# fail 1
# cancelled 0
`;

test('replay of CI run 43623577056: the failed file and its rule come first, with the journey line it names', () => {
  const failed = failedTests(REPLAY_2334D99);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].name, 'tooling/scripts/journey-navigation.test.mjs');
  assert.match(failed[0].error[0], /^AssertionError \[ERR_ASSERTION\]: a response wait set up before a goto or reload/);
  assert.ok(failed[0].error.includes('apps/customer/tests/real-app/J-merchant-01-settings.pw.mjs:99 (viewerPrefsRead)'));
  assert.ok(failed[0].error.length <= 8);
  const summary = failureSummary(failed);
  assert.match(summary, /^FAILED TOOLING TESTS \(1\)/);
  assert.match(summary, /✖ tooling\/scripts\/journey-navigation\.test\.mjs\n/);
  assert.doesNotMatch(summary, /triggerUncaughtException/);
});

test('a failed subtest is named with its message and its place in the test file; its parent is not listed again', () => {
  const tap = [
    '# Subtest: outer',
    '    # Subtest: inner breaks',
    '    not ok 1 - inner breaks',
    '      ---',
    "      location: '/repo/tooling/ci/x.test.mjs:3:38'",
    "      failureType: 'testCodeFailure'",
    '      error: |-',
    '        one is not two',
    '',
    '        1 !== 2',
    "      code: 'ERR_ASSERTION'",
    '      stack: |-',
    '        TestContext.<anonymous> (file:///repo/tooling/ci/x.test.mjs:3:72)',
    '        Test.runInAsyncScope (node:async_hooks:226:14)',
    '      ...',
    '    1..1',
    'not ok 1 - outer',
    '  ---',
    "  location: '/repo/tooling/ci/x.test.mjs:3:1'",
    "  failureType: 'subtestsFailed'",
    "  error: '1 subtest failed'",
    '  ...',
    '# Subtest: quoted',
    'not ok 2 - quoted',
    '  ---',
    "  error: 'it''s red'",
    '  ...',
  ].join('\n');
  assert.deepEqual(failedTests(tap), [
    {
      name: 'inner breaks',
      location: '/repo/tooling/ci/x.test.mjs:3:38',
      error: ['one is not two', '1 !== 2', 'TestContext.<anonymous> (file:///repo/tooling/ci/x.test.mjs:3:72)'],
    },
    { name: 'quoted', location: null, error: ["it's red"] },
  ]);
});

test('output with no `not ok` line (a timeout, a crash) says so instead of naming nothing', () => {
  assert.deepEqual(failedTests('TAP version 13\nok 1 - fine\n'), []);
  assert.match(failureSummary([]), /no `not ok` line in the output; read the whole output below/);
});

test('end to end: a red tooling test is named on the first lines of stdout and in the stderr line, before its TAP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tooling-tests-'));
  try {
    mkdirSync(join(dir, 'tooling', 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'tooling', 'scripts', 'a-pass.test.mjs'), "import test from 'node:test';\ntest('fine', () => {});\n");
    writeFileSync(
      join(dir, 'tooling', 'scripts', 'b-red.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('the planted rule', () => assert.equal(1, 2, 'planted: one is not two'));\n",
    );
    // Without node's test context, as the gate runs it, so the inner `node --test` really runs both files.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', env });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    const first = r.stdout.split('\n').slice(0, 4).join('\n');
    assert.match(first, /^FAILED TOOLING TESTS \(1\)/);
    assert.match(first, /✖ the planted rule {2}\(tooling\/scripts\/b-red\.test\.mjs:3:1\)/);
    assert.match(first, /planted: one is not two/);
    assert.ok(r.stdout.indexOf('FAILED TOOLING TESTS') < r.stdout.indexOf('TAP version 13'));
    assert.match(
      r.stderr,
      /TOOLING TESTS FAILED — 1 of 2 files: 1 failed, 0 cancelled, 1 passed, in \d+ s\.\n {2}✖ tooling\/scripts\/b-red\.test\.mjs: 1 failed, 0 cancelled\nFAILED TOOLING TESTS \(1\)/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gates.mjs keeps a gate's whole output: the tooling tests' TAP is over execFileSync's default 1 MB", async () => {
  const { GATE_OUTPUT_MAX } = await import('../ci/gates.mjs');
  assert.ok(GATE_OUTPUT_MAX >= 64 * 1024 * 1024);
  // The runner itself, on a planted gate printing 2 MB (twice the default) and then failing: its last line survives.
  const { runGate } = await import('../ci/gates.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'gate-output-'));
  try {
    const big = join(dir, 'big.mjs');
    writeFileSync(big, "process.stdout.write('x'.repeat(2 * 1024 * 1024) + '\\nnot ok 1 - the last line\\n');\nprocess.exitCode = 1;\n");
    const r = await runGate({ id: 'big', script: relative(process.cwd(), big) });
    assert.equal(r.ok, false);
    assert.ok(r.output.length > 2 * 1024 * 1024, `the runner kept ${r.output.length} bytes`);
    assert.match(r.output, /not ok 1 - the last line\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The run takes several files at once (ps#3684: one at a time it ran past its 5-minute limit on #9648 and #9650), so a
// hang must still be stopped and named, a file marked alone must still run with nothing beside it, and the whole run's limit
// must still hold.
const plant = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'tooling-tests-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), `import test from 'node:test';\n${body}\n`);
  return dir;
};
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
// Each file writes when it starts and when it ends, so the test can see what ran beside what.
const logged = (name, ms) =>
  `import { appendFileSync } from 'node:fs';\ntest('${name}', async () => { appendFileSync('log', 'start ${name}\\n'); await new Promise((r) => setTimeout(r, ${ms})); appendFileSync('log', 'end ${name}\\n'); });`;

test('a planted hang (a server left listening) is stopped at its own limit and named; the files beside it still pass', async () => {
  const dir = plant({
    'hang.test.mjs': "import { createServer } from 'node:http';\ntest('leaves a server running', () => { createServer().listen(0); });",
    'fine.test.mjs': "test('fine', () => {});",
  });
  try {
    const started = Date.now();
    const [hang, fine] = await runFiles(['hang.test.mjs', 'fine.test.mjs'], { cwd: dir, env, alone: [], atOnce: 2, fileTimeoutMs: 3000 });
    assert.ok(Date.now() - started < 15_000, 'the hang held the run past its limit');
    assert.equal(hang.timedOut, true);
    assert.notEqual(hang.status, 0);
    assert.equal(fine.status, 0, fine.output);
    assert.match(fine.output, /^# pass 1$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('files run at once, and a file marked alone runs after them with nothing beside it', async () => {
  const dir = plant({ 'a.test.mjs': logged('a', 600), 'b.test.mjs': logged('b', 600), 'c.test.mjs': logged('c', 600) });
  try {
    const rs = await runFiles(['a.test.mjs', 'b.test.mjs', 'c.test.mjs'], { cwd: dir, env, alone: ['b.test.mjs'], atOnce: 2 });
    assert.deepEqual(
      rs.map((r) => [r.file, r.status]),
      [
        ['a.test.mjs', 0],
        ['b.test.mjs', 0],
        ['c.test.mjs', 0],
      ],
    );
    const log = readFileSync(join(dir, 'log'), 'utf8').trim().split('\n');
    // a and c overlap; b starts only after both ended, and ends before anything else starts.
    assert.ok(log.indexOf('start c') < log.indexOf('end a') && log.indexOf('start a') < log.indexOf('end c'), log.join(', '));
    assert.deepEqual(log.slice(-2), ['start b', 'end b'], log.join(', '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("past the whole run's limit, the files not started are not run, and say so", async () => {
  const dir = plant({ 'slow.test.mjs': logged('slow', 3000), 'later.test.mjs': "test('later', () => {});" });
  try {
    const [slow, later] = await runFiles(['slow.test.mjs', 'later.test.mjs'], { cwd: dir, env, alone: [], atOnce: 1, timeoutMs: 1000 });
    assert.equal(slow.timedOut, true, 'the running file is stopped at the run limit');
    assert.equal(later.notRun, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('end to end: a planted hang turns the gate red and names the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tooling-tests-'));
  try {
    mkdirSync(join(dir, 'tooling', 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'tooling', 'scripts', 'a-pass.test.mjs'), "import test from 'node:test';\ntest('fine', () => {});\n");
    // A test that never ends, which node:test's own runner would wait for forever. TOOLING_TESTS_FILE_TIMEOUT_MS can
    // only lower the per-file limit, so the planted hang is stopped in 3 s rather than 3 minutes, by the gate itself.
    writeFileSync(
      join(dir, 'tooling', 'scripts', 'b-hang.test.mjs'),
      "import test from 'node:test';\ntest('never ends', () => new Promise(() => setInterval(() => {}, 1000)));\n",
    );
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...env, TOOLING_TESTS_FILE_TIMEOUT_MS: '3000' } });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /TOOLING TESTS FAILED — 1 of 2 files/);
    assert.match(r.stderr, /✖ tooling\/scripts\/b-hang\.test\.mjs: stopped after \d+ s, its limit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file is run alone only by its own mark in its first lines, never by a mention further down', () => {
  const mark = ['// tooling-tests', 'alone. It takes the checkout index.lock.'].join(': ');
  assert.equal(runsAlone(`${mark}\nimport test from 'node:test';\n`), true);
  assert.equal(runsAlone(`// a header\n${mark}\n`), true);
  assert.equal(runsAlone(`${'\n'.repeat(20)}${mark}\n`), false);
  assert.equal(runsAlone(`const s = '${mark}';\n`), false);
});

// CI's build job runs a NEEDS_BUILD file only when its output was built (.github/workflows/ci.yml, "Tooling tests that
// need the build"), so a change that can move what the file checks must build that output, or the file never runs on it.
// The product side is turbo's: a change to the app, or to a package it imports, builds the app (its dependents and ^build).
// This holds the tooling side: the file, the tooling it imports, and the list deep-entries checks.
const localImports = (file, seen = new Set()) => {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const [, spec] of readFileSync(join(ROOT, file), 'utf8').matchAll(/(?:from|import\()\s*'(\.{1,2}\/[^']+\.m?js)'/g))
    localImports(
      relative(ROOT, join(ROOT, dirname(file), spec))
        .split('\\')
        .join('/'),
      seen,
    );
  return seen;
};

test('each NEEDS_BUILD file names a built output, and a change to it or what it reads builds that output', () => {
  const files = Object.keys(NEEDS_BUILD);
  assert.ok(files.length > 0);
  assert.ok(
    files.every((f) => !testFiles().includes(f)),
    'a NEEDS_BUILD file also runs unbuilt in the Doctrine gates',
  );
  const read = { 'tooling/lint/deep-entries.test.mjs': ['tooling/lint/oxlint-plugin-garden/deep-entries.json'] };
  for (const [file, out] of Object.entries(NEEDS_BUILD)) {
    // A misspelt output never exists: its file would never run, so it must be a workspace's dist, from its own build.
    const ws = /^((?:apps|packages|services)\/[^/]+)\/dist\/[^/]/.exec(out)?.[1];
    assert.ok(ws, `${file}: ${out} is not inside a workspace's dist/`);
    assert.ok(JSON.parse(readFileSync(join(ROOT, ws, 'package.json'), 'utf8')).scripts?.build, `${ws} has no build script`);
    const inputs = [...localImports(file), ...(read[file] ?? [])];
    assert.ok(inputs.length > 1, `${file} imports none of its own tooling`);
    for (const changed of inputs) {
      const flags = classify([changed]);
      const builds = flags.full || (flags.affected && buildFilters([changed], readEdges([changed]), 'BASE').includes(`./${ws}`));
      assert.ok(builds, `a change to ${changed} does not build ${ws}, so CI never runs ${file} on it`);
    }
  }
});
