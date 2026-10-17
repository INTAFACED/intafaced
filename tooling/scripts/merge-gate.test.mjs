/** Offline orchestration tests: GitHub and evidence are injected; runGate cannot create live PASS receipts. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_MAX_BUFFER, writePassReceipt, invalidateReceipt } from './merge-review.mjs';
import { test } from 'node:test';
import { GitHubRefusalError } from './gate-gh.mjs';
import {
  AGENT_RULE_PATTERNS,
  CI_PR_PATHS,
  ciWouldRun,
  collapseChecks,
  coverageProblems,
  identifyChecks,
  sharedRequiredCheckProblem,
  mainCopyProblem,
  writeReviewerInput,
  mergeCommand,
  runGate,
  runVerifiedGate,
} from './merge-gate.mjs';

const HEAD = 'a'.repeat(40),
  TARGET = 'b'.repeat(40),
  BASE = 'c'.repeat(40),
  MERGE = 'd'.repeat(40),
  REPO = 'o/r';
const WORKFLOW_IDS = { CI: 9001, Gitleaks: 9002, 'Supply chain': 9003, Other: 9004, 'Docs format': 9005 };
const chk = (name, bucket = 'pass', workflow = 'CI', workflowId = WORKFLOW_IDS[workflow]) => ({
  name,
  workflow,
  workflowId,
  bucket,
  state: bucket.toUpperCase(),
  completedAt: '2026-10-15T00:00:00Z',
  link: `https://github.com/o/r/actions/runs/1/job/${name}`,
});
const REQ = [chk('Gitleaks', 'pass', 'Gitleaks'), chk('Dependency audit', 'pass', 'Supply chain')];
const CI = ['Doctrine gates', 'Typecheck & build', 'Format', 'Definition of Done', 'Tests (full)'].map((n) => chk(n));
const pr = (extra = {}) => ({
  number: 7,
  state: 'OPEN',
  isDraft: false,
  headRefOid: HEAD,
  baseRefOid: TARGET,
  baseRefName: 'main',
  title: 'fix: work',
  body: '',
  authorAssociation: 'OWNER',
  mergeCommitSha: MERGE,
  changedFiles: 1,
  mergeable: 'MERGEABLE',
  ...extra,
});
const opts = (extra = {}) => ({ pr: 7, head: HEAD, repo: REPO, timeoutMin: 2, pollSec: 1, ciGraceSec: 5, comment: true, ...extra });
const clock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
};
function world(extra = {}) {
  const calls = [],
    observed = [];
  const w = {
    pr: pr(),
    files: [{ filename: 'packages/ui/src/a.ts' }],
    checks: [...REQ, ...CI],
    runs: [{ workflowName: 'CI', status: 'completed' }],
    comments: [],
    ...extra,
  };
  w.comments = w.comments.map((c) => ({ author_association: 'OWNER', ...c }));
  let lastPr;
  const gh = (args, options = {}) => {
    const key = args.join(' ');
    calls.push({ args, input: options.input });
    if (w.refuse && key.startsWith(w.refuse)) throw new GitHubRefusalError('HTTP 403: denied');
    const json = (v) => ({ status: 0, stdout: JSON.stringify(v), stderr: '' });
    if (key.startsWith('pr view')) {
      lastPr = typeof w.pr === 'function' ? w.pr() : w.pr;
      return json(lastPr);
    }
    if (key === `api repos/${REPO}/pulls/7`)
      return json({
        number: 7,
        author_association: lastPr.authorAssociation,
        head: { sha: lastPr.headRefOid },
        merge_commit_sha: lastPr.mergeCommitSha,
      });
    if (key === `api repos/${REPO}/commits/${MERGE}`)
      return json({ sha: MERGE, parents: [{ sha: w.mergeBaseTip ?? TARGET }, { sha: HEAD }] });
    if (key.includes('/files')) return json([w.files]);
    if (key.includes('/compare/')) return json({ merge_base_commit: { sha: w.base ?? BASE } });
    if (key.includes('/comments')) return json([w.comments]);
    if (key.startsWith('pr checks')) return json(typeof w.checks === 'function' ? w.checks() : w.checks);
    if (key.startsWith('run list')) return json(typeof w.runs === 'function' ? w.runs() : w.runs);
    if (key.startsWith('pr comment')) return json('');
    throw new Error(`Unexpected fake gh call: ${key}`);
  };
  const evidenceCollector = async (i) => {
    observed.push(i);
    return w.evidence ?? { pass: true, reasons: [], classifications: [], summary: ['Exact head CI checks passed.'] };
  };
  const readLiveMain = () => {
    const value = typeof w.liveMain === 'function' ? w.liveMain() : (w.liveMain ?? w.mergeBaseTip ?? TARGET);
    return value;
  };
  const run = (o = {}, deps = {}) => runGate(opts(o), { gh, ...clock(), evidenceCollector, readLiveMain, ...deps });
  return { w, gh, calls, observed, run };
}

test('CI path filter excludes docs and includes every agent-rule path', () => {
  assert.equal(ciWouldRun(['docs/a.md', 'README.md', 'NOTICE', 'LICENSE']), false);
  for (const file of [
    'apps/a.ts',
    'INTAFACED_DEFINITIVE_BUILD.md',
    'AGENTS.md',
    'docs/SKILL.md',
    '.agents/skills/a/SKILL.md',
    '.cursor/rules/a.md',
    'tooling/agent-protocol/AGENT_PROTOCOL.md',
  ])
    assert.equal(ciWouldRun([file]), true, file);
});
test(
  'CI path filter mirror matches workflow including agent rules',
  { skip: !existsSync(new URL('../../.github/workflows/ci.yml', import.meta.url)) && 'workflow absent in tooling-only fixture' },
  () => {
    const yml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const block = yml.match(/pull_request:\n {4}paths:\n((?: {6}(?:- .*|#.*)\n)+)/)?.[1] ?? '';
    const paths = block
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => l.replace(/^ +- /, '').replace(/^'|'$/g, ''));
    assert.deepEqual(paths, CI_PR_PATHS);
    assert.ok(AGENT_RULE_PATTERNS.every((p) => paths.includes(p)));
  },
);
test('collapse checks retains latest attempts separately per workflow', () => {
  const checks = collapseChecks([chk('A', 'fail'), { ...chk('A'), completedAt: '2026-10-16T00:00:00Z' }, chk('A', 'fail', 'Other')]);
  assert.equal(checks.length, 2);
  assert.equal(checks[0].bucket, 'pass');
});
test('coverage requires common jobs and the affected shard or full suite', () => {
  const common = CI.filter((c) => c.name !== 'Tests (full)');
  assert.deepEqual(coverageProblems(['services/svc-trade/a.ts'], [...common, chk('Tests (trade)')]), []);
  assert.deepEqual(coverageProblems(['tooling/scripts/a.mjs'], CI), []);
  assert.match(coverageProblems(['services/svc-trade/a.ts'], [...common, chk('Tests (trade)', 'skipping')]).join(), /Tests \(trade\)/);
  assert.match(coverageProblems(['tooling/scripts/a.mjs'], [...common, chk('Tests (trade)')]).join(), /Tests \(full\)/);
  assert.match(
    coverageProblems(['apps/web/a.ts'], [chk('changes')]).join(),
    /Doctrine gates.*Typecheck.*Format.*Definition of Done.*Tests/,
  );
});
test('a red merge seal plus a skipped Definition of Done refuses', async () => {
  const checks = [
    ...REQ,
    ...CI.filter((c) => c.name !== 'Definition of Done'),
    chk('Definition of Done', 'skipping'),
    chk('CI merge seal', 'fail'),
  ];
  const r = await world({
    checks,
    evidence: {
      pass: true,
      reasons: [],
      classifications: [
        {
          check: 'CI/CI merge seal',
          classification: 'inherited',
          allowed: true,
          noNewFailures: true,
          reason: 'seal excused by a clear full suite',
        },
      ],
      summary: [],
    },
  }).run();
  assert.equal(r.code, 1);
  assert.match(r.evalResult.reasons.join('\n'), /Definition of Done/);
  assert.equal(r.verdict, 'FAIL');
});
test('PASS distinguishes full review merge base from tested target tip, never merges or writes receipt', async () => {
  const w = world();
  const r = await w.run();
  assert.equal(r.code, 0);
  assert.equal(r.base, TARGET);
  assert.equal(r.reviewBase, BASE);
  assert.equal(r.targetBase, TARGET);
  assert.equal(w.observed[0].base, TARGET);
  assert.equal(w.observed[0].head, HEAD);
  assert.equal(r.mergeCommand, mergeCommand(7, HEAD, REPO));
  assert.match(r.comment, /Review merge base/);
  assert.equal(r.receipt, undefined);
  assert.equal(w.calls.filter((c) => c.args[1] === 'comment').length, 1);
  assert.ok(!w.calls.some((c) => c.args.includes('merge')));
  assert.ok(w.calls.some((c) => c.args.includes(`repos/${REPO}/compare/${TARGET}...${HEAD}`)));
  assert.ok(!w.calls.some((c) => c.args.includes('--branch')));
});
test('body and all paginated comments are declarations for evidence', async () => {
  const w = world({
    pr: pr({ body: 'Author-Session: author' }),
    comments: [{ body: 'Inherited-Failure: CI/Format | owner=nitro | evidence=https://example.test' }],
  });
  await w.run();
  assert.match(w.observed[0].declarations, /Author-Session: author\nInherited-Failure:/);
});
test('failed exact evidence blocks with its classification and reason', async () => {
  const w = world({
    evidence: {
      pass: false,
      reasons: ['unknown signature blocks'],
      classifications: [{ check: 'CI/Tests (full)', classification: 'unknown', reason: 'missing exact base' }],
      summary: [],
    },
  });
  const r = await w.run();
  assert.equal(r.code, 1);
  assert.equal(r.mergeCommand, undefined);
  assert.match(r.comment, /unknown.*missing exact base/);
});
test('required checks must be green and cannot be substituted by same-named workflows', async () => {
  for (const checks of [
    [chk('Gitleaks'), REQ[1], ...CI],
    [chk('Gitleaks', 'fail', 'Gitleaks'), REQ[1], ...CI],
    [REQ[0], chk('Dependency audit', 'skipping', 'Supply chain'), ...CI],
  ]) {
    const r = await world({ checks }).run();
    assert.equal(r.code, 1);
    assert.match(r.evalResult.reasons.join(), /required check/);
  }
});
test('docs-only emits report and checks every reported red job', async () => {
  const w = world({ files: [{ filename: 'README.md' }], checks: REQ, runs: [] });
  const r = await w.run();
  assert.equal(r.code, 0);
  assert.equal(w.observed.length, 0);
  assert.match(r.comment, /Docs-only report/);
  const bad = await world({ files: [{ filename: 'README.md' }], checks: [...REQ, chk('Prettier', 'fail', 'Docs format')], runs: [] }).run();
  assert.equal(bad.code, 1);
  assert.match(bad.comment, /docs-only reported check failed/);
});
test('CI-present shell and skipped tests cannot satisfy non-doc coverage', async () => {
  const r = await world({ checks: [...REQ, chk('changes'), ...CI.map((c) => ({ ...c, bucket: 'skipping' }))] }).run();
  assert.equal(r.code, 1);
  assert.match(r.comment, /Required CI coverage missing.*Doctrine gates/);
});
test('missing CI blocks code and agent-rule PRs after bounded grace', async () => {
  for (const filename of ['apps/a.ts', 'AGENTS.md']) {
    const r = await world({ files: [{ filename }], checks: REQ, runs: [] }).run();
    assert.equal(r.code, 1);
    assert.match(r.comment, /CI never started/);
  }
});
test('waits for finished checks and active runs for two polls', async () => {
  let count = 0;
  const w = world({ checks: () => (++count < 3 ? [...REQ, ...CI, chk('extra', 'pending')] : [...REQ, ...CI]) });
  assert.equal((await w.run()).code, 0);
  assert.ok(count >= 5);
});
test('timeout cannot be bypassed by overdue missing check while another job runs', async () => {
  await assert.rejects(
    world({ checks: [REQ[0], ...CI, chk('long', 'pending')], runs: [{ workflowName: 'CI', status: 'in_progress' }] }).run({
      timeoutMin: 0.1,
    }),
    /not finished/,
  );
});
test('wrong head, closed, draft, non-main and invalid base stop before checks', async () => {
  for (const [extra, pattern] of [
    [{ headRefOid: BASE }, /not the reviewed/],
    [{ state: 'MERGED' }, /not OPEN/],
    [{ isDraft: true }, /draft/],
    [{ baseRefName: 'dev' }, /not main/],
    [{ baseRefOid: '' }, /base commit/],
  ]) {
    const w = world({ pr: pr(extra) });
    await assert.rejects(w.run(), pattern);
    assert.ok(!w.calls.some((c) => c.args[1] === 'checks'));
  }
});
test('incomplete changed-file list and missing merge base fail closed', async () => {
  await assert.rejects(world({ pr: pr({ changedFiles: 2 }) }).run(), /incomplete/);
  await assert.rejects(world({ base: 'bad' }).run(), /merge base/);
});
test('rename retains old protected path and requires validated review', async () => {
  const w = world({ files: [{ filename: 'docs/moved.md', previous_filename: 'services/svc-ledger/src/a.ts' }] });
  const r = await w.run();
  assert.equal(r.code, 1);
  assert.ok(r.evalResult.protectedFiles.includes('services/svc-ledger/src/a.ts'));
  assert.ok(w.observed[0].files.includes('services/svc-ledger/src/a.ts'));
});
test('protected paths accept only review validator PASS for that head', async () => {
  const w = world({ files: [{ filename: 'packages/ledger-client/src/a.ts' }] });
  let input;
  const r = await w.run(
    {},
    {
      reviewValidator: (i) => {
        input = i;
        return { pass: true, reasons: [], review: { reviewerSession: 'reviewer' } };
      },
    },
  );
  assert.equal(input.head, HEAD);
  assert.equal(r.code, 0);
  assert.match(r.comment, /session reviewer/);
});
test('gate edits need a declared title and independent review even when checks pass', async () => {
  const files = [{ filename: 'tooling/scripts/merge-evidence.mjs' }];
  const r = await world({ files }).run();
  assert.equal(r.code, 1);
  assert.match(r.comment, /without a ci: or gate:/);
  const declared = await world({ files, pr: pr({ title: 'gate: evidence' }) }).run();
  assert.equal(declared.code, 1);
  assert.match(declared.comment, /Author-Session/);
  const reviewed = await world({ files, pr: pr({ title: 'gate: evidence' }) }).run(
    {},
    {
      reviewValidator: () => ({ pass: true, reasons: [], review: { reviewerSession: 'reviewer' } }),
    },
  );
  assert.equal(reviewed.code, 0);
});
test('a reviewed gate edit cannot authorize itself from the PR copy or leave a receipt', async () =>
  withReceipts(async (receiptRoot) => {
    const old = seedReceipt(receiptRoot);
    const w = world({ files: [{ filename: '.github/workflows/ci.yml' }], pr: pr({ title: 'gate: evidence' }) });
    await assert.rejects(
      runVerifiedGate(opts(), {
        git: fakeGit({ 'rev-parse HEAD': { status: 0, stdout: BASE } }).git,
        gh: w.gh,
        receiptRoot,
        reviewValidator: () => ({ pass: true, reasons: [], review: { reviewerSession: 'reviewer' } }),
        runGateFn: (o) => w.run(o, { reviewValidator: () => ({ pass: true, reasons: [], review: { reviewerSession: 'reviewer' } }) }),
        writeReceipt: () => assert.fail('PR gate copy must never authorize a receipt'),
      }),
      /branch HEAD differs/,
    );
    assert.equal(existsSync(old.path), false);
    assert.equal(w.calls.length, 0);
  }));
test('head, target base, title, open state and draft are rechecked after evidence', async () => {
  for (const [extra, pattern] of [
    [{ headRefOid: BASE }, /head moved/],
    [{ baseRefOid: BASE }, /base moved/],
    [{ title: 'changed' }, /title or declarations/],
    [{ state: 'CLOSED' }, /not OPEN/],
    [{ isDraft: true }, /draft/],
  ]) {
    const w = world();
    await assert.rejects(
      w.run(
        {},
        {
          evidenceCollector: async () => {
            w.w.pr = pr(extra);
            return { pass: true, reasons: [], classifications: [], summary: [] };
          },
        },
      ),
      pattern,
    );
  }
});
test('new pending checks and restarted runs after evidence require a fresh run', async () => {
  for (const change of ['checks', 'runs']) {
    const w = world();
    await assert.rejects(
      w.run(
        {},
        {
          evidenceCollector: async () => {
            if (change === 'checks') w.w.checks = [...REQ, ...CI, chk('new', 'pending')];
            else w.w.runs = [{ workflowName: 'CI', status: 'queued' }];
            return { pass: true, reasons: [], classifications: [], summary: [] };
          },
        },
      ),
      /changed or restarted/,
    );
  }
});
test('merge conflict blocks even with valid evidence', async () => {
  const r = await world({ pr: pr({ mergeable: 'CONFLICTING' }) }).run();
  assert.equal(r.code, 1);
  assert.match(r.comment, /merge conflicts/);
});
test('GitHub 403 stops after one call without retry or comment', async () => {
  const w = world({ refuse: 'pr checks' });
  await assert.rejects(w.run(), GitHubRefusalError);
  assert.equal(w.calls.filter((c) => c.args[1] === 'checks').length, 1);
  assert.ok(!w.calls.some((c) => c.args[1] === 'comment'));
});
function fakeGit(overrides = {}) {
  const calls = [];
  const git = (args) => {
    const key = args.join(' ');
    calls.push(key);
    if (overrides[key]) return overrides[key];
    if (args[0] === 'cat-file' && args[1] === '-t') return { status: 0, stdout: 'commit\n', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') return { status: 0, stdout: `${HEAD}\n`, stderr: '' };
    return { status: 0, stdout: args[0] === 'rev-parse' ? `${TARGET}\n` : '', stderr: '' };
  };
  return { git, calls };
}
test('main copy proves fetched HEAD, clean tracked gate dirs and all untracked dependencies', () => {
  const { git, calls } = fakeGit();
  assert.equal(mainCopyProblem(git), null);
  assert.deepEqual(calls, [
    'fetch -q origin main',
    'rev-parse origin/main',
    'rev-parse HEAD',
    'diff --quiet origin/main -- tooling/scripts tooling/ci .github/workflows package.json :(glob)apps/*/package.json :(glob)services/*/package.json :(glob)packages/*/package.json',
    'ls-files --others -- tooling/scripts tooling/ci .github/workflows package.json :(glob)apps/*/package.json :(glob)services/*/package.json :(glob)packages/*/package.json',
  ]);
  assert.ok(!calls.some((c) => c.includes('--exclude-standard')), 'ignored spoof dependencies must also be listed');
});
test('main copy refuses branch execution, tracked edits, untracked imports and lookup errors', () => {
  const cases = [
    [{ 'fetch -q origin main': { status: 128, stderr: 'offline' } }, /could not fetch/],
    [{ 'rev-parse HEAD': { status: 0, stdout: BASE } }, /branch HEAD differs/],
    [{ 'rev-parse origin/main': { status: 0, stdout: '' } }, /Could not prove/],
    [
      {
        'diff --quiet origin/main -- tooling/scripts tooling/ci .github/workflows package.json :(glob)apps/*/package.json :(glob)services/*/package.json :(glob)packages/*/package.json':
          { status: 1 },
      },
      /Gate files differ/,
    ],
    [
      {
        'diff --quiet origin/main -- tooling/scripts tooling/ci .github/workflows package.json :(glob)apps/*/package.json :(glob)services/*/package.json :(glob)packages/*/package.json':
          { status: 129, stderr: 'bad' },
      },
      /git diff.*failed/,
    ],
    [
      {
        'ls-files --others -- tooling/scripts tooling/ci .github/workflows package.json :(glob)apps/*/package.json :(glob)services/*/package.json :(glob)packages/*/package.json':
          { status: 0, stdout: 'tooling/scripts/merge-review.mjs' },
      },
      /Untracked gate files/,
    ],
  ];
  for (const [overrides, pattern] of cases) assert.match(mainCopyProblem(fakeGit(overrides).git), pattern);
});

const withReceipts = async (fn) => {
  const receiptRoot = mkdtempSync(join(tmpdir(), 'merge-gate-lifecycle-'));
  try {
    await fn(receiptRoot);
  } finally {
    rmSync(receiptRoot, { recursive: true, force: true });
  }
};
const seedReceipt = (receiptRoot) =>
  writePassReceipt({
    repo: REPO,
    pr: 7,
    head: HEAD,
    base: BASE,
    gateSha: HEAD,
    liveHead: HEAD,
    evidence: { pass: true, reasons: [], classifications: [], summary: [] },
    receiptRoot,
  });
test('unit orchestration cannot write live receipts without explicit isolated root', async () => {
  await assert.rejects(runVerifiedGate(opts(), { git: fakeGit().git, gh: world().gh }), /Only the production CLI/);
});
test('verified lifecycle saves exact bound receipt before posting PASS', async () =>
  withReceipts(async (receiptRoot) => {
    const w = world();
    let writeInput;
    const r = await runVerifiedGate(opts(), {
      git: fakeGit().git,
      gh: w.gh,
      receiptRoot,
      runGateFn: (o) => w.run(o),
      writeReceipt: (i) => {
        assert.ok(!w.calls.some((c) => c.args[1] === 'comment'), 'PASS must wait for persisted receipt');
        writeInput = i;
        return writePassReceipt(i);
      },
    });
    assert.equal(writeInput.gateSha, TARGET);
    assert.equal(writeInput.base, TARGET);
    assert.ok(existsSync(r.receipt.path));
    const saved = JSON.parse(readFileSync(r.receipt.path, 'utf8'));
    assert.equal(saved.head, HEAD);
    assert.equal(saved.base, TARGET);
    assert.equal(saved.status, 'PASS');
    assert.equal(w.calls.filter((c) => c.args[1] === 'comment').length, 1);
  }));
test('copy refusal invalidates earlier PASS before doing any GitHub work', async () =>
  withReceipts(async (receiptRoot) => {
    const old = seedReceipt(receiptRoot),
      w = world();
    await assert.rejects(
      runVerifiedGate(opts(), { git: fakeGit({ 'rev-parse HEAD': { status: 0, stdout: BASE } }).git, gh: w.gh, receiptRoot }),
      /branch HEAD differs/,
    );
    assert.equal(existsSync(old.path), false);
    assert.equal(w.calls.length, 0);
  }));
test('failed evidence and thrown GitHub refusal invalidate stale receipt and never write PASS', async () =>
  withReceipts(async (receiptRoot) => {
    for (const throws of [false, true]) {
      const old = seedReceipt(receiptRoot),
        w = world({ evidence: { pass: false, reasons: ['unknown'], classifications: [], summary: [] } });
      const call = () =>
        runVerifiedGate(opts(), {
          git: fakeGit().git,
          gh: w.gh,
          receiptRoot,
          runGateFn: throws
            ? async () => {
                throw new GitHubRefusalError('403');
              }
            : (o) => w.run(o),
          writeReceipt: () => assert.fail('must not write PASS'),
        });
      if (throws) await assert.rejects(call(), GitHubRefusalError);
      else assert.equal((await call()).code, 1);
      assert.equal(existsSync(old.path), false);
    }
  }));
test('late main-copy refusal cannot publish PASS or leave a receipt', async () =>
  withReceipts(async (receiptRoot) => {
    const old = seedReceipt(receiptRoot),
      w = world();
    let calls = 0;
    const g = fakeGit();
    const git = (args) => {
      if (args[0] === 'fetch' && args.at(-1) === 'main' && ++calls === 2) return { status: 128, stderr: 'offline' };
      return g.git(args);
    };
    await assert.rejects(runVerifiedGate(opts(), { git, gh: w.gh, receiptRoot, runGateFn: (o) => w.run(o) }), /could not fetch/);
    assert.equal(existsSync(old.path), false);
    assert.ok(!w.calls.some((c) => c.args[1] === 'comment'));
  }));
test('PR drift during final main verification blocks receipt and PASS comment', async () =>
  withReceipts(async (receiptRoot) => {
    const w = world();
    let fetches = 0;
    const g = fakeGit();
    const git = (args) => {
      if (args[0] === 'fetch' && args.at(-1) === 'main' && ++fetches === 2) w.w.pr = pr({ isDraft: true });
      return g.git(args);
    };
    await assert.rejects(
      runVerifiedGate(opts(), {
        git,
        gh: w.gh,
        receiptRoot,
        runGateFn: (o) => w.run(o),
        writeReceipt: () => assert.fail('must not write'),
      }),
      /PR changed before receipt/,
    );
    assert.ok(!w.calls.some((c) => c.args[1] === 'comment'));
  }));
test('comment refusal removes just-written receipt and stops immediately', async () =>
  withReceipts(async (receiptRoot) => {
    const old = seedReceipt(receiptRoot),
      w = world({ refuse: 'pr comment' });
    await assert.rejects(
      runVerifiedGate(opts(), { git: fakeGit().git, gh: w.gh, receiptRoot, runGateFn: (o) => w.run(o) }),
      GitHubRefusalError,
    );
    assert.equal(existsSync(old.path), false);
    assert.equal(w.calls.filter((c) => c.args[1] === 'comment').length, 1);
  }));

test('main-copy policy inputs include every workspace manifest used for protected-task provenance', () => {
  const { git, calls } = fakeGit();
  mainCopyProblem(git);
  for (const prefix of ['apps', 'services', 'packages']) {
    assert.ok(calls.find((c) => c.startsWith('diff ')).includes(`:(glob)${prefix}/*/package.json`));
    assert.ok(calls.find((c) => c.startsWith('ls-files ')).includes(`:(glob)${prefix}/*/package.json`));
  }
});

test('final verification tolerates gh checks exit one for explicitly inherited red evidence', async () =>
  withReceipts(async (receiptRoot) => {
    const w = world({ checks: [...REQ, ...CI.map((c) => (c.name === 'Tests (full)' ? { ...c, bucket: 'fail', state: 'FAIL' } : c))] });
    const gh = (args, options = {}) => {
      if (args[0] === 'pr' && args[1] === 'checks') assert.equal(options.allowFail, true, 'red checks exit 1 with usable JSON');
      return w.gh(args, options);
    };
    const r = await runVerifiedGate(opts(), { git: fakeGit().git, gh, receiptRoot, runGateFn: (o) => w.run(o) });
    assert.equal(r.code, 0);
    assert.ok(existsSync(r.receipt.path));
  }));

test('edited or deleted declaration comments during evidence block the verdict', async () => {
  for (const edit of [true, false]) {
    const w = world({ comments: [{ id: 1, body: 'Author-Session: original' }] });
    await assert.rejects(
      w.run(
        {},
        {
          evidenceCollector: async () => {
            w.w.comments = edit ? [{ id: 1, body: 'Author-Session: changed' }] : [];
            return { pass: true, reasons: [], classifications: [], summary: [] };
          },
        },
      ),
      /declarations changed in comments/,
    );
  }
});
test('declaration comment drift during main verification blocks the receipt', async () =>
  withReceipts(async (receiptRoot) => {
    const w = world({ comments: [{ id: 1, body: 'Author-Session: original' }] });
    let fetches = 0;
    const g = fakeGit();
    const git = (args) => {
      if (args[0] === 'fetch' && args.at(-1) === 'main' && ++fetches === 2) w.w.comments = [];
      return g.git(args);
    };
    await assert.rejects(
      runVerifiedGate(opts(), {
        git,
        gh: w.gh,
        receiptRoot,
        runGateFn: (o) => w.run(o),
        writeReceipt: () => assert.fail('must not write'),
      }),
      /declarations changed before receipt/,
    );
  }));

test('wrapping a declaration in a Markdown fence invalidates the snapshot', async () => {
  const body = `Opus-Review: ${HEAD} 11111111-1111-1111-1111-111111111111 PASS`;
  const w = world({ comments: [{ id: 1, body }] });
  await assert.rejects(
    w.run(
      {},
      {
        evidenceCollector: async () => {
          w.w.comments = [{ id: 1, body: ['```', body, '```'].join('\n') }];
          return { pass: true, reasons: [], classifications: [], summary: [] };
        },
      },
    ),
    /declarations changed in comments/,
  );
});

test('an added marker-free comment cannot change declaration Markdown context', async () => {
  const w = world({ comments: [{ id: 2, body: 'Author-Session: original' }] });
  await assert.rejects(
    w.run(
      {},
      {
        evidenceCollector: async () => {
          w.w.comments.unshift({ id: 1, author_association: 'OWNER', body: '```' });
          return { pass: true, reasons: [], classifications: [], summary: [] };
        },
      },
    ),
    /declarations changed in comments/,
  );
});

test('receipt publication revalidates the current transcript and blocks a withdrawn approval', async () =>
  withReceipts(async (receiptRoot) => {
    const review = {
      head: HEAD,
      authorSession: '11111111-1111-1111-1111-111111111111',
      reviewerSession: '22222222-2222-2222-2222-222222222222',
    };
    const w = world({ files: [{ filename: 'services/svc-bank/src/a.ts' }] });
    await assert.rejects(
      runVerifiedGate(opts(), {
        git: fakeGit().git,
        gh: w.gh,
        receiptRoot,
        runGateFn: (o) => w.run(o, { reviewValidator: () => ({ pass: true, reasons: [], review }) }),
        reviewValidator: () => ({ pass: false, reasons: ['Latest exact-head verdict is FAIL'] }),
        writeReceipt: () => assert.fail('withdrawn approval must never write a receipt'),
      }),
      /Opus review changed or was withdrawn/,
    );
    assert.equal(
      w.calls.some((c) => c.args[1] === 'comment'),
      false,
    );
  }));

test('outsider declarations and outsider comment drift cannot alter the gate input', async () => {
  const w = world({ comments: [{ id: 1, author_association: 'NONE', body: 'Author-Session: attacker' }] });
  await w.run(
    {},
    {
      evidenceCollector: async (input) => {
        assert.doesNotMatch(input.declarations, /attacker/);
        w.w.comments.push({
          id: 2,
          author_association: 'NONE',
          body: 'Inherited-Failure: attacker | owner=outsider | evidence=https://example.com',
        });
        return { pass: true, reasons: [], classifications: [], summary: [] };
      },
    },
  );
});
test('only trusted comment associations contribute declarations', async () => {
  const w = world({
    comments: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIMER', 'NONE'].map((association, id) => ({
      id,
      author_association: association,
      body: `trusted-association=${association}`,
    })),
  });
  await w.run();
  const declarations = w.observed[0].declarations;
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR'])
    assert.match(declarations, new RegExp(`trusted-association=${association}`));
  for (const association of ['CONTRIBUTOR', 'FIRST_TIMER', 'NONE'])
    assert.doesNotMatch(declarations, new RegExp(`trusted-association=${association}`));
});

test('outsider PR body cannot supply or poison declarations; trusted commenters still can', async () => {
  for (const association of ['NONE', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'CONTRIBUTOR', null]) {
    const w = world({
      pr: pr({
        authorAssociation: association,
        body: 'Author-Session: outsider\nInherited-Failure: CI/Tests (full) | owner=outsider | evidence=https://example.com/fake',
      }),
      comments: [{ id: 1, body: 'trusted comment', author_association: 'COLLABORATOR' }],
    });
    const result = await w.run();
    assert.equal(result.code, 0);
    assert.equal(w.observed[0].declarations, '\ntrusted comment');
  }
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    const w = world({ pr: pr({ authorAssociation: association, body: 'trusted body' }) });
    assert.equal((await w.run()).code, 0);
    assert.equal(w.observed[0].declarations, 'trusted body');
  }
});
test('ignored outsider body drift does not force a rerun; trusted author status drift does', async () => {
  for (const elevate of [false, true]) {
    const w = world({ pr: pr({ authorAssociation: 'NONE', body: 'outsider initial' }) });
    const run = () =>
      w.run(
        {},
        {
          evidenceCollector: async () => {
            w.w.pr.body = 'outsider edit';
            if (elevate) w.w.pr.authorAssociation = 'COLLABORATOR';
            return { pass: true, reasons: [], classifications: [], summary: [] };
          },
        },
      );
    if (elevate) await assert.rejects(run(), /declarations changed/);
    else assert.equal((await run()).code, 0);
  }
});

test('tested base is the merge result main parent, not the PR creation base or merge-base', async () => {
  const w = world({ pr: pr({ baseRefOid: BASE }) });
  const result = await w.run();
  assert.equal(result.base, TARGET);
  assert.equal(result.reviewBase, BASE);
  assert.equal(result.liveMain, TARGET);
  assert.equal(w.observed[0].mergeSha, MERGE);
});
test('a stale merge parent that is not live main is refused at the start', async () => {
  const live = 'e'.repeat(40);
  const w = world({ liveMain: live });
  await assert.rejects(w.run(), /Tested main parent .* is not the live main ref/);
});
test('live main moving before the verdict is refused', async () => {
  let reads = 0;
  const w = world({ liveMain: () => (reads++ === 0 ? TARGET : 'e'.repeat(40)) });
  await assert.rejects(w.run(), /Live main moved during this gate run/);
});
test('two runs sharing a required check key fail closed instead of keeping the latest', async () => {
  const older = {
    ...REQ[0],
    bucket: 'fail',
    state: 'FAIL',
    completedAt: '2026-10-15T00:00:00Z',
    link: 'https://github.com/o/r/actions/runs/1/job/9',
  };
  const newer = { ...REQ[0], bucket: 'pass', completedAt: '2026-10-16T00:00:00Z', link: 'https://github.com/o/r/actions/runs/2/job/10' };
  assert.match(sharedRequiredCheckProblem([older, newer]), /9002\/Gitleaks ×2/);
  assert.equal(sharedRequiredCheckProblem([...REQ, ...CI]), null);
  await assert.rejects(world({ checks: [older, newer, REQ[1], ...CI] }).run(), /shared by more than one run/);
});
test('checks collapse by workflow id and job name, so a second CI cannot hide a red job', () => {
  const red = chk('Typecheck & build', 'fail', 'CI', 9001);
  const impostor = { ...chk('Typecheck & build', 'pass', 'CI', 9099), completedAt: '2026-10-16T00:00:00Z' };
  const kept = collapseChecks([red, impostor]);
  assert.equal(kept.length, 2);
  assert.ok(kept.some((c) => c.workflowId === 9001 && c.bucket === 'fail'));
  assert.equal(sharedRequiredCheckProblem([red, impostor]), null);
  const joined = identifyChecks(
    [{ name: 'Typecheck & build', workflow: 'CI', bucket: 'fail', link: 'https://github.com/o/r/actions/runs/55/job/7' }],
    [{ databaseId: 55, workflowDatabaseId: 9001, status: 'completed' }],
  );
  assert.equal(joined[0].workflowId, 9001);
  assert.throws(
    () => identifyChecks([{ name: 'Typecheck & build', workflow: 'CI', link: 'https://example.test/nope' }], []),
    /no workflow id/,
  );
});

test('reviewer input fetches the PR head and writes the patch file, hash and file list', () => {
  const dest = mkdtempSync(join(tmpdir(), 'reviewer-input-'));
  const patchBody = 'diff --git a/src/a.ts b/src/a.ts\n';
  try {
    const calls = [];
    const git = (args) => {
      calls.push(args.join(' '));
      const key = args.join(' ');
      if (key === 'fetch -q origin main') return { status: 0, stdout: '', stderr: '' };
      if (key === 'rev-parse origin/main') return { status: 0, stdout: `${TARGET}\n`, stderr: '' };
      if (key === `fetch -q origin ${HEAD}`) return { status: 0, stdout: '', stderr: '' };
      if (key === `cat-file -t ${HEAD}`) return { status: 0, stdout: 'commit\n', stderr: '' };
      if (key === `merge-base origin/main ${HEAD}`) return { status: 0, stdout: `${BASE}\n`, stderr: '' };
      if (args[0] === '-c' && args.includes('diff')) return { status: 0, stdout: patchBody, stderr: '' };
      throw new Error(`unexpected git ${key}`);
    };
    const written = writeReviewerInput({ pr: 7, head: HEAD, repo: REPO, dest, git });
    assert.equal(written.patchHash.length, 64);
    assert.deepEqual(written.files, ['src/a.ts']);
    assert.equal(readFileSync(written.patchFile, 'utf8'), patchBody);
    const manifest = JSON.parse(readFileSync(written.manifestPath, 'utf8'));
    assert.equal(manifest.head, HEAD);
    assert.equal(manifest.base, BASE);
    assert.equal(manifest.liveMain, TARGET);
    assert.equal(manifest.patchFile, written.patchFile);
    assert.ok(calls.some((c) => c === `fetch -q origin ${HEAD}`));
    assert.ok(GIT_MAX_BUFFER > 1024 * 1024);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('pre-receipt refuses a tested parent that is not the captured live main', async () =>
  withReceipts(async (receiptRoot) => {
    const stale = 'e'.repeat(40);
    const w = world({ liveMain: stale, mergeBaseTip: stale });
    await assert.rejects(
      runVerifiedGate(opts(), {
        git: fakeGit().git,
        gh: w.gh,
        receiptRoot,
        runGateFn: (o) => w.run(o),
        writeReceipt: () => assert.fail('stale main parent must not write a receipt'),
      }),
      /Tested main parent .* is not the live main ref/,
    );
  }));

test('verified gate fetches the PR head before the patch and refuses a mismatched tip', async () =>
  withReceipts(async (receiptRoot) => {
    const w = world({ files: [{ filename: 'services/svc-bank/src/a.ts' }] });
    const order = [];
    const git = (args) => {
      order.push(args.join(' '));
      if (args[0] === 'cat-file') return { status: 0, stdout: 'commit\n', stderr: '' };
      return fakeGit().git(args);
    };
    const stopped = await runVerifiedGate(opts({ comment: false }), {
      git,
      gh: w.gh,
      receiptRoot,
      writeReceipt: () => assert.fail('this probe must not write a receipt'),
      runGateFn: (o, deps) => {
        assert.equal(o.head, HEAD);
        assert.ok(order.includes(`fetch -q origin ${HEAD}`), 'head is fetched before the patch is read');
        const patch = deps.readCanonicalPatch({ base: BASE, head: HEAD });
        assert.equal(patch.files.length, 0);
        assert.ok(order.at(-1).includes(`${BASE}...${HEAD}`));
        return { code: 1, comment: '', checks: [], snapshot: {}, declarationComments: '', evalResult: { reasons: ['probe'] } };
      },
    });
    assert.equal(stopped.code, 1);
    const mismatch = [];
    const bad = (args) => {
      mismatch.push(args.join(' '));
      if (args.join(' ') === `fetch -q origin ${HEAD}`) return { status: 128, stderr: 'missing object' };
      if (args[0] === 'cat-file') return { status: 0, stdout: 'commit\n', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') return { status: 0, stdout: `${BASE}\n`, stderr: '' };
      return fakeGit().git(args);
    };
    await assert.rejects(
      runVerifiedGate(opts(), {
        git: bad,
        gh: w.gh,
        receiptRoot,
        runGateFn: () => assert.fail('a mismatched tip must not reach the patch'),
      }),
      /does not match the reviewed head/,
    );
    assert.ok(mismatch.includes('fetch -q origin pull/7/head'));
  }));

test('canonical patch files must match the GitHub PR file list', async () => {
  const hash = 'ab'.repeat(32);
  const files = [{ filename: 'services/svc-bank/src/new.ts', previous_filename: 'services/svc-bank/src/old.ts' }];
  const review = { reviewerSession: 'reviewer' };
  const patch = {
    hash,
    files: ['services/svc-bank/src/new.ts', 'services/svc-bank/src/old.ts'],
    patch: 'diff --git a/services/svc-bank/src/old.ts b/services/svc-bank/src/old.ts\n',
  };
  const ok = await world({ files, pr: pr({ changedFiles: 1, title: 'fix: rename' }) }).run(
    {},
    {
      readCanonicalPatch: () => patch,
      reviewValidator: () => ({ pass: true, reasons: [], review }),
    },
  );
  assert.equal(ok.code, 0, ok.evalResult.reasons.join('; '));
  await assert.rejects(
    world({ files, pr: pr({ changedFiles: 1 }) }).run(
      {},
      { readCanonicalPatch: () => ({ ...patch, files: ['services/svc-bank/src/new.ts'] }) },
    ),
    /GitHub PR file list/,
  );
});

test('pre-receipt re-check covers an infra-only change', async () =>
  withReceipts(async (receiptRoot) => {
    const review = { head: HEAD, base: BASE, reviewerSession: '22222222-2222-2222-2222-222222222222' };
    const w = world({ files: [{ filename: 'packages/ui/package.json' }] });
    await assert.rejects(
      runVerifiedGate(opts(), {
        git: fakeGit().git,
        gh: w.gh,
        receiptRoot,
        runGateFn: (o) => w.run(o, { reviewValidator: () => ({ pass: true, reasons: [], review }) }),
        reviewValidator: () => ({ pass: false, reasons: ['Latest exact-head verdict is FAIL'] }),
        writeReceipt: () => assert.fail('infra-only withdrawal must never write a receipt'),
      }),
      /Opus review changed or was withdrawn/,
    );
    assert.equal(
      w.calls.some((c) => c.args[1] === 'comment'),
      false,
    );
  }));
