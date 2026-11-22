import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { countLine } from './api-count.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('countLine names the script, its mode words and its own count; nothing when it made no call', () => {
  const argv = ['/usr/bin/node', '/home/runner/work/intafaced/intafaced/tooling/ci/journey-seal.mjs', '--recheck'];
  assert.equal(countLine({ calls: 0, remaining: null }, argv), null);
  assert.equal(
    countLine({ calls: 17, remaining: 9120 }, argv),
    'GitHub API calls by tooling/ci/journey-seal.mjs --recheck: 17 (budget remaining 9120 at the last answer)',
  );
  const judge = ['node', 'tooling/ci/judge-down.mjs', 'down', 'CI review', 'issue', '/tmp/x/y'];
  assert.equal(countLine({ calls: 3, remaining: null }, judge), 'GitHub API calls by tooling/ci/judge-down.mjs down CI review issue: 3');
});

test("the line goes to stderr once at exit, after process.exit(1) too, with the last answer's remaining budget; stdout stays the script's own", () => {
  const mod = pathToFileURL(join(here, 'api-count.mjs')).href;
  const script = `import { countCall } from '${mod}';
countCall(new Response('', { headers: { 'x-ratelimit-remaining': '41' } }));
countCall();
countCall(new Response('', { headers: { 'x-ratelimit-remaining': '39' } }));
console.log(JSON.stringify({ done: true }));
process.exit(1);`;
  let out = '';
  let err = '';
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = e.stdout;
    err = e.stderr;
  }
  // A caller that parses the script's stdout (journey-touch.mjs --json in real-app-journeys.yml) still reads it whole.
  assert.deepEqual(JSON.parse(out), { done: true });
  const lines = err.trim().split('\n');
  assert.match(lines.at(-1), /: 3 \(budget remaining 39 at the last answer\)$/);
  assert.equal(lines.filter((l) => l.startsWith('GitHub API calls by')).length, 1);
});

/** A script that calls GitHub's REST API itself: fetch to api.github.com, or `gh api`, `gh run`, `gh pr`, `gh issue`. */
export const callsGithub = (text) =>
  (text.includes('api.github.com') && /(^|[^.\w])fetch\(/m.test(text)) ||
  /execFileSync\(\s*'gh'|execFile\(\s*'gh'|run\('gh'|\bgh api "repos/m.test(text);
/** It counts each call: it imports countCall. (A script that reads only through githubFetch, which counts, calls neither.) */
export const counts = (text) => /from '\.\/api-count\.mjs'/.test(text);

// Spend no call of the workflow token's budget, so they have nothing to count: app-token.mjs reads with the App's own
// token (a budget of its own), and api-budget.mjs reads only `gh api rate_limit`, which GitHub does not count.
const UNCOUNTED = new Set(['app-token.mjs', 'api-budget.mjs']);

test('#3718: every tooling/ci script that calls GitHub counts its calls (api-count.mjs countCall)', () => {
  const scripts = readdirSync(here).filter((f) => f.endsWith('.mjs') && !/\.(test|mutation)\.mjs$/.test(f) && !UNCOUNTED.has(f));
  const uncounted = scripts.filter((f) => {
    const text = readFileSync(join(here, f), 'utf8');
    return callsGithub(text) && !counts(text);
  });
  assert.deepEqual(uncounted, [], `count each GitHub call with countCall from tooling/ci/api-count.mjs: ${uncounted.join(', ')}`);
});

test('#3718 replayed: main-trust.mjs before this change, calling GitHub uncounted, fails the check', () => {
  // main-trust.mjs at 8d61182a06: its gh() called fetch on API = 'https://api.github.com' and counted nothing.
  const before =
    "export const API = 'https://api.github.com';\nasync function gh(method, path, body) {\n  const res = await fetch(API + path, {";
  assert.equal(callsGithub(before) && !counts(before), true);
  const after = `import { countCall } from './api-count.mjs';\n${before}`;
  assert.equal(callsGithub(after) && !counts(after), false);
  // shard-download.mjs's artifact zips: gh api inside its bash script.
  assert.equal(callsGithub('gh api "repos/$0/actions/artifacts/$2/zip"'), true);
});
