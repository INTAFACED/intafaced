// Tests for api-budget.mjs: GitHub's spent hourly budget told apart from every other refusal, replayed on the real
// refusals of 13 Nov 2026 (run 43358106834, seal run 43358114181).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET_TITLE, budgetLine, httpMessage, isBudgetResponse, isBudgetText, titleFor } from './api-budget.mjs';
import { summarize } from './why-red.mjs';

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
