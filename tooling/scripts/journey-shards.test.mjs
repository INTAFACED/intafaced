// Proves the journey shard split without a run. Run: node --test tooling/scripts/journey-shards.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  estimateDurations,
  fileDurations,
  journeyFiles,
  longestDurations,
  planShards,
  shardCount,
  stepCounts,
  targetFiles,
  timedSteps,
} from './journey-shards.mjs';

const report = {
  suites: [
    {
      file: 'J-bank-04.pw.mjs',
      specs: [{ tests: [{ results: [{ duration: 1000 }, { duration: 500 }] }] }, { tests: [{ results: [{ duration: 250 }] }] }],
      suites: [],
    },
    { title: 'group', suites: [{ file: 'nested/J-p2p-01.pw.mjs', specs: [{ tests: [{ results: [{ duration: 400 }] }] }] }] },
  ],
};

test('sums every result of every test per file, by its path in the report', () => {
  assert.deepEqual(
    [...fileDurations(report)],
    [
      ['J-bank-04.pw.mjs', 1750],
      ['nested/J-p2p-01.pw.mjs', 400],
    ],
  );
});

test('a report with no suites gives no durations', () => {
  assert.equal(fileDurations({}).size, 0);
  assert.equal(fileDurations(undefined).size, 0);
});

test('each file counts its longest time across runs', () => {
  const cut = new Map([['a', 5]]);
  const full = new Map([
    ['a', 50],
    ['b', 7],
  ]);
  assert.deepEqual(
    [...longestDurations([cut, full, new Map()])],
    [
      ['a', 50],
      ['b', 7],
    ],
  );
});

test('finds journey files in nested folders, never in node_modules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-shards-'));
  for (const f of ['J-a.pw.mjs', 'bank/J-b.pw.mjs', 'helper.mjs', 'node_modules/x/J-c.pw.mjs']) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), '');
  }
  assert.deepEqual(journeyFiles(dir), ['J-a.pw.mjs', 'bank/J-b.pw.mjs']);
  fs.rmSync(dir, { recursive: true });
});

test('refuses a file name that would match other files as a glob', () => {
  assert.throws(() => planShards(['J-x-[a].pw.mjs', 'b'], new Map(), 1), /as a glob/);
});

test('the long file gets a shard to itself and the rest balance around it', () => {
  const durations = new Map([
    ['a', 20],
    ['b', 6],
    ['c', 5],
    ['d', 4],
    ['e', 3],
    ['f', 2],
  ]);
  const plan = planShards(['f', 'e', 'd', 'c', 'b', 'a'], durations, 2);
  assert.deepEqual(plan, [
    { ms: 20, files: ['a'] },
    { ms: 20, files: ['b', 'c', 'd', 'e', 'f'] },
  ]);
});

test('every file lands in exactly one shard and every shard gets one', () => {
  const files = Array.from({ length: 80 }, (_, i) => `J-${String(i).padStart(2, '0')}.pw.mjs`);
  const durations = new Map(files.map((f, i) => [f, (i * 7919) % 1200]));
  const plan = planShards(files, durations, 8);
  assert.equal(plan.length, 8);
  assert.ok(plan.every((bin) => bin.files.length > 0));
  assert.deepEqual(plan.flatMap((bin) => bin.files).sort(), [...files].sort());
});

test('a file the last run did not have counts as the median, not as zero', () => {
  const durations = new Map([
    ['old-1', 10],
    ['old-2', 30],
    ['old-3', 50],
  ]);
  const plan = planShards(['old-1', 'old-2', 'old-3', 'new'], durations, 2);
  assert.deepEqual(plan, [
    { ms: 60, files: ['old-1', 'old-3'] },
    { ms: 60, files: ['new', 'old-2'] },
  ]);
});

test('with no durations the split is by count and the same every time', () => {
  const files = ['e', 'a', 'd', 'b', 'c'];
  const one = planShards(files, new Map(), 2);
  assert.deepEqual(one, planShards([...files].reverse(), new Map(), 2));
  assert.deepEqual(
    one.map((bin) => bin.files.length),
    [3, 2],
  );
});

test('refuses a shard count it cannot fill', () => {
  assert.throws(() => planShards(['a'], new Map(), 2), /cannot fill 2 shards/);
  assert.throws(() => planShards(['a'], new Map(), 0), /whole number/);
});

test('counts a step for each test( at the start of a line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-shards-'));
  fs.writeFileSync(path.join(dir, 'J-a.pw.mjs'), "test.use({});\ntest('J-a-01 #1', fn);\n  test('J-a-01 #2', fn);\n// not test( here\n");
  fs.writeFileSync(path.join(dir, 'J-b.pw.mjs'), '');
  assert.deepEqual(
    [...stepCounts(dir, ['J-a.pw.mjs', 'J-b.pw.mjs'])],
    [
      ['J-a.pw.mjs', 2],
      ['J-b.pw.mjs', 0],
    ],
  );
  fs.rmSync(dir, { recursive: true });
});

test('counts the steps a report timed per file, not the ones it skipped, interrupted or never reached', () => {
  const ended = (status) => ({ results: [{ status, duration: 5 }] });
  const cut = {
    suites: [
      {
        file: 'J-a.pw.mjs',
        specs: [
          { tests: [ended('passed')] },
          { tests: [ended('failed')] },
          { tests: [ended('timedOut')] },
          { tests: [ended('skipped')] },
          { tests: [ended('interrupted')] },
          { tests: [{ results: [] }] },
        ],
      },
    ],
  };
  assert.deepEqual([...timedSteps(cut)], [['J-a.pw.mjs', 3]]);
  assert.equal(timedSteps({}).size, 0);
});

test('a new file and steps added to an old one count at the suite time per step before any run timed them', () => {
  const past = new Map([
    ['old', 100],
    ['grown', 50],
  ]);
  // 150 ms over 15 timed steps: 10 ms a step.
  const timed = new Map([
    ['old', 10],
    ['grown', 5],
  ]);
  const steps = new Map([
    ['old', 10],
    ['grown', 8],
    ['new', 4],
    ['empty', 0],
  ]);
  assert.deepEqual(
    [...estimateDurations(['old', 'grown', 'new', 'empty'], past, timed, steps)],
    [
      ['old', 100],
      ['grown', 80],
      ['new', 40],
      ['empty', 10],
    ],
  );
});

test('with no timed file every step counts the same', () => {
  const steps = new Map([
    ['a', 3],
    ['b', 1],
  ]);
  assert.deepEqual(
    [...estimateDurations(['a', 'b'], new Map(), new Map(), steps)],
    [
      ['a', 3],
      ['b', 1],
    ],
  );
});

test('the shard count keeps each shard near the target, within its floor and ceiling', () => {
  const min = 60_000;
  assert.equal(shardCount(236 * min, 25 * min), 10);
  assert.equal(shardCount(10 * min, 25 * min), 8);
  assert.equal(shardCount(5000 * min, 25 * min), 24);
  assert.equal(shardCount(200 * min, 25 * min), 8);
  assert.equal(shardCount(201 * min, 25 * min), 9);
});

test('a targeted run takes only existing journey files, with or without the folder and the suffix', () => {
  const files = ['J-bank-04.pw.mjs', 'J-wallet-05.pw.mjs', 'nested/J-p2p-01.pw.mjs'];
  assert.deepEqual(targetFiles('J-wallet-05.pw.mjs', files), ['J-wallet-05.pw.mjs']);
  assert.deepEqual(targetFiles(' apps/customer/tests/real-app/J-wallet-05.pw.mjs,J-bank-04\nnested/J-p2p-01 J-bank-04 ', files), [
    'J-bank-04.pw.mjs',
    'J-wallet-05.pw.mjs',
    'nested/J-p2p-01.pw.mjs',
  ]);
});

test('a targeted run refuses a name that is not a journey file, and an empty list', () => {
  const files = ['J-bank-04.pw.mjs'];
  assert.throws(() => targetFiles('J-bank-4.pw.mjs', files), /not a journey file.*J-bank-4\.pw\.mjs/);
  assert.throws(() => targetFiles('../../../etc/passwd', files), /not a journey file/);
  assert.throws(() => targetFiles('*.pw.mjs', files), /not a journey file/);
  assert.throws(() => targetFiles(' , ', files), /names no journey file/);
  assert.throws(() => targetFiles(undefined, files), /names no journey file/);
});
