// tooling-tests.mjs names each failed tooling test, with the first lines of its error, before the whole TAP output, and
// gates.mjs keeps all of that output. On 14 Nov the Doctrine gates job of two journey builds (CI runs 43623577056 and
// 43623998224) printed "TOOLING TESTS FAILED: 1 failed, 984 passed" and then the TAP output cut at 1 MB, before its one
// `not ok` line, so each builder spent a push finding journey-navigation.test.mjs.
// Run: node --test tooling/scripts/tooling-tests.test.mjs (also by the tooling-tests Doctrine gate).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { failedTests, failureSummary } from './tooling-tests.mjs';

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
    assert.match(r.stderr, /TOOLING TESTS FAILED — exit 1, 1 failed, 0 cancelled, 1 passed across 2 files\.\nFAILED TOOLING TESTS \(1\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gates.mjs keeps a gate's whole output: the tooling tests' TAP is over execFileSync's default 1 MB", async () => {
  const { GATE_OUTPUT_MAX } = await import('../ci/gates.mjs');
  assert.ok(GATE_OUTPUT_MAX >= 64 * 1024 * 1024);
  const src = readFileSync(join(ROOT, 'tooling/ci/gates.mjs'), 'utf8');
  const call = src.slice(src.indexOf('output = execFileSync(process.execPath, [join(ROOT, gate.script)'));
  assert.match(call.slice(0, 400), /maxBuffer: GATE_OUTPUT_MAX/, "the gate runner's execFileSync passes the larger buffer");
});
