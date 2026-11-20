// node --test tooling/ci/cleanup-replay.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { codemodOf, judgeReplay, replayCodemod } from './cleanup-replay.mjs';
import { pathKind } from './journey-touch.mjs';
import { cleanupInputs } from './journey-seal.mjs';

const isProduct = (p) => Boolean(pathKind(p).product);

test('codemodOf: one `Codemod: <name>` line names the script; none, two names or a bad name name nothing', () => {
  assert.equal(codemodOf('Moves the imports.\n\nCodemod: entry-imports\n'), 'entry-imports');
  assert.equal(codemodOf('Codemod: entry-imports\nCodemod: entry-imports'), 'entry-imports');
  assert.equal(codemodOf('Codemod: a\nCodemod: b'), null);
  assert.equal(codemodOf('Codemod: ../x'), null);
  assert.equal(codemodOf('  Codemod: x'), null, 'at column 0 only');
  assert.equal(codemodOf(null), null);
});

test('judgeReplay: exactly the script’s output passes; a slice, an extra hand edit or other bytes fail', () => {
  const a = 'apps/customer/src/a.ts';
  const b = 'apps/customer/src/b.ts';
  const base = { name: 'm', changed: [a, b], isProduct, differs: [] };
  assert.deepEqual(judgeReplay({ ...base, paths: [a, b, 'apps/customer/src/a.test.ts', 'docs/x.md'] }), {
    ok: true,
    name: 'm',
    paths: new Set([a, b]),
  });
  assert.match(judgeReplay({ ...base, paths: [a] }).why, /changes apps\/customer\/src\/b\.ts, which this pull request does not/);
  assert.match(judgeReplay({ ...base, paths: [a, b, 'services/svc-x/src/y.ts'] }).why, /svc-x\/src\/y\.ts is product code .*hand edit/);
  assert.match(judgeReplay({ ...base, paths: [a, b], differs: [b] }).why, /b\.ts differs from codemod m's output/);
  assert.match(judgeReplay({ ...base, changed: [], paths: [a] }).why, /changes nothing/);
});

// A real git history: the merge base holds a codemod that renames an import in two customer files.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-replay-test-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  const put = (p, t) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 't');
  put('apps/customer/src/a.ts', "import { x } from './old';\n");
  put('apps/customer/src/b.ts', "import { y } from './old';\nexport const b = 1;\n");
  put('apps/customer/src/c.ts', 'export const c = 1;\n');
  put(
    'tooling/codemods/old-to-entry.mjs',
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "for (const f of ['apps/customer/src/a.ts', 'apps/customer/src/b.ts'])",
      "  writeFileSync(f, readFileSync(f, 'utf8').replaceAll(\"'./old'\", \"'./entry'\"));",
      '',
    ].join('\n'),
  );
  put('tooling/codemods/noop.mjs', '\n');
  put('tooling/codemods/boom.mjs', 'process.exit(3);\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  const head = (edit) => {
    g('checkout', '-q', '--detach', base);
    put('apps/customer/src/a.ts', "import { x } from './entry';\n");
    put('apps/customer/src/b.ts', "import { y } from './entry';\nexport const b = 1;\n");
    edit?.(put);
    g('add', '-A');
    g('commit', '-qm', 'head');
    return g('rev-parse', 'HEAD');
  };
  const pathsOf = (sha) => g('diff', '--name-only', '--no-renames', base, sha).split('\n').filter(Boolean);
  return { dir, base, head, pathsOf, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('replayCodemod: reruns the merge base’s codemod and passes its exact output; fails a hand edit, a slice and a missing script', () => {
  const r = repo();
  try {
    const run = (head, name = 'old-to-entry') =>
      replayCodemod({ root: r.dir, base: r.base, head, name, paths: r.pathsOf(head), isProduct });
    const exact = r.head();
    assert.deepEqual(run(exact), { ok: true, name: 'old-to-entry', paths: new Set(['apps/customer/src/a.ts', 'apps/customer/src/b.ts']) });
    // A unit test beside it keeps its own kind and does not spoil the verdict.
    assert.equal(run(r.head((put) => put('apps/customer/src/a.test.ts', 'test\n'))).ok, true);
    // A hand edit in another product file: not a clean-up change.
    assert.match(run(r.head((put) => put('apps/customer/src/c.ts', 'export const c = 2;\n'))).why, /c\.ts is product code .*hand edit/);
    // The same file, edited further by hand: other bytes than the script's.
    assert.match(
      run(r.head((put) => put('apps/customer/src/b.ts', "import { y } from './entry';\nexport const b = 2;\n"))).why,
      /b\.ts differs from codemod old-to-entry's output/,
    );
    // A slice: only one of the two files the script writes.
    assert.match(
      run(r.head((put) => put('apps/customer/src/b.ts', "import { y } from './old';\nexport const b = 1;\n"))).why,
      /changes apps\/customer\/src\/b\.ts, which this pull request does not/,
    );
    // A script the merge base does not hold (one the pull request would add beside its output) proves nothing.
    assert.match(run(exact, 'not-there').why, /tooling\/codemods\/not-there\.mjs is not on the merge base/);
    assert.match(run(exact, 'noop').why, /changes nothing/);
    assert.match(run(exact, 'boom').why, /codemod boom failed \(exit 3\)/);
    assert.match(replayCodemod({ root: r.dir, base: 'nope', head: exact, name: 'x', paths: [], isProduct }).why, /not a commit/);
    // It leaves no worktree behind.
    assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: r.dir, encoding: 'utf8' }).trim().split('\n').length, 1);
  } finally {
    r.done();
  }
});

test('the seal replays the codemod its body names on the merge base, and reads no codemod when none is named', async () => {
  const calls = [];
  const io = {
    mergeBase: async (base, head) => (calls.push(['mergeBase', base, head]), 'b'.repeat(40)),
    replay: async (a) => (calls.push(['replay', a.base, a.head, a.name, a.paths]), { ok: true, name: a.name, paths: new Set(a.paths) }),
  };
  const pull = { body: 'Codemod: old-to-entry', base: { sha: 'a'.repeat(40) } };
  const v = await cleanupInputs({ io, pull, paths: ['apps/customer/src/a.ts'], head: 'c'.repeat(40) });
  assert.equal(v.ok, true);
  assert.deepEqual(calls, [
    ['mergeBase', 'a'.repeat(40), 'c'.repeat(40)],
    ['replay', 'b'.repeat(40), 'c'.repeat(40), 'old-to-entry', ['apps/customer/src/a.ts']],
  ]);
  assert.equal(await cleanupInputs({ io, pull: { body: 'no line' }, paths: [], head: 'c'.repeat(40) }), null);
  assert.equal(await cleanupInputs({ io: {}, pull, paths: [], head: 'c'.repeat(40) }), null, 'an io without replay: today’s rules');
  const throws = {
    ...io,
    mergeBase: async () => {
      throw new Error('HTTP 502');
    },
  };
  assert.equal(await cleanupInputs({ io: throws, pull, paths: [], head: 'c'.repeat(40) }), null);
});
