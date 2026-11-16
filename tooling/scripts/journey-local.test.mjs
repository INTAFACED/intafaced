// pnpm local:stack journey, driven with a fake stack: what it starts, what it prints and what it stops.
// Run: node --test tooling/scripts/journey-local.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { journeyFiles, journeyLocal, onlyReady, parseArgs, readReport, refusal, workTree } from './journey-local.mjs';

const ALL_HELD =
  '\nlocal-test-stack: refusing: every slot is held (0: /w/a (pid 1); 1: /w/b (pid 2); 2: /w/c (pid 3); 3: /w/d (pid 4)); stop one with `local-test-stack.mjs stop` in its checkout\n';
const report = (tests) => ({
  suites: [
    {
      file: 'J-x-01.pw.mjs',
      specs: tests.map(([title, status, message]) => ({
        title,
        tests: [{ status, results: [{ error: message ? { message } : undefined }] }],
      })),
    },
  ],
  errors: [],
});

/** A fake world: `answers` maps a command's first words to { code, text }; every call is recorded. */
function world({ answers = {}, hadStack = false, rep = report([['J-x-01 #1 opens', 'expected']]), pw = 0 } = {}) {
  const calls = [];
  const said = [];
  let signal;
  const io = {
    dir: '/j',
    exists: (f) => f === '/j/J-x-01.pw.mjs',
    out: '/o',
    say: (l) => said.push(l),
    branch: 'j/J-x-01',
    ourStack: () => hadStack,
    slot: () => 2,
    state: () => '/s',
    readJson: () => rep,
    rm: () => {},
    run: async (argv) => {
      const key = argv
        .slice(1, 3)
        .map((a) => a.split('/').pop())
        .join(' ');
      calls.push(key);
      if (argv[0] === 'pnpm') return { code: pw, text: '' };
      return answers[key] ?? { code: 0, text: key.endsWith('custody') ? 'on\n' : '' };
    },
    killChild: async () => calls.push('kill'),
    onSignal: (fn) => {
      signal = fn;
    },
    waitForTaker: async () => {},
  };
  return { io, calls, said, signal: () => signal() };
}

test('every slot held: one line naming GitHub run instead, exit 3, nothing stopped', async () => {
  const w = world({ answers: { 'local-test-stack.mjs start': { code: 1, text: ALL_HELD } } });
  assert.equal(await journeyLocal({ ids: ['J-x-01'] }, w.io), 3);
  assert.deepEqual(w.calls, ['local-test-stack.mjs start']);
  assert.equal(w.said.length, 1);
  assert.match(
    w.said[0],
    /^local:stack journey: no free slot: every local stack slot is held\. Prove it on GitHub instead: gh workflow run real-app-journeys\.yml --ref j\/J-x-01 -f journeys="J-x-01\.pw\.mjs"$/,
  );
});

test('a pass: readied as CI readies a shard, PASS, pictures and Open, then the stack it started is stopped', async () => {
  const w = world();
  assert.equal(await journeyLocal({ ids: ['J-x-01'] }, w.io), 0);
  assert.deepEqual(w.calls, [
    'local-test-stack.mjs start',
    'local-test-stack.mjs restart',
    'local-test-gates.mjs apply',
    'local-test-stack.mjs custody',
    'local-test-market.mjs',
    'local-test-market.mjs stop',
    'local-test-gates.mjs verify',
    'journey-market-past.mjs J-x-01.pw.mjs',
    'local-test-market.mjs history',
    'local-test-market.mjs',
    'local-test-seed.mjs apply',
    'exec playwright',
    'local-test-stack.mjs stop',
  ]);
  assert.ok(w.said.includes('local:stack journey: PASS J-x-01.pw.mjs: 1 passed'));
  assert.ok(w.said.some((l) => l.startsWith('Pictures: /o/results')));
  // Slot 2's Customer port: 3210 + 2000.
  assert.ok(w.said.some((l) => l.startsWith('Open: http://127.0.0.1:5210')));
});

test('a failing step is named with its first error line, exit 1, and the stack is still stopped', async () => {
  const w = world({
    pw: 1,
    rep: report([
      ['J-x-01 #1 opens', 'expected'],
      ['J-x-01 #2 pays', 'unexpected', '\u001b[31mError: expect(locator).toBeVisible() failed\u001b[39m\n\nLocator: ...'],
    ]),
  });
  assert.equal(await journeyLocal({ ids: ['J-x-01'] }, w.io), 1);
  assert.ok(w.said.includes('local:stack journey: FAIL J-x-01 #2 pays: Error: expect(locator).toBeVisible() failed'));
  assert.equal(w.calls.at(-1), 'local-test-stack.mjs stop');
});

test("this checkout's own running stack is reused and left running", async () => {
  const w = world({ hadStack: true });
  assert.equal(await journeyLocal({ ids: ['J-x-01'] }, w.io), 0);
  assert.ok(!w.calls.includes('local-test-stack.mjs stop'));
  assert.ok(w.said.some((l) => l.startsWith('Open: http://127.0.0.1:5210   (the stack is left running')));
});

test('--keep leaves the stack it started running', async () => {
  const w = world();
  assert.equal(await journeyLocal({ ids: ['J-x-01'], keep: true }, w.io), 0);
  assert.ok(!w.calls.includes('local-test-stack.mjs stop'));
});

test('another refusal after the claim (low disk): stopped, one line with the reason and the GitHub run, exit 3', async () => {
  const w = world({ answers: { 'local-test-stack.mjs start': { code: 1, text: '\nlocal-test-stack: only 9.0 GB free on /\n' } } });
  assert.equal(await journeyLocal({ ids: ['J-x-01'] }, w.io), 3);
  assert.deepEqual(w.calls, ['local-test-stack.mjs start', 'local-test-stack.mjs stop']);
  assert.match(w.said[0], /the local start refused \(only 9\.0 GB free on \/\)\. Prove it on GitHub instead/);
});

test('custody off: no market maker wait, history or second start', async () => {
  const w = world({ answers: { 'local-test-stack.mjs custody': { code: 0, text: 'off\n' } } });
  assert.equal(await journeyLocal({ ids: ['J-x-01'] }, w.io), 0);
  assert.deepEqual(w.calls.slice(3, 7), [
    'local-test-stack.mjs custody',
    'local-test-market.mjs',
    'local-test-gates.mjs verify',
    'local-test-seed.mjs apply',
  ]);
});

test('interrupted: the child is killed, the stack it started is stopped, and the run ends 130, not 1', async () => {
  const w = world();
  let release;
  w.io.run = async (argv) => {
    const key = argv
      .slice(1, 3)
      .map((a) => a.split('/').pop())
      .join(' ');
    w.calls.push(key);
    if (key === 'local-test-stack.mjs start') return new Promise((r) => (release = r));
    return { code: 0, text: '' };
  };
  const running = journeyLocal({ ids: ['J-x-01'] }, w.io);
  await new Promise((r) => setImmediate(r));
  const handled = w.signal();
  release({ code: 1, text: '' }); // the killed start's own failure races the signal (proof run 43782013433, case 3)
  assert.equal(await handled, 130);
  assert.equal(await running, 130);
  assert.deepEqual(w.calls, ['local-test-stack.mjs start', 'kill', 'local-test-stack.mjs stop']);
  assert.deepEqual(w.said, ['local:stack journey: interrupted; stopping what it started']);
});

test('a name with no journey file is a usage error before anything starts', async () => {
  const w = world();
  assert.equal(await journeyLocal({ ids: ['J-nope-01'] }, w.io), 2);
  assert.deepEqual(w.calls, []);
});

test('parts', () => {
  assert.deepEqual(parseArgs(['J-a-01', '--only', 'bank,pay', '--keep']), { ids: ['J-a-01'], only: 'bank,pay', keep: true });
  assert.match(parseArgs([]).error, /name at least one journey/);
  assert.match(parseArgs(['J-a-01', '--only']).error, /--only needs/);
  assert.deepEqual(journeyFiles(['J-a-01.pw.mjs', 'apps/customer/tests/real-app/J-a-01'], '/j', () => true).files, [
    'J-a-01.pw.mjs',
    'J-a-01.pw.mjs',
  ]);
  assert.equal(refusal(ALL_HELD).slice(0, 30), 'refusing: every slot is held (');
  assert.equal(refusal('all fine\n'), null);
  const table =
    '  SERVICE          PORT        PID     HEALTH\n  svc-bank         16510       4       ok\n  svc-pay          16511       -       DOWN (0)\n';
  assert.deepEqual(onlyReady(table, 'bank'), { ready: true, bad: [] });
  assert.deepEqual(onlyReady(table, 'bank,pay'), { ready: false, bad: ['pay'] });
  assert.deepEqual(
    readReport(
      report([
        ['a', 'expected'],
        ['b', 'skipped'],
      ]),
    ),
    { passed: 1, failed: [], skipped: 1 },
  );
});

test('run.json: the tree ran is recorded with code null at the start and the exit code at the end', async () => {
  for (const [w, want] of [
    [world(), 0],
    [world({ rep: report([['J-x-01 #1 opens', 'unexpected', 'boom']]), pw: 1 }), 1],
    [world({ answers: { 'local-test-stack.mjs start': { code: 1, text: ALL_HELD } } }), 3],
  ]) {
    const records = [];
    Object.assign(w.io, { tree: () => 'abc123', now: () => 1700000000000, record: (r) => records.push(r) });
    assert.equal(await journeyLocal({ ids: ['J-x-01'] }, w.io), want);
    assert.deepEqual(records, [
      { tree: 'abc123', files: ['J-x-01.pw.mjs'], startedAt: 1700000000000, code: null },
      { tree: 'abc123', files: ['J-x-01.pw.mjs'], startedAt: 1700000000000, code: want },
    ]);
  }
});

test('run.json: an interrupted run keeps code null, so it never reads as a pass', async () => {
  const w = world();
  const records = [];
  Object.assign(w.io, { tree: () => 't', now: () => 1, record: (r) => records.push(r) });
  const run = w.io.run;
  w.io.run = async (argv, o) => {
    if (argv[0] === 'pnpm') await w.signal();
    return run(argv, o);
  };
  assert.equal(await journeyLocal({ ids: ['J-x-01'] }, w.io), 130);
  assert.deepEqual(
    records.map((r) => r.code),
    [null],
  );
});

test('workTree: the tree git add -A would commit, untracked files in, ignored ones out, the index untouched', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jl-tree-'));
  const git = (...a) =>
    execFileSync('git', a, {
      cwd: d,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(d, '.gitignore'), '/.jr/\n');
  fs.writeFileSync(path.join(d, 'a.ts'), 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'one');
  const committed = git('rev-parse', 'HEAD^{tree}');
  assert.equal(workTree(d, path.join(d, '.jr')), committed);
  fs.writeFileSync(path.join(d, 'b.ts'), 'b\n');
  const withB = workTree(d, path.join(d, '.jr'));
  assert.notEqual(withB, committed);
  assert.equal(git('status', '--porcelain'), '?? b.ts');
  git('add', '-A');
  git('commit', '-qm', 'two');
  assert.equal(git('rev-parse', 'HEAD^{tree}'), withB);
  assert.equal(workTree(path.join(os.tmpdir(), 'no-such-dir-jl'), path.join(d, '.jr')), null);
  fs.rmSync(d, { recursive: true, force: true });
});
