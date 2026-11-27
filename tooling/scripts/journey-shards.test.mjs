// Proves the journey shard split without a run. Run: node --test tooling/scripts/journey-shards.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JOURNEY_DIR,
  JOBS_PAGE,
  MAX_SHARDS,
  MIN_SHARDS,
  MIN_TARGET_MINUTES,
  TARGETED_MAX_SHARDS,
  UNTIMED_STEP_MS,
  estimateDurations,
  freshFiles,
  fileDurations,
  fullPlan,
  jobsFit,
  journeyFiles,
  longFiles,
  longestDurations,
  custodyShares,
  planByCustody,
  planCovers,
  planShards,
  shardCount,
  shardTarget,
  sourceTitles,
  stepTime,
  titleDurations,
  titleEstimates,
  stepCounts,
  targetFiles,
  targetedShards,
  timedSteps,
  PR_MAX_SHARDS,
  SETUP_SPREAD_MINUTES,
  TAPE_READY_MINUTES,
  TAPE_WAIT,
  ownDuration,
  shardEnd,
  tapeFiles,
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
  // Well past the 8-shard floor #8032 fell to: the untimed suite is far over 32 shards of 10 minutes, so it plans past
  // the old pull-request ceiling, within main's.
  assert.ok(shards.length > 32 && shards.length <= MAX_SHARDS, `${shards.length} shards`);
  assert.deepEqual(shards.flatMap((s) => s.split(' ')).sort(), journeyFiles(JOURNEY_DIR));
});

// Every full run aims each shard at the floor, up to main's ceiling, so a pull request's journey meets the same
// neighbours as on main (MAX_SHARDS: #8509's runs 43731598319 and 43745698376 went red in shards of 10 files on
// steps main passed in shards of 3 to 6). A targeted run keeps its own plan.
test('every full run, on main or off it, plans 10-minute shards up to 90, the same plan from the same reports', () => {
  const min = 60_000;
  assert.deepEqual(fullPlan(), { target: MIN_TARGET_MINUTES * min, max: MAX_SHARDS });
  assert.equal(MAX_SHARDS, 90);
  const plan = (args) =>
    JSON.parse(
      execFileSync(process.execPath, ['tooling/scripts/journey-shards.mjs', '--shards', 'auto', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  const main = plan(['--main']);
  // With no report every step counts UNTIMED_STEP_MS: more shards than the old 32, never past main's ceiling.
  assert.ok(main.length > 32 && main.length <= MAX_SHARDS, `${main.length} shards`);
  assert.deepEqual(main.flatMap((s) => s.split(' ')).sort(), journeyFiles(JOURNEY_DIR));
  // A pull request's full run (no --main) gets the very same shards, each with the same files.
  assert.deepEqual(plan([]), main);
  // --only wins: a targeted run is never main's, so --main never lifts its cap.
  assert.ok(plan(['--main', '--only', 'J-wallet-05']).length <= TARGETED_MAX_SHARDS);
});

test('the shard count keeps each shard near the target, within its floor and ceiling', () => {
  const min = 60_000;
  assert.equal(shardCount(236 * min, 25 * min), 10);
  assert.equal(shardCount(10 * min, 25 * min), 8);
  assert.equal(shardCount(5000 * min, 25 * min), 90);
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
  // Pull request run 45138504039 (23 Nov 2026): J-campaigns-18 took 14.9 minutes and 163 files about 363, so shards of
  // 12.9 minutes, 29 of them, end with it instead of 30 of 10 that end before it and wait on it.
  assert.equal(SETUP_SPREAD_MINUTES, 2);
  assert.equal(
    shardTarget(
      new Map([
        ['J-campaigns-18.pw.mjs', 14.9 * min],
        ['J-cex-spot-10.pw.mjs', 12.5 * min],
      ]),
    ),
    774_000,
  );
  assert.equal(shardCount(363 * min, 774_000), 29);
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

test("a pull request's run takes the shards its target asks, at most 60, and is never the full suite (project-state#3377, #3035)", () => {
  const min = 60_000;
  assert.equal(PR_MAX_SHARDS, 60);
  const timed = (n, each) => {
    const files = Array.from({ length: n }, (_, i) => `J-x-${String(i).padStart(3, '0')}.pw.mjs`);
    return { files, durations: new Map(files.map((f) => [f, each * min])) };
  };
  // #9170's bounded set (run 44668020108): 65 files, about 194 minutes, at the 10-minute target. A pull request's run
  // takes the 20 shards the target asks; packed into a run by hand's 10 they ran 20 to 25 minutes each.
  const bounded = timed(65, 3);
  assert.equal(
    targetedShards(bounded.files, bounded.durations, 10 * min, undefined, true),
    20,
    "a pull request's run: what the target asks",
  );
  assert.equal(targetedShards(bounded.files, bounded.durations, 10 * min), TARGETED_MAX_SHARDS, 'a run by hand keeps its cap');
  // Planted, the past mistake (#8836's run 44250481099: 355 files planned as a full run): a run by hand still fails open
  // to the full plan, a pull request's stops at 60.
  const big = timed(400, 5);
  assert.equal(targetedShards(big.files, big.durations, 15 * min), MAX_SHARDS, 'a run by hand: planned as a full run');
  assert.equal(targetedShards(big.files, big.durations, 15 * min, undefined, true), 60, "a pull request's run: 60");
  assert.equal(
    targetedShards(timed(60, 5).files, timed(60, 5).durations, 15 * min, undefined, true),
    20,
    'under the cap: what the target asks',
  );
  // Few files take as few shards as before.
  assert.equal(targetedShards(timed(3, 5).files, timed(3, 5).durations, 10 * min, undefined, true), 2);
  // The planner refuses a pull request's run with no journeys input (the full suite).
  const out = spawnSync('node', [fileURLToPath(new URL('./journey-shards.mjs', import.meta.url)), '--shards', 'auto', '--pull'], {
    encoding: 'utf8',
  });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /never the full suite/);
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
  // Fails open: 120 files of 5 minutes in 10 shards would need 60 minutes each, so it plans as a full run: 60 shards
  // of 10 minutes, not 40 of the 15-minute target.
  const big = timed(120, 5);
  assert.equal(targetedShards(big.files, big.durations, 15 * min), 60);
  // The boundary: exactly at the limit caps; one minute over doesn't.
  const edge = timed(10, 40);
  assert.equal(targetedShards(edge.files, edge.durations, 10 * min, 40 * min), 10);
  assert.equal(targetedShards(edge.files, edge.durations, 10 * min, 39 * min), 10, 'never more shards than the target asks');
  const over = timed(20, 21);
  assert.equal(targetedShards(over.files, over.durations, 10 * min, 42 * min), 10);
  assert.equal(targetedShards(over.files, over.durations, 10 * min, 42 * min - 1), 20);
});

// Run 44250481099 (18 Nov 2026): the touched-journeys map narrowed four svc-bank paths to 355 journey files, about 877
// minutes. The targeted plan stopped at 32 shards of about 27 minutes and the run took 45 minutes, while full runs of 64
// shards took 28 to 34. A targeted run too big for its cap plans exactly as the full suite would.
test('a targeted run too big for its 10-shard cap plans as a full run does, up to 90 shards, never fewer', () => {
  const min = 60_000;
  const files = Array.from({ length: 355 }, (_, i) => `J-x-${String(i).padStart(3, '0')}.pw.mjs`);
  const durations = new Map(files.map((f) => [f, (877 / 355) * min]));
  const full = fullPlan();
  const asFull = Math.min(files.length, shardCount(877 * min, full.target, MIN_SHARDS, full.max));
  assert.equal(asFull, 88);
  assert.equal(targetedShards(files, durations, 10 * min), asFull);
  assert.equal(targetedShards(files, durations, 25 * min), asFull, 'a long target does not shrink it below the full plan');
  const plan = planShards(files, durations, asFull);
  assert.deepEqual(planCovers(plan, files), [], 'every file runs exactly once');
  assert.ok(Math.max(...plan.map((bin) => bin.ms)) <= 15 * min, 'shards of about 15 minutes, not 27');
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

test('a file far longer than the median shard is named, longest first; the run waits on it whatever the plan (15 Nov 2026)', () => {
  const min = 60_000;
  // Main's run 43656238027 in small: shards of about 12 minutes, two files of 23 and 15 minutes, one of 13.
  const durations = new Map([
    ['J-long.pw.mjs', 23 * min],
    ['J-mid.pw.mjs', 15 * min],
    ['J-near.pw.mjs', 13 * min],
    ...Array.from({ length: 12 }, (_, i) => [`J-f${String(i).padStart(2, '0')}.pw.mjs`, 6 * min]),
  ]);
  const plan = planShards([...durations.keys()], durations, 9);
  assert.equal(planCovers(plan, [...durations.keys()]).length, 0);
  assert.deepEqual(
    longFiles(plan, durations).map(({ file, ms, medianMs }) => [file, ms / min, medianMs / min]),
    [
      ['J-long.pw.mjs', 23, 12],
      ['J-mid.pw.mjs', 15, 12],
    ],
    'over the median by more than the 2-minute slack: named; 13 against 12 is within it',
  );
  // Split the long file into parts of 12 and 11 minutes and nothing is named.
  const split = new Map([...durations].filter(([f]) => f !== 'J-long.pw.mjs' && f !== 'J-mid.pw.mjs'));
  split
    .set('J-long.pw.mjs', 12 * min)
    .set('J-long-part.pw.mjs', 11 * min)
    .set('J-mid.pw.mjs', 8 * min)
    .set('J-mid-part.pw.mjs', 7 * min);
  assert.deepEqual(longFiles(planShards([...split.keys()], split, 10), split), []);
  assert.deepEqual(longFiles([], new Map()), [], 'an empty plan names nothing');
});

test('the planner as the workflow calls it on main names the files the run waits on in a warning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-shards-long-'));
  const files = journeyFiles(JOURNEY_DIR);
  // Every step timed, so no untimed step adds to a file: the first file 40 minutes, every other 2.
  const steps = stepCounts(JOURNEY_DIR, files);
  const suites = files.map((file, i) => {
    const n = Math.max(1, steps.get(file));
    return {
      file,
      specs: Array.from({ length: n }, () => ({
        tests: [{ results: [{ status: 'passed', duration: ((i === 0 ? 40 : 2) * 60_000) / n }] }],
      })),
    };
  });
  const report = path.join(dir, 'report.json');
  fs.writeFileSync(report, JSON.stringify({ suites }));
  const run = spawnSync(process.execPath, ['tooling/scripts/journey-shards.mjs', '--shards', 'auto', '--report', report, '--main'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const warned = run.stderr.split('\n').filter((l) => l.startsWith('::warning::') && l.includes('the run waits on it'));
  assert.equal(warned.length, 1, run.stderr);
  assert.ok(warned[0].startsWith(`::warning::${files[0]} takes about 40 min`), warned[0]);
});

test('a step moved into a part file takes its time with it, found by its title (15 Nov 2026 splits)', () => {
  const min = 60_000;
  // Main's report from before the split: every step in J-x.pw.mjs, 20 minutes in all.
  const before = {
    suites: [
      {
        file: 'J-x.pw.mjs',
        specs: [
          { title: 'J-x starts: an account', tests: [{ results: [{ status: 'passed', duration: 2 * min }] }] },
          { title: 'J-x #1 reads', tests: [{ results: [{ status: 'passed', duration: 3 * min }] }] },
          {
            title: 'J-x #2 sends',
            tests: [
              {
                results: [
                  { status: 'failed', duration: 9 * min },
                  { status: 'passed', duration: 6 * min },
                ],
              },
            ],
          },
          { title: 'J-x #3 never ran', tests: [{ results: [{ status: 'skipped', duration: 0 }] }] },
        ],
      },
    ],
  };
  const times = titleDurations(before);
  assert.equal(times.get('J-x #2 sends'), 15 * min, 'every timed result of a title, retries included');
  assert.equal(times.has('J-x #3 never ran'), false, 'a skipped step says nothing about its time');
  const texts = new Map([
    ['J-x.pw.mjs', "const J = 'J-x';\ntest(`${J} starts: an account`, async () => {});\ntest(`${J} #1 reads`, async () => {});\n"],
    [
      'J-x-send.pw.mjs',
      "const J = 'J-x';\ntest(`${J} starts (send): an account`, async () => {});\ntest(`${J} #2 sends`, async () => {});\ntest(`${J} #3 never ran`, async () => {});\n",
    ],
    [
      'J-loop.pw.mjs',
      "const J = 'J-loop';\nfor (const n of [1, 2]) test(`${J} #${n}`, async () => {});\n  test(`${J} #${n} too`, () => {});\n",
    ],
  ]);
  assert.deepEqual(sourceTitles(texts.get('J-x.pw.mjs')), ['J-x starts: an account', 'J-x #1 reads']);
  assert.equal(sourceTitles(texts.get('J-loop.pw.mjs')), null, 'a title with anything but ${J} to fill in is not read');
  const fallback = new Map([
    ['J-x.pw.mjs', 20 * min],
    ['J-x-send.pw.mjs', 1],
    ['J-loop.pw.mjs', 7 * min],
  ]);
  const est = titleEstimates([...texts.keys()], texts, times, min, fallback);
  assert.equal(est.get('J-x.pw.mjs'), 5 * min, 'the original keeps only the time of the steps it still holds');
  assert.equal(
    est.get('J-x-send.pw.mjs'),
    17 * min,
    'the part file: #2 moved with its 15 minutes, a new setup and an untimed step a step each',
  );
  assert.equal(est.get('J-loop.pw.mjs'), 7 * min, 'an unreadable file keeps its own past time');
  assert.equal(stepTime(['J-x.pw.mjs'], new Map([['J-x.pw.mjs', 20 * min]]), new Map([['J-x.pw.mjs', 4]])), 5 * min);
  assert.equal(stepTime([], new Map(), new Map()), UNTIMED_STEP_MS);
});

test("the repo's journey titles read from their files match the titles main's reports use", () => {
  const files = journeyFiles(JOURNEY_DIR);
  const read = files.map((f) => sourceTitles(fs.readFileSync(path.join(JOURNEY_DIR, f), 'utf8')));
  const readable = read.filter(Boolean);
  assert.ok(readable.length > files.length * 0.9, `${readable.length} of ${files.length} journey files have readable titles`);
  const all = readable.flat();
  assert.equal(new Set(all).size, all.length, 'no title is declared twice across the journey files');
  assert.ok(
    all.includes(
      "J-wallet-05 #8 watches the status: requested, held, broadcast, confirming and settled in plain words, settled only at the owner's depth, and a failure reads as a sentence",
    ),
  );
});

// The run's readers ask one page of 100 jobs (MAX_SHARDS says which), so every shard and every other job of a run fit on
// it. Planted: one shard more than the page leaves room for is refused by name.
test("every shard of the largest full run fits on one page of the jobs API beside the run's other jobs", () => {
  const yml = fs.readFileSync('.github/workflows/real-app-journeys.yml', 'utf8');
  assert.deepEqual(jobsFit(yml), []);
  const others = JOBS_PAGE - MAX_SHARDS;
  assert.ok(others >= 1);
  const room = yml.split(/^jobs:$/m)[1].match(/^ {2}[a-z][a-z0-9_-]*:$/gm).length - 1;
  assert.deepEqual(jobsFit(yml, JOBS_PAGE - room), []);
  assert.match(jobsFit(yml, JOBS_PAGE - room + 1)[0], /past one page of 100 jobs: lower MAX_SHARDS/);
  assert.deepEqual(jobsFit('name: x\n'), ['no jobs read from the workflow']);
});

test("a step's own time leaves out the time it waited on the TEST tape, by the annotation tapeWindow records", () => {
  const waited = { duration: 400_000, status: 'passed', annotations: [{ type: TAPE_WAIT, description: '330000' }] };
  assert.equal(ownDuration(waited), 70_000);
  assert.equal(ownDuration({ duration: 5_000, annotations: [{ type: 'serial' }] }), 5_000);
  assert.equal(ownDuration({ duration: 5_000, annotations: [{ type: TAPE_WAIT, description: 'nonsense' }] }), 5_000);
  assert.equal(ownDuration({ duration: 5_000, annotations: [{ type: TAPE_WAIT, description: '9000' }] }), 0, 'never below zero');
  const r = { suites: [{ file: 'J-algo-dev-14.pw.mjs', specs: [{ title: 'J-algo-dev-14 #1 mints', tests: [{ results: [waited] }] }] }] };
  assert.equal(fileDurations(r).get('J-algo-dev-14.pw.mjs'), 70_000);
  assert.equal(titleDurations(r).get('J-algo-dev-14 #1 mints'), 70_000);
});

test('a shard ends with its files in name order, the first that reads the tape not before the tape is ready', () => {
  const min = 60_000;
  const d = new Map([
    ['J-academy-02.pw.mjs', 1.2 * min],
    ['J-algo-dev-14.pw.mjs', 1 * min],
    ['J-identity-08.pw.mjs', 5 * min],
    ['J-wallet-01.pw.mjs', 9 * min],
  ]);
  const tape = new Set(['J-algo-dev-14.pw.mjs']);
  const ready = TAPE_READY_MINUTES * min;
  assert.equal(shardEnd(['J-wallet-01.pw.mjs', 'J-algo-dev-14.pw.mjs', 'J-academy-02.pw.mjs'], d, tape), ready + 10 * min);
  assert.equal(shardEnd(['J-academy-02.pw.mjs', 'J-identity-08.pw.mjs'], d, tape), 6.2 * min, 'no tape, no wait');
  assert.equal(shardEnd(['J-algo-dev-14.pw.mjs'], d, tape, 0.5 * min), 1.5 * min);
  assert.equal(shardEnd(['J-wallet-01.pw.mjs', 'J-academy-02.pw.mjs'], d), 10.2 * min, 'without a tape set it sums');
});

test("the repo's files that read the tape are the ones that call tapeWindow", () => {
  const files = journeyFiles(JOURNEY_DIR);
  const tape = tapeFiles(JOURNEY_DIR, files);
  assert.ok(tape.has('J-algo-dev-14.pw.mjs') && tape.has('J-algo-dev-06.pw.mjs'));
  assert.ok(!tape.has('J-academy-02.pw.mjs'));
});

test("run 45138504039's shard waiting on the tape: the plan that counts the wait keeps every shard within 1.3 times the median (project-state#3917)", () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/journey-shards-run-45138504039.json', import.meta.url), 'utf8'));
  const d = new Map(Object.entries(fx.seconds).map(([f, s]) => [f, s * 1000]));
  const files = [...d.keys()];
  const tape = new Set(fx.tape);
  // A shard job's setup before its journeys: the median of 136 shard jobs on 23 Nov 2026 (SETUP_SPREAD_MINUTES).
  const setup = 2.1 * 60_000;
  const ratio = (plan) => {
    const ends = plan.map((bin) => setup + shardEnd(bin.files, d, tape)).sort((a, b) => a - b);
    return ends.at(-1) / ends[Math.floor(ends.length / 2)];
  };
  // The past mistake: the run's own plan of 30 shards, made blind to the wait (no tape set), as before this change.
  const blind = planShards(files, d, 30);
  assert.ok(ratio(blind) > 1.3, `the blind plan's longest shard is ${ratio(blind).toFixed(2)} times its median`);
  // The plan as the workflow now makes it: the target and count from the times, the wait counted.
  const shards = targetedShards(files, d, shardTarget(d), undefined, true);
  const plan = planShards(files, d, shards, new Set(), tape);
  assert.deepEqual(planCovers(plan, files), []);
  assert.ok(ratio(plan) <= 1.3, `the plan's longest shard is ${ratio(plan).toFixed(2)} times its median`);
  // Counting the wait alone, at the run's own 30 shards, already brings it under the bar.
  assert.ok(ratio(planShards(files, d, 30, new Set(), tape)) <= 1.3);
});

// #11077: a launch-desk file's stack runs custody as launch does, a frozen journey's on today's, so no shard mixes them.
test('plans each custody switch apart, so no shard mixes a launch-desk file with a frozen one', () => {
  const files = [
    'J-a-1.pw.mjs',
    'J-a-1-venue.pw.mjs',
    'J-a-2.pw.mjs',
    'J-b-1.pw.mjs',
    'J-b-2.pw.mjs',
    'J-b-3.pw.mjs',
    'J-b-4.pw.mjs',
    'J-b-5.pw.mjs',
  ];
  const durations = new Map(files.map((f) => [f, 60_000]));
  const custodyOf = (f) => (f.startsWith('J-a-') ? 'off' : 'on');
  const plan = planByCustody(files, durations, 4, new Set(), new Set(), custodyOf);
  assert.equal(plan.length, 4);
  assert.deepEqual(planCovers(plan, files, new Set(), custodyOf), []);
  assert.deepEqual(
    plan.map((bin) => custodyOf(bin.files[0])),
    ['off', 'on', 'on', 'on'],
  );
  // The same files planned without the switch mix them, and planCovers names it.
  const mixed = planShards(files, durations, 3);
  assert.ok(planCovers(mixed, files, new Set(), custodyOf).some((p) => /mixes custody off and on/.test(p)));
  // One shard can't keep two switches apart; the caller takes one more shard.
  assert.throws(() => planByCustody(files, durations, 1, new Set(), new Set(), custodyOf), /cannot keep 2 custody switches apart/);
  // Without a switch the plan is planShards' own.
  assert.deepEqual(planByCustody(files, durations, 3), planShards(files, durations, 3));
});

test('gives each custody group shards by its time, at least one, no more than its files, and one per fresh file', () => {
  const groups = [{ files: ['a1', 'a2'] }, { files: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'] }];
  const durations = new Map([...groups[0].files, ...groups[1].files].map((f) => [f, 60_000]));
  assert.deepEqual(custodyShares(groups, durations, 4), [1, 3]);
  assert.deepEqual(custodyShares(groups, durations, 20), [2, 6]);
  assert.deepEqual(custodyShares(groups, durations, 2), [1, 1]);
  assert.deepEqual(custodyShares(groups, durations, 4, new Set(['a1', 'a2'])), [2, 2]);
});

test("the planner's real plan never mixes custody in a shard (launch-custody.mjs)", () => {
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const out = execFileSync('node', ['tooling/scripts/journey-shards.mjs', '--shards', 'auto'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const shard of JSON.parse(out)) {
    const r = spawnSync('node', ['tooling/scripts/launch-custody.mjs', '--files', shard], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^(on|off)\n$/);
  }
});
