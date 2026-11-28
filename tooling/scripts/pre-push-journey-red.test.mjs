// pre-push-journey-red.mjs decide: a j/ branch re-pushed after its previous head's journeys run failed one of its own
// journey files goes only with a local PASS of those files on the tree pushed; a step red on main (the seal's mainsOwn),
// no free slot, the Mac and an unreadable GitHub pass through; nothing applies to other branches (project-state#4140).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, failedIn, journeyFileNames, logLine } from './pre-push-journey-red.mjs';

const SHA = 'a'.repeat(40);
const PREV = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const PUSH = { branch: 'j/J-bank-19', sha: SHA, prev: PREV };
const RED_RUN = { id: 7, status: 'completed', conclusion: 'failure' };
const report = (states, files) => ({ states, files, tests: {}, testFiles: {} });
const RED_REPORT = report(
  { 'J-bank-19#2': 'failed', 'J-bank-19#1': 'passed', 'J-wallet-04#3': 'failed' },
  {
    'J-bank-19#2': 'J-bank-19.pw.mjs',
    'J-bank-19#1': 'J-bank-19.pw.mjs',
    'J-wallet-04#3': 'J-wallet-04.pw.mjs',
  },
);

/** An io where the previous head's run failed J-bank-19 #2 in the branch's own file, main is green, no local record. */
const io = (over = {}) => ({
  mac: false,
  ownFiles: () => ['J-bank-19.pw.mjs'],
  tree: () => TREE,
  record: () => null,
  latestRun: async () => RED_RUN,
  report: async () => RED_REPORT,
  mainLatest: async () => ({ run: { id: 1, head_sha: 'd'.repeat(40) }, red: new Map(), problems: [] }),
  issues: async () => [],
  money: { 'J-bank-19#2': false },
  ...over,
});

test('it refuses a red own-journey run with no matching PASS, naming the steps and the command', async () => {
  const got = await decide(PUSH, io());
  assert.equal(got.kind, 'refuse');
  assert.deepEqual(got.steps, ['J-bank-19#2']); // J-wallet-04 is not this branch's file
  assert.deepEqual(got.files, ['J-bank-19.pw.mjs']);
  assert.match(got.line, /pnpm local:stack journey J-bank-19\b/);
  assert.match(got.line, /no \.jr\/run\.json/);
});

test('a PASS on another tree, of other files, or a failed or unfinished run does not count', async () => {
  for (const rec of [
    { tree: 'e'.repeat(40), files: ['J-bank-19.pw.mjs'], code: 0 },
    { tree: TREE, files: ['J-wallet-04.pw.mjs'], code: 0 },
    { tree: TREE, files: ['J-bank-19.pw.mjs'], code: 1 },
    { tree: TREE, files: ['J-bank-19.pw.mjs'], code: null },
  ])
    assert.equal((await decide(PUSH, io({ record: () => rec }))).kind, 'refuse', JSON.stringify(rec));
});

test('it allows a push with a matching local PASS', async () => {
  const got = await decide(PUSH, io({ record: () => ({ tree: TREE, files: ['J-bank-19.pw.mjs', 'J-x-01.pw.mjs'], code: 0 }) }));
  assert.equal(got.kind, 'allow');
});

test('it allows a step red on main the way the seal reads it: same red on main, a tracking issue, not money', async () => {
  const mainRed = async () => ({ run: { id: 1, head_sha: 'd'.repeat(40) }, red: new Map([['J-bank-19#2', 'failed']]), problems: [] });
  const tracked = async () => [{ number: 5, state: 'open', title: 'Journey broken on main: J-bank-19', labels: [{ name: 'regression' }] }];
  assert.equal((await decide(PUSH, io({ mainLatest: mainRed, issues: tracked }))).kind, 'allow');
  // The seal's rule, not a looser one: no tracking issue, or a money step, still needs the local PASS.
  assert.equal((await decide(PUSH, io({ mainLatest: mainRed }))).kind, 'refuse');
  assert.equal((await decide(PUSH, io({ mainLatest: mainRed, issues: tracked, money: { 'J-bank-19#2': true } }))).kind, 'refuse');
});

test('it passes through on no free slot, on the Mac, and when GitHub or the report cannot be read', async () => {
  const noSlot = await decide(PUSH, io({ record: () => ({ tree: TREE, files: ['J-bank-19.pw.mjs'], code: 3 }) }));
  assert.equal(noSlot.kind, 'pass-through');
  assert.match(noSlot.line, /no free slot/);
  assert.match((await decide(PUSH, io({ mac: true }))).line, /on the Mac/);
  const down = async () => {
    throw new Error('gh api: HTTP 502');
  };
  for (const over of [{ latestRun: down }, { report: down }, { mainLatest: down }, { issues: down }]) {
    const got = await decide(PUSH, io(over));
    assert.equal(got.kind, 'pass-through', Object.keys(over)[0]);
    assert.match(got.line, /could not be read/);
  }
  assert.match((await decide(PUSH, io({ report: async () => null }))).line, /report could not be read/);
});

test('nothing applies off a j/ branch, on a first push, without own journey files, or without a red own run', async () => {
  const never = () => assert.fail('no read is made when nothing applies');
  const quiet = { latestRun: never, report: never, mainLatest: never, issues: never, record: never };
  assert.equal((await decide({ ...PUSH, branch: 'fix/ps-1' }, io(quiet))).kind, 'skip');
  assert.equal((await decide({ ...PUSH, prev: '0'.repeat(40) }, io(quiet))).kind, 'skip');
  assert.equal((await decide(PUSH, io({ ...quiet, ownFiles: () => [] }))).kind, 'skip');
  for (const run of [
    null,
    { ...RED_RUN, status: 'in_progress', conclusion: null },
    { ...RED_RUN, conclusion: 'success' },
    { ...RED_RUN, conclusion: 'cancelled' },
  ])
    assert.equal((await decide(PUSH, io({ latestRun: async () => run }))).kind, 'skip');
  // A red only in another journey's file, or a step that failed and passed on its retry (flaky), is not this branch's.
  assert.equal(
    (await decide(PUSH, io({ report: async () => report({ 'J-wallet-04#3': 'failed' }, { 'J-wallet-04#3': 'J-wallet-04.pw.mjs' }) }))).kind,
    'skip',
  );
  assert.equal(
    (await decide(PUSH, io({ report: async () => report({ 'J-bank-19#2': 'flaky' }, { 'J-bank-19#2': 'J-bank-19.pw.mjs' }) }))).kind,
    'skip',
  );
});

test('helpers: failed keys with their files, journey file names, one countable log line', () => {
  const got = failedIn({
    states: { 'J-a-01#1': 'failed', 'J-a-01#2': 'passed' },
    files: { 'J-a-01#1': 'J-a-01.pw.mjs' },
    tests: { 'J-a-01#test x': 'failed' },
    testFiles: { 'J-a-01#test x': 'J-a-01-b.pw.mjs' },
  });
  assert.deepEqual(
    [...got],
    [
      ['J-a-01#1', 'J-a-01.pw.mjs'],
      ['J-a-01#test x', 'J-a-01-b.pw.mjs'],
    ],
  );
  assert.deepEqual(
    journeyFileNames(['apps/customer/tests/real-app/J-bank-19.pw.mjs', 'apps/customer/tests/real-app/journey.mjs', 'README.md']),
    ['J-bank-19.pw.mjs'],
  );
  const line = JSON.parse(logLine(PUSH, { kind: 'pass-through', line: 'x\ny' }, new Date(0)));
  assert.deepEqual(line, { at: '1970-01-01T00:00:00.000Z', branch: 'j/J-bank-19', sha: SHA, prev: PREV, kind: 'pass-through', line: 'x' });
});
