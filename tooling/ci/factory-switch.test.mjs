// The planted cases of the factory switch (factory-switch.mjs): only `run` passes; `pause`, blank, other text and any
// unreadable answer fail closed. tooling-tests.mjs runs this file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeSwitch, readSwitch, switchProblem, sweep, sweepHead, sweepWants } from './factory-switch.mjs';

test('run passes, with or without a trailing newline', () => {
  assert.equal(judgeSwitch('run').pass, true);
  assert.equal(judgeSwitch('run\n').pass, true);
});

test('pause, blank and any other text fail', () => {
  for (const t of ['pause', 'pause\n', '', '   ', 'Run', 'RUN', 'running', 'run\npause', 'paused', undefined, null]) {
    assert.equal(judgeSwitch(t).pass, false, JSON.stringify(t));
  }
  assert.match(judgeSwitch('pause\n').why, /says "pause", not "run"/);
  assert.doesNotMatch(judgeSwitch('pause\n::warning::x').why, /\n/);
});

test('reads the raw file on the factory-switch branch', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, text: async () => 'run\n' };
  };
  assert.equal(await readSwitch({ repo: 'o/r', token: 't', fetchImpl }), 'run\n');
  assert.equal(seen.url, 'https://api.github.com/repos/o/r/contents/FACTORY?ref=factory-switch');
  assert.equal(seen.init.headers.accept, 'application/vnd.github.raw');
});

test('a missing branch or file, or any refusal, throws so the seal fails closed', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const fetchImpl = async () => ({ ok: false, status, text: async () => 'run' });
    await assert.rejects(readSwitch({ repo: 'o/r', token: 't', fetchImpl }), new RegExp(`HTTP ${status}`));
  }
});

const seal = (conclusion, failedStep) => ({
  id: 9,
  name: 'CI merge seal',
  status: 'completed',
  conclusion,
  steps: failedStep ? [{ name: failedStep, conclusion: 'failure' }] : [],
});

test('a pause re-runs every green seal; a run re-runs only seals that failed on the switch', () => {
  assert.equal(sweepWants(true, seal('success')), true);
  assert.equal(sweepWants(true, seal('failure', 'Require needed jobs')), false);
  assert.equal(sweepWants(false, seal('failure', 'The factory switch says run')), true);
  assert.equal(sweepWants(false, seal('failure', 'Require the named journey steps on this exact head')), true);
  assert.equal(sweepWants(false, seal('failure', 'Require the CI review on this exact head')), false);
  assert.equal(sweepWants(false, seal('success')), false);
});

function fakeApi({ runStatus = 'completed', job, rerunStatus = 201 }) {
  const posted = [];
  let reads = 0;
  return {
    posted,
    get: async (path) => {
      if (path.includes('/runs?head_sha=')) {
        reads++;
        return { workflow_runs: [{ id: 7, event: 'pull_request', status: reads > 1 ? 'completed' : runStatus }] };
      }
      if (path.includes('/runs/7/jobs')) return { jobs: [job] };
      throw new Error(`unexpected ${path}`);
    },
    post: async (path) => {
      posted.push(path);
      return { status: rerunStatus, message: '' };
    },
  };
}

test('sweepHead re-runs a green seal on a pause, and leaves it on a run', async () => {
  const a = fakeApi({ job: seal('success') });
  assert.match(await sweepHead({ repo: 'o/r', sha: 'a', paused: true, ...a, sleep: async () => {} }), /re-ran the success seal/);
  assert.deepEqual(a.posted, ['/repos/o/r/actions/jobs/9/rerun']);
  const b = fakeApi({ job: seal('success') });
  assert.match(await sweepHead({ repo: 'o/r', sha: 'a', paused: false, ...b, sleep: async () => {} }), /left as it is/);
  assert.deepEqual(b.posted, []);
});

test('sweepHead waits out a run that is still finishing, then re-runs', async () => {
  const a = fakeApi({ runStatus: 'in_progress', job: seal('success') });
  let slept = 0;
  await sweepHead({ repo: 'o/r', sha: 'a', paused: true, ...a, sleep: async () => slept++ });
  assert.equal(slept, 1);
  assert.equal(a.posted.length, 1);
});

test('a refused re-run fails the sweep for that head', async () => {
  const a = fakeApi({ job: seal('success'), rerunStatus: 403 });
  await assert.rejects(sweepHead({ repo: 'o/r', sha: 'a', paused: true, ...a, sleep: async () => {} }), /HTTP 403/);
});

test('sweep reports a head it could not sweep and fails', async () => {
  const get = async (path) => {
    if (path.includes('/pulls?')) return [{ number: 1, head: { sha: 'a' } }];
    throw new Error('HTTP 500');
  };
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    assert.equal(
      await sweep({ repo: 'o/r', base: 'main', paused: true, get, post: async () => ({}), sleep: async () => {}, log: () => {} }),
      false,
    );
  } finally {
    console.error = orig;
  }
  assert.match(errors[0], /Not swept::#1: HTTP 500/);
});

// What the seal and the sweep act on (factory-switch.mjs main, journey-seal.mjs): a refused or unreadable read must be
// a problem, never a pass, or a broken read would let every pull request through while the factory is paused.
test('switchProblem: only a readable `run` is no problem; a refused, unreadable or thrown read fails closed', async () => {
  const answer = (status, text) => async () => ({ ok: status === 200, status, text: async () => text });
  assert.equal(await switchProblem({ repo: 'o/r', token: 't', fetchImpl: answer(200, 'run\n') }), null);
  assert.equal((await switchProblem({ repo: 'o/r', token: 't', fetchImpl: answer(200, 'pause\n') }))?.title, 'Factory paused');
  for (const status of [401, 403, 404, 429, 500]) {
    const p = await switchProblem({ repo: 'o/r', token: 't', fetchImpl: answer(status, 'run') });
    assert.equal(p?.title, 'Factory switch unreadable', `HTTP ${status}`);
    assert.match(p.why, new RegExp(`HTTP ${status}.*fails closed`));
  }
  const thrown = await switchProblem({
    repo: 'o/r',
    token: 't',
    fetchImpl: async () => {
      throw new Error('connect ETIMEDOUT');
    },
  });
  assert.equal(thrown?.title, 'Factory switch unreadable');
  const badBody = await switchProblem({
    repo: 'o/r',
    token: 't',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('body cut off');
      },
    }),
  });
  assert.equal(badBody?.title, 'Factory switch unreadable');
});
