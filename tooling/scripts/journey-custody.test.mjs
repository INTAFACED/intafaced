// The custody switch per journey file (journey-custody.mjs), the planner keeping the two apart (journey-shards.mjs),
// the stack's reading of the switch (local-test-custody.mjs) and the shard check that holds them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JOURNEYS_JSON,
  CUSTODY_STARTS,
  checkShard,
  countSteps,
  custodyOf,
  journeyOf,
  partitionByCustody,
  readStarts,
  reportFiles,
  shardCustody,
} from './journey-custody.mjs';
import { JOURNEY_DIR, journeyFiles, planByCustody, planMixesCustody, planCovers } from './journey-shards.mjs';
import { stackCustodyLayer } from './local-test-custody.mjs';
import ledger from './local-stack-services/ledger.mjs';

const step = (n, later) => ({ n, slices: [], noSlice: false, ...(later ? { later } : {}) });
const J = [
  { id: 'J-wallet-04', later: 'custody', steps: [step(1), step(2)] },
  { id: 'J-ops-console-04', steps: [step(1), step(2, 'custody')] },
  { id: 'J-ops-console-0', steps: [step(1)] },
  { id: 'J-cex-spot-01', steps: [step(1), step(2)] },
];
const starts = (value, services = ['ledger', 'bank']) => services.map((service) => ({ service, custodyLayer: value, at: 'T' }));

test('a file of a Later: custody journey runs on; every other file, a mixed journey and a look sweep included, runs off', () => {
  assert.equal(custodyOf('J-wallet-04.pw.mjs', J), 'on');
  assert.equal(custodyOf('J-wallet-04-security-lock.pw.mjs', J), 'on');
  assert.equal(custodyOf('J-ops-console-04-freeze.pw.mjs', J), 'off');
  assert.equal(custodyOf('J-cex-spot-01-venue.pw.mjs', J), 'off');
  assert.equal(custodyOf('look-sweep-390.pw.mjs', J), 'off');
  assert.equal(journeyOf('J-ops-console-04-freeze.pw.mjs', J).id, 'J-ops-console-04', 'the longest id wins');
  assert.equal(journeyOf('J-wallet-040.pw.mjs', J), undefined, 'an id is a whole name or a name and a dash');
});

test('a shard has one custody value, and a shard of both is refused', () => {
  assert.equal(shardCustody(['J-wallet-04.pw.mjs'], J), 'on');
  assert.equal(shardCustody(['J-cex-spot-01.pw.mjs', 'look-sweep-390.pw.mjs'], J), 'off');
  assert.throws(() => shardCustody(['J-wallet-04.pw.mjs', 'J-cex-spot-01.pw.mjs'], J), /mixes custody-on files \(J-wallet-04\.pw\.mjs\)/);
  assert.deepEqual(partitionByCustody(['J-cex-spot-01.pw.mjs', 'J-wallet-04.pw.mjs'], J), {
    on: ['J-wallet-04.pw.mjs'],
    off: ['J-cex-spot-01.pw.mjs'],
  });
});

test('the check passes a shard whose every ledger and bank start ran its custody value', () => {
  assert.deepEqual(checkShard({ files: ['J-cex-spot-01.pw.mjs'], starts: starts('off'), journeys: J }), []);
  assert.deepEqual(checkShard({ files: ['J-wallet-04.pw.mjs'], starts: starts('on'), journeys: J }), []);
});

test('planted fault: a launch file on a custody-on stack fails the check', () => {
  const problems = checkShard({ files: ['J-cex-spot-01.pw.mjs'], starts: starts('on'), journeys: J });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /ledger started at T with LEDGER_CUSTODY_LAYER=on, but this shard's files run with off \(launch steps/);
});

test('planted fault: a restart during the journeys with custody on fails a launch shard', () => {
  const problems = checkShard({
    files: ['J-cex-spot-01.pw.mjs'],
    starts: [...starts('off'), { service: 'ledger', custodyLayer: 'on', at: 'later' }],
    journeys: J,
  });
  assert.deepEqual(problems, [
    "ledger started at later with LEDGER_CUSTODY_LAYER=on, but this shard's files run with off (launch steps must run with custody off)",
  ]);
});

test('planted fault: a second worker with the other value, a Later file run off, a missing start, a mixed shard', () => {
  assert.equal(
    checkShard({
      files: ['J-cex-spot-01.pw.mjs'],
      starts: [...starts('off'), { service: 'ledger-2', custodyLayer: 'on', at: 'T' }],
      journeys: J,
    }).length,
    1,
  );
  assert.match(
    checkShard({ files: ['J-wallet-04.pw.mjs'], starts: starts('off'), journeys: J })[0],
    /Later: custody journeys run with custody on/,
  );
  assert.deepEqual(checkShard({ files: ['J-cex-spot-01.pw.mjs'], starts: starts('off', ['ledger']), journeys: J }), [
    'no start of bank was recorded with the custody switch',
  ]);
  assert.match(checkShard({ files: ['J-wallet-04.pw.mjs', 'J-cex-spot-01.pw.mjs'], starts: starts('on'), journeys: J })[0], /mixes/);
  assert.match(checkShard({ files: [], starts: starts('off'), journeys: J })[0], /names no journey file/);
});

test('the record reads one start a line and names a line that is not JSON', () => {
  const { starts: got, problems } = readStarts('{"service":"ledger","custodyLayer":"off","at":"T"}\n\nnot json\n');
  assert.equal(got.length, 1);
  assert.deepEqual(problems, [`line 2 of ${CUSTODY_STARTS} is not JSON`]);
});

const report = (file, specs) => ({
  suites: [{ file, specs: specs.map(([title, status]) => ({ title, tests: [{ results: [{ status }] }] })) }],
});

test('the count takes launch steps on off files, Later journeys on on files, and later steps inside launch journeys apart', () => {
  const r = {
    suites: [
      ...report('J-cex-spot-01.pw.mjs', [
        ['J-cex-spot-01 #1 opens', 'passed'],
        ['J-cex-spot-01 #2 buys', 'failed'],
        ['J-cex-spot-01 starts: x', 'passed'],
      ]).suites,
      ...report('J-ops-console-04-freeze.pw.mjs', [
        ['J-ops-console-04 #1 freezes', 'passed'],
        ['J-ops-console-04 #2 holds', 'timedOut'],
      ]).suites,
      ...report('J-wallet-04.pw.mjs', [
        ['J-wallet-04 #1 deposits', 'passed'],
        ['J-wallet-04 #2 never ran', 'skipped'],
      ]).suites,
    ],
  };
  assert.deepEqual(countSteps(r, J), { launchOff: 3, laterOn: 1, laterStepsOff: 1 });
  assert.deepEqual(reportFiles(r), ['J-cex-spot-01.pw.mjs', 'J-ops-console-04-freeze.pw.mjs', 'J-wallet-04.pw.mjs']);
});

test('the planner never puts custody-on and custody-off files in one shard, and runs each file once', () => {
  const files = [
    'J-wallet-04.pw.mjs',
    'J-wallet-04-security-lock.pw.mjs',
    'J-cex-spot-01.pw.mjs',
    'J-ops-console-04-freeze.pw.mjs',
    'look-sweep-390.pw.mjs',
  ];
  const durations = new Map(files.map((f, i) => [f, (i + 1) * 60_000]));
  for (const shards of [1, 2, 3, 5]) {
    const plan = planByCustody(files, durations, shards, J);
    assert.deepEqual(planCovers(plan, files), [], `${shards} shards`);
    assert.deepEqual(planMixesCustody(plan, J), [], `${shards} shards`);
    assert.ok(plan.length <= Math.max(2, shards));
    for (const bin of plan) assert.equal(bin.custody, shardCustody(bin.files, J));
  }
  assert.deepEqual(
    planByCustody(['J-cex-spot-01.pw.mjs'], durations, 1, J).map((b) => b.custody),
    ['off'],
  );
  assert.deepEqual(planMixesCustody([{ files: ['J-wallet-04.pw.mjs', 'J-cex-spot-01.pw.mjs'] }], J), [
    'shard 1 mixes custody-on and custody-off files',
  ]);
});

test("the real planner's plan keeps every Later: custody file on a shard of its own kind", () => {
  const journeys = JSON.parse(fs.readFileSync(JOURNEYS_JSON, 'utf8'));
  const out = execFileSync(process.execPath, ['tooling/scripts/journey-shards.mjs', '--shards', 'auto'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const shards = JSON.parse(out).map((s) => s.split(' '));
  assert.deepEqual(shards.flat().sort(), journeyFiles(JOURNEY_DIR));
  for (const files of shards) shardCustody(files, journeys);
  const modes = shards.map((files) => shardCustody(files, journeys));
  assert.ok(modes.includes('on') && modes.includes('off'), 'the suite has files of both kinds');
});

test('the stack runs custody off unless asked for on, and refuses any other value', () => {
  assert.equal(stackCustodyLayer({}), 'off');
  assert.equal(stackCustodyLayer({ LEDGER_CUSTODY_LAYER: '' }), 'off');
  assert.equal(stackCustodyLayer({ LEDGER_CUSTODY_LAYER: 'on' }), 'on');
  assert.equal(stackCustodyLayer({ LEDGER_CUSTODY_LAYER: 'off' }), 'off');
  assert.throws(() => stackCustodyLayer({ LEDGER_CUSTODY_LAYER: 'true' }), /LEDGER_CUSTODY_LAYER is "true"/);
});

test("svc-ledger's and svc-bank's stack env take the switch from local-test-custody.mjs, never a fixed on", () => {
  for (const name of ['ledger', 'bank']) {
    const src = fs.readFileSync(`tooling/scripts/local-stack-services/${name}.mjs`, 'utf8');
    assert.match(src, /LEDGER_CUSTODY_LAYER: stackCustodyLayer\(\),/, name);
    assert.doesNotMatch(src, /LEDGER_CUSTODY_LAYER:\s*['"]on['"]/, name);
  }
  const was = process.env.LEDGER_CUSTODY_LAYER;
  try {
    delete process.env.LEDGER_CUSTODY_LAYER;
    const env = ledger({ c: () => ({}), secrets: {}, dbUrl: () => 'x', urlOf: () => 'http://x', PORTS: {} }).env();
    assert.equal(env.LEDGER_CUSTODY_LAYER, 'off');
  } finally {
    if (was === undefined) delete process.env.LEDGER_CUSTODY_LAYER;
    else process.env.LEDGER_CUSTODY_LAYER = was;
  }
});

test('the CLI check fails a launch shard whose stack state recorded a custody-on start, and passes it off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-custody-'));
  fs.mkdirSync(path.join(dir, 'run'));
  const write = (value) =>
    fs.writeFileSync(
      path.join(dir, CUSTODY_STARTS),
      starts(value)
        .map((s) => JSON.stringify(s))
        .join('\n') + '\n',
    );
  const run = () =>
    spawnSync(process.execPath, ['tooling/scripts/journey-custody.mjs', 'check', '--state', dir, '--files', 'J-academy-01.pw.mjs'], {
      encoding: 'utf8',
    });
  write('off');
  assert.equal(run().status, 0);
  write('on');
  const red = run();
  assert.equal(red.status, 1);
  assert.match(red.stderr, /::error::custody: ledger started at T with LEDGER_CUSTODY_LAYER=on/);
  fs.rmSync(dir, { recursive: true });
});
