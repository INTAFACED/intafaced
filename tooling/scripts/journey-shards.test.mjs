// Proves the journey shard split without a run. Run: node --test tooling/scripts/journey-shards.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileDurations, planShards } from './journey-shards.mjs';

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

test('sums every result of every test per file, by base name', () => {
  assert.deepEqual(
    [...fileDurations(report)],
    [
      ['J-bank-04.pw.mjs', 1750],
      ['J-p2p-01.pw.mjs', 400],
    ],
  );
});

test('a report with no suites gives no durations', () => {
  assert.equal(fileDurations({}).size, 0);
  assert.equal(fileDurations(undefined).size, 0);
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
