// related-tests-before-push.mjs on planted repos: a failing test refuses the push and is named; green tests pass; at
// the time limit the tests are stopped and the push goes on; without Postgres binaries, or when vitest names no
// failing test, it never refuses. vitest and Postgres are planted as shell scripts that log what they were given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SCRIPT, failingTests, findNode, groupByPackage } from './related-tests-before-push.mjs';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// The fake vitest: `pass`, `fail` (names a failing test), `sleep` (writes its pid, then sleeps 60 s) or `crash` (exits 1
// naming no test). Each call appends its arguments and the environment it saw to calls.log.
const VITEST = `#!/bin/sh
echo "ARGS $*" >> ../../calls.log
echo "ENV TZ=$TZ CI=\${CI:-unset} GIT_DIR=\${GIT_DIR:-unset} DB=$TEST_DATABASE_URL BANK=$TEST_DATABASE_URL_BANK" >> ../../calls.log
case "$(cat ../../mode)" in
  pass) echo " Test Files  1 passed (1)"; exit 0 ;;
  fail) echo " FAIL  src/a.test.ts > a > breaks when the change is wrong"; echo "AssertionError: expected 1 to be 2"; exit 1 ;;
  sleep) echo $$ > ../../vitest.pid; sleep 60; exit 0 ;;
  crash) echo "Error: something outside the tests"; exit 1 ;;
esac
`;
// The fake Postgres binaries: each logs its call; pg_ctl start writes a postmaster.pid so the stop step runs.
const PG = {
  initdb: '#!/bin/sh\necho "initdb $*" >> "$PG_LOG"\nwhile [ $# -gt 0 ]; do [ "$1" = -D ] && mkdir -p "$2"; shift; done\n',
  pg_ctl:
    '#!/bin/sh\necho "pg_ctl $*" >> "$PG_LOG"\nD=""\nfor a in "$@"; do [ "$prev" = -D ] && D="$a"; prev="$a"; done\ncase "$*" in *start*) echo 1 > "$D/postmaster.pid";; *stop*) rm -f "$D/postmaster.pid";; esac\n',
  psql: '#!/bin/sh\necho "psql $*" >> "$PG_LOG"\n',
};

function plant({ mode = 'pass', pg = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'related-tests-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'config', 'user.email', 't@example.invalid');
  git(work, 'config', 'user.name', 't');
  const write = (f, body, exec = false) => {
    mkdirSync(dirname(join(work, f)), { recursive: true });
    writeFileSync(join(work, f), body);
    if (exec) chmodSync(join(work, f), 0o755);
  };
  write('.gitignore', 'node_modules\ncalls.log\nmode\nvitest.pid\npg.log\n');
  write('.node-version', `${process.versions.node.split('.')[0]}\n`);
  write('packages/x/package.json', JSON.stringify({ name: '@t/x', scripts: { test: 'vitest run' } }));
  write('packages/x/src/a.ts', 'export const a = 1;\n');
  write('tooling/infra/postgres-init/01-service-schemas.sql', 'SELECT 1;\n');
  write('tooling/infra/postgres-init/02-intafaced-test-db.sh', 'echo "02 $PGPORT" >> "$PG_LOG"\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'fetch', '-q', 'origin');
  git(work, 'checkout', '-q', '-b', 'feat');
  write('packages/x/src/a.ts', 'export const a = 2;\n');
  write('packages/x/src/a.test.ts', "import { a } from './a';\n");
  write('README.md', 'not package code\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'change');
  write('packages/x/node_modules/.bin/vitest', VITEST, true);
  write('mode', mode);
  const pgBin = join(dir, 'pgbin');
  if (pg)
    for (const [b, body] of Object.entries(PG)) {
      mkdirSync(pgBin, { recursive: true });
      writeFileSync(join(pgBin, b), body);
      chmodSync(join(pgBin, b), 0o755);
    }
  const run = (env = {}) => {
    const t = Date.now();
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', GIT_DIR: join(work, '.git'), PRE_PUSH_PG_BIN: pgBin, PG_LOG: join(work, 'pg.log'), ...env },
      timeout: 60_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t };
  };
  const calls = () => (existsSync(join(work, 'calls.log')) ? readFileSync(join(work, 'calls.log'), 'utf8') : '');
  const pgLog = () => (existsSync(join(work, 'pg.log')) ? readFileSync(join(work, 'pg.log'), 'utf8') : '');
  return { work, run, calls, pgLog, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a failing test refuses, named, after the package own changed tests ran first under CI conditions', () => {
  const p = plant({ mode: 'fail' });
  try {
    const r = p.run();
    assert.equal(r.code, 1, r.out);
    assert.match(
      r.out,
      /a unit test failed — push refused \(\d+ s, packages\/x\):\n\s+src\/a\.test\.ts > a > breaks when the change is wrong/,
    );
    assert.match(r.out, /AssertionError: expected 1 to be 2/);
    const calls = p.calls();
    assert.match(calls.split('\n')[0], /^ARGS run --bail=1 --passWithNoTests src\/a\.test\.ts$/);
    assert.doesNotMatch(calls, /ARGS related/, 'it stops at the first failing package run');
    assert.match(
      calls,
      /ENV TZ=UTC CI=unset GIT_DIR=unset DB=postgres:\/\/intafaced:intafaced@127\.0\.0\.1:\d+\/intafaced_test BANK=postgres:\/\/svc_bank:svc_bank@127\.0\.0\.1:\d+\/intafaced_test/,
    );
    const pg = p.pgLog();
    assert.match(pg, /initdb .*-U intafaced/);
    assert.match(pg, /pg_ctl .*-c timezone=UTC.* start/);
    assert.match(pg, /psql .*-f tooling\/infra\/postgres-init\/01-service-schemas\.sql/);
    assert.match(pg, /^02 \d+$/m);
    assert.match(pg, /pg_ctl .*-m immediate.* stop/, 'the throwaway cluster is stopped');
  } finally {
    p.done();
  }
});

test('green tests pass: own changed tests, then the related ones with the own tests left out', () => {
  const p = plant({ mode: 'pass' });
  try {
    const r = p.run();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /related tests — passed in \d+ s/);
    const args = p
      .calls()
      .split('\n')
      .filter((l) => l.startsWith('ARGS'));
    assert.deepEqual(args, [
      'ARGS run --bail=1 --passWithNoTests src/a.test.ts',
      'ARGS related --run --bail=1 --passWithNoTests src/a.test.ts src/a.ts --exclude src/a.test.ts',
    ]);
  } finally {
    p.done();
  }
});

test('at the time limit the tests are stopped, the push goes on and it says so', () => {
  const p = plant({ mode: 'sleep' });
  try {
    const r = p.run({ PRE_PUSH_TESTS_SECONDS: '3' });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.ms < 15_000, `it returned after ${r.ms} ms`);
    assert.match(r.out, /time limit of 3 s reached while packages\/x \(vitest run\); stopped, the push goes on/);
    const pid = Number(readFileSync(join(p.work, 'vitest.pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the stopped vitest is not left running');
    assert.match(p.pgLog(), /pg_ctl .* stop/);
  } finally {
    p.done();
  }
});

test('never refuses without Postgres binaries, or when vitest names no failing test', () => {
  const p = plant({ mode: 'fail', pg: false });
  try {
    const r = p.run({ PRE_PUSH_PG_BIN: join(p.work, 'no-such-dir') });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no Postgres binaries here .*; skipped, CI's Tests job runs them/);
    assert.equal(p.calls(), '');
  } finally {
    p.done();
  }
  const q = plant({ mode: 'crash' });
  try {
    const r = q.run();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ended with code 1 and named no failing test; not refused/);
  } finally {
    q.done();
  }
});

test('the changed files are grouped by package, packages before services before apps; only code counts', () => {
  const groups = groupByPackage([
    'apps/customer/src/a.tsx',
    'services/svc-bank/src/b.ts',
    'services/svc-bank/src/b.test.ts',
    'packages/contracts/src/c.ts',
    'services/svc-bank/README.md',
    'tooling/ci/x.mjs',
  ]);
  assert.deepEqual(
    groups.map((g) => [g.dir, g.files, g.tests]),
    [
      ['packages/contracts', ['src/c.ts'], []],
      ['services/svc-bank', ['src/b.ts', 'src/b.test.ts'], ['src/b.test.ts']],
      ['apps/customer', ['src/a.tsx'], []],
    ],
  );
});

test("vitest's failing tests are read from its output, a failed suite by its file", () => {
  const out = [
    '\x1b[31m FAIL \x1b[39m src/loans/credit-card-preview.test.ts > credit card preview > serves TEST rows',
    ' FAIL  src/holds/received-holds.db.test.ts [ src/holds/received-holds.db.test.ts ]',
    ' ✓ src/ok.test.ts (3 tests) 20ms',
    ' FAIL  src/loans/credit-card-preview.test.ts > credit card preview > serves TEST rows',
  ].join('\n');
  assert.deepEqual(failingTests(out), [
    'src/loans/credit-card-preview.test.ts > credit card preview > serves TEST rows',
    'src/holds/received-holds.db.test.ts',
  ]);
  assert.deepEqual(failingTests(' ✓ src/ok.test.ts (3 tests)\n Test Files  1 passed (1)'), []);
});

test('the Node of CI is this one when the major matches, else none where nothing is installed', () => {
  assert.equal(findNode(process.versions.node.split('.')[0]), process.execPath);
  assert.equal(findNode('9', { current: '22.0.0', home: join(tmpdir(), 'no-such-home') }), null);
});
