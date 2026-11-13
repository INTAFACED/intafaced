// node --test tooling/scripts/review-before-push.test.mjs: the local review prompt is the CI review's own, plus how to answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localPrompt, LOCAL_READS } from './review-before-push.mjs';
import { buildPrompt } from '../ci/ci-review.mjs';

test('the prompt is buildPrompt with the same brief and diff, then the local answer rules', () => {
  const diff = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n';
  const p = localPrompt({ brief: '# Brief\nJudge money.', diff, head: 'abc123' });
  assert.ok(p.startsWith(buildPrompt({ brief: '# Brief\nJudge money.', diff, pr: 'not opened yet', head: 'abc123' })));
  assert.ok(p.endsWith(LOCAL_READS));
  assert.match(p, /BEGIN UNTRUSTED DIFF\n[\s\S]*\+b\n[\s\S]*END UNTRUSTED DIFF/);
});
