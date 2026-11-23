// The pre-push hook on planted repos: a worktree with no node_modules (here or in the main checkout) pushes; formatting
// is left to .githooks/pre-commit and CI's Format job, so an unformatted push goes through; a direct push to main is still refused.
// Only the cheap checks whose failure costs a CI round trip run here: the lint ratchet on the pushed files (it refuses a
// rise, and refuses without oxlint), the tooling tests that read every journey file and the seal's title rule when a
// journey file is pushed, and the CI review's size count. CI's other checks never run here (since 22 Nov: the Doctrine
// gates, the cross-package read scan, the typecheck and rust:check run on GitHub only; .githooks/pre-push says where).
// Every refusal is named in one run, with the list at the end; a direct push to main is refused before any check runs.
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
// CI and GITHUB_ACTIONS are unset, so each push here runs as on a builder's machine, even when this file runs inside CI
// (under GITHUB_ACTIONS the lint ratchet would fetch the real repository's main, which a planted repository shares nothing with).
const BUILDER = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CI' && k !== 'GITHUB_ACTIONS'));

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

test('no node_modules here or in the main checkout: the push goes through', () => {
  const p = plant();
  try {
    const r = p.push();
    assert.equal(r.code, 0, r.out);
  } finally {
    p.done();
  }
});

test('formatting is not checked here: a prettier that would refuse is never run', () => {
  const p = plant({ prettier: 'echo "prettier ran"; exit 1' });
  try {
    const r = p.push();
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /prettier ran/);
  } finally {
    p.done();
  }
});

test('a direct push to main is still refused, before any check runs', () => {
  const p = plant({ prettier: 'exit 0', base: { ...scan(false), ...sizeStep(1) }, change: JOURNEY });
  try {
    const r = p.push('main');
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /Direct push to main refused/);
    assert.doesNotMatch(r.out, /journey scan ran|size step/);
  } finally {
    p.done();
  }
});

test("CI's checks never run here: a red planted in them leaves the push alone", () => {
  const p = plant({ prettier: 'exit 0', ciChecks: "console.log('ran'); process.exit(1);" });
  try {
    const r = p.push();
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /\bran\b/);
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
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /\bran\b/);
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
  // journey-navigation.test.mjs, the rule two journey builds broke on 14 Nov, is now the lint garden/no-stale-read, which
  // the lint ratchet runs before a push; journey-world.test.mjs ("every real journey file declares at least what it changes") the one J-algo-dev-02 broke on
  // 7d8e66a1 the same day.
  assert.deepEqual(marked, [
    'tooling/scripts/journey-freeze-guard.test.mjs',
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
  execFileSync('git', ['ls-files', '--', '.oxlintrc.json', 'tooling/lint', 'tooling/ci/lint-ratchet.mjs', 'tooling/ci/exact-revert.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
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

// J-derivatives-04's head ea7d4f6c (17 Nov): its branch was cut before main gained garden/no-history-comment's
// [private-record], and CI's ratchet, judging by main as it was, refused two comments citing project-state; the push-time
// run had judged by the worktree's stale origin/main. Replayed: the rule reaches the remote's main after the branch is
// cut and origin/main is never fetched; the hook fetches main itself and refuses the push, with the line, as CI did.
test('a rule main gained after the branch was cut refuses the push though origin/main is stale (J-derivatives-04 ea7d4f6c, replayed)', () => {
  const off = JSON.parse(RATCHET['.oxlintrc.json']);
  off.rules['garden/no-history-comment'] = 'off';
  const file = 'apps/customer/tests/real-app/J-x.pw.mjs';
  const p = plant({
    prettier: 'exit 0',
    oxlint: true,
    base: { ...RATCHET, '.oxlintrc.json': JSON.stringify(off, null, 2) },
    change: { [file]: '// The rule comes from project-state row d12.\nexport const x = 1;\n' },
  });
  try {
    const stale = git(p.work, 'rev-parse', 'origin/main').trim();
    // Main gains the rule on the remote; this worktree's origin/main stays where the branch was cut.
    git(p.work, 'checkout', '-q', 'main');
    writeFileSync(join(p.work, '.oxlintrc.json'), RATCHET['.oxlintrc.json']);
    git(p.work, 'commit', '-q', '-am', 'main gains a rule');
    git(p.work, 'push', '-q', '--no-verify', 'origin', 'main');
    git(p.work, 'update-ref', 'refs/remotes/origin/main', stale);
    git(p.work, 'checkout', '-q', 'feat');
    const r = p.push();
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /garden\/no-history-comment\[private-record\] rose from 0 to 1/);
    assert.match(r.out, /apps\/customer\/tests\/real-app\/J-x\.pw\.mjs:1 {2}\[private-record\]/);
    assert.match(r.out, /lint-ratchet failed — push refused/);
  } finally {
    p.done();
  }
});

test('a push that adds an `as unknown as` cast is refused in seconds, with the line and the fix', () => {
  const file = 'services/svc-x/src/a.ts';
  const p = plant({
    prettier: 'exit 0',
    oxlint: true,
    base: { ...RATCHET, [file]: 'export const n = 1;\n' },
    change: { [file]: 'export const n = "1" as unknown as number;\n' },
  });
  try {
    const started = Date.now();
    const r = p.push();
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /services\/svc-x\/src\/a\.ts:1 {2}`as unknown as` turns type checking off here: narrow with a type guard/);
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

test('no oxlint in the worktree: the push is refused, with how to install it, never let through unchecked', () => {
  const p = plant({ prettier: 'exit 0', base: { ...RATCHET, ...copy([]) }, change: copy(["paidOwed: 'Owed, not collected yet',"]) });
  try {
    const r = p.push();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /lint-ratchet needs this worktree's oxlint — push refused\. Install it: pnpm install --frozen-lockfile/);
  } finally {
    p.done();
  }
});

// The CI review's size count (review-before-push.mjs --size), planted: it names what it was given and answers `code`.
const sizeStep = (code) => ({
  'tooling/scripts/review-before-push.mjs': `console.log('size step:', process.argv.slice(2).join(' '));\nprocess.exit(${code});\n`,
});

test("the CI review's size count runs on the pushed head and branch, and its refusal refuses the push", () => {
  const p = plant({ prettier: 'exit 0', base: sizeStep(1) });
  try {
    const head = git(p.work, 'rev-parse', 'HEAD').trim();
    const r = p.push('feat');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`size step: --size --head ${head} --branch feat`));
  } finally {
    p.done();
  }
});

test("the size count's pass lets the push through, and a push that only deletes a branch never counts", () => {
  const p = plant({ prettier: 'exit 0', base: sizeStep(0) });
  try {
    const r = p.push('feat');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /size step: --size --head [0-9a-f]{40} --branch feat/);
    writeFileSync(join(p.work, 'tooling', 'scripts', 'review-before-push.mjs'), sizeStep(1)['tooling/scripts/review-before-push.mjs']);
    const d = spawnSync('git', ['push', 'origin', ':refs/heads/feat'], { cwd: p.work, encoding: 'utf8', env: BUILDER });
    assert.equal(d.status, 0, `${d.stdout}${d.stderr}`);
    assert.doesNotMatch(`${d.stdout}${d.stderr}`, /size step/);
  } finally {
    p.done();
  }
});

// The wire replay of the services a push changes (tooling/scripts/pre-push-wire-replay.mjs), planted: it answers `code`.
const replayStep = (code) => ({
  'tooling/scripts/pre-push-wire-replay.mjs': `console.log('wire replay step');\n${code ? "console.error('✖ @intafaced/svc-trade wire replay does not answer as recorded');\n" : ''}process.exit(${code});\n`,
});

test('a red wire replay refuses the push, named; a green one lets it through (project-state#3682)', () => {
  const p = plant({ prettier: 'exit 0', base: replayStep(1) });
  try {
    const r = p.push();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /wire replay step/);
    assert.match(r.out, /- wire replay/);
    writeFileSync(
      join(p.work, 'tooling', 'scripts', 'pre-push-wire-replay.mjs'),
      replayStep(0)['tooling/scripts/pre-push-wire-replay.mjs'],
    );
    const g = p.push();
    assert.equal(g.code, 0, g.out);
    assert.match(g.out, /wire replay step/);
  } finally {
    p.done();
  }
});

// One run names every refusal. fix/ps-3343-curriculum's head 09d41f0f86 (19 Nov) was refused for unicorn/no-thenable by the
// lint ratchet; its second push, for the secret scan; its third, for the CI review's size count: three pushes for three
// refusals the first run could have named. Replayed: the real lint ratchet on a real rise, and the size count planted
// with the refusal that head got; the one push names both and lists them at the end. (The secret scan is a Doctrine gate,
// CI's alone since 22 Nov: its Fast gates job names it about two minutes after the push.)
test('every check runs and every refusal is named in one run, listed at the end (fix/ps-3343-curriculum 09d41f0f86, replayed)', () => {
  const file = 'crates/svc-academy/scripts/record-curriculum.mjs';
  const p = plant({
    prettier: 'exit 0',
    oxlint: true,
    base: { ...RATCHET, [file]: 'export const n = 1;\n', ...sizeStep(1) },
    change: { [file]: 'export const n = 1;\nexport const reply = { then: () => n };\n' },
  });
  try {
    const r = p.push();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /unicorn\/no-thenable rose from 0 to 1 in the touched files/);
    assert.match(r.out, /size step: --size --head [0-9a-f]{40} --branch feat/);
    assert.match(
      r.out,
      /push refused by 2 check\(s\), each named above, all from this one run:\n {6}- lint-ratchet\n {6}- CI review size \(feat\)\n/,
    );
  } finally {
    p.done();
  }
});

// CI's own checks, planted red where the hook used to call them (the Doctrine gates, the cross-package read scan, the
// typecheck and rust:check): none runs before a push, and the push goes through. CI runs each on GitHub (.githooks/pre-push).
test('the Doctrine gates, the cross-package read scan, the typecheck and rust:check never run here: planted reds leave the push alone', () => {
  const red = (name) => `console.log('${name} ran');\nprocess.exit(1);\n`;
  const p = plant({
    prettier: 'exit 0',
    base: {
      'tooling/ci/gates.mjs': red('gates'),
      'tooling/ci/cross-package-reads.mjs': red('cross-package reads'),
      'tooling/scripts/pre-push-typecheck.mjs': red('typecheck'),
      'Cargo.toml': '[workspace]\n',
      'tooling/ci/ci-affected.mjs': "console.log('ci-affected ran'); console.log('true');\n",
    },
    change: { 'src/b.test.ts': 'export {};\n', 'crates/x/src/lib.rs': 'pub fn x() {}\n' },
  });
  const bin = join(p.work, '..', 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'cargo'), '#!/bin/sh\necho "cargo ran"\nexit 1\n');
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\necho "pnpm ran: $*"\nexit 1\n');
  chmodSync(join(bin, 'cargo'), 0o755);
  chmodSync(join(bin, 'pnpm'), 0o755);
  try {
    const r = p.push('feat', { ...BUILDER, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /gates ran|cross-package reads ran|typecheck ran|ci-affected ran|cargo ran|pnpm ran/);
  } finally {
    p.done();
  }
});

// A push that brings nothing of its own skips every check (22 Nov: moving seven volt/* layer branches to main took over 30
// minutes of checks on main's own commits). Each case plants a red size count, so a check that runs refuses the push.
// Main gains a commit on the remote after the branch was pushed, as it does between two syncs of a layer branch.
function mainGains(p, files) {
  git(p.work, 'checkout', '-q', 'main');
  git(p.work, 'merge', '-q', '--ff-only', 'origin/main');
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(p.work, f)), { recursive: true });
    writeFileSync(join(p.work, f), body);
  }
  git(p.work, 'add', '-A');
  git(p.work, 'commit', '-q', '-m', 'main moves on');
  git(p.work, 'push', '-q', '--no-verify', 'origin', 'main');
  git(p.work, 'fetch', '-q', 'origin');
  git(p.work, 'checkout', '-q', 'feat');
}
const SKIPPED = /this push adds nothing beyond origin\/main and what the remote already holds; the checks are skipped/;

test('a branch moved to a commit on main skips every check, even a red one', () => {
  const p = plant({ prettier: 'exit 0', base: sizeStep(1) });
  try {
    git(p.work, 'push', '-q', '--no-verify', 'origin', 'origin/main:refs/heads/volt/layer');
    mainGains(p, { 'main.txt': 'main\n' });
    git(p.work, 'checkout', '-q', '--detach', 'origin/main');
    const started = Date.now();
    const r = p.push('volt/layer');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, SKIPPED);
    assert.doesNotMatch(r.out, /size step/);
    assert.ok(Date.now() - started < 5_000, `the push took ${Date.now() - started} ms`);
  } finally {
    p.done();
  }
});

test('a clean merge of main into the pushed branch skips every check, even a red one', () => {
  const p = plant({ prettier: 'exit 0', base: sizeStep(1) });
  try {
    git(p.work, 'push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/feat');
    mainGains(p, { 'main.txt': 'main\n' });
    git(p.work, 'merge', '-q', '--no-edit', 'origin/main');
    const r = p.push();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, SKIPPED);
    assert.doesNotMatch(r.out, /size step/);
  } finally {
    p.done();
  }
});

test('a merge with a conflict resolution, or an edit folded into a clean merge, runs every check (planted red size count)', () => {
  const p = plant({ prettier: 'exit 0', base: sizeStep(1), change: { 'README.md': 'branch\n' } });
  try {
    git(p.work, 'push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/feat');
    mainGains(p, { 'README.md': 'main\n' });
    spawnSync('git', ['merge', '-q', '--no-edit', 'origin/main'], { cwd: p.work });
    writeFileSync(join(p.work, 'README.md'), 'branch and main\n');
    git(p.work, 'commit', '-q', '-am', 'merge main, resolved');
    const r = p.push();
    assert.equal(r.code, 1, r.out);
    assert.doesNotMatch(r.out, SKIPPED);
    assert.match(r.out, /size step: --size/);
    assert.match(r.out, /push refused by 1 check\(s\)[^\n]*\n {6}- CI review size \(/);
  } finally {
    p.done();
  }
  // A clean merge with an edit amended into it is not what git's merge gives: it runs the checks too.
  const q = plant({ prettier: 'exit 0', base: sizeStep(1) });
  try {
    git(q.work, 'push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/feat');
    mainGains(q, { 'main.txt': 'main\n' });
    git(q.work, 'merge', '-q', '--no-edit', 'origin/main');
    writeFileSync(join(q.work, 'src', 'a.ts'), 'export const a = 2;\n');
    git(q.work, 'commit', '-q', '-a', '--amend', '--no-edit');
    const e = q.push();
    assert.equal(e.code, 1, e.out);
    assert.doesNotMatch(e.out, SKIPPED);
    assert.match(e.out, /push refused by 1 check\(s\)[^\n]*\n {6}- CI review size \(/);
  } finally {
    q.done();
  }
});

test('a new commit on top of a clean merge of main runs every check (planted red size count)', () => {
  const p = plant({ prettier: 'exit 0', base: sizeStep(1) });
  try {
    git(p.work, 'push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/feat');
    mainGains(p, { 'main.txt': 'main\n' });
    git(p.work, 'merge', '-q', '--no-edit', 'origin/main');
    writeFileSync(join(p.work, 'src', 'b.ts'), 'export const b = 1;\n');
    git(p.work, 'add', '-A');
    git(p.work, 'commit', '-q', '-m', 'new work');
    const r = p.push();
    assert.equal(r.code, 1, r.out);
    assert.doesNotMatch(r.out, SKIPPED);
    assert.match(r.out, /push refused by 1 check\(s\)[^\n]*\n {6}- CI review size \(/);
  } finally {
    p.done();
  }
});

test('a lint rise of the branch’s own, then a clean merge of main, still fails the lint ratchet (planted rise)', () => {
  const p = plant({ prettier: 'exit 0', oxlint: true, base: { ...RATCHET, ...copy([]) } });
  try {
    git(p.work, 'push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/feat');
    writeFileSync(join(p.work, COPY), copy(["paidOwed: 'Owed, not collected yet',"])[COPY]);
    git(p.work, 'commit', '-q', '-am', 'a promise of later');
    mainGains(p, { 'main.txt': 'main\n' });
    git(p.work, 'merge', '-q', '--no-edit', 'origin/main');
    const r = p.push();
    assert.equal(r.code, 1, r.out);
    assert.doesNotMatch(r.out, SKIPPED);
    assert.match(r.out, /garden\/no-promise-copy rose from 0 to 1 in the touched files/);
    assert.match(r.out, /lint-ratchet failed — push refused/);
  } finally {
    p.done();
  }
});

test('a push to main is refused though it brings nothing new (main moved back to an older commit of its own)', () => {
  const p = plant({ prettier: 'exit 0', base: sizeStep(1) });
  try {
    mainGains(p, { 'main.txt': 'main\n' });
    const r = (({ status, stdout, stderr }) => ({ code: status, out: `${stdout}${stderr}` }))(
      spawnSync('git', ['push', '--force', 'origin', 'origin/main~1:refs/heads/main'], { cwd: p.work, encoding: 'utf8', env: BUILDER }),
    );
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Direct push to main refused/);
    assert.doesNotMatch(r.out, SKIPPED);
  } finally {
    p.done();
  }
});

// The CI-running notice, planted: it prints the shas the hook hands it, then exits as told (its own tests hold the real
// one's reads of gh: tooling/scripts/pre-push-ci-running.test.mjs).
const notice = (code) => ({
  'tooling/scripts/pre-push-ci-running.mjs': `console.log('notice for ' + process.argv.slice(2).join(' ')); process.exit(${code});\n`,
});

test('the CI-running notice gets the head each push replaces and prints at the end; it never refuses (project-state#3754)', () => {
  for (const code of [0, 1]) {
    const p = plant({ change: notice(code) });
    try {
      assert.equal(p.push().code, 0);
      const before = git(p.work, 'rev-parse', 'HEAD').trim();
      writeFileSync(join(p.work, 'src', 'a.ts'), 'export const a = 2;\n');
      git(p.work, 'commit', '-qam', 'again');
      const r = p.push();
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, new RegExp(`^notice for ${before}$`, 'm'), 'its line names the replaced head');
    } finally {
      p.done();
    }
  }
});
