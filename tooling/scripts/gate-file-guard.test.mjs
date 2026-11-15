/**
 * Unit tests for gate-file-guard.mjs and gate-gh.mjs. No network.
 * Run: node --test tooling/scripts/gate-file-guard.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GitHubRefusalError, makeGh } from './gate-gh.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MARKER,
  changedFiles,
  evaluateGateFileRule,
  gateFilesTouched,
  listGitFiles,
  renderComment,
  titleStatesGateChange,
  upsertComment,
} from './gate-file-guard.mjs';

test('title declarations: accepted forms', () => {
  for (const t of [
    'ci: widen allowlist',
    'ci(deps): bump audit list',
    'CI: shout',
    'gate: new scan',
    'gate(money): x',
    'chore(ci): pin node',
    'fix(ci): run every package',
    'test(gate): cover x',
    'ci!: breaking',
    'fix: thing [gate-change]',
    '[GATE-CHANGE] fix',
    'docs: x [gate-change] y',
  ]) {
    assert.equal(titleStatesGateChange(t), true, t);
  }
});

test('title declarations: refused forms (#4402 shape included)', () => {
  for (const t of [
    'fix(identity): recover bounded input checks',
    'fix(db): repair the migration runner',
    'docs: explain ci',
    'feat(ci-tools): x',
    'cicd: x',
    'circuit: x',
    'gateway: fix',
    'fix: gate',
    '',
    undefined,
  ]) {
    assert.equal(titleStatesGateChange(t), false, String(t));
  }
});

test('gate files: the four things the brief names, plus the tools themselves', () => {
  const touched = (f) => gateFilesTouched([f]).length === 1;
  assert.ok(touched('tooling/ci/dependency-audit.mjs')); // dependency-audit allowlist (KNOWN)
  assert.ok(touched('tooling/ci/secret-scan.mjs')); // secret-scan inventory
  assert.ok(touched('tooling/ci/money-skip-inventory.mjs')); // money-skip inventory
  assert.ok(touched('tooling/ci/sub/deep/file.json'));
  assert.ok(touched('.github/workflows/ci.yml'));
  assert.ok(touched('.github/workflows/new-one.yaml'));
  assert.ok(touched('.gitleaks.toml'));
  assert.ok(touched('tooling/scripts/gate-gh.mjs'));
  assert.ok(touched('tooling/scripts/main-auto-revert.mjs'));
  assert.ok(touched('tooling/scripts/gate-file-guard.mjs'));
  // The journeys run's list and its steps (the factory's setup step 2): the baseline guard enforces the list's rules.
  assert.ok(touched('docs/runbooks/journey-baseline.json'));
  assert.ok(touched('docs/roadmap/journeys.json'));
  assert.ok(touched('tooling/coverage-law-index.json'));
  assert.ok(!touched('docs/runbooks/journey-baseline-proof/J-agents-03-6.txt'));
  assert.ok(!touched('docs/roadmap/slices.json'));
});

test('gate files: ordinary files are not gate files', () => {
  for (const f of [
    'services/svc-pay/src/a.ts',
    'tooling/scripts/worktree.mjs',
    'tooling/cia/x.mjs',
    'github/workflows/x.yml',
    'docs/ci.md',
    'apps/admin/package.json',
  ]) {
    assert.equal(gateFilesTouched([f]).length, 0, f);
  }
});

test('rule: undeclared change fails, declared passes, no gate file passes', () => {
  const files = ['services/svc-bank/drizzle/0019.sql', 'tooling/ci/dependency-audit.mjs'];
  assert.equal(evaluateGateFileRule('fix(bank): migration', files).ok, false);
  assert.equal(evaluateGateFileRule('ci: allow GHSA', files).ok, true);
  assert.equal(evaluateGateFileRule('fix(bank): migration', ['services/svc-bank/a.ts']).ok, true);
});

test('comment states the rule and lists the files', () => {
  const bad = renderComment(evaluateGateFileRule('fix: x', ['tooling/ci/secret-scan.mjs']));
  assert.ok(bad.startsWith(MARKER));
  assert.match(bad, /FAIL/);
  assert.match(bad, /tooling\/ci\/secret-scan\.mjs/);
  assert.match(bad, /`ci:`.*`gate:`.*`chore\(ci\):`.*\[gate-change\]/);
  assert.match(renderComment(evaluateGateFileRule('ci: x', ['tooling/ci/secret-scan.mjs'])), /OK, declared/);
});

test('upsertComment edits its own marked comment only, creates if absent, stays quiet when passing and absent', () => {
  const calls = [];
  const mk = (existing) => (args) => {
    calls.push(args);
    if (args.includes('--slurp')) return { stdout: JSON.stringify([existing]) };
    return { stdout: '' };
  };
  const other = { id: 1, body: 'a human comment' };
  const mine = { id: 2, body: `${MARKER}\nold` };
  assert.equal(upsertComment(mk([other, mine]), 'o/r', 5, `${MARKER}\nnew`), 'updated');
  assert.ok(calls.some((a) => a.includes('PATCH') && a.includes('repos/o/r/issues/comments/2')));
  assert.equal(
    calls.some((a) => a.join(' ').includes('comments/1')),
    false,
    'never touches a human comment',
  );
  calls.length = 0;
  assert.equal(upsertComment(mk([other]), 'o/r', 5, `${MARKER}\nnew`), 'created');
  calls.length = 0;
  assert.equal(upsertComment(mk([other]), 'o/r', 5, `${MARKER}\nok`, { onlyIfExisting: true }), 'none');
  assert.equal(calls.length, 1);
});

test('gate-gh: 403 and 429 throw a refusal; other failures throw plain errors; success passes through', () => {
  const spawn = (r) => () => r;
  assert.throws(() => makeGh({ spawn: spawn({ status: 1, stderr: 'HTTP 403: forbidden', stdout: '' }) })(['api', 'x']), GitHubRefusalError);
  assert.throws(
    () => makeGh({ spawn: spawn({ status: 1, stderr: 'gh: HTTP 429: rate limit', stdout: '' }) })(['api', 'x']),
    GitHubRefusalError,
  );
  assert.throws(
    () => makeGh({ spawn: spawn({ status: 1, stderr: 'HTTP 404: not found', stdout: '' }) })(['api', 'x']),
    (e) => !(e instanceof GitHubRefusalError),
  );
  // allowFail never swallows a refusal
  assert.throws(
    () => makeGh({ spawn: spawn({ status: 1, stderr: 'HTTP 429', stdout: '' }) })(['api', 'x'], { allowFail: true }),
    GitHubRefusalError,
  );
  assert.equal(makeGh({ spawn: spawn({ status: 1, stderr: 'HTTP 404', stdout: '' }) })(['api', 'x'], { allowFail: true }).status, 1);
  assert.equal(makeGh({ spawn: spawn({ status: 0, stdout: 'ok', stderr: '' }) })(['api', 'x']).stdout, 'ok');
});

test('gate files: the review additions (rules every agent loads, repo-wide config, refusal handling)', () => {
  for (const f of [
    'AGENTS.md',
    'CLAUDE.md',
    'services/svc-x/CLAUDE.md',
    'packages/a/b/CLAUDE.md',
    'tooling/agent-protocol/AGENT_PROTOCOL.md',
    '.agents/skills/x/SKILL.md',
    'docs/agents/build-slice.md',
    'services/svc-x/AGENTS.md',
    'tooling/x/SKILL.md',
    '.cursor/rules/inta.mdc',
    '.claude/settings.json',
    '.claude/agents/explore.md',
    '.github/dependabot.yml',
    '.github/CODEOWNERS',
    'turbo.json',
    '.prettierignore',
    'package.json',
    'tooling/scripts/github-refusal.mjs',
    'tooling/scripts/gate-gh.mjs',
    '.oxlintrc.json',
    'tooling/lint/oxlint-plugin-garden/index.js',
    'tooling/lint/ratchet.json',
  ]) {
    assert.equal(gateFilesTouched([f]).length, 1, f);
  }
  assert.equal(gateFilesTouched(['apps/admin/package.json', 'services/svc-pay/package.json']).length, 0, 'only the ROOT package.json');
});

test('no author is exempt: the root package.json needs a declaring title from everyone, bots included', () => {
  const files = ['package.json', 'pnpm-lock.yaml'];
  assert.equal(evaluateGateFileRule('chore(deps): bump x', files).ok, false);
  assert.equal(evaluateGateFileRule('ci(deps): bump x', files).ok, true);
  assert.equal(evaluateGateFileRule.length, 2, 'the rule takes only a title and files (no author argument)');
});

const DEPENDABOT = new URL('../../.github/dependabot.yml', import.meta.url);
test(
  'dependabot prefixes pass the title rule (npm bumps touch the root package.json, actions bumps touch workflows)',
  { skip: !existsSync(DEPENDABOT) && 'dependabot.yml not present (empty-tree run)' },
  () => {
    const yml = readFileSync(DEPENDABOT, 'utf8');
    for (const [eco, next] of [
      ['npm', "package-ecosystem: 'github-actions'"],
      ['github-actions', "package-ecosystem: 'maven'"],
    ]) {
      const start = yml.indexOf(`package-ecosystem: '${eco}'`);
      const block = yml.slice(start, yml.indexOf(next, start + 1));
      const prefixes = [...block.matchAll(/^\s+prefix(?:-development)?: '([^']+)'/gm)].map((m) => m[1]);
      assert.ok(prefixes.length >= 1, `${eco}: a prefix is set`);
      for (const prefix of prefixes)
        assert.equal(titleStatesGateChange(`${prefix}: Bump something from 1 to 2`), true, `${eco}: ${prefix}`);
    }
  },
);

test('gate-gh: a hung or unspawnable gh fails with a clear error, never hangs; a timeout is passed to spawn', () => {
  let seen;
  const hung = (bin, args, o) => (
    (seen = o),
    { error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null }
  );
  assert.throws(() => makeGh({ spawn: hung, timeoutMs: 5000 })(['api', 'x']), /did not complete \(ETIMEDOUT\) within 5s/);
  assert.equal(seen.timeout, 5000);
  makeGh({ spawn: (b, a, o) => ((seen = o), { status: 0, stdout: '', stderr: '' }) })(['api', 'x']);
  assert.equal(seen.timeout, 120000);
});

test('gate-gh: the GraphQL "API rate limit already exceeded" message is a refusal (exit 3 territory)', () => {
  const spawn = () => ({ status: 1, stderr: 'GraphQL: API rate limit already exceeded for user ID 123.', stdout: '' });
  assert.throws(() => makeGh({ spawn })(['pr', 'view', '1']), GitHubRefusalError);
  const secondary = () => ({ status: 1, stderr: 'You have exceeded a secondary rate limit.', stdout: '' });
  assert.throws(() => makeGh({ spawn: secondary })(['pr', 'view', '1']), GitHubRefusalError);
});

// project-state #2511: the API file list (`pulls/<n>/files`) was this check's only red in the week to 15 Nov 2026, each one
// "API rate limit exceeded for installation" (#8023, #8100, #8141). The workflow lists the files from git instead.
test('the workflow lists the PR files from git, never from the API budget', () => {
  const yml = readFileSync(new URL('../../.github/workflows/gate-file-guard.yml', import.meta.url), 'utf8');
  const runs = yml.split('\n').filter((l) => /node tooling\/scripts\/gate-file-guard\.mjs/.test(l));
  // The last call is the one every base that has the git list runs; an earlier one is only for an older base.
  assert.match(runs.at(-1) ?? '', /--base "\$BASE_SHA" --head "\$HEAD_SHA"/, 'the guard is given the base and head SHAs');
  assert.match(yml, /fetch-depth: 0/, 'the checkout has the history git needs for the merge base');
  assert.match(yml, /git fetch --no-tags --filter=blob:none origin "\$HEAD_SHA"/, 'the PR head is fetched as data');
});

test('with --base/--head the file list makes no GitHub call', () => {
  const gh = () => assert.fail('the API was called');
  const a = 'a'.repeat(40),
    b = 'b'.repeat(40);
  let seen;
  const files = changedFiles({ base: a, head: b, pr: '1', repo: 'o/r' }, gh, (args) => ((seen = args), 'x.ts\0tooling/ci/y.mjs\0'));
  assert.deepEqual(files, ['x.ts', 'tooling/ci/y.mjs']);
  assert.deepEqual(seen, ['diff', '--name-only', '--no-renames', '-z', `${a}...${b}`]);
  assert.throws(() => listGitFiles('main', b, () => ''), /full commit SHAs/);
  assert.throws(() => listGitFiles(a, undefined, () => ''), /full commit SHAs/);
});

test('the git list is the merge-base diff: base-side changes are not the PR, a moved gate file is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gfg-'));
  const git = (...args) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'tooling/ci'), { recursive: true });
    writeFileSync(join(dir, 'tooling/ci/scan.mjs'), 'a\n');
    writeFileSync(join(dir, 'app.ts'), 'a\n');
    git('add', '.');
    git('commit', '-qm', 'root');
    git('switch', '-qc', 'pr');
    git('mv', 'tooling/ci/scan.mjs', 'scan.mjs');
    git('commit', '-qm', 'move a gate file out');
    const head = git('rev-parse', 'HEAD');
    git('switch', '-q', 'main');
    writeFileSync(join(dir, '.gitleaks.toml'), 'x\n');
    git('add', '.');
    git('commit', '-qm', 'main moves on');
    const base = git('rev-parse', 'HEAD');
    const files = listGitFiles(base, head, (args) => git(...args));
    assert.deepEqual(files.sort(), ['scan.mjs', 'tooling/ci/scan.mjs']);
    assert.equal(evaluateGateFileRule('fix: tidy', files).ok, false, 'moving a gate file away is a gate change');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
