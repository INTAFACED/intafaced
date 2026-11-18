// The parts of brief-cases.mjs that need no model: how it reads the job's calls, drops a line and scores an answer, and
// that each case file is one the runner can run.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dropLine, JUDGES, jobCall, mergeRuns, scoreRead, scoreReview, totals } from './brief-cases.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/ci-review.yml', import.meta.url), 'utf8');

test('the calls are read from the job, so the cases are asked as the job asks', () => {
  const c = jobCall(workflow);
  for (const j of ['review', 'read']) {
    assert.match(c[j].model, /^[a-z]+-[a-z]+-\d/);
    assert.match(c[j].cli, /^[\w-]+$/);
    assert.match(c[j].effort, /^(low|medium|high|xhigh|max)$/);
    assert.match(c[j].reads, /\$GITHUB_WORKSPACE/);
    assert.match(c[j].turns, /^\d+$/);
  }
  assert.match(c.review.reads, /callers and tests/);
  assert.match(c.read.reads, /\$pics/);
  assert.throws(() => jobCall('name: CI review\n'), /no longer has the calls/);
});

test('--drop removes exactly the one line that holds the text', () => {
  const brief = 'a\nb holds x\nc';
  assert.equal(dropLine(brief, 'x'), 'a\nc');
  assert.throws(() => dropLine(brief, 'zzz'), /matches 0/);
  assert.throws(() => dropLine('x\nx', 'x'), /matches 2/);
  for (const j of Object.values(JUDGES)) {
    const text = readFileSync(j.brief, 'utf8');
    assert.equal(dropLine(text, '## What you answer').split('\n').length, text.split('\n').length - 1);
  }
});

test('a review case scores a caught fault 1, a fault named only in a note 0.5, a miss 0; a control passes on PASS', () => {
  const bad = { kind: 'bad', names: ['J-x-01'] };
  const ok = (verdict, findings) => ({ ok: true, verdict, findings });
  assert.equal(scoreReview(bad, ok('FAIL', ['a.ts:1: item 4: J-x-01 #2 now fails'])).score, 1);
  assert.equal(scoreReview(bad, ok('PASS', ['note: J-x-01 #2 will go red'])).score, 0.5);
  assert.equal(scoreReview(bad, ok('FAIL', ['a.ts:1: item 4: another fault'])).score, 0);
  assert.equal(scoreReview(bad, { ok: false, why: 'no JSON' }).score, 0);
  const control = { kind: 'control' };
  assert.equal(scoreReview(control, ok('PASS', [])).score, 1);
  assert.equal(scoreReview(control, ok('FAIL', ['a.ts:1: item 3: x'])).score, 0);
});

test('a read case scores WEAK or MISMATCH right for a bad case, FAITHFUL right for a control', () => {
  const lines = (verdict) => ({ ok: true, lines: [{ step: 'J-x-01 #2', verdict, note: 'n' }] });
  assert.equal(scoreRead({ kind: 'bad', step: 'J-x-01 #2' }, lines('WEAK')).score, 1);
  assert.equal(scoreRead({ kind: 'bad', step: 'J-x-01 #2' }, lines('MISMATCH')).score, 1);
  assert.equal(scoreRead({ kind: 'bad', step: 'J-x-01 #2' }, lines('FAITHFUL')).score, 0);
  assert.equal(scoreRead({ kind: 'control', step: 'J-x-01#2' }, lines('FAITHFUL')).score, 1);
  assert.equal(scoreRead({ kind: 'control', step: 'J-x-01 #2' }, lines('WEAK')).score, 0);
  assert.deepEqual(
    totals([
      { kind: 'bad', score: 0.5 },
      { kind: 'control', score: 1 },
      { kind: 'control', score: 0 },
    ]),
    {
      bad: 0.5,
      badOf: 1,
      controls: 1,
      controlsOf: 2,
    },
  );
});

test('a case asked twice scores the mean of its runs, and a control passes only when every run passes', () => {
  assert.equal(mergeRuns([{ score: 1 }, { score: 0 }]).score, 0.5);
  assert.equal(mergeRuns([{ score: 1 }, { score: 0.5 }]).score, 0.75);
  const flaky = mergeRuns([
    { score: 1, got: 'PASS' },
    { score: 0, got: 'FAIL' },
  ]);
  assert.equal(flaky.got, 'PASS | FAIL');
  assert.deepEqual(totals([{ kind: 'control', ...flaky }]), { bad: 0, badOf: 0, controls: 0, controlsOf: 1 });
  assert.deepEqual(totals([{ kind: 'control', ...mergeRuns([{ score: 1 }, { score: 1 }]) }]).controls, 1);
});

test('each case file has bad cases and controls, unique ids, full shas, and no copied step words', () => {
  const sha = /^[0-9a-f]{40}\^?$/;
  for (const [judge, j] of Object.entries(JUDGES)) {
    const { cases } = JSON.parse(readFileSync(j.cases, 'utf8'));
    assert.ok(cases.some((c) => c.kind === 'bad') && cases.some((c) => c.kind === 'control'), judge);
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, `${judge}: ids are unique`);
    for (const c of cases) {
      assert.ok(['bad', 'control'].includes(c.kind), c.id);
      assert.match(c.head, sha, c.id);
      if (judge === 'review') {
        assert.match(c.base, sha, c.id);
        assert.ok(Number.isInteger(c.pr), c.id);
        if (c.kind === 'bad') assert.ok(c.names?.length && c.names.every((n) => new RegExp(n)), c.id);
      } else {
        assert.match(c.step, /^J-[a-z0-9-]+ #\d+$/, c.id);
        assert.match(c.words, sha, c.id);
        assert.deepEqual(Object.keys(c).sort(), ['head', 'id', 'kind', 'step', 'words'], `${c.id}: ids and shas only`);
      }
    }
  }
});
