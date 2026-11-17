/**
 * Unit tests for gate-files.mjs and gate-gh.mjs. No network.
 * Run: node --test tooling/scripts/gate-files.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubRefusalError, makeGh } from './gate-gh.mjs';
import { gateFilesTouched } from './gate-files.mjs';

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
  assert.ok(touched('tooling/scripts/gate-files.mjs'));
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
    '.cursor/rules/any.mdc',
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
