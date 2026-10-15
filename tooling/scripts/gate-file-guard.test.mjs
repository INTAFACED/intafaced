/**
 * Unit tests for gate-file-guard.mjs and gate-gh.mjs. No network.
 * Run: node --test tooling/scripts/gate-file-guard.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GitHubRefusalError, makeGh } from './gate-gh.mjs';
import {
  MARKER,
  evaluateGateFileRule,
  gateFilesTouched,
  renderComment,
  listPrFiles,
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
  assert.ok(touched('tooling/scripts/merge-gate.mjs'));
  for (const file of ['merge-evidence.mjs', 'merge-evidence.test.mjs', 'merge-review.mjs', 'merge-review.test.mjs'])
    assert.ok(touched(`tooling/scripts/${file}`));
  assert.ok(touched('tooling/scripts/main-auto-revert.mjs'));
  assert.ok(touched('tooling/scripts/gate-file-guard.mjs'));
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
    'tooling/agent-protocol/AGENT_PROTOCOL.md',
    '.agents/skills/x/SKILL.md',
    '.cursor/rules/inta.mdc',
    '.github/dependabot.yml',
    '.github/CODEOWNERS',
    'turbo.json',
    '.prettierignore',
    'package.json',
    'tooling/scripts/github-refusal.mjs',
    'tooling/scripts/gate-gh.mjs',
    'tooling/scripts/fixtures/merge-gate/main-runs.json',
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

test('listPrFiles includes previous paths of renames', () => {
  let call;
  assert.deepEqual(
    listPrFiles(
      (args) => {
        call = args;
        return { stdout: 'docs/moved.md\nservices/svc-pay/old.ts\n' };
      },
      'o/r',
      7,
    ),
    ['docs/moved.md', 'services/svc-pay/old.ts'],
  );
  assert.match(call.at(-1), /previous_filename/);
});
