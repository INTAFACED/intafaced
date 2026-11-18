// Tests for brief-score-guard.mjs: a change to REVIEW.md or READ.md needs its old and new scores in the body.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRIEF_PATHS, judge } from './brief-score-guard.mjs';

const OLD = 'Brief-score: review old bad 2 of 12, controls 9 of 9';
const NEW = 'Brief-score: review new bad 3.5 of 12, controls 9 of 9';

test('a pull request that changes no brief needs nothing in its body', () => {
  assert.deepEqual(judge(['tooling/ci/ci-review.mjs', 'apps/customer/src/x.tsx'], ''), { ok: true, lines: [] });
});

test('a changed brief passes with its old and new scores at the start of a line', () => {
  assert.equal(judge([BRIEF_PATHS.review], `Why.\n\n${OLD}\n${NEW}\n`).ok, true);
  assert.equal(judge([BRIEF_PATHS.review, BRIEF_PATHS.read], `${OLD}\n${NEW}`).ok, false, 'each changed brief needs its own');
});

test('a changed brief with no score, one side only, or the lines in code or indented, fails and says how to fix it', () => {
  const fails = (body, why) => {
    const v = judge([BRIEF_PATHS.read], body);
    assert.equal(v.ok, false, why);
    assert.match(v.lines.join('\n'), /test-judge\/READ\.md changed.*brief-cases\.mjs read/, why);
  };
  fails('', 'no body');
  fails('Scores: better than before.', 'prose is not a score');
  fails('Brief-score: read new bad 4 of 8, controls 6 of 6', 'the new score alone');
  fails(
    '```\nBrief-score: read old bad 3 of 8, controls 6 of 6\nBrief-score: read new bad 4 of 8, controls 6 of 6\n```',
    'in a code block',
  );
  fails('  Brief-score: read old bad 3 of 8, controls 6 of 6\n  Brief-score: read new bad 4 of 8, controls 6 of 6', 'indented');
  fails(`${OLD}\n${NEW}`, "the review brief's scores do not cover the read brief");
});

test('old and new must count the same cases', () => {
  const v = judge([BRIEF_PATHS.review], `${OLD}\nBrief-score: review new bad 3 of 11, controls 9 of 9`);
  assert.equal(v.ok, false);
  assert.match(v.lines[0], /count different cases/);
});

test('totals only in a table fail: the guard reads Brief-score lines alone', () => {
  // #8839's shape (18 Nov): the old and new totals in a table, which a machine line replaces.
  const body = '| Brief | Bad score | Controls passed |\n|---|---|---|\n| REVIEW.md today | **2 of 11** | 9 of 9 |';
  assert.equal(judge([BRIEF_PATHS.review], body).ok, false);
});
