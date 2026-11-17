/**
 * refusal.mjs: a 403 or 429 stop line keeps GitHub's own reason. The planted case is #8202 (13 Nov 2026), whose stop
 * line read only "GitHub 403 on GET …/runs?branch=main&per_page=100", so nobody could read the refusal it asked for.
 * Run by tooling/scripts/tooling-tests.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refusalDetail } from './refusal.mjs';
import { isRefusal } from './journeys-revive.mjs';

const SECONDARY = JSON.stringify({
  message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
  documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api',
});

test('a secondary rate limit names itself, its retry-after and its request id', () => {
  const headers = new Headers({ 'retry-after': '60', 'x-github-request-id': 'ABCD:1234' });
  assert.equal(
    refusalDetail(headers, SECONDARY),
    ' (GitHub: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.; retry-after 60s; request ABCD:1234)',
  );
});

test('a spent primary limit says how much is left and when it resets', () => {
  const headers = new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1794540585' });
  const d = refusalDetail(headers, JSON.stringify({ message: 'API rate limit exceeded for installation ID 1.' }));
  assert.equal(
    d,
    ` (GitHub: API rate limit exceeded for installation ID 1.; rate limit remaining 0, resets ${new Date(1794540585e3).toISOString()})`,
  );
});

test('a missing permission is told apart from a limit', () => {
  const d = refusalDetail(
    new Headers({ 'x-ratelimit-remaining': '4321' }),
    JSON.stringify({ message: 'Resource not accessible by integration' }),
  );
  assert.match(d, /Resource not accessible by integration; rate limit remaining 4321/);
});

test('a body that is not JSON is kept on one line, cut short; nothing to say is empty', () => {
  assert.equal(refusalDetail(new Headers(), 'blocked\n  by\tproxy'), ' (GitHub: blocked by proxy)');
  assert.equal(refusalDetail(new Headers(), 'x'.repeat(500)).length, ' (GitHub: )'.length + 200);
  assert.equal(refusalDetail(new Headers(), ''), '');
  assert.equal(refusalDetail(undefined, undefined), '');
});

test('the longer stop line is still a refusal, so the tick still stops and is never retried', () => {
  const line = `GitHub 403 on GET /repos/x/actions/workflows/real-app-journeys.yml/runs?branch=main&per_page=100: stopping, not retrying${refusalDetail(new Headers({ 'retry-after': '60' }), SECONDARY)}`;
  assert.equal(isRefusal(new Error(line)), true);
});
