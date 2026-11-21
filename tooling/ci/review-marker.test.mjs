// review-marker: which changed files need the CI review (reviewReason), and the merge queue seal against a fake GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEW_BASE,
  REVIEW_WORKFLOW,
  STATUS_CONTEXT,
  groupPulls,
  queueRefPr,
  reviewJob,
  reviewReason,
  sealMergeGroup,
  squashPrNumber,
} from './review-marker.mjs';

// Gate files and look baselines need the review; money and security code alone no longer does
// (2026-11-06). Every case the old rule had is kept, with its expected result under the new one.
const reasonCases = [
  [['docs/x.md'], false],
  [['services/svc-support/src/a.ts', 'docs/x.md'], false],
  [['services/svc-pay/src/a.ts'], false], // money: depends on ledger-client
  [['apps/admin/src/a.tsx'], false], // money on the head or on the default branch
  [['services/svc-edge/src/a.ts'], false], // security
  [['packages/ledger-client/src/a.ts'], false],
  [['packages/config/src/freeze-authority.ts'], false],
  [['packages/db/src/migrate.ts'], false],
  [['services/svc-new/src/a.ts'], false], // no package.json: was money by fail-closed, now no money check runs
  [['services/svc-unread/src/a.ts'], false], // unreadable package.json: likewise
  [['tooling/scripts/local-test-gates.mjs'], false], // tooling without a package.json: likewise
  [['tooling/pay-sim/src/cli.ts'], false],
  [['tooling/coverage.yaml'], false],
  [['apps/customer/src/assets/logo.png'], false],
  [['apps/customer/src/screens/home/index.tsx'], false],
  [['.github/CODEOWNERS'], true], // gate files
  [['.github/workflows/ci.yml'], true],
  [['tooling/ci/dependency-audit.mjs'], true],
  [['AGENTS.md'], true],
  [['services/svc-support/CLAUDE.md'], true],
  [['services/svc-pay/src/a.ts', 'services/svc-pay/CLAUDE.md'], true], // money plus a gate file
  [['pnpm-lock.yaml'], false], // security code in AGENTS.md (owner decision 2026-11-06)
  [['.npmrc'], false], // the seal's old security list
  [['apps/customer/Dockerfile'], false],
  [['docker-compose.apps.yml'], false],
  [['tsconfig.base.json'], false],
  [['.github/actions/test-infra/action.yml'], false], // .github/ outside GATE_PATHS
  [['pnpm-workspace.yaml'], false],
  [['tooling/infra/migrate-all.mjs'], false],
  [['services/svc-edge/src/a.ts', 'pnpm-lock.yaml'], false], // security plus the lockfile
  [['apps/customer/look-baselines/home/390x844.png'], true], // look baselines
  [['packages/ui/look-baselines/kit-buttons/phone/a.png'], true],
  [[], true],
];

test('reviewReason: gate files and look baselines need the review, nothing else does', () => {
  for (const [files, want] of reasonCases)
    assert.equal(reviewReason(files) !== null, want, `review-reason case failed for ${JSON.stringify(files)}`);
});

// A PASS comment from a reviewer login, which counts for nothing.
const REVIEWER = 'reviewer';
const base = 'b'.repeat(40);
const ref = (n) => `refs/heads/gh-readonly-queue/main/pr-${n}-${base}`;
const sq = (title, n) => ({ commit: { message: `${title} (#${n})\n\nbody (#9)` } });

test('merge group: squash numbers, queue refs and the group read from its commits', () => {
  assert.equal(squashPrNumber('test(customer): J-cex-spot-01 #8 (#7108) (#7109)'), 7109, 'the last (#N) is the squash');
  assert.equal(squashPrNumber('Merge pull request #5 from x/y'), null, 'a merge commit names no squash');
  assert.equal(queueRefPr(ref(12)), 12, 'queue ref');
  assert.equal(queueRefPr('refs/heads/main'), null, 'queue ref');
  assert.equal(queueRefPr(`refs/heads/gh-readonly-queue/release/2.0/pr-7-${base}`), 7, 'a base branch with a slash');
  assert.equal(JSON.stringify(groupPulls([sq('a', 1), sq('b', 2)], ref(2))), '[1,2]', 'a group of two');
  assert.equal(groupPulls([sq('a', 1), { commit: { message: 'no number' } }], ref(1)), null, 'an unnamed commit');
  assert.equal(groupPulls([sq('a', 1), sq('b', 1)], ref(1)), null, 'a repeated number');
  assert.equal(groupPulls([sq('a', 1)], ref(3)), null, 'the queue ref names a pull request the commits do not');
  assert.equal(groupPulls([sq('a', 1), sq('b', 2)], ref(1)), null, 'the queue ref names the group head, the last commit');
  assert.equal(groupPulls([], ref(1)), null, 'an empty group');
});

test('sealMergeGroup: each queued pull request is held to its own seal, offline', async () => {
  const shaOf = (n) => String(n).padStart(40, 'c');
  const reviewed = (n, verdict = 'success', base = REVIEW_BASE) => [
    {
      id: 900 + n,
      path: REVIEW_WORKFLOW,
      event: 'pull_request_target',
      head_sha: shaOf(n),
      pull_requests: [{ number: n, base: { ref: base } }],
      jobs: [[reviewJob(shaOf(n), verdict)]],
    },
  ];
  // 1: docs only. 2: a gate file (tooling/ci), CI review passed. 3: a workflow (.github), CI review passed.
  // 4: a gate file with no review. 5: a gate file with only a PASS comment and an `Independent review` status from the
  // shared login. 6: closed. 7: a gate file whose CI review said FAIL. 8: a gate file reviewed against a side branch.
  // 9: money (svc-pay) and 10: security (svc-edge), no review: sealed on their checks alone. 11: a look baseline and
  // 12: the lockfile, no review (security code).
  const world = {
    1: { files: ['docs/x.md'] },
    2: { files: ['tooling/ci/x.mjs'], runs: reviewed(2) },
    3: { files: ['.github/workflows/ci.yml'], runs: reviewed(3) },
    4: { files: ['tooling/ci/x.mjs'] },
    5: {
      files: ['tooling/ci/x.mjs'],
      comments: [{ user: { login: REVIEWER }, body: `Independent review: PASS ${shaOf(5)}\nReviewer session: session_R1` }],
      statuses: [{ context: STATUS_CONTEXT, state: 'success' }],
    },
    6: { files: ['docs/x.md'], state: 'closed' },
    7: { files: ['tooling/ci/x.mjs'], runs: reviewed(7, 'failure') },
    8: { files: ['tooling/ci/x.mjs'], runs: reviewed(8, 'success', 'side/b') },
    9: { files: ['services/svc-pay/src/a.ts'] },
    10: { files: ['services/svc-edge/src/a.ts', 'packages/auth/src/a.ts'] },
    11: { files: ['apps/customer/look-baselines/home/390x844.png'] },
    12: { files: ['pnpm-lock.yaml'] },
  };
  const io = {
    pull: async (n) => ({
      state: world[n].state ?? 'open',
      head: { sha: shaOf(n) },
      base: { ref: REVIEW_BASE },
      user: { login: 'author' },
    }),
    files: async (n) => world[n].files,
    reviewRuns: async (sha) => world[Number(sha.replace(/^c+/, ''))].runs ?? [],
    attempts: async (run) => run.jobs,
  };
  const group = async (numbers, opts = {}) =>
    sealMergeGroup({ commits: numbers.map((n) => sq(`t${n}`, n)), headRef: ref(numbers.at(-1)), io, ...opts });
  const cases = [
    [[1, 2, 3], true, 'docs, a reviewed gate-file PR and a reviewed workflow PR'],
    [[1, 9, 10], true, 'a money PR and a security PR with no review merge through the queue'],
    [[1, 4], false, 'a gate-file PR with no review never merges through the queue'],
    [[9, 11], false, 'nor does a look-baseline PR with no review'],
    [[9, 12], true, 'a lockfile PR with no review merges through the queue too'],
    [[4, 1], false, 'nor when it is not the last in the group'],
    [[2, 5], false, 'a PASS comment and status from the shared login count for nothing in the queue either'],
    [[2, 7], false, 'a FAIL verdict holds in the queue'],
    [[6], false, 'a closed pull request is no queue entry'],
    [[8], false, 'a PASS reviewed against a side branch counts for nothing in the queue'],
  ];
  for (const [numbers, want, what] of cases) {
    const got = await group(numbers);
    assert.equal(got.ok, want, `${what}: ${got.lines.join(' | ')}`);
  }
  assert.ok((await group([6], { dryRun: true })).ok, 'a dry run reads a closed pull request');
  const bad = await sealMergeGroup({ commits: [{ commit: { message: 'Merge pull request #4' } }], headRef: ref(4), io });
  assert.equal(bad.ok, false, 'an unreadable group fails closed');
  assert.ok(bad.lines[0].includes('could not be read whole'), 'an unreadable group fails closed');
});
