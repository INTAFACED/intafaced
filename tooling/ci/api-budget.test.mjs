// Tests for api-budget.mjs: GitHub's spent hourly budget told apart from every other refusal, replayed on the real
// refusals of 13 Nov 2026 (Gate-file guard run 43358106834, seal run 43358114181).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BUDGET_MARK, BUDGET_TITLE, httpMessage, isBudgetResponse, isBudgetText, titleFor } from './api-budget.mjs';
import { summarize } from './why-red.mjs';

const answer = (status, headers = {}) => ({ status, ok: false, headers: new Headers(headers) });
// The words `gh` printed in Gate-file guard run 43358106834 at 03:18:58 UTC on 13 Nov (request id left out).
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

test('the Gate-file guard names the spent budget in an annotation, replayed on run 43358106834', () => {
  // A stand-in gh that answers as GitHub did, so the real guard runs end to end.
  const dir = mkdtempSync(join(tmpdir(), 'api-budget-'));
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh\necho '${GH_REFUSAL}' >&2\nexit 1\n`);
  chmodSync(gh, 0o755);
  const guard = fileURLToPath(new URL('../scripts/gate-file-guard.mjs', import.meta.url));
  const run = (path) =>
    spawnSync(process.execPath, [guard, '--pr', '8203', '--title', 'fix: x', '--repo', 'INTAFACED/intafaced'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...path },
    });
  const r = run();
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, new RegExp(`::error title=${BUDGET_TITLE}::gate-file-guard: ${BUDGET_MARK}`));
  // why-red reads that annotation as JUDGE DOWN, not RED.
  const ann = /::error title=(.+?)::(.*)/.exec(r.stderr);
  const v = summarize({
    sha: 'e'.repeat(40),
    checks: [{ id: 1, name: 'Gate-file guard', status: 'completed', conclusion: 'failure' }],
    annotations: { 1: [{ annotation_level: 'failure', title: ann[1], message: ann[2] }] },
    failedSteps: {},
    statuses: [],
    runs: {},
  });
  assert.match(v.at(-1), /^JUDGE DOWN:/);
  // A planted fault: a permission refusal prints no budget annotation and stays a plain refusal.
  writeFileSync(gh, `#!/bin/sh\necho 'HTTP 403: Resource not accessible by integration' >&2\nexit 1\n`);
  const p = run();
  assert.equal(p.status, 3);
  assert.doesNotMatch(p.stderr, /judge down/);
});
