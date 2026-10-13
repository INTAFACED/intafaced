/**
 * Unit tests for gate-file-guard.mjs and gate-gh.mjs. No network.
 * Run: node --test tooling/scripts/gate-file-guard.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubRefusalError, makeGh } from './gate-gh.mjs';
import { MARKER, evaluateGateFileRule, gateFilesTouched, renderComment, titleStatesGateChange, upsertComment } from './gate-file-guard.mjs';

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
  assert.ok(touched('tooling/scripts/main-auto-revert.mjs'));
  assert.ok(touched('tooling/scripts/gate-file-guard.mjs'));
});

test('gate files: ordinary files are not gate files', () => {
  for (const f of [
    'services/svc-pay/src/a.ts',
    'tooling/scripts/worktree.mjs',
    'tooling/cia/x.mjs',
    'github/workflows/x.yml',
    '.github/CODEOWNERS',
    'docs/ci.md',
    'package.json',
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
