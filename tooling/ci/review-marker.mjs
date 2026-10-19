#!/usr/bin/env node
/**
 * Merge-seal step: a pull request is sealed only when the commit status `Independent review` is a success on its
 * current head. That status is posted by .github/workflows/review-signoff.yml (tooling/ci/review-signoff.mjs) when a
 * listed reviewer (tooling/ci/reviewers.json) comments `Independent review: PASS <full head sha>`, or when the same
 * patch is carried across a clean rebase. A comment by anyone else, or for another sha, creates no status.
 *
 *   node tooling/ci/review-marker.mjs --self-test
 *   GH_TOKEN=... HEAD_SHA=... REPO=owner/name node tooling/ci/review-marker.mjs
 *
 * The sign-off workflow re-runs a failed seal after it posts the status, so nobody re-runs it by hand. The seal also
 * looks a few times, for the seconds between a comment and its status.
 */
/** The comment line the sign-off workflow accepts, on its own line. */
export const MARKER = /^Independent review: PASS ([0-9a-f]{40})[ \t]*$/im;

export const STATUS_CONTEXT = 'Independent review';

/** True when the newest status of the review context on this head is a success. */
export function hasSignoff(statuses) {
  const mine = statuses.filter((s) => s?.context === STATUS_CONTEXT);
  return mine.length > 0 && mine[0].state === 'success'; // the API lists newest first
}

function selfTest() {
  const ok = { context: STATUS_CONTEXT, state: 'success' };
  const cases = [
    [[ok], true],
    [[], false],
    [[{ context: 'other', state: 'success' }], false],
    [[{ context: STATUS_CONTEXT, state: 'failure' }, ok], false],
    [[{ context: STATUS_CONTEXT, state: 'pending' }], false],
    [[ok, { context: STATUS_CONTEXT, state: 'failure' }], true],
  ];
  for (const [statuses, want] of cases) {
    if (hasSignoff(statuses) !== want) {
      console.error('review-marker self-test failed for', JSON.stringify(statuses));
      process.exit(1);
    }
  }
  const sha = 'a'.repeat(40);
  const markers = [
    [`Independent review: PASS ${sha}`, true],
    [`notes\nIndependent review: PASS ${sha}\nmore`, true],
    [`Independent review: PASS ${sha} but not really`, false],
    [`Independent review: FAIL ${sha}`, false],
    [`Independent review: PASS for head ${sha}`, false],
    ['Independent review: PASS aaaaaaaaa', false],
    [`Independent review: PASS ${sha.toUpperCase()}`, true],
  ];
  for (const [body, want] of markers) {
    if (MARKER.test(body) !== want) {
      console.error('review-marker self-test failed for', JSON.stringify(body));
      process.exit(1);
    }
  }
  console.log('review-marker self-test ok');
}

async function readStatuses(repo, sha, token) {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/statuses?per_page=100`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    console.error(`::error::could not read commit statuses (HTTP ${res.status}); sealing fails closed`);
    process.exit(1);
  }
  return res.json();
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const { GH_TOKEN, HEAD_SHA, REPO } = process.env;
  if (!GH_TOKEN || !HEAD_SHA || !REPO) {
    console.error('::error::review-marker needs GH_TOKEN, HEAD_SHA and REPO');
    process.exit(1);
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (hasSignoff(await readStatuses(REPO, HEAD_SHA, GH_TOKEN))) {
      console.log(`review sign-off found for ${HEAD_SHA}`);
      return;
    }
    if (attempt < 4) await new Promise((r) => setTimeout(r, 20_000));
  }
  console.error(
    `::error title=Review sign-off missing::No success status "${STATUS_CONTEXT}" on ${HEAD_SHA}. Get an independent review of this exact head; a listed reviewer comments "Independent review: PASS ${HEAD_SHA}" and the status follows (see AGENTS.md).`,
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
