// Proves the journey shard split without a run. Run: node --test tooling/scripts/journey-shards.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JOURNEY_DIR,
  MAIN_MAX_SHARDS,
  MAX_SHARDS,
  MIN_TARGET_MINUTES,
  TARGETED_MAX_SHARDS,
  UNTIMED_STEP_MS,
  estimateDurations,
  freshFiles,
  fileDurations,
  fullPlan,
  journeyFiles,
  longestDurations,
  planCovers,
  planShards,
  shardCount,
  shardTarget,
  stepCounts,
  targetFiles,
  targetedShards,
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

test("with no timed file every step counts the same, a step's time on main", () => {
  assert.equal(UNTIMED_STEP_MS, 16_000);
  const steps = new Map([
    ['a', 3],
    ['b', 1],
  ]);
  assert.deepEqual(
    [...estimateDurations(['a', 'b'], new Map(), new Map(), steps)],
    [
      ['a', 3 * UNTIMED_STEP_MS],
      ['b', 1 * UNTIMED_STEP_MS],
    ],
  );
});

// #8032: run 43130806194 could not download the last reports (HTTP 403, the installation's rate limit), planned "about
// 0 min" on the 8-shard floor, and every shard hit its time limit. With no report the full suite still plans its size.
test('the planner as the workflow calls it with no report plans the full suite at its real size, not the floor', () => {
  const run = execFileSync(process.execPath, ['tooling/scripts/journey-shards.mjs', '--shards', 'auto'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const shards = JSON.parse(run);
  assert.equal(shards.length, MAX_SHARDS, `${shards.length} shards`);
  assert.deepEqual(shards.flatMap((s) => s.split(' ')).sort(), journeyFiles(JOURNEY_DIR));
});

// Main's run aims each shard at the floor, up to its own ceiling, so a break is named as its shorter shard ends; every
// other full run (a pull request's, a manual run on a branch) keeps the longest-file target and MAX_SHARDS.
test('a run on main plans 10-minute shards up to 64; any other full run keeps the longest-file target and 32', () => {
  const min = 60_000;
  const durations = new Map([['a', 26 * min]]);
  assert.deepEqual(fullPlan(durations, true), { target: MIN_TARGET_MINUTES * min, max: MAIN_MAX_SHARDS });
  assert.deepEqual(fullPlan(durations, false), { target: 16 * min, max: MAX_SHARDS });
  assert.equal(MAIN_MAX_SHARDS, 64);
  const plan = (args) =>
    JSON.parse(
      execFileSync(process.execPath, ['tooling/scripts/journey-shards.mjs', '--shards', 'auto', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  const main = plan(['--main']);
  // With no report every step counts UNTIMED_STEP_MS: more shards than any other full run gets, never past main's ceiling.
  assert.ok(main.length > MAX_SHARDS && main.length <= MAIN_MAX_SHARDS, `${main.length} shards`);
  assert.deepEqual(main.flatMap((s) => s.split(' ')).sort(), journeyFiles(JOURNEY_DIR));
  // --only wins: a targeted run is never main's, so --main never lifts its cap.
  assert.ok(plan(['--main', '--only', 'J-wallet-05']).length <= TARGETED_MAX_SHARDS);
});

test('the shard count keeps each shard near the target, within its floor and ceiling', () => {
  const min = 60_000;
  assert.equal(shardCount(236 * min, 25 * min), 10);
  assert.equal(shardCount(10 * min, 25 * min), 8);
  assert.equal(shardCount(5000 * min, 25 * min), 32);
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
  assert.deepEqual(targetFiles('./apps/customer/tests/real-app/J-bank-04.pw.mjs', files), ['J-bank-04.pw.mjs']);
  assert.throws(() => targetFiles('x/apps/customer/tests/real-app/J-bank-04.pw.mjs', files), /not a journey file/);
  assert.throws(() => targetFiles('J-bank-4.pw.mjs', files), /not a journey file.*J-bank-4\.pw\.mjs/);
  assert.throws(() => targetFiles('../../../etc/passwd', files), /not a journey file/);
  assert.throws(() => targetFiles('*.pw.mjs', files), /not a journey file/);
  assert.throws(() => targetFiles(' , ', files), /names no journey file/);
  assert.throws(() => targetFiles(undefined, files), /names no journey file/);
});

test('each shard aims at the longest file less the setup spread, within 10 and 25 minutes', () => {
  const min = 60_000;
  // Main's last three runs of 6 Nov 2026, as the planner reads them: J-wallet-05 at most 26.1 minutes, about 513 minutes
  // in all, so 32 shards.
  assert.equal(
    shardTarget(
      new Map([
        ['J-wallet-05.pw.mjs', 26.1 * min],
        ['J-bank-04.pw.mjs', 19.1 * min],
      ]),
    ),
    966_000,
  );
  assert.equal(shardCount(513 * min, 966_000), 32);
  assert.equal(shardTarget(new Map([['a', 12 * min]])), 10 * min, 'never below 10 minutes');
  assert.equal(shardTarget(new Map([['a', 50 * min]])), 25 * min, 'never above 25 minutes');
  assert.equal(shardTarget(new Map()), 10 * min, 'no durations at all');
});

test('the coverage check passes a plan that runs every file once', () => {
  const files = ['a.pw.mjs', 'b.pw.mjs', 'c.pw.mjs'];
  assert.deepEqual(planCovers(planShards(files, new Map(), 2), files), []);
});

test('the coverage check names a dropped file, a repeated file, a stranger and an empty shard (planted faults)', () => {
  const files = ['a.pw.mjs', 'b.pw.mjs', 'c.pw.mjs'];
  assert.deepEqual(planCovers([{ files: ['a.pw.mjs'] }, { files: ['b.pw.mjs'] }], files), ['c.pw.mjs is in no shard']);
  assert.deepEqual(planCovers([{ files: ['a.pw.mjs', 'c.pw.mjs'] }, { files: ['b.pw.mjs', 'c.pw.mjs'] }], files), [
    'c.pw.mjs is in shards 1, 2',
  ]);
  assert.deepEqual(planCovers([{ files: ['a.pw.mjs', 'a.pw.mjs', 'b.pw.mjs', 'c.pw.mjs'] }], files), ['a.pw.mjs is in shards 1, 1']);
  assert.deepEqual(planCovers([{ files: ['a.pw.mjs', 'b.pw.mjs', 'c.pw.mjs', 'x.pw.mjs'] }], files), [
    'x.pw.mjs is not a journey file of this run',
  ]);
  assert.deepEqual(planCovers([{ files: ['a.pw.mjs', 'b.pw.mjs', 'c.pw.mjs'] }, { files: [] }], files), ['shard 2 has no file']);
});

// The real journey list, through the planner as the workflow runs it, at every shard count it may pick: every file runs
// exactly once. Then the same check, planted with one file dropped and one repeated, must fail.
test('every real journey file runs exactly once at every shard count, and a dropped or repeated file fails', () => {
  const files = journeyFiles(JOURNEY_DIR);
  assert.ok(files.length >= 8, `found ${files.length} journey files`);
  const durations = new Map(files.map((f, i) => [f, ((i * 7919) % 1500) * 1000]));
  for (let n = 1; n <= Math.min(48, files.length); n++) {
    const plan = planShards(files, durations, n);
    assert.equal(plan.length, n);
    assert.deepEqual(planCovers(plan, files), [], `${n} shards`);
  }
  const plan = planShards(files, durations, 32);
  const dropped = plan.map((bin, i) => ({ files: i === 0 ? bin.files.slice(1) : bin.files }));
  assert.deepEqual(planCovers(dropped, files), [`${plan[0].files[0]} is in no shard`]);
  const repeated = plan.map((bin, i) => ({ files: i === 1 ? [...bin.files, plan[0].files[0]] : bin.files }));
  assert.deepEqual(planCovers(repeated, files), [`${plan[0].files[0]} is in shards 1, 2`]);
});

test('the planner as the workflow calls it prints shards that hold every real journey file exactly once', () => {
  const out = execFileSync(process.execPath, ['tooling/scripts/journey-shards.mjs', '--shards', 'auto'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const shards = JSON.parse(out).map((s) => s.split(' '));
  const printed = shards.flat().sort();
  assert.deepEqual(printed, journeyFiles(JOURNEY_DIR));
  assert.equal(new Set(printed).size, printed.length);
});

test('a targeted run takes at most 10 shards, packing the same files, while every shard stays clear of the limit', () => {
  const min = 60_000;
  assert.equal(TARGETED_MAX_SHARDS, 10);
  const timed = (n, each) => {
    const files = Array.from({ length: n }, (_, i) => `J-x-${String(i).padStart(3, '0')}.pw.mjs`);
    return { files, durations: new Map(files.map((f) => [f, each * min])) };
  };
  // 60 files of 5 minutes: the 15-minute target asks 20 shards; 10 shards of 30 minutes each stay clear of 40.
  const mid = timed(60, 5);
  assert.equal(Math.min(60, Math.ceil(300 / 15)), 20, 'what the target alone asks');
  assert.equal(targetedShards(mid.files, mid.durations, 15 * min), 10);
  const plan = planShards(mid.files, mid.durations, 10);
  assert.deepEqual(planCovers(plan, mid.files), [], 'the capped plan still runs every file exactly once');
  // Few files take as few shards as before: the cap never adds one.
  const few = timed(3, 5);
  assert.equal(targetedShards(few.files, few.durations, 10 * min), 2);
  assert.equal(targetedShards(few.files.slice(0, 1), few.durations, 10 * min), 1);
  // Fails open: 120 files of 5 minutes in 10 shards would need 60 minutes each, so the uncapped count stands.
  const big = timed(120, 5);
  assert.equal(targetedShards(big.files, big.durations, 15 * min), 32);
  // The boundary: exactly at the limit caps; one minute over doesn't.
  const edge = timed(10, 40);
  assert.equal(targetedShards(edge.files, edge.durations, 10 * min, 40 * min), 10);
  assert.equal(targetedShards(edge.files, edge.durations, 10 * min, 39 * min), 10, 'never more shards than the target asks');
  const over = timed(20, 21);
  assert.equal(targetedShards(over.files, over.durations, 10 * min, 42 * min), 10);
  assert.equal(targetedShards(over.files, over.durations, 10 * min, 42 * min - 1), 20);
});

test('the planner as the workflow calls it for a targeted run prints at most 10 shards holding exactly the named files', () => {
  const all = journeyFiles(JOURNEY_DIR);
  const named = all.slice(0, 40);
  const out = execFileSync(process.execPath, ['tooling/scripts/journey-shards.mjs', '--shards', 'auto', '--only', named.join(' ')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const shards = JSON.parse(out).map((s) => s.split(' '));
  assert.ok(shards.length <= TARGETED_MAX_SHARDS, `${shards.length} shards`);
  assert.deepEqual(shards.flat().sort(), [...named].sort());
});

// A file that needs a fresh stack (`// Stack: fresh`) runs first in its shard: only files after it in name order, the
// order Playwright runs a shard in, share its shard (#7994: J-more-catalogue-11 #1 read J-more-catalogue-01 #6's launch).
test('a file that needs a fresh stack runs first in its shard, whatever the times say', () => {
  const files = ['J-a.pw.mjs', 'J-b.pw.mjs', 'J-c.pw.mjs', 'J-m.pw.mjs', 'J-x.pw.mjs', 'J-y.pw.mjs', 'J-z.pw.mjs'];
  const durations = new Map(files.map((f, i) => [f, (i + 1) * 1000]));
  const fresh = new Set(['J-m.pw.mjs']);
  for (const shards of [2, 3, 4]) {
    const plan = planShards(files, durations, shards, fresh);
    const bin = plan.find((b) => b.files.includes('J-m.pw.mjs'));
    assert.equal(bin.files[0], 'J-m.pw.mjs', `${shards} shards: ${JSON.stringify(plan)}`);
    assert.deepEqual(planCovers(plan, files, fresh), []);
  }
  // Without the line the same times put J-c before J-m in J-m's shard: the order that broke #7994.
  const loose = planShards(files, durations, 2);
  assert.notEqual(loose.find((b) => b.files.includes('J-m.pw.mjs')).files[0], 'J-m.pw.mjs', JSON.stringify(loose));
});

test('the plan check names a fresh-stack file that another file runs before in its shard', () => {
  const files = ['J-a.pw.mjs', 'J-m.pw.mjs', 'J-z.pw.mjs'];
  const broken = [
    { ms: 2, files: ['J-a.pw.mjs', 'J-m.pw.mjs'] },
    { ms: 1, files: ['J-z.pw.mjs'] },
  ];
  assert.deepEqual(planCovers(broken, files, new Set(['J-m.pw.mjs'])), [
    'J-m.pw.mjs needs a fresh stack but runs after J-a.pw.mjs in shard 1',
  ]);
  assert.deepEqual(planCovers(broken, files), []);
});

test('a plan that cannot run every fresh-stack file first refuses by name', () => {
  assert.throws(
    () => planShards(['J-a.pw.mjs', 'J-m.pw.mjs'], new Map(), 1, new Set(['J-m.pw.mjs'])),
    /J-a\.pw\.mjs runs before every file that needs a fresh stack/,
  );
  assert.throws(
    () => planShards(['J-a.pw.mjs', 'J-m.pw.mjs'], new Map(), 1, new Set(['J-a.pw.mjs', 'J-m.pw.mjs'])),
    /2 journey files need a fresh stack and there are 1 shards/,
  );
});

test("the repo's fresh-stack files, J-more-catalogue-11 among them, each run first in their shard of the full plan and of a targeted one", () => {
  const all = journeyFiles(JOURNEY_DIR);
  const fresh = freshFiles(JOURNEY_DIR, all);
  assert.ok(fresh.has('J-more-catalogue-11.pw.mjs'), 'J-more-catalogue-11 carries // Stack: fresh');
  for (const only of [null, 'J-more-catalogue-01.pw.mjs J-more-catalogue-11.pw.mjs']) {
    const out = execFileSync(
      process.execPath,
      ['tooling/scripts/journey-shards.mjs', '--shards', 'auto', ...(only ? ['--only', only] : [])],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const shards = JSON.parse(out).map((s) => s.split(' '));
    for (const f of fresh) {
      const shard = shards.find((s) => s.includes(f));
      if (shard) assert.equal([...shard].sort()[0], f, `${only ?? 'full'}: ${f} runs after ${[...shard].sort()[0]}`);
    }
  }
});
