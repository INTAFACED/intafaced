/**
 * CI runs on one pinned runner image and gets nats-server one way, so main does not go red from a change outside the
 * repo (weed project-state#3065). `ubuntu-latest` moved to a newer Ubuntu under us and its newer pg_dump turned main red
 * (#7933, #7938); the nats image pulled from Docker Hub timed out under shard load (#7239).
 *
 * - Every `runs-on:` in a tracked workflow file names PINNED_RUNNER. Moving to a newer image is a one-line change here
 *   and in the workflows, made on purpose and proven on its PR.
 * - No workflow or action names a `nats:` image: the binary comes from .github/actions/nats-server (a pinned release,
 *   checked by SHA-256, kept in the Actions cache).
 *
 * Planted faults at the bottom prove each rule fails on the shape it forbids. Run by tooling/scripts/tooling-tests.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const PINNED_RUNNER = 'ubuntu-24.04';
const NATS_ACTION = './.github/actions/nats-server';

/** Each problem in one workflow or action file, as `file:line: what to write instead`. */
export function runnerFaults(text, file) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const code = line.replace(/(^|\s)#.*$/, '');
    const runsOn = /^\s*runs-on:\s*(.*?)\s*$/.exec(code);
    if (runsOn) {
      const value = runsOn[1].replace(/^['"]|['"]$/g, '');
      if (value !== PINNED_RUNNER)
        out.push(
          `${file}:${i + 1}: runs-on: ${runsOn[1] || '(a list or block)'} — write \`runs-on: ${PINNED_RUNNER}\` (tooling/ci/runner-pin.test.mjs PINNED_RUNNER); a floating or other image changes under main without a commit`,
        );
    }
    if (/(^|[\s'"/])nats:[\w.-]+/.test(code) && !/^\s*nats:\s*$/.test(code))
      out.push(
        `${file}:${i + 1}: a nats image — take the binary from \`uses: ${NATS_ACTION}\` (pinned, checksummed, cached), not a Docker Hub pull (#7239)`,
      );
  });
  return out;
}

function workflowFiles() {
  return execFileSync('git', ['ls-files', '*.yml', '*.yaml'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !f.includes('node_modules/'))
    .filter((f) => f.startsWith('.github/') || /^\s*runs-on:/m.test(readFileSync(f, 'utf8')));
}

test('every workflow runs on the pinned image and takes nats-server from the one action', () => {
  const files = workflowFiles();
  assert.ok(
    files.some((f) => f.startsWith('.github/workflows/')),
    'found no workflow files: wrong working directory?',
  );
  const faults = files.flatMap((f) => runnerFaults(readFileSync(f, 'utf8'), f));
  assert.deepEqual(faults, [], `\n${faults.join('\n')}`);
});

test('planted: a floating, other or list runner fails, naming the pinned image', () => {
  for (const planted of [
    'runs-on: ubuntu-latest',
    "runs-on: 'ubuntu-latest'",
    'runs-on: ubuntu-22.04',
    'runs-on: ${{ matrix.os }}',
    'runs-on: [ubuntu-latest]',
    'runs-on:',
  ]) {
    const faults = runnerFaults(`jobs:\n  a:\n    ${planted}\n`, 'w.yml');
    assert.equal(faults.length, 1, planted);
    assert.match(faults[0], /^w\.yml:3: .*runs-on: ubuntu-24\.04/, planted);
  }
  assert.deepEqual(runnerFaults('    runs-on: ubuntu-24.04 # pinned\n', 'w.yml'), []);
  assert.deepEqual(runnerFaults('    # runs-on: ubuntu-latest, never\n', 'w.yml'), []);
});

test('planted: a nats image from Docker Hub fails, naming the action', () => {
  for (const planted of [
    'docker create --name nats-src nats:2.10.24-alpine',
    'docker run -d -p 4222:4222 nats:2.10-alpine --jetstream',
    'image: nats:2.10-alpine',
    'image: docker.io/library/nats:2.10',
  ]) {
    const faults = runnerFaults(`      run: ${planted}\n`, 'w.yml');
    assert.equal(faults.length, 1, planted);
    assert.match(faults[0], /\.\/\.github\/actions\/nats-server/, planted);
  }
  assert.deepEqual(runnerFaults('  nats:\n    image: ghcr.io/x/y:1\n', 'w.yml'), []);
});
