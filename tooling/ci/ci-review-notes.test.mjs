// The CI review's non-blocking notes reach the pull request (#9357): before, a `note:` was written only into the run's
// summary, which nothing reads once the review PASSes, so the product problems notes named merged and stayed on main
// (#8823's, #8712's and #8940's notes, now #9352 to #9355). The Verdict step now hands the notes on as a job output,
// and a job of its own posts them on the pull request, where the builder's watch wakes and the builder answers each
// in the PR body, fixed or why not, before the seal can start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTES_MARK, notesComment, notesOf } from './ci-review.mjs';

const script = fileURLToPath(new URL('./ci-review.mjs', import.meta.url));
const HEAD = 'a'.repeat(40);
// #8823's real note (shortened): a PASS that carried it, and it merged.
const NOTE = "note: services/svc-ws/src/server.ts:212: the per-IP cap reads the socket's address, which behind the proxy is the proxy's";

/** The Verdict step on a recorded answer: its exit, and what it wrote to the step's outputs. */
function judge(v) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-review-notes-'));
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify(v));
  const output = join(dir, 'output');
  writeFileSync(output, '');
  const env = { ...process.env, GITHUB_EVENT_PATH: join(dir, 'none.json'), GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: output };
  let code = 0;
  try {
    execFileSync(process.execPath, [script, 'judge', dir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status;
  }
  const lines = readFileSync(output, 'utf8').split('\n');
  const notes = lines.find((l) => l.startsWith('notes='));
  return { code, notes: notes ? JSON.parse(notes.slice('notes='.length)) : undefined };
}

test('a planted note in a recorded PASS leaves the Verdict step as an output, and the PASS stays a PASS', () => {
  const pass = judge({ head: HEAD, verdict: 'PASS', findings: [NOTE], cleared: ['x.ts: checked'] });
  assert.equal(pass.code, 0);
  assert.deepEqual(pass.notes, [NOTE]);
  // A FAIL's notes go too; its blocking findings stay in the job summary, where the red sends the builder.
  const fail = judge({ head: HEAD, verdict: 'FAIL', findings: ['x.ts:2: item 3: y', NOTE] });
  assert.equal(fail.code, 1);
  assert.deepEqual(fail.notes, [NOTE]);
  // No note, no output: the posting job is skipped.
  assert.equal(judge({ head: HEAD, verdict: 'PASS', findings: [] }).notes, undefined);
});

test('the comment names the head, each note as written, and the answer the builder owes before merge', () => {
  assert.deepEqual(notesOf(['x.ts:2: item 3: y', NOTE, '  Note: z']), [NOTE, '  Note: z']);
  const body = notesComment({ head: HEAD, notes: [NOTE], run: 'https://example.test/run/1' });
  assert.ok(body.startsWith(NOTES_MARK));
  assert.ok(body.includes(HEAD));
  assert.ok(body.includes(`- ${NOTE}`));
  assert.match(body, /PR body/);
  assert.match(body, /Answer each in the PR body before merge/);
  assert.match(body, /Push a fix only for a defect in this change/);
  assert.ok(body.includes('https://example.test/run/1'));
  // A note's mention notifies nobody.
  const quiet = notesComment({ head: HEAD, notes: ['note: ask @someone about it'], run: '' });
  assert.ok(!/@someone/.test(quiet));
  assert.ok(quiet.includes('someone'));
});

test('a job of its own posts the notes on the pull request before the seal starts, never a step of the review', () => {
  const wf = readFileSync(new URL('../../.github/workflows/ci-review.yml', import.meta.url), 'utf8');
  const jobOf = (name) => wf.split(`\n  ${name}:\n`)[1]?.split(/\n {2}[a-z][a-z0-9-]*:\n/)[0] ?? '';
  const review = jobOf('review');
  assert.match(review, /\n {6}notes: \$\{\{ steps\.verdict\.outputs\.notes \}\}/, 'the review job hands the notes on');
  assert.doesNotMatch(review, /pull-requests: write/, 'the review job writes nothing on the pull request');
  const notes = jobOf('notes');
  assert.ok(notes, 'a notes job');
  assert.match(notes, /\n {4}needs: review\n/);
  assert.match(notes, /needs\.review\.outputs\.notes != ''/);
  assert.match(notes, /\n {6}pull-requests: write/);
  assert.match(notes, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/, "runs main's script, never the PR's");
  assert.match(notes, /NOTES: \$\{\{ needs\.review\.outputs\.notes \}\}/, 'the notes reach the script as data, through env');
  assert.match(notes, /node tooling\/ci\/ci-review\.mjs notes/);
  assert.match(jobOf('seal-start'), /\n {4}needs: \[[^\]]*\bnotes\b[^\]]*\]\n/, 'the seal starts after the notes are posted');
});
