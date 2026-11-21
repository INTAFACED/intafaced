import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { githubFetch, parseIncluded } from './github-fetch.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Runs `fn` with no token in the env and a stand-in `gh` on PATH that records its arguments and stdin. */
async function withFakeGh(reply, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  const log = join(dir, 'log.json');
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input }));
process.stdout.write(${JSON.stringify(reply)});
`,
  );
  chmodSync(join(dir, 'gh'), 0o755);
  const saved = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    return await fn(() => JSON.parse(readFileSync(log, 'utf8')));
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('gh api -i output reads as a Response: status, headers and the body as it is', async () => {
  const res = parseIncluded(Buffer.from('HTTP/2.0 404 Not Found\r\nX-Ratelimit-Remaining: 4999\r\n\r\n{"message":"Not Found"}'));
  assert.equal(res.status, 404);
  assert.equal(res.ok, false);
  assert.equal(res.headers.get('x-ratelimit-remaining'), '4999');
  assert.deepEqual(await res.json(), { message: 'Not Found' });
  const bin = Buffer.concat([Buffer.from('HTTP/2.0 200 OK\r\n\r\n'), Buffer.from([0x50, 0x4b, 0x00, 0xff, 0x0d, 0x0a])]);
  assert.deepEqual([...Buffer.from(await parseIncluded(bin).arrayBuffer())], [0x50, 0x4b, 0x00, 0xff, 0x0d, 0x0a]);
  assert.throws(() => parseIncluded(Buffer.from('gh: not logged in')), /no HTTP status/);
});

test('#3160: with no token a call goes through gh, which signs in itself; no token on the command line', async () => {
  await withFakeGh('HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":1}', async (seen) => {
    const res = await githubFetch('https://api.github.com/repos/o/r/pulls/1', {
      headers: { authorization: 'Bearer undefined', accept: 'application/vnd.github+json' },
    });
    assert.deepEqual(await res.json(), { ok: 1 });
    assert.deepEqual(seen().args, ['api', '-i', '-X', 'GET', 'repos/o/r/pulls/1', '-H', 'accept: application/vnd.github+json']);
    await githubFetch('https://api.github.com/graphql', { method: 'POST', headers: {}, body: '{"query":"{}"}' });
    assert.deepEqual(seen(), { args: ['api', '-i', '-X', 'POST', 'graphql', '--input', '-'], input: '{"query":"{}"}' });
  });
});

// The past mistake (project-state#3160): a tooling/ci script that called GitHub with fetch and its own GH_TOKEN, so a
// person ran it by hand as `GH_TOKEN=$(gh auth token) node ...`, which the machine's deny rule refuses. Moved to
// githubFetch: journey-seal, journeys-revive, ci-jobs-seal, journey-touch, main-first, review-marker. Not yet moved
// (this list only shrinks; a script leaves it when it calls githubFetch):
const NOT_YET = new Set([
  'app-token.mjs',
  'bisect-main.mjs',
  'brief-score-guard.mjs',
  'ci-review.mjs',
  'factory-switch.mjs',
  'journey-list-guard.mjs',
  'journeys-revert.mjs',
  'judge-down.mjs',
  'main-trust.mjs',
  'post-merge-trust.mjs',
  'test-diff-guard.mjs',
  'test-judge.mjs',
]);

/** A script that names the GitHub API and calls the global fetch itself. */
export const callsGithubWithFetch = (text) => text.includes('https://api.github.com') && /(^|[^.\w])fetch\(/m.test(text);

test('#3160: a tooling/ci script calls GitHub through githubFetch (github-fetch.mjs), never fetch with its own token', () => {
  const scripts = readdirSync(here).filter((f) => f.endsWith('.mjs') && !/\.(test|mutation)\.mjs$/.test(f) && f !== 'github-fetch.mjs');
  const fetching = scripts.filter((f) => callsGithubWithFetch(readFileSync(join(here, f), 'utf8')));
  const added = fetching.filter((f) => !NOT_YET.has(f));
  assert.deepEqual(added, [], `call GitHub with githubFetch from tooling/ci/github-fetch.mjs, not fetch: ${added.join(', ')}`);
  const moved = [...NOT_YET].filter((f) => !fetching.includes(f));
  assert.deepEqual(moved, [], `these no longer call fetch; take them off NOT_YET in github-fetch.test.mjs: ${moved.join(', ')}`);
});

test("#3160 replayed: main's journey-seal.mjs, before the move, fails the check", () => {
  // journey-seal.mjs at 270623ddb: `const res = await fetch(`https://api.github.com${path}`, {` in poster, and getTried's
  // default fetchImpl = fetch; its main() exited with "journey-seal needs GH_TOKEN and REPO".
  const before = 'const poster = (token) => async (path) => {\n  const res = await fetch(`https://api.github.com${path}`, {';
  assert.equal(callsGithubWithFetch(before), true);
  assert.equal(callsGithubWithFetch(before.replace('await fetch(', 'await githubFetch(')), false);
});
