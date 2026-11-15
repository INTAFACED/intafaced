// The pre-push hook on planted repos: a worktree with no node_modules (here or in the main checkout) pushes with one
// line instead of being refused; formatting still refuses when prettier is there; a direct push to main is still refused;
// CI's checks (tooling/scripts/ci-checks.mjs) never run here: they run on GitHub, on the branch and then on the PR. A push
// that changes a journey file runs the marked tooling tests that read journey files, and a red one refuses it. The lint
// ratchet (tooling/ci/lint-ratchet.mjs, a Doctrine gate) runs on the pushed files when oxlint is installed, and refuses a rise.
// Each case is a throwaway repo holding the real .githooks/pre-push, pushing to a local bare remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// The hook prints its pointer to GitHub's branch run only when CI is unset, so each push here runs as on a builder's
// machine, even when this file runs inside CI.
const BUILDER = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CI'));

function plant({ prettier = null, oxlint = false, ciChecks = 'process.exit(0);', base = {}, change = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'config', 'user.email', 't@example.invalid');
  git(work, 'config', 'user.name', 't');
  mkdirSync(join(work, '.githooks'), { recursive: true });
  copyFileSync(join(ROOT, '.githooks', 'pre-push'), join(work, '.githooks', 'pre-push'));
  chmodSync(join(work, '.githooks', 'pre-push'), 0o755);
  mkdirSync(join(work, 'tooling', 'scripts'), { recursive: true });
  writeFileSync(join(work, 'tooling', 'scripts', 'truth-check.mjs'), 'process.exit(0);\n');
  // CI's checks (tooling/scripts/ci-checks.mjs), planted: the real one builds and tests the whole repo.
  writeFileSync(join(work, 'tooling', 'scripts', 'ci-checks.mjs'), `${ciChecks}\n`);
  writeFileSync(join(work, '.gitignore'), 'node_modules\n');
  writeFileSync(join(work, 'README.md'), 'base\n');
  const write = (files) => {
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(work, f)), { recursive: true });
      writeFileSync(join(work, f), body);
    }
  };
  write(base);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'fetch', '-q', 'origin');
  git(work, 'config', 'core.hooksPath', '.githooks');
  if (prettier !== null) {
    mkdirSync(join(work, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(work, 'node_modules', '.bin', 'prettier'), `#!/bin/sh\n${prettier}\n`);
    chmodSync(join(work, 'node_modules', '.bin', 'prettier'), 0o755);
  }
  // The real oxlint of this checkout, for the lint ratchet (its own shim finds oxlint beside itself, so it is called).
  if (oxlint) {
    writeFileSync(join(work, 'node_modules', '.bin', 'oxlint'), `#!/bin/sh\nexec '${join(ROOT, 'node_modules', '.bin', 'oxlint')}' "$@"\n`);
    chmodSync(join(work, 'node_modules', '.bin', 'oxlint'), 0o755);
  }
  git(work, 'checkout', '-q', '-b', 'feat');
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src', 'a.ts'), 'export const a = 1;\n');
  write(change);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'change');
  const push = (ref = 'feat', env = BUILDER) => {
    const r = spawnSync('git', ['push', 'origin', `HEAD:refs/heads/${ref}`], { cwd: work, encoding: 'utf8', env });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { push, work, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('no node_modules here or in the main checkout: one line, the push goes through', () => {
  const p = plant();
  try {
    const r = p.push();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no prettier in this worktree; skipped/);
  } finally {
    p.done();
  }
});

test('formatting still refuses when prettier is there', () => {
  const p = plant({ prettier: 'echo "[warn] src/a.ts"; exit 1' });
  try {
    const r = p.push();
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /format:check failed/);
  } finally {
    p.done();
  }
});

test('a formatted push with prettier there goes through', () => {
  const p = plant({ prettier: 'exit 0' });
  try {
    const r = p.push();
    assert.equal(r.code, 0, r.out);
  } finally {
    p.done();
  }
});

test('a direct push to main is still refused', () => {
  const p = plant({ prettier: 'exit 0' });
  try {
    const r = p.push('main');
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /Direct push to main refused/);
  } finally {
    p.done();
  }
});

test("CI's checks never run here: a red planted in them leaves the push alone, and the hook names GitHub's branch run", () => {
  const p = plant({ prettier: 'exit 0', ciChecks: "console.log('ran'); process.exit(1);" });
  try {
    const r = p.push();
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /\bran\b/);
    assert.match(r.out, /gh workflow run ci\.yml -R INTAFACED\/intafaced --ref <branch>/);
  } finally {
    p.done();
  }
});

test('a push that only deletes a branch runs no checks', () => {
  const p = plant({ prettier: 'exit 0', ciChecks: "console.log('ran'); process.exit(1);" });
  try {
    // The branch exists on the remote (pushed here without the hook), so the delete reaches the hook.
    git(p.work, 'push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/gone');
    const r = spawnSync('git', ['push', 'origin', ':refs/heads/gone'], { cwd: p.work, encoding: 'utf8', env: BUILDER });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /\bran\b|gh workflow run/);
  } finally {
    p.done();
  }
});

// A planted tooling test with the hook's marker line, red or green, and a journey file to push beside it.
const MARK = '// Before a push: runs from .githooks/pre-push when the push changes a journey file (it takes under a second).';
const scan = (ok) => ({
  'tooling/scripts/journey-rule.test.mjs': `${MARK}\nconsole.log('journey scan ran');\n${ok ? '' : "throw new Error('planted: a journey file breaks the rule');\n"}`,
  // Unmarked: the slow tooling tests stay in CI.
  'tooling/scripts/slow.test.mjs': "console.log('slow test ran'); process.exit(1);\n",
});
const JOURNEY = { 'apps/customer/tests/real-app/J-x-01.pw.mjs': 'export const x = 1;\n' };

test('a push that changes a journey file runs the marked journey-file tests, and a red one refuses it, named', () => {
  const p = plant({ prettier: 'exit 0', base: scan(false), change: JOURNEY });
  try {
    const r = p.push();
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /journey-file scans: 1 tooling test file/);
    assert.match(r.out, /planted: a journey file breaks the rule/);
    assert.match(r.out, /tooling test that reads every journey file failed — push refused/);
    assert.doesNotMatch(r.out, /slow test ran/);
  } finally {
    p.done();
  }
});

test('a push that changes a journey file goes through when the marked journey-file tests pass', () => {
  const p = plant({ prettier: 'exit 0', base: scan(true), change: JOURNEY });
  try {
    const r = p.push();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /journey-file scans: 1 tooling test file/);
    assert.match(r.out, /journey scan ran/);
    assert.doesNotMatch(r.out, /slow test ran/);
  } finally {
    p.done();
  }
});

test('a push with no journey file runs no journey-file tests, even a red one', () => {
  const p = plant({ prettier: 'exit 0', base: scan(false) });
  try {
    const r = p.push();
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /journey-file scans|journey scan ran/);
  } finally {
    p.done();
  }
});

test('the tooling tests that read every journey file carry the marker, and each runs in seconds', () => {
  const marked = execFileSync('git', ['grep', '-l', '-E', `^${MARK.replace(/[.()]/g, '\\$&')}`, '--', 'tooling/*.test.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .sort();
  // journey-navigation.test.mjs is the rule two journey builds broke on 14 Nov, each found only by a red Doctrine gates job;
  // journey-world.test.mjs ("every real journey file declares at least what it changes") the one J-algo-dev-02 broke on
  // 7d8e66a1 the same day.
  assert.deepEqual(marked, [
    'tooling/scripts/journey-freeze-guard.test.mjs',
    'tooling/scripts/journey-navigation.test.mjs',
    'tooling/scripts/journey-world.test.mjs',
    'tooling/scripts/local-test-market-history.test.mjs',
    'tooling/scripts/real-app-navigation.test.mjs',
  ]);
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...marked], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  // Measured at about 1 s on the Mac; 10 s is what a push may spend on them.
  assert.ok(Date.now() - started < 10_000, `the journey-file tests took ${Date.now() - started} ms`);
});

// The lint ratchet, replayed on J-agents-01's head a6e6a2e3 (14 Nov): four new lines in a customer copy catalogue, one a
// promise of later ("not collected yet"), which CI's Doctrine gates job refused as garden/no-promise-copy 0 -> 2 after the
// push. Main's real rules, plugin and gate script, with this checkout's oxlint; only the copy file is planted.
const RATCHET = Object.fromEntries(
  execFileSync('git', ['ls-files', '--', '.oxlintrc.json', 'tooling/lint', 'tooling/ci/lint-ratchet.mjs'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]),
);
const COPY = 'apps/customer/src/features/more/agents-catalogue-copy.ts';
const copy = (lines) => ({ [COPY]: `export const en = {\n  windowState: 'State',\n${lines.map((l) => `  ${l}\n`).join('')}};\n` });

test('a push that raises a lint rule in the files it touches is refused, named, as CI would (J-agents-01 a6e6a2e3, replayed)', () => {
  const p = plant({
    prettier: 'exit 0',
    oxlint: true,
    base: { ...RATCHET, ...copy([]) },
    change: copy(["paidFrom: 'Paid from',", "paidOwed: 'Owed, not collected yet',"]),
  });
  try {
    const started = Date.now();
    const r = p.push();
    assert.notEqual(r.code, 0, r.out);
    assert.match(
      r.out,
      /garden\/no-promise-copy rose from 0 to 1 in the touched files \(apps\/customer\/src\/features\/more\/agents-catalogue-copy\.ts\)/,
    );
    assert.match(r.out, /lint-ratchet failed — push refused/);
    // The whole push, hook included, measured at about 2 s on the Mac; 20 s is what the ratchet may add.
    assert.ok(Date.now() - started < 20_000, `the push took ${Date.now() - started} ms`);
  } finally {
    p.done();
  }
});

test('a push that holds every lint rule goes through with the ratchet run', () => {
  const p = plant({
    prettier: 'exit 0',
    oxlint: true,
    base: { ...RATCHET, ...copy([]) },
    change: copy(["paidFrom: 'Paid from',", "paidOwed: 'Owed by the partner',"]),
  });
  try {
    const r = p.push();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Lint ratchet: \d+ touched file\(s\)/);
  } finally {
    p.done();
  }
});

test('no oxlint in the worktree: the ratchet is skipped with one line, never refused', () => {
  const p = plant({ prettier: 'exit 0', base: { ...RATCHET, ...copy([]) }, change: copy(["paidOwed: 'Owed, not collected yet',"]) });
  try {
    const r = p.push();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /lint-ratchet — no oxlint in this worktree; skipped/);
  } finally {
    p.done();
  }
});
