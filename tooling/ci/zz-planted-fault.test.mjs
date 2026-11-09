// PLANTED FAULT, never merged (INTAFACED/project-state#1574, 9 Nov 2026): this test fails on purpose, so this pull
// request's CI is red and its merge seal must never pass, though auto-merge is armed. Closed after the read.
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('planted fault: a red required check must never merge', () => {
  assert.equal(1, 2, 'planted: this pull request must stay unmerged');
});
