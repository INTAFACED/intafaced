// Tests for api-budget.mjs: GitHub's spent hourly budget told apart from every other refusal, replayed on the real
// refusals of 13 Nov 2026 (run 43358106834, seal run 43358114181).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET_TITLE, budgetLine, httpMessage, isBudgetResponse, isBudgetText, titleFor } from './api-budget.mjs';
import { summarize } from './why-red.mjs';
import { readFileSync } from 'node:fs';

const answer = (status, headers = {}) => ({ status, ok: false, headers: new Headers(headers) });
// The words `gh` printed in run 43358106834 at 03:18:58 UTC on 13 Nov (request id left out).
const GH_REFUSAL =
  'gh: API rate limit exceeded for installation. If you reach out to GitHub Support for help, please include the request ID and timestamp 2026-11-13 03:18:58 UTC. (HTTP 403)';

test('a 403 or 429 with no calls remaining is the spent budget; every other refusal is not', () => {
  assert.equal(isBudgetResponse(answer(403, { 'x-ratelimit-remaining': '0' })), true);
  assert.equal(isBudgetResponse(answer(429, { 'x-ratelimit-remaining': '0' })), true);
  assert.equal(isBudgetResponse(answer(403, { 'x-ratelimit-remaining': '4120' })), false, 'a permission 403 keeps calls');
  assert.equal(isBudgetResponse(answer(403)), false, 'no header, no claim');
  assert.equal(isBudgetResponse(answer(404, { 'x-ratelimit-remaining': '0' })), false);
  assert.equal(isBudgetText(GH_REFUSAL), true);
  assert.equal(isBudgetText('You have exceeded a secondary rate limit'), false);
  assert.equal(isBudgetText('HTTP 403: Resource not accessible by integration'), false);
});

test('the seal says judge down with the reset, replayed on run 43358114181', () => {
  // The seal's read of #8203 at 03:18 UTC: 403, nothing remaining, the budget back at 03:20:08 UTC.
  const res = answer(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.parse('2026-11-13T03:20:08Z') / 1000) });
  const m = httpMessage('/repos/INTAFACED/intafaced/pulls/8203', res);
  assert.match(
    m,
    /^GET \/repos\/INTAFACED\/intafaced\/pulls\/8203: HTTP 403; judge down: GitHub's hourly API budget is spent until 03:20 UTC/,
  );
  assert.equal(titleFor(m, 'Named journey steps unreadable'), BUDGET_TITLE);
  // A planted fault: the same 403 with calls left (a missing permission) keeps the old words and title.
  const perm = httpMessage('/repos/INTAFACED/intafaced/pulls/8203', answer(403, { 'x-ratelimit-remaining': '4120' }));
  assert.equal(perm, 'GET /repos/INTAFACED/intafaced/pulls/8203: HTTP 403');
  assert.equal(titleFor(perm, 'Named journey steps unreadable'), 'Named journey steps unreadable');
});

test('why-red reads a spent-budget annotation as JUDGE DOWN, replayed on the words of run 43358106834', () => {
  // The annotation a gate script prints when gh refuses for the spent budget (the Gate-file guard printed it, until it was
  // removed on 15 Nov 2026; the seal's scripts print the same title).
  const read = (message) =>
    summarize({
      sha: 'e'.repeat(40),
      checks: [{ id: 1, name: 'CI merge seal', status: 'completed', conclusion: 'failure' }],
      annotations: { 1: [{ annotation_level: 'failure', title: titleFor(message, 'Review sign-off unreadable'), message }] },
      failedSteps: {},
      statuses: [],
      runs: {},
    }).at(-1);
  assert.equal(isBudgetText(GH_REFUSAL), true);
  assert.match(read(`${GH_REFUSAL}; ${budgetLine()}`), /^JUDGE DOWN:/);
  // The annotation's form, as the guard's end-to-end replay pinned it: the budget's own title, and the mark in its message.
  assert.equal(titleFor(`${GH_REFUSAL}; ${budgetLine()}`, 'Review sign-off unreadable'), BUDGET_TITLE);
  assert.equal(titleFor('HTTP 403: Resource not accessible by integration', 'Review sign-off unreadable'), 'Review sign-off unreadable');
  // A planted fault: a permission refusal carries no budget words and stays a red of its own.
  assert.doesNotMatch(read('HTTP 403: Resource not accessible by integration'), /^JUDGE DOWN:/);
});

// The wait (22 Nov 2026): run 44981346475's third attempt (#9601) read FACTORY at 04:15 UTC, the budget spent until 04:22.
// A merge seal's job (API_BUDGET_WAIT_MIN 15) waits for that reset and asks once more; past 15 minutes, or still spent
// after the wait, it fails closed with the same words.
const RESET_0422 = Date.parse('2026-11-22T04:22:00Z') / 1000;
const AT_0415 = Date.parse('2026-11-22T04:15:15Z');

test('a reset at most API_BUDGET_WAIT_MIN away is waited for; a further one, or none allowed, is not', async () => {
  const { resetWait, RESET_SLACK_MS } = await import('./api-budget.mjs');
  assert.equal(resetWait(RESET_0422, { now: AT_0415, maxMin: 15 }), Date.parse('2026-11-22T04:22:00Z') - AT_0415 + RESET_SLACK_MS);
  assert.equal(resetWait(RESET_0422, { now: Date.parse('2026-11-22T04:06:59Z'), maxMin: 15 }), null, '15 min 1 s away: no wait');
  assert.equal(resetWait(RESET_0422, { now: AT_0415, maxMin: NaN }), null, 'a step that sets no wait never waits');
  assert.equal(resetWait(undefined, { now: AT_0415, maxMin: 15 }), null, 'no reset named, no wait');
  assert.equal(
    resetWait(RESET_0422, { now: Date.parse('2026-11-22T04:23:00Z'), maxMin: 15 }),
    RESET_SLACK_MS,
    'a past reset asks again at once',
  );
});

const spent = (reset) =>
  new Response('{"message":"API rate limit exceeded for installation"}', {
    status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
  });

test('githubFetch waits for a reset 7 minutes away and asks once more, replayed on run 44981346475', async () => {
  const { githubFetch } = await import('./github-fetch.mjs');
  const real = globalThis.fetch;
  const env = { ...process.env };
  const answers = [spent(RESET_0422), new Response('{"ok":true}', { status: 200 })];
  const asked = [];
  const slept = [];
  globalThis.fetch = async (url) => (asked.push(String(url)), answers.shift());
  process.env.GH_TOKEN = 'test-token-not-real';
  process.env.API_BUDGET_WAIT_MIN = '15';
  try {
    const res = await githubFetch(
      'https://api.github.com/repos/o/r/contents/FACTORY?ref=factory-switch',
      {},
      {
        sleep: async (ms) => slept.push(ms),
        now: () => AT_0415,
      },
    );
    assert.equal(res.status, 200);
    assert.equal(asked.length, 2, 'asked once more after the wait');
    assert.equal(slept.length, 1);
    assert.ok(slept[0] > 6 * 60_000 && slept[0] < 7 * 60_000, `waited ${slept[0]} ms`);
    // Still spent after the wait: the second answer stands, so the caller fails closed with the budget's words.
    answers.push(spent(RESET_0422), spent(RESET_0422));
    const still = await githubFetch('https://api.github.com/repos/o/r/pulls/9601', {}, { sleep: async () => {}, now: () => AT_0415 });
    assert.equal(still.status, 403);
    assert.match(httpMessage('/repos/o/r/pulls/9601', still), /judge down: GitHub's hourly API budget is spent until 04:22 UTC/);
    assert.equal(asked.length, 4, 'once more, never a loop');
    // A reset 20 minutes away: no wait, the 403 at once (a planted fault for the 15-minute bound).
    answers.push(spent(RESET_0422));
    const far = await githubFetch(
      'https://api.github.com/repos/o/r/pulls/9601',
      {},
      {
        sleep: async () => assert.fail('no wait past 15 minutes'),
        now: () => Date.parse('2026-11-22T04:02:00Z'),
      },
    );
    assert.equal(far.status, 403);
    assert.equal(asked.length, 5);
  } finally {
    globalThis.fetch = real;
    process.env = env;
  }
});

test('a gh read in the seal (journey-verdict.mjs) waits for a near reset once, and a refusal that is not the budget never waits', async () => {
  const { budgetRetry } = await import('./journey-verdict.mjs');
  const refusal = (stderr) => Object.assign(new Error('Command failed: gh api'), { stderr });
  const waited = [];
  let calls = 0;
  const near = () => ({ ms: 400_000, reset: RESET_0422 });
  const got = budgetRetry(
    () => {
      if (++calls === 1) throw refusal(GH_REFUSAL);
      return 'read';
    },
    { wait: (ms) => waited.push(ms), waitFor: (s) => (isBudgetText(s) ? near() : null), log: () => {} },
  );
  assert.equal(got, 'read');
  assert.deepEqual(waited, [400_000]);
  // Still spent after the wait: the second error stands.
  calls = 0;
  assert.throws(
    () =>
      budgetRetry(
        () => {
          calls++;
          throw refusal(GH_REFUSAL);
        },
        { wait: () => {}, waitFor: near, log: () => {} },
      ),
    /Command failed/,
  );
  assert.equal(calls, 2);
  // A permission refusal is not the budget: thrown at once, no wait (the real ghResetWait reads its words).
  calls = 0;
  assert.throws(
    () =>
      budgetRetry(
        () => {
          calls++;
          throw refusal('HTTP 403: Resource not accessible by integration');
        },
        { wait: () => assert.fail('no wait'), log: () => {} },
      ),
    /Command failed/,
  );
  assert.equal(calls, 1);
});

test('the merge seal job allows the wait, and its time limit holds it', () => {
  const yml = readFileSync(new URL('../../.github/workflows/merge-seal.yml', import.meta.url), 'utf8');
  const seal = yml.slice(yml.indexOf('\n  seal:'));
  assert.match(seal, /\n    env:\n      API_BUDGET_WAIT_MIN: 15\n/);
  assert.ok(Number(/\n    timeout-minutes: (\d+)/.exec(seal)?.[1]) >= 60 + 20 + 15, 'the inputs, the review and one wait');
});
