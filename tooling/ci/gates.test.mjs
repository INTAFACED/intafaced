/**
 * gates.mjs --changed: a builder's local run leaves the tooling tests to CI only when nothing they read changed.
 * Run: node --test tooling/ci/gates.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { GATES, NOT_GATES, gateAnnotation, gatesToRun, changedSinceMain, gatesBeforePush, LEFT_TO_CI_BEFORE_PUSH } from './gates.mjs';

const ids = (gates) => gates.map((g) => g.id);
const allButTooling = ids(GATES).filter((id) => id !== 'tooling-tests');

test('a full run (no --changed) runs every gate, the tooling tests included', () => {
  assert.deepEqual(ids(gatesToRun(GATES, null)), ids(GATES));
  assert.ok(ids(GATES).includes('tooling-tests'));
});

test('a product-only diff leaves out the tooling tests and nothing else', () => {
  const run = ids(gatesToRun(GATES, ['services/svc-ledger/src/index.ts', 'apps/customer/src/main.tsx', 'docs/x.md']));
  assert.deepEqual(run, allButTooling);
});

test('an empty diff leaves out the tooling tests and nothing else', () => {
  assert.deepEqual(ids(gatesToRun(GATES, [])), allButTooling);
});

test('a diff touching tooling/ or .github/ runs every gate', () => {
  assert.deepEqual(ids(gatesToRun(GATES, ['services/a.ts', 'tooling/scripts/local-test-stack.mjs'])), ids(GATES));
  assert.deepEqual(ids(gatesToRun(GATES, ['.github/workflows/ci.yml'])), ids(GATES));
});

test('a path that only looks like tooling (a service folder named tooling) does not count', () => {
  assert.deepEqual(ids(gatesToRun(GATES, ['services/svc-x/tooling/a.ts', 'xtooling/a.mjs'])), allButTooling);
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'gates-changed-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'services'), { recursive: true });
  mkdirSync(join(dir, 'tooling'), { recursive: true });
  writeFileSync(join(dir, 'services/a.ts'), 'a\n');
  writeFileSync(join(dir, 'tooling/t.mjs'), 't\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-qb', 'work');
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the diff is read from the merge-base with origin/main: commits, uncommitted edits and untracked files', () => {
  const r = repo();
  try {
    assert.deepEqual(changedSinceMain(r.dir), []);
    writeFileSync(join(r.dir, 'services/a.ts'), 'b\n');
    r.git('commit', '-qam', 'product');
    assert.deepEqual(changedSinceMain(r.dir), ['services/a.ts']);
    assert.deepEqual(ids(gatesToRun(GATES, changedSinceMain(r.dir))), allButTooling);

    // origin/main moving on with a tooling change of its own is not this branch's change.
    r.git('checkout', '-q', 'main');
    writeFileSync(join(r.dir, 'tooling/t.mjs'), 'main moved\n');
    r.git('commit', '-qam', 'main tooling');
    r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    r.git('checkout', '-q', 'work');
    assert.deepEqual(changedSinceMain(r.dir), ['services/a.ts']);

    writeFileSync(join(r.dir, 'tooling/t.mjs'), 'edited, not committed\n');
    assert.deepEqual(changedSinceMain(r.dir), ['services/a.ts', 'tooling/t.mjs']);
    assert.deepEqual(ids(gatesToRun(GATES, changedSinceMain(r.dir))), ids(GATES));
    r.git('checkout', '--', 'tooling/t.mjs');

    writeFileSync(join(r.dir, 'tooling/new.test.mjs'), 'untracked\n');
    assert.ok(changedSinceMain(r.dir).includes('tooling/new.test.mjs'));
    assert.deepEqual(ids(gatesToRun(GATES, changedSinceMain(r.dir))), ids(GATES));
    rmSync(join(r.dir, 'tooling/new.test.mjs'));

    // A file moved out of tooling/ counts on both sides.
    r.git('mv', 'tooling/t.mjs', 'services/t.mjs');
    assert.ok(changedSinceMain(r.dir).includes('tooling/t.mjs'));
  } finally {
    r.done();
  }
});

test('an unreadable diff (no origin/main, or not a repo) is null, so every gate runs', () => {
  const r = repo();
  try {
    r.git('update-ref', '-d', 'refs/remotes/origin/main');
    assert.equal(changedSinceMain(r.dir), null);
    assert.deepEqual(ids(gatesToRun(GATES, changedSinceMain(r.dir))), ids(GATES));
  } finally {
    r.done();
  }
  const plain = mkdtempSync(join(tmpdir(), 'gates-norepo-'));
  try {
    assert.equal(changedSinceMain(plain), null);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test('--before-push runs every gate but those it leaves to CI, each named with why, and the boundary scan among them', () => {
  const left = Object.keys(LEFT_TO_CI_BEFORE_PUSH);
  assert.deepEqual(
    ids(gatesBeforePush(GATES)),
    ids(GATES).filter((id) => !left.includes(id)),
  );
  for (const id of left) {
    assert.ok(ids(GATES).includes(id), `${id} is not a gate`);
    assert.ok(LEFT_TO_CI_BEFORE_PUSH[id].length >= 20, `${id} needs its reason`);
  }
  for (const id of ['boundary', 'brand', 'dead-code', 'secrets', 'migrations']) assert.ok(ids(gatesBeforePush(GATES)).includes(id), id);
  assert.ok(!ids(gatesBeforePush(GATES)).includes('money-property-mutation'));
});

// The real runner on a planted root: every gate a stub, so the manifest check holds and only the planted reds fail.
function stubRoot(stub) {
  const dir = mkdtempSync(join(tmpdir(), 'gates-before-push-'));
  mkdirSync(join(dir, 'tooling', 'ci'), { recursive: true });
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gates.mjs'), join(dir, 'tooling', 'ci', 'gates.mjs'));
  for (const file of Object.keys(NOT_GATES)) if (file !== 'gates.mjs') writeFileSync(join(dir, 'tooling', 'ci', file), '');
  for (const gate of GATES) {
    mkdirSync(dirname(join(dir, gate.script)), { recursive: true });
    writeFileSync(join(dir, gate.script), stub(gate.id));
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'GITHUB_ACTIONS'));
  const run = (...args) => spawnSync(process.execPath, ['tooling/ci/gates.mjs', ...args], { cwd: dir, encoding: 'utf8', env });
  const onActions = (...args) =>
    spawnSync(process.execPath, ['tooling/ci/gates.mjs', ...args], { cwd: dir, encoding: 'utf8', env: { ...env, GITHUB_ACTIONS: 'true' } });
  return { run, onActions, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('--before-push refuses on a red gate with its own message, reports in the list order, and never runs a gate left to CI', () => {
  const first = ids(gatesBeforePush(GATES))[0];
  const r = stubRoot((id) => {
    if (id === 'boundary') return "console.error('BOUNDARY SCAN FAILED: planted');\nprocess.exitCode = 1;\n";
    if (Object.hasOwn(LEFT_TO_CI_BEFORE_PUSH, id)) return `console.error('${id} ran');\nprocess.exitCode = 1;\n`;
    // The first gate in the list finishes last, so a report in finishing order would show.
    if (id === first) return "setTimeout(() => console.log('first done'), 500);\n";
    return "console.log('clean');\n";
  });
  try {
    const out = r.run('--before-push');
    assert.equal(out.status, 1, `${out.stdout}${out.stderr}`);
    assert.match(out.stderr, new RegExp(`✖ 1 of ${gatesBeforePush(GATES).length} DOCTRINE GATE\\(S\\) FAILED`));
    assert.match(out.stderr, /── boundary [\s\S]*BOUNDARY SCAN FAILED: planted/);
    for (const id of Object.keys(LEFT_TO_CI_BEFORE_PUSH)) assert.doesNotMatch(`${out.stdout}${out.stderr}`, new RegExp(`${id} ran`));
    const reported = [...out.stdout.matchAll(/^ {2}[✓✖] (\S+)/gm)].map((m) => m[1]);
    assert.deepEqual(reported, ids(gatesBeforePush(GATES)));

    const green = stubRoot(() => "console.log('clean');\n");
    try {
      const ok = green.run('--before-push');
      assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
      assert.match(ok.stdout, new RegExp(`✓ all ${gatesBeforePush(GATES).length} doctrine gates passed — \\d+ms total, \\d+ms at once`));
    } finally {
      green.done();
    }
  } finally {
    r.done();
  }
});

// J-cex-spot-10's red Doctrine gates run (17 Nov) carried no annotation of its own, only the exit code and a runner
// notice, so a reader of annotations could say "a gate" and never which: each red gate now annotates by its id.
test('on GitHub Actions each red gate is an error annotation titled by its id; a green gate and a laptop run make none', () => {
  const r = stubRoot((id) => (id === 'lint-ratchet' ? "console.error('rose');\nprocess.exitCode = 1;\n" : "console.log('clean');\n"));
  try {
    const ci = r.onActions();
    assert.equal(ci.status, 1, `${ci.stdout}${ci.stderr}`);
    const lines = ci.stdout.split('\n').filter((l) => l.startsWith('::error'));
    const ratchet = GATES.find((g) => g.id === 'lint-ratchet');
    assert.deepEqual(lines, [`::error title=lint-ratchet::Doctrine gate lint-ratchet failed: ${ratchet.doctrine}`]);
    assert.equal(lines[0], gateAnnotation(ratchet));
    assert.doesNotMatch(r.run().stdout, /::error/);
  } finally {
    r.done();
  }
});

test("a gate annotation escapes what would end GitHub's title or message early", () => {
  assert.equal(gateAnnotation({ id: 'a:b,c', doctrine: '100% \n x' }), '::error title=a%3Ab%2Cc::Doctrine gate a:b,c failed: 100%25 %0A x');
});
