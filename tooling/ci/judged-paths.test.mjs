// The guard leaves a journey step file to the test judge (judged-paths.mjs leftToJudge, R3 C6). That is safe only while
// (a) the guard's `judgeRuns` is exactly the judge job's `if:` in ci-review.yml, and (b) the seal needs the judge's
// verdict for every such file. Both are read from the files that decide them, so a change to either fails here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JOURNEY_FILE, JUDGE_JOB_CONDITIONS, judgeRunsFor, leftToJudge } from './judged-paths.mjs';
import { JUDGE_CHECK, requiredChecks } from './review-marker.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/ci-review.yml', import.meta.url), 'utf8');

/** The `judge` job's `if:` as its && terms, read from the workflow text (a folded >- scalar, as ci-review.yml writes it). */
export function judgeJobTerms(text) {
  const job = /\n  judge:\n([\s\S]*?)(?=\n  [a-z][\w-]*:\n|$)/.exec(text)?.[1];
  assert.ok(job, 'ci-review.yml has a judge job');
  const cond = /\n    if: >-\n((?: {6}.*\n)+)/.exec(`\n${job}\n`)?.[1];
  assert.ok(cond, 'the judge job has a folded if:');
  return cond
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s*&&\s*/);
}

test("the guard's judgeRuns is the judge job's condition, term for term", () => {
  const terms = judgeJobTerms(workflow);
  const pr = terms.filter((t) => t.includes('github.event.pull_request'));
  assert.deepEqual(pr.sort(), [...JUDGE_JOB_CONDITIONS].sort(), `the judge job's pull request terms: ${terms.join(' && ')}`);
  // Its other terms read only the review job (needs.review), which the seal's own requirement covers (below).
  for (const t of terms.filter((x) => !pr.includes(x))) assert.match(t, /^(always\(\)|needs\.review\.outputs\.\w+ == '\w+')$/, t);
});

test('planted: a judge condition the guard does not know fails', () => {
  const at = workflow.indexOf('\n  judge:\n');
  const planted =
    workflow.slice(0, at) +
    workflow
      .slice(at)
      .replace(
        "github.event.pull_request.base.ref == 'main'",
        "github.event.pull_request.base.ref == 'main' && github.event.pull_request.draft == false",
      );
  const terms = judgeJobTerms(planted).filter((t) => t.includes('github.event.pull_request'));
  assert.notDeepEqual(terms.sort(), [...JUDGE_JOB_CONDITIONS].sort());
});

test('judgeRunsFor: only a same-repository pull request into main', () => {
  const repo = 'INTAFACED/intafaced';
  assert.equal(judgeRunsFor({ baseRef: 'main', headRepo: repo, repo }), true);
  assert.equal(judgeRunsFor({ baseRef: 'main', headRepo: 'someone/intafaced', repo }), false, 'a fork');
  assert.equal(judgeRunsFor({ baseRef: 'main', headRepo: '', repo }), false, 'a deleted head repository');
  assert.equal(judgeRunsFor({ baseRef: 'feature', headRepo: repo, repo }), false, 'another base');
});

test('the seal needs the test judge for every journey step file the guard leaves to it', () => {
  for (const path of ['apps/customer/tests/real-app/J-bank-13.pw.mjs', 'apps/customer/tests/real-app/J-ops-console-02-documents.pw.mjs']) {
    assert.ok(JOURNEY_FILE.test(path) && leftToJudge({ path, status: 'M' }, { judgeRuns: true }), path);
    for (const status of ['M', 'A'])
      assert.ok(
        requiredChecks([path]).some((r) => r.check === JUDGE_CHECK),
        `${path} (${status}) needs the test judge's verdict`,
      );
  }
});
