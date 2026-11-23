// node:test file of mvn-run.mjs (#8121). The failure texts are copied from run 43227496169, job 131214736321.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// #9531 (run 44953598502): Central answered "Could not find artifact" for exec-maven-plugin 3.5.0 past the -U retry.
// The retry above only covers a blip; the fix that stops CI asking Central at all is a cache of each package's Maven
// repository: the test-infra action restores it, and the Tests job saves it only after that package's Maven tests ran
// (a job that ran only `build:jar` lacks the test plugins: PR #9537's first run, shard 3). These read both files and
// fail when a repository is left uncached, keyed on anything but its pom.xml, cached with Maven's records of a failed
// fetch (which would carry a miss into every run), saved by a job that did not run its tests, or saved under another
// path or key than the one restored.
const ACTION = readFileSync(new URL('../../.github/actions/test-infra/action.yml', import.meta.url), 'utf8');
const CI = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const MAVEN_PACKAGES = ['packages/sbe-codec', 'services/svc-fix'];

/** The `uses: <action>` step in `yaml` whose path block names `dir`'s Maven repository, as { path, key, if } or null. */
function cacheStep(yaml, action, dir) {
  const step = yaml
    .split(/\n(?=\s+- (?:name|uses|id): )/)
    .find((s) => s.includes(`uses: ${action}@`) && new RegExp(`^\\s+${dir}/\\.tools/m2$`, 'm').test(s));
  if (!step) return null;
  const path = (step.match(/path: \|\n((?:\s+\S.*\n?)+?)(?=\s+key:)/)?.[1] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return { path, key: step.match(/^\s+key: (.+)$/m)?.[1] ?? '', if: step.match(/^\s+if: (.+)$/m)?.[1] ?? '' };
}

/** The problems with `dir`'s Maven repository cache across the action and the Tests job, or [] when it holds. */
function mavenRepoCacheProblems(action, ci, dir) {
  const restore = cacheStep(action, 'actions/cache/restore', dir);
  const save = cacheStep(ci, 'actions/cache/save', dir);
  if (!restore) return [`test-infra restores no ${dir}/.tools/m2`];
  if (!save) return [`the Tests job saves no ${dir}/.tools/m2`];
  const problems = [];
  for (const record of ['*.lastUpdated', 'resolver-status.properties'])
    if (!restore.path.includes(`!${dir}/.tools/m2/**/${record}`))
      problems.push(`${dir}: Maven's failed-fetch record ${record} is not excluded`);
  if (!restore.key.includes(`hashFiles('${dir}/pom.xml')`)) problems.push(`${dir}: the key is not its pom.xml's hash (${restore.key})`);
  if (save.key !== restore.key || save.path.join('\n') !== restore.path.join('\n'))
    problems.push(`${dir}: saved under another path or key than restored`);
  if (!save.if.includes('success()') || !save.if.includes(`hashFiles('${dir}/target/surefire-reports/TEST-*.xml') != ''`))
    problems.push(`${dir}: saved by a job that did not pass or did not run its Maven tests (${save.if})`);
  return problems;
}

test('#9531: every package Maven runs for restores its Maven repository, saved only after its tests ran, no failed fetch kept', () => {
  for (const dir of MAVEN_PACKAGES) {
    // The repository the package's own toolchain points Maven at is the one cached.
    assert.match(
      readFileSync(new URL(`../../${dir}/scripts/ensure-toolchain.mjs`, import.meta.url), 'utf8'),
      /MAVEN_REPO: join\(\w+, 'm2'\)/,
    );
    assert.deepEqual(mavenRepoCacheProblems(ACTION, CI, dir), []);
  }
});

test('planted: an uncached repository, a kept failure record, a key off the pom or a save without its tests is caught', () => {
  const dir = 'packages/sbe-codec';
  const problems = (action, ci = CI) => mavenRepoCacheProblems(action, ci, dir).join('; ');
  assert.match(problems(ACTION.replaceAll(`${dir}/.tools/m2\n`, `${dir}/.tools/other\n`)), /restores no/);
  assert.match(problems(ACTION, CI.replaceAll(`${dir}/.tools/m2\n`, `${dir}/.tools/other\n`)), /saves no/);
  assert.match(problems(ACTION.replace(`!${dir}/.tools/m2/**/*.lastUpdated`, `${dir}/.tools/m2/x`)), /lastUpdated is not excluded/);
  assert.match(problems(ACTION.replace(`hashFiles('${dir}/pom.xml')`, 'github.sha')), /not its pom.xml/);
  assert.match(problems(ACTION, CI.replace(`hashFiles('${dir}/pom.xml')`, 'github.sha')), /another path or key/);
  assert.match(
    problems(ACTION, CI.replace(`hashFiles('${dir}/target/surefire-reports/TEST-*.xml') != ''`, 'true')),
    /did not run its Maven tests/,
  );
  assert.match(
    problems(
      ACTION.replace(
        "Restore sbe-codec's Maven repository\n      uses: actions/cache/restore@",
        "Restore sbe-codec's Maven repository\n      uses: actions/cache@",
      ),
    ),
    /restores no/,
  );
});
