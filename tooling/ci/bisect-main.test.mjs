/**
 * bisect-main.mjs: the install retry, the binary search, the culprit's confirmation, the input parsing and the traced-red
 * writes against a stub GitHub. tooling-tests.mjs runs it with every other tooling test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOB_PROBES,
  SHA,
  confirmBlame,
  firstBad,
  installOrStop,
  noteTracedRed,
  parseJobs,
  parseTests,
  splitTestPath,
} from './bisect-main.mjs';

test('the install: one flake is retried, two stop the search, and nothing counts the commit as failing', () => {
  let calls = 0;
  const flaky = () => ({ status: calls++ === 0 ? 1 : 0 });
  installOrStop(flaky);
  assert.ok(calls === 2, 'a single install flake is retried');
  let stopped = false;
  try {
    installOrStop(() => ({ status: 1 }));
  } catch (e) {
    stopped = /no culprit/.test(e.message);
  }
  assert.ok(stopped, 'an install that fails twice stops the search with no culprit');
});

test('the binary search finds each culprit of 13 commits in at most 4 probes; one commit needs no probe', () => {
  const commits = Array.from({ length: 13 }, (_, i) => `c${i}`);
  for (let culpritIdx = 0; culpritIdx < commits.length; culpritIdx++) {
    let calls = 0;
    const r = firstBad(commits, (sha) => {
      calls += 1;
      return Number(sha.slice(1)) >= culpritIdx;
    });
    assert.ok(r.culprit === commits[culpritIdx], `finds commit ${culpritIdx}, got ${r.culprit}`);
    assert.ok(calls <= 4, `13 commits take at most 4 probes, took ${calls} for ${culpritIdx}`);
  }
  assert.ok(firstBad(['only'], () => assert.ok(false, 'a single commit needs no probe')).culprit === 'only', 'one commit is the culprit');
});

test("the culprit's parent must pass on this runner before anyone is blamed", () => {
  const cs = ['c0', 'c1', 'c2'];
  let asked = [];
  const bad = (set) => (sha) => (asked.push(sha), set.includes(sha));
  let b = confirmBlame({ commits: cs, culprit: 'c1', probed: [{ sha: 'c1', bad: true }], good: 'g' }, bad(['c1', 'c2']));
  assert.ok(b.culprit === 'c1' && asked.join() === 'c0', 'a parent that passes here confirms the culprit');
  asked = [];
  b = confirmBlame({ commits: cs, culprit: 'c1', probed: [{ sha: 'c1', bad: true }], good: 'g' }, bad(['c0', 'c1', 'c2']));
  assert.ok(b.culprit === null && /fails here too/.test(b.why), 'a parent that fails here too blames no one');
  asked = [];
  b = confirmBlame({ commits: cs, culprit: 'c0', probed: [], good: 'g' }, bad(['g', 'c0', 'c1', 'c2']));
  assert.ok(b.culprit === null && asked.join() === 'g', 'the first commit is checked against the last green, probed here');
  asked = [];
  b = confirmBlame({ commits: cs, culprit: 'c2', probed: [{ sha: 'c1', bad: false }], good: 'g' }, bad(['c2']));
  assert.ok(b.culprit === 'c2' && asked.length === 0, 'a parent the search found passing costs no probe');
});

test('the inputs: test paths, shas and probed jobs; anything else is refused', () => {
  assert.ok(splitTestPath('services/svc-x/src/a.test.ts').join('|') === 'services/svc-x|src/a.test.ts', 'splits a test path');
  assert.ok(parseTests('services/svc-x/src/a.test.ts\npackages/y/b.spec.tsx').length === 2, 'parses a list');
  let threw = false;
  try {
    parseTests('services/svc-x/../../etc/passwd.test.ts');
  } catch {
    threw = true;
  }
  assert.ok(threw, 'a path with .. is refused');
  threw = false;
  try {
    parseTests('rm -rf /');
  } catch {
    threw = true;
  }
  assert.ok(threw, 'a non-path is refused');
  assert.ok(SHA.test('a'.repeat(40)) && !SHA.test('main'), 'only full shas are accepted');
  assert.ok(parseJobs('Doctrine gates').join() === 'Doctrine gates', 'a probed job is taken');
  assert.ok(parseJobs('Typecheck & build').join() === 'Typecheck & build', 'a build red is probed (ci.yml build job name)');
  assert.ok(JOB_PROBES['Typecheck & build'].join(' ') === 'sh -c pnpm build && pnpm typecheck', "the build job's own commands on main");
  assert.ok(parseJobs('').length === 0, 'no jobs is none');
  threw = false;
  try {
    parseJobs('Doctrine gates,rm -rf /');
  } catch {
    threw = true;
  }
  assert.ok(threw, 'a job with no probe is refused, so no input becomes a command');
});

test('a traced red comments on the "Main is red" issue, adds regression, then removes main-unknown-red', async () => {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = String(url).replace('https://api.github.com', '');
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : null });
    const json = path.startsWith('/search/issues') ? { items: [{ number: 7881, title: 'Main is red' }] } : {};
    return new Response(JSON.stringify(json), { status: init.method === 'DELETE' ? 200 : 201 });
  };
  try {
    assert.ok((await noteTracedRed('o/r', 'culprit body')) === 7881, 'the open "Main is red" issue is found');
  } finally {
    globalThis.fetch = real;
  }
  const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body)}`);
  assert.ok(
    JSON.stringify(writes) ===
      JSON.stringify([
        'POST /repos/o/r/issues/7881/comments {"body":"culprit body"}',
        'POST /repos/o/r/issues/7881/labels {"labels":["regression"]}',
        'DELETE /repos/o/r/issues/7881/labels/main-unknown-red null',
      ]),
    `a traced red comments, adds regression, then removes main-unknown-red; got ${JSON.stringify(writes)}`,
  );
});
