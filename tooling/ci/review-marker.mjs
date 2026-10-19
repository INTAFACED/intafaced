#!/usr/bin/env node
/**
 * Merge-seal step: a pull request is sealed only when a comment on it says
 * `Independent review: PASS <full head sha>` for the PR's current head.
 *
 *   node tooling/ci/review-marker.mjs --self-test
 *   GH_TOKEN=... PR_NUMBER=1 HEAD_SHA=... REPO=owner/name node tooling/ci/review-marker.mjs
 *
 * The comment is a record the reviewer posts after an independent review of
 * that exact head; anyone who can comment can write it, so it enforces the
 * habit, not identity. A new push needs a new review and a new comment. After
 * posting it, re-run the failed "CI merge seal" job.
 */
const MARKER = /^Independent review: PASS ([0-9a-f]{40})[ \t]*$/im;

/** True when any comment carries the marker for exactly `sha`. */
export function hasReviewMarker(comments, sha) {
  const want = String(sha).toLowerCase();
  return comments.some((c) => {
    const m = MARKER.exec(c?.body ?? '');
    return m !== null && m[1].toLowerCase() === want;
  });
}

function selfTest() {
  const sha = 'a'.repeat(40);
  const ok = [
    [[{ body: `Independent review: PASS ${sha}` }], sha, true],
    [[{ body: `notes\nIndependent review: PASS ${sha}\nmore` }], sha, true],
    [[{ body: `Independent review: PASS ${'b'.repeat(40)}` }], sha, false],
    [[{ body: 'Independent review: PASS aaaaaaaaa' }], sha, false],
    [[{ body: `Independent review: FAIL ${sha}` }], sha, false],
    [[{ body: `Independent review: PASS for head ${sha}` }], sha, false],
    [[{ body: `Independent review: PASS ${sha}` }], sha, true],
    [[{ body: `Independent review: PASS ${sha} but not really` }], sha, false],
    [[{ body: `Independent review: PASS ${sha.toUpperCase()}` }], sha, true],
    [[], sha, false],
  ];
  for (const [comments, s, want] of ok) {
    if (hasReviewMarker(comments, s) !== want) {
      console.error('review-marker self-test failed for', JSON.stringify(comments));
      process.exit(1);
    }
  }
  console.log('review-marker self-test ok');
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const { GH_TOKEN, PR_NUMBER, HEAD_SHA, REPO } = process.env;
  if (!GH_TOKEN || !PR_NUMBER || !HEAD_SHA || !REPO) {
    console.error('::error::review-marker needs GH_TOKEN, PR_NUMBER, HEAD_SHA and REPO');
    process.exit(1);
  }
  const comments = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      console.error(`::error::could not read PR comments (HTTP ${res.status}); sealing fails closed`);
      process.exit(1);
    }
    const batch = await res.json();
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  if (!hasReviewMarker(comments, HEAD_SHA)) {
    console.error(
      `::error title=Review marker missing::No comment "Independent review: PASS ${HEAD_SHA}" on this PR. Get an independent review of this exact head, post that comment, then re-run this job.`,
    );
    process.exit(1);
  }
  console.log(`review marker found for ${HEAD_SHA}`);
}

main();
