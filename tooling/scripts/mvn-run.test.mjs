// node:test file of mvn-run.mjs (#8121). The failure texts are copied from run 43227496169, job 131214736321.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isResolutionFailure, runMvnSync } from './mvn-run.mjs';

const FIRST_MISS = [
  '[ERROR] Plugin org.apache.maven.plugins:maven-resources-plugin:3.3.1 or one of its dependencies could not be resolved:',
  '[ERROR] \tCould not find artifact org.apache.maven.plugins:maven-resources-plugin:jar:3.3.1 in central (https://repo.maven.apache.org/maven2)',
  '[ERROR] -> [Help 1]',
].join('\n');
const CACHED_MISS = [
  '[ERROR] Plugin org.codehaus.mojo:exec-maven-plugin:3.5.0 or one of its dependencies could not be resolved:',
  '[ERROR] \torg.codehaus.mojo:exec-maven-plugin:jar:3.5.0 was not found in https://repo.maven.apache.org/maven2 during a previous attempt. This failure was cached in the local repository and resolution is not reattempted until the update interval of central has elapsed or updates are forced',
].join('\n');
const TEST_FAILURE = [
  '[ERROR] Tests run: 12, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.4 s <<< FAILURE! -- in io.intafaced.sbe.CodecTest',
  'Tests run: 12, Failures: 1, Errors: 0, Skipped: 0',
  '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.5.2:test (default-test) on project sbe-codec: There are test failures.',
].join('\n');
const COMPILE_ERROR = '[ERROR] COMPILATION ERROR :\n[ERROR] /src/main/java/io/intafaced/sbe/SbeCodecMain.java:[12,5] cannot find symbol';
const DEPS_MISS =
  '[ERROR] Failed to execute goal on project svc-fix: Could not resolve dependencies for project io.intafaced:svc-fix:jar:0.0.0';
const TRANSFER =
  '[ERROR] Could not transfer artifact uk.co.real-logic:sbe-tool:jar:1.39.0 from/to central (https://repo.maven.apache.org/maven2): Connection reset';

test('the run 43227496169 failures are resolution failures, the first and the cached one', () => {
  assert.equal(isResolutionFailure(FIRST_MISS), true);
  assert.equal(isResolutionFailure(CACHED_MISS), true);
  assert.equal(isResolutionFailure(DEPS_MISS), true);
  assert.equal(isResolutionFailure(TRANSFER), true);
});

test('a failing test, a compile error or no output is never a resolution failure', () => {
  assert.equal(isResolutionFailure(TEST_FAILURE), false);
  assert.equal(isResolutionFailure(`${TEST_FAILURE}\n${CACHED_MISS}`), false, 'a test ran: never retried');
  assert.equal(isResolutionFailure(COMPILE_ERROR), false);
  assert.equal(isResolutionFailure(''), false);
  assert.equal(isResolutionFailure(undefined), false);
});

/** A spawnSync stand-in that answers from a script of results and records each call. */
function fakeMaven(results) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 1, stdout: '', stderr: '', ...results[calls.length - 1] };
  };
  return { calls, spawn };
}

const quiet = { out: null, log: () => {}, sleep: () => {} };

test('a resolution miss is tried once more, with -U, and its pass is returned', () => {
  const waits = [];
  const { calls, spawn } = fakeMaven([{ stdout: FIRST_MISS }, { status: 0 }]);
  const r = runMvnSync('mvn', ['-q', 'test'], { ...quiet, spawn, sleep: (ms) => waits.push(ms), waitMs: 7 });
  assert.equal(r.status, 0);
  assert.equal(r.attempts, 2);
  assert.deepEqual(
    calls.map((c) => c.args),
    [
      ['-q', 'test'],
      ['-U', '-q', 'test'],
    ],
  );
  assert.deepEqual(waits, [7]);
});

test('a second resolution miss fails: one retry, never a loop', () => {
  const { calls, spawn } = fakeMaven([{ stdout: FIRST_MISS }, { stdout: CACHED_MISS }, { status: 0 }]);
  const r = runMvnSync('mvn', ['test'], { ...quiet, spawn });
  assert.equal(r.status, 1);
  assert.equal(r.attempts, 2);
  assert.equal(calls.length, 2);
});

test('a failing test or a compile error fails at once, with no retry', () => {
  for (const stdout of [TEST_FAILURE, COMPILE_ERROR]) {
    const { calls, spawn } = fakeMaven([{ stdout }, { status: 0 }]);
    const r = runMvnSync('mvn', ['test'], { ...quiet, spawn });
    assert.equal(r.status, 1);
    assert.equal(r.attempts, 1);
    assert.equal(calls.length, 1);
  }
});

test('a pass runs once; a killed run (status null) is not retried', () => {
  const ok = fakeMaven([{ status: 0 }]);
  assert.equal(runMvnSync('mvn', ['test'], { ...quiet, spawn: ok.spawn }).attempts, 1);
  const killed = fakeMaven([{ status: null, signal: 'SIGKILL' }, { status: 0 }]);
  const r = runMvnSync('mvn', ['test'], { ...quiet, spawn: killed.spawn });
  assert.equal(r.status, null);
  assert.equal(killed.calls.length, 1);
});

test('each attempt reaches the output sink, and cwd and env pass through', () => {
  const seen = [];
  const env = { JAVA_HOME: '/jdk' };
  const { calls, spawn } = fakeMaven([{ stdout: FIRST_MISS }, { status: 0, stdout: 'ok' }]);
  runMvnSync('mvn', ['test'], { ...quiet, spawn, cwd: '/pkg', env, out: (r) => seen.push(r.stdout) });
  assert.deepEqual(seen, [FIRST_MISS, 'ok']);
  assert.equal(calls[1].opts.cwd, '/pkg');
  assert.equal(calls[1].opts.env, env);
});
