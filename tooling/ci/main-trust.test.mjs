/**
 * main-trust.mjs: the decision table, the parsers and the labels, then each issue-opening path of main() against a
 * stub GitHub. tooling-tests.mjs runs it with every other tooling test.
 */
import test from 'node:test';
import { API, decide, failingTestPaths, main, missingLabels, ownerFor, probedJobs, redShas, settlesRed } from './main-trust.mjs';

const eq = (got, want, m) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

test('the decision table, the probed jobs, the red shas, the failing test paths, the owner and the labels', () => {
  eq(decide({ conclusion: 'failure', attempt: 1 }), 'rerun', 'first red re-runs');
  eq(
    probedJobs([
      { name: 'Doctrine gates', conclusion: 'failure' },
      { name: 'Doctrine gates', conclusion: 'failure' },
      { name: 'Tests (shard 1)', conclusion: 'failure' },
      { name: 'Format', conclusion: 'success' },
    ]),
    ['Doctrine gates'],
    'a failed Doctrine gates job is probed by its command; a job with no probe is left to its test files',
  );
  eq(probedJobs([{ name: 'Doctrine gates', conclusion: 'success' }]), [], 'a green job is not probed');
  eq(
    probedJobs([
      { name: 'Typecheck & build', conclusion: 'failure' },
      { name: 'Tests (2/16)', conclusion: 'failure' },
    ]),
    ['Typecheck & build'],
    "main's build red (run 42828463480, 10 Nov) starts the bisect by its own command",
  );
  eq(decide({ conclusion: 'failure', attempt: 2 }), 'real-red', 'second red is real');
  eq(decide({ conclusion: 'success', attempt: 2 }), 'green-after-rerun', 'green after re-run');
  eq(decide({ conclusion: 'success', attempt: 1 }), 'green', 'plain green');
  eq(decide({ conclusion: 'cancelled', attempt: 1 }), 'ignore', 'cancelled ignored');
  eq(
    redShas(['Main failed twice on `46b3f74801` (x)', 'Main failed twice on `46b3f74801`', 'Main failed twice on `abcdef1234`']),
    ['46b3f74801', 'abcdef1234'],
    'red shas, deduped',
  );
  eq(redShas([null, 'nothing here']), [], 'no red named');
  eq(
    [settlesRed(['ahead', 'identical']), settlesRed(['ahead', 'behind']), settlesRed(['diverged']), settlesRed([])],
    [true, false, false, false],
    'a green settles only reds at or behind it',
  );
  const resolve = (rel, pkgs) => (pkgs.includes('svc-protocol') ? 'services/svc-protocol' : 'packages/x');
  eq(
    failingTestPaths(
      ['Run tests', 'Failing: Failed:    svc-protocol#test; FAIL  src/lending/a.onchain.test.ts > S > cascade; FAIL  src/b.test.ts > x;'],
      resolve,
    ),
    ['services/svc-protocol/src/b.test.ts', 'services/svc-protocol/src/lending/a.onchain.test.ts'],
    'parses the Failing step',
  );
  eq(failingTestPaths(['Why: AssertionError: x'], resolve), [], 'other steps ignored');
  eq(ownerFor('services/svc-a/x.test.ts', { 'services/svc-a/': 'alice' }, 'bob'), 'alice', 'override wins');
  eq(ownerFor('services/svc-b/x.test.ts', { 'services/svc-a/': 'alice' }, 'bob'), 'bob', 'last committer otherwise');
  eq(ownerFor('x.test.ts', {}, null), null, 'unknown owner stays null');
  eq(missingLabels([], ['main-unknown-red'], ['main-unknown-red', 'regression']), ['main-unknown-red'], 'a bare issue gets its label');
  eq(
    missingLabels([{ name: 'regression' }], ['main-unknown-red'], ['main-unknown-red', 'regression']),
    [],
    'a traced red keeps regression',
  );
});

// The labels go in the request that opens the issue, so no issue ever exists bare, and an open issue missing its label
// gets it on the next red.
test('each issue-opening path of main() opens its issue labelled, against a stub GitHub', async () => {
  const sha = 'a'.repeat(40);
  async function run(env, { jobs, openIssue = null, rejectAssignee = false }) {
    const calls = [];
    const realFetch = globalThis.fetch;
    const realEnv = { ...process.env };
    const realLog = console.log;
    globalThis.fetch = async (url, init) => {
      const path = String(url).replace(API, '');
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ method: init.method, path, body });
      const reply = (status, json) => new Response(json === undefined ? '' : JSON.stringify(json), { status });
      if (path.includes('/jobs?')) return reply(200, { jobs });
      if (path.startsWith('/search/issues')) return reply(200, { items: openIssue ? [openIssue] : [] });
      if (path === '/repos/o/r/issues' && init.method === 'POST')
        return body.assignees?.length && rejectAssignee ? reply(422, { message: 'Validation Failed' }) : reply(201, { number: 9001 });
      if (path.includes('/git/ref/heads/last-green')) return reply(200, { object: { sha } });
      if (path.includes('/commits?path=')) return reply(200, [{ author: { login: 'github-actions[bot]' }, commit: { message: 'x (#1)' } }]);
      return reply(init.method === 'GET' ? 200 : 201, {});
    };
    Object.assign(process.env, { GITHUB_REPOSITORY: 'o/r', RUN_ID: '1', HEAD_SHA: sha, GH_TOKEN: 't', ...env });
    console.log = () => {};
    try {
      await main();
    } finally {
      globalThis.fetch = realFetch;
      process.env = realEnv;
      console.log = realLog;
    }
    return calls
      .filter((c) => c.method !== 'GET' && !c.path.includes('/dispatches'))
      .map((c) => [c.method, c.path, c.body?.labels ?? null]);
  }
  const red = { CONCLUSION: 'failure', RUN_ATTEMPT: '2' };
  // A red with no "Failing:" step names no test file, and the issue still opens labelled.
  const noFile = [{ name: 'Format', conclusion: 'failure', steps: [{ name: 'Run prettier' }] }];
  eq(
    await run(red, { jobs: noFile }),
    [['POST', '/repos/o/r/issues', ['main-unknown-red']]],
    'a red naming no test file opens "Main is red" as main-unknown-red',
  );
  const named = [
    {
      name: 'Tests (shard 1)',
      conclusion: 'failure',
      steps: [{ name: 'Failing: Failed: x#test; FAIL  tooling/ci/main-trust.mjs.test.ts > a;' }],
    },
  ];
  eq(
    await run(red, { jobs: named }),
    [['POST', '/repos/o/r/issues', ['main-unknown-red']]],
    'a red naming a test file opens "Main is red" as main-unknown-red until the bisect names a merge',
  );
  eq(
    await run(red, { jobs: noFile, openIssue: { number: 7881, title: 'Main is red', labels: [] } }),
    [
      ['POST', '/repos/o/r/issues/7881/comments', null],
      ['POST', '/repos/o/r/issues/7881/labels', ['main-unknown-red']],
    ],
    'an open bare "Main is red" gets main-unknown-red on the next red',
  );
  eq(
    await run(red, { jobs: noFile, openIssue: { number: 7881, title: 'Main is red', labels: [{ name: 'regression' }] } }),
    [['POST', '/repos/o/r/issues/7881/comments', null]],
    'a "Main is red" the bisect traced keeps regression',
  );
  const flakyRun = { CONCLUSION: 'success', RUN_ATTEMPT: '2' };
  eq(
    (await run(flakyRun, { jobs: named, rejectAssignee: true })).filter((c) => c[1] === '/repos/o/r/issues'),
    [
      ['POST', '/repos/o/r/issues', ['flaky-test']],
      ['POST', '/repos/o/r/issues', ['flaky-test']],
    ],
    'a flaky unit test opens "Flaky on main" as flaky-test, kept when the owner cannot be assigned',
  );
});
