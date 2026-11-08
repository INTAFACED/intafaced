import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rerunSeal, sealStep } from './seal-rerun.mjs';

// The cases review-signoff.mjs --self-test held for these, moved unchanged with the code (U4 C5).
test('sealStep and rerunSeal: wait out a running seal, re-run a red one once, fail loudly otherwise', async () => {
  const SEAL = 'CI merge seal';
  const head = 'a'.repeat(40);
  const run = (over) => ({
    id: 2,
    name: SEAL,
    status: 'completed',
    conclusion: 'failure',
    details_url: 'https://github.com/o/r/actions/runs/77/job/2',
    ...over,
  });
  assert.ok(sealStep([], undefined).act === 'done', 'no seal yet: it will read the review itself');
  assert.ok(sealStep([run({ status: 'queued', conclusion: null })], undefined).act === 'done', 'a queued seal reads the review itself');
  assert.ok(
    sealStep([run({ status: 'in_progress', conclusion: null })], undefined).act === 'wait',
    'a running seal may have read too early: wait',
  );
  assert.ok(sealStep([run({ conclusion: 'success' })], undefined).act === 'done', 'a green seal needs nothing');
  assert.ok(sealStep([run()], undefined).act === 'run' && sealStep([run()], undefined).runId === '77', 'a red seal names its run');
  assert.ok(sealStep([run()], 'in_progress').act === 'wait', 'a red seal whose run is still finishing: wait');
  assert.ok(sealStep([run()], 'completed').act === 'rerun', 'a red seal in a finished run is re-run');
  assert.ok(sealStep([run({ details_url: '' })], 'completed').act === 'fail', 'a red seal without a run is an error, not silence');
  assert.ok(
    sealStep([run({ id: 1, conclusion: 'success' }), run({ id: 3 })], 'completed').act === 'rerun' &&
      sealStep([run({ id: 3, conclusion: 'success' }), run({ id: 1 })], 'completed').act === 'done',
    'the newest seal check run decides',
  );
  assert.ok(sealStep([run({ name: 'Format' })], undefined).act === 'done', 'other checks are ignored');

  // The loop, against a scripted API: each call takes the next answer for its path.
  const fake = (answers) => {
    const calls = [];
    const api = async (method, path) => {
      calls.push(`${method} ${path.replace(/\?.*/, '')}`);
      const key = Object.keys(answers).find((k) => `${method} ${path}`.includes(k));
      const a = answers[key];
      return Array.isArray(a) ? a.shift() : a;
    };
    return { api, calls, opts: { api, sleep: async () => {}, log: () => {} } };
  };
  const cr = (...runs) => ({ status: 200, json: { check_runs: runs } });
  const running = run({ status: 'in_progress', conclusion: null });
  let f = fake({
    'check-runs': [cr(running), cr(running), cr(run())],
    'GET /repos/o/r/actions/runs/77': { status: 200, json: { status: 'completed' } },
    'rerun-failed-jobs': { status: 201 },
  });
  assert.ok((await rerunSeal('o/r', head, f.opts)) === 're-ran the failed jobs of run 77', 'waits out a running seal, then re-runs it red');
  assert.ok(f.calls.filter((c) => c.includes('rerun')).length === 1, 'one re-run');
  f = fake({
    'check-runs': cr(run()),
    'GET /repos/o/r/actions/runs/77': { status: 200, json: { status: 'completed' } },
    'rerun-failed-jobs': { status: 403 },
  });
  assert.ok((await rerunSeal('o/r', head, f.opts)) === 'run 77 is already re-running', 'someone else re-ran it first');
  const rejects = (p, msg) => assert.rejects(p, undefined, msg);
  await rejects(rerunSeal('o/r', head, fake({ 'check-runs': cr(running) }).opts), 'a seal that never finishes fails the job');
  await rejects(rerunSeal('o/r', head, fake({ 'check-runs': { status: 404, json: {} } }).opts), 'an unreadable check list fails the job');
  await rejects(
    rerunSeal(
      'o/r',
      head,
      fake({
        'check-runs': cr(run()),
        'GET /repos/o/r/actions/runs/77': { status: 200, json: { status: 'completed' } },
        'rerun-failed-jobs': { status: 500 },
      }).opts,
    ),
    'a refused re-run fails the job',
  );
  f = fake({ 'check-runs': cr(run({ conclusion: 'success' })) });
  assert.ok(
    (await rerunSeal('o/r', head, f.opts)) === 'the seal is already green' && f.calls.length === 1,
    'a green seal: one read, nothing else',
  );
});

test("a pull request whose head moved is not re-sealed: a re-run would cancel the new head's CI (8 Nov, 3dbe29e7)", async () => {
  const old = 'e'.repeat(40);
  const posted = [];
  const api = async (method, path) => {
    if (path.endsWith('/pulls/7')) return { status: 200, json: { state: 'open', head: { sha: 'f'.repeat(40) } } };
    if (path.includes('/check-runs'))
      return {
        status: 200,
        json: {
          check_runs: [
            { id: 1, name: 'CI merge seal', status: 'completed', conclusion: 'failure', details_url: 'https://x/actions/runs/9/job/1' },
          ],
        },
      };
    if (method === 'POST') return (posted.push(path), { status: 201 });
    return { status: 200, json: { status: 'completed' } };
  };
  const msg = await rerunSeal('o/r', old, { api, number: 7, sleep: async () => {}, log: () => {} });
  assert.match(msg, /^not re-run: #7 is open on f{10}/);
  assert.deepEqual(posted, [], 'nothing re-run');
  // Planted: the same head still on the pull request is re-run.
  const same = async (method, path) =>
    path.endsWith('/pulls/7') ? { status: 200, json: { state: 'open', head: { sha: old } } } : api(method, path);
  await rerunSeal('o/r', old, { api: same, number: 7, sleep: async () => {}, log: () => {} });
  assert.equal(posted.length, 1);
});

test('review 7553-R1/R2: the head moving while a running seal is waited out, or a closed pull request, re-runs nothing', async () => {
  const old = 'e'.repeat(40);
  for (const later of [
    { state: 'open', head: { sha: 'f'.repeat(40) } },
    { state: 'closed', head: { sha: old } },
  ]) {
    let reads = 0;
    const posted = [];
    const api = async (method, path) => {
      if (path.endsWith('/pulls/7')) return { status: 200, json: reads++ === 0 ? { state: 'open', head: { sha: old } } : later };
      if (path.includes('/check-runs')) {
        const status = reads === 0 ? 'in_progress' : 'completed'; // the seal is running at first, then finishes red
        return {
          status: 200,
          json: {
            check_runs: [
              {
                id: 1,
                name: 'CI merge seal',
                status,
                conclusion: status === 'completed' ? 'failure' : null,
                details_url: 'https://x/actions/runs/9/job/1',
              },
            ],
          },
        };
      }
      if (method === 'POST') return (posted.push(path), { status: 201 });
      return { status: 200, json: { status: 'completed' } };
    };
    // Each poll reads the check runs; the pull request is read only once the seal is ready to re-run.
    let polls = 0;
    const sleep = async () => {
      if (++polls === 1) reads = 1; // a push lands while the seal is waited out
    };
    const msg = await rerunSeal('o/r', old, { api, number: 7, sleep, log: () => {} });
    assert.match(msg, /^not re-run: #7 is /, msg);
    assert.deepEqual(posted, [], `${later.state}: nothing re-run`);
  }
});
