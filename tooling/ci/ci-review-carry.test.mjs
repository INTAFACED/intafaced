// The carry (ci-review.mjs carriedVerdict, writeCarried; project-state #3728): a head whose diff against main is byte for
// byte an earlier reviewed head's carries that head's verdicts. The diffs here are real `git diff base...head` text from a
// scratch repository, the shape the compare API returns, so "a main that changed a patched file changes the diff" is
// checked on git's own output, not assumed. Failure it prevents: 111 of 699 CI reviews over 48 h to 22 Nov 2026 re-read
// a patch an earlier head of the same pull request had already passed, after a merge of main.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carriedVerdict, writeCarried, readVerdicts, CARRY_HEADS } from './ci-review.mjs';

const PR = 41;

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'ci-review-carry-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  const commit = (files, msg) => {
    for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

// A pull request's branch: one patch to a.txt, reviewed at `first`; main then moves, and the branch merges it in.
const LINES = Array.from({ length: 12 }, (_, i) => `line ${i}`);
const A = `${LINES.join('\n')}\n`;
const PATCHED = `${[...LINES.slice(0, -1), 'line 11 fixed'].join('\n')}\n`;
function scene(mainChange, patch = { 'a.txt': PATCHED }) {
  const r = repo();
  r.commit({ 'a.txt': A, 'b.txt': 'b\n' }, 'base');
  r.git('switch', '-q', '-c', 'pr');
  const first = r.commit(patch, 'the patch');
  r.git('switch', '-q', 'main');
  const base = r.commit(mainChange, 'main moves');
  r.git('switch', '-q', 'pr');
  r.git('merge', '-q', '--no-edit', 'main');
  const head = r.git('rev-parse', 'HEAD');
  const diffOf = async (sha) => r.git('diff', `${base}...${sha}`);
  return { ...r, first, base, head, diffOf };
}

const run = (id, sha, at) => ({
  id,
  head_sha: sha,
  path: '.github/workflows/ci-review.yml',
  event: 'pull_request_target',
  run_attempt: 1,
  created_at: at,
  pull_requests: [{ number: PR, base: { ref: 'main' } }],
});
const job = (sha, review, tests = review) => ({
  name: 'CI review',
  head_sha: sha,
  status: 'completed',
  conclusion: review === 'success' && tests === 'success' ? 'success' : 'failure',
  steps: [
    { name: 'Verdict', conclusion: review },
    { name: 'Test verdict', conclusion: tests },
  ],
});
const io = (s, jobsByRun) => ({
  pull: { number: PR, head: s.head, base: s.base },
  attempts: async (r) => [jobsByRun[r.id] ?? []],
  diffOf: s.diffOf,
});
const carry = async (s, runs, jobsByRun) => carriedVerdict({ ...io(s, jobsByRun), runs, diff: await s.diffOf(s.head) });

test('the same patch over a main that touched other files carries the earlier PASS', async () => {
  const s = scene({ 'b.txt': 'b\nmoved on main\n' });
  const got = await carry(s, [run(1, s.first, '2026-11-22T10:00:00Z')], { 1: [job(s.first, 'success')] });
  assert.deepEqual(got, { from: s.first.toLowerCase(), review: 'PASS', tests: 'PASS' });
  const dir = mkdtempSync(join(tmpdir(), 'ci-review-carry-out-'));
  writeCarried(dir, { head: s.head, carried: got });
  assert.ok(existsSync(join(dir, 'skip-reviewer')) && existsSync(join(dir, 'tests', 'skip-judge')), 'the reviewer is not called');
  assert.equal(readVerdicts(dir).ok, true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')).verdict, 'PASS');
  assert.equal(JSON.parse(readFileSync(join(dir, 'tests', 'verdict.json'), 'utf8')).verdict, 'PASS');
});

test('the same patch over a main that touched a patched file is reviewed afresh', async () => {
  // main changes the patched file's first line, far from the patch's last: the merge is clean and the patch the same.
  const s = scene({ 'a.txt': `line 0 changed on main\n${LINES.slice(1).join('\n')}\n` });
  assert.equal(
    s
      .git('diff', `${s.base}...${s.first}`)
      .split('\n')
      .filter((l) => /^[+-][^+-]/.test(l))
      .join(),
    s
      .git('diff', `${s.base}...${s.head}`)
      .split('\n')
      .filter((l) => /^[+-][^+-]/.test(l))
      .join(),
    'the same changed lines',
  );
  const got = await carry(s, [run(1, s.first, '2026-11-22T10:00:00Z')], { 1: [job(s.first, 'success')] });
  assert.equal(got, null);
});

test('a changed patch is reviewed afresh, even by whitespace alone', async () => {
  const s = scene({ 'b.txt': 'b\nmoved on main\n' });
  s.commit({ 'a.txt': PATCHED.replace('fixed', 'fixed ') }, 'a trailing space');
  const head = s.git('rev-parse', 'HEAD');
  const got = await carriedVerdict({
    ...io({ ...s, head }, { 1: [job(s.first, 'success')] }),
    runs: [run(1, s.first, '2026-11-22T10:00:00Z')],
    diff: await s.diffOf(head),
  });
  assert.equal(got, null);
});

test('an earlier FAIL on the same patch stands, in either part, even after a later attempt passed', async () => {
  const s = scene({ 'b.txt': 'b\nmoved on main\n' });
  const runs = [{ ...run(1, s.first, '2026-11-22T10:00:00Z'), run_attempt: 2 }];
  const failThenPass = { attempts: async () => [[job(s.first, 'failure', 'success')], [job(s.first, 'success')]] };
  const got = await carriedVerdict({ ...io(s, {}), ...failThenPass, runs, diff: await s.diffOf(s.head) });
  assert.deepEqual(got, { from: s.first.toLowerCase(), review: 'FAIL', tests: 'PASS' });
  const testsFail = await carry(s, [run(1, s.first, '2026-11-22T10:00:00Z')], { 1: [job(s.first, 'success', 'failure')] });
  assert.deepEqual(testsFail, { from: s.first.toLowerCase(), review: 'PASS', tests: 'FAIL' });
  const dir = mkdtempSync(join(tmpdir(), 'ci-review-carry-out-'));
  writeCarried(dir, { head: s.head, carried: got });
  const v = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8'));
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.findings[0], /^the CI review FAILed on [0-9a-f]{40}/, 'a blocking finding, never a note');
});

test('a head with no verdict, another pull request, or a run outside the workflow carries nothing', async () => {
  const s = scene({ 'b.txt': 'b\nmoved on main\n' });
  const at = '2026-11-22T10:00:00Z';
  const down = { ...job(s.first, 'skipped', 'skipped'), conclusion: 'success' };
  assert.equal(await carry(s, [run(1, s.first, at)], { 1: [down] }), null, 'judge down');
  assert.equal(
    await carry(s, [{ ...run(1, s.first, at), pull_requests: [{ number: PR + 1, base: { ref: 'main' } }] }], {
      1: [job(s.first, 'success')],
    }),
    null,
  );
  assert.equal(await carry(s, [{ ...run(1, s.first, at), event: 'pull_request' }], { 1: [job(s.first, 'success')] }), null);
  assert.equal(await carry(s, [run(1, s.head, at)], { 1: [job(s.head, 'success')] }), null, 'its own head is the seal’s, not a carry');
});

test('the newest matching head decides, and only the newest CARRY_HEADS heads are read', async () => {
  const s = scene({ 'b.txt': 'b\nmoved on main\n' });
  // Two heads with one diff (the second an empty commit on the first): the newer one's FAIL stands over the older PASS,
  // and the newer one's PASS carries over an older FAIL that a fix then cleared.
  const twin = s.git('commit-tree', `${s.first}^{tree}`, '-p', s.first, '-m', 'empty');
  const runs = [run(1, s.first, '2026-11-22T09:00:00Z'), run(2, twin, '2026-11-22T10:00:00Z')];
  assert.equal((await carry(s, runs, { 1: [job(s.first, 'success')], 2: [job(twin, 'failure')] })).review, 'FAIL');
  assert.equal((await carry(s, runs, { 1: [job(s.first, 'failure')], 2: [job(twin, 'success')] })).from, twin);
  const again = twin;
  const many = Array.from({ length: CARRY_HEADS }, (_, i) => run(10 + i, again.replace(/.$/, String(i)), `2026-11-22T11:0${i}:00Z`));
  assert.equal(await carry(s, [...many, run(1, s.first, '2026-11-22T09:00:00Z')], { 1: [job(s.first, 'success')] }), null);
});
