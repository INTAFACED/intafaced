/**
 * Fixture PRs only. Does not call gh or git.
 * A same-named open PR from another author that touches a checked path
 * must not be skipped: the tool must not print clear and exit 0.
 * This checkout's own open PR (same branch name and same author) may still be skipped.
 */
import { prCollisionVerdict } from './claim-check.mjs';

const branch = 'fix/same-name';
const checkoutAuthor = 'this-checkout';
const checked = 'tooling/ci/claim-check.mjs';

const foreign = {
  number: 910,
  title: 'fork PR with the same branch name',
  headRefName: branch,
  author: { login: 'fork-user', name: 'Fork User' },
  files: [{ path: checked }],
};

const own = {
  number: 911,
  title: 'this checkout open PR',
  headRefName: branch,
  author: { login: checkoutAuthor, name: 'This Checkout' },
  files: [{ path: checked }],
};

function fail(title, verdict) {
  console.error(`FAIL: ${title}`);
  console.error(`  exitCode=${verdict.exitCode} clear=${verdict.clear}`);
  console.error(verdict.line);
  process.exit(1);
}

const foreignVerdict = prCollisionVerdict({
  prs: [foreign],
  branch,
  author: checkoutAuthor,
  mine: [checked],
});
if (foreignVerdict.exitCode === 0 || foreignVerdict.clear) {
  console.error('FAIL: same-name open PR from another author was skipped');
  console.error('  headRefName equals the current branch, author does not, and the PR touches a checked path');
  console.error('  tool printed clear and exit 0');
  console.error(`  exitCode=${foreignVerdict.exitCode} clear=${foreignVerdict.clear}`);
  console.error(foreignVerdict.line);
  process.exit(1);
}
if (!foreignVerdict.collisions.some((c) => c.pr.number === 910)) {
  fail('other author same-name PR was not reported as a collision', foreignVerdict);
}

const ownVerdict = prCollisionVerdict({
  prs: [own],
  branch,
  author: checkoutAuthor,
  mine: [checked],
});
if (ownVerdict.exitCode !== 0 || !ownVerdict.clear || ownVerdict.collisions.length !== 0) {
  fail('this checkout own open PR (same branch and same author) should still be skipped', ownVerdict);
}

const mixed = prCollisionVerdict({
  prs: [own, foreign],
  branch,
  author: checkoutAuthor,
  mine: [checked],
});
if (mixed.exitCode === 0 || mixed.clear) {
  console.error('FAIL: mixed list skipped the other author because the branch name matched');
  console.error('  tool printed clear and exit 0');
  console.error(`  exitCode=${mixed.exitCode} clear=${mixed.clear}`);
  console.error(mixed.line);
  process.exit(1);
}
if (mixed.collisions.some((c) => c.pr.number === 911)) {
  fail('own PR was not skipped when listed beside another author', mixed);
}
if (!mixed.collisions.some((c) => c.pr.number === 910)) {
  fail('other author missing from mixed collisions', mixed);
}

const disjoint = prCollisionVerdict({
  prs: [{ ...foreign, number: 912, files: [{ path: 'docs/other.md' }] }],
  branch,
  author: checkoutAuthor,
  mine: [checked],
});
if (disjoint.exitCode !== 0 || !disjoint.clear) {
  fail('same-name other author that does not touch the path should stay clear', disjoint);
}

const otherBranch = prCollisionVerdict({
  prs: [{ ...foreign, number: 913, headRefName: 'feat/other-branch' }],
  branch,
  author: checkoutAuthor,
  mine: [checked],
});
if (otherBranch.exitCode === 0 || otherBranch.clear) {
  fail('different branch that touches the path should still collide', otherBranch);
}

console.log('claim-check author collision test OK');
console.log('  fixture same-name other author collides · same author skipped · disjoint clear');
