import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyse, buildIndex, dependsOn, laneFor, parseSpec, progress, queue, untangle } from './roadmap.mjs';

test('a slice heading and its table rows are read', () => {
  const text = [
    '### SP-order-entry-02. Market order sizing by value',
    '',
    '| | |',
    '|---|---|',
    '| IDs | `cex-spot-order-entry-001` Market order (thin, core) |',
    '| Depends | `SP-order-entry-01` (typed body). Blocks `SP-conditional-algo-01`. |',
    '| Size | M |',
  ].join('\n');
  const [slice] = parseSpec(text, 'cex-spot', 'spot-order-entry', 'modules/cex-spot/specs/spot-order-entry.md');
  assert.equal(slice.id, 'SP-order-entry-02');
  assert.equal(slice.fields.Size, 'M');
  assert.match(slice.fields.Depends, /typed body/);
});

test('only what a slice needs counts as a dependency, not what it unblocks', () => {
  const known = new Set(['SP-order-entry-01', 'SP-order-entry-02', 'SP-conditional-algo-01']);
  assert.deepEqual(dependsOn('`SP-order-entry-01` (typed body). Blocks `SP-conditional-algo-01`.', known, 'SP-order-entry-02'), [
    'SP-order-entry-01',
  ]);
  assert.deepEqual(dependsOn('None. First slice of the group. Blocks `SP-order-entry-02`.', known, 'SP-order-entry-01'), []);
});

test('"slice 03" means slice 03 of the same group, "slice xfer-07" a slice of the same module; "not needed" is not a dependency', () => {
  const known = new Set(['I-signin-sessions-01', 'I-signin-sessions-03', 'I-signin-sessions-04', 'I-signin-sessions-05']);
  assert.deepEqual(dependsOn('Slice 03 for reset wiring.', known, 'I-signin-sessions-04'), ['I-signin-sessions-03']);
  assert.deepEqual(dependsOn('Slice 01 not needed (sign-out is not guarded).', known, 'I-signin-sessions-05'), []);
  assert.deepEqual(dependsOn('None; uses the flows table also needed by slices 19 and 20.', known, 'I-signin-sessions-03'), []);
  const bank = new Set(['BK-xfer-04', 'BK-xfer-07']);
  assert.deepEqual(dependsOn('`rail.bank`. Slice xfer-07 for proof and linking.', bank, 'BK-xfer-04'), ['BK-xfer-07']);
});

test('a slice is built in its back-end service lane, split where one service serves two modules', () => {
  const base = { packages: [], areas: [], apps: ['customer'] };
  assert.equal(laneFor({ ...base, module: 'cex-spot', services: ['svc-trade'] }), 'svc-trade spot');
  assert.equal(laneFor({ ...base, module: 'derivatives', services: ['svc-trade'] }), 'svc-trade futures');
  assert.equal(laneFor({ ...base, module: 'wallet', services: ['svc-pay'] }), 'svc-pay wallet');
  assert.equal(laneFor({ ...base, module: 'merchant', services: ['svc-ledger', 'svc-pay'] }), 'svc-pay merchant');
  assert.equal(laneFor({ ...base, module: 'bank', services: ['svc-ledger'] }), 'ledger');
  assert.equal(laneFor({ ...base, module: 'home-ia', services: [], areas: ['customer: home'] }), 'customer: home');
});

test('slices that need nothing come first; slices in a loop are found, not guessed', () => {
  const slices = [
    { id: 'A-x-01', module: 'm', depends: [] },
    { id: 'A-x-02', module: 'm', depends: ['A-x-01'] },
    { id: 'A-x-03', module: 'm', depends: ['A-x-04'] },
    { id: 'A-x-04', module: 'm', depends: ['A-x-03'] },
  ];
  const analysis = analyse(slices);
  assert.deepEqual([...analysis.tangled].sort(), ['A-x-03', 'A-x-04']);
  assert.equal(analysis.depth.get('A-x-02'), 2);
  assert.equal(queue(slices, analysis)[0].id, 'A-x-01');
});

test('progress counts PRs per slice, excludes reverts, and gives 3-hour and 7-day rates', () => {
  const slices = [
    { id: 'SP-x-01', lane: 'svc-trade spot' },
    { id: 'SP-x-02', lane: 'svc-trade spot' },
    { id: 'BK-y-01', lane: 'svc-bank' },
    { id: 'BK-y-02', lane: 'svc-bank' },
  ];
  const page = progress(
    slices,
    [
      { at: '2026-10-20T11:00:00Z', subject: 'svc-trade: SP-x-02 limit order, part 2 (#4)' },
      { at: '2026-10-20T10:30:00Z', subject: 'Revert "svc-bank: BK-y-02 statements (#3)"' },
      { at: '2026-10-20T07:00:00Z', subject: 'svc-trade: SP-x-02 limit order, part 1 (#2)' },
      { at: '2026-10-19T12:00:00Z', subject: 'svc-trade: SP-x-01 market order (#1)' },
      { at: '2026-10-01T12:00:00Z', subject: 'svc-bank: BK-y-01 accounts (#0)' },
      { at: '2026-10-20T11:30:00Z', subject: 'svc-bank: tidy, mentions NOPE-z-01' },
    ],
    '2026-10-20T12:00:00Z',
  );
  assert.match(page, /Started \(named in at least one merged PR\): 3 of 4 slices\. Not started: 1\./);
  assert.match(page, /PRs per started slice: 1\.3 on average; 2 have one PR, 1 two, 0 three or more\./);
  assert.match(page, /Last 3 hours: 1 PRs, 0 slices started \(8\.0 PRs a day\)\./);
  assert.match(page, /Last 7 days: 3 PRs, 2 slices started \(0\.4 PRs a day\)\./);
  assert.match(page, /Forecast at the 3-hour pace: about 1 days for the 1 unstarted slices at 2\.0 PRs each/);
  assert.match(page, /\| svc-trade spot \| 2 \| 2 \| 3 \|/);
});

test('a lane override beats the computed lane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-'));
  mkdirSync(join(dir, 'modules', 'wallet', 'specs'), { recursive: true });
  const spec = (id) => [`### ${id}. Something`, '', '| | |', '|---|---|', '| Module | nothing that names a service |', '| Size | S |', ''];
  writeFileSync(join(dir, 'modules', 'wallet', 'specs', 'w.md'), [...spec('W-x-01'), ...spec('W-x-02')].join('\n'));
  const lanes = Object.fromEntries(buildIndex(dir, { 'W-x-02': 'svc-bank' }).map((s) => [s.id, s.lane]));
  assert.equal(lanes['W-x-02'], 'svc-bank');
  assert.notEqual(lanes['W-x-01'], 'svc-bank');
});

test('two slices that each need the other: the earlier one goes first, and its edge moves to later', () => {
  const out = untangle([
    { id: 'Q-a-01', spec: 's.md', depends: ['Q-a-02'] },
    { id: 'Q-a-02', spec: 's.md', depends: ['Q-a-01'] },
    { id: 'T-b-01', spec: 't.md', depends: ['Q-a-01', 'U-c-01'] },
    { id: 'U-c-01', spec: 'u.md', depends: ['T-b-01'] },
  ]);
  const by = Object.fromEntries(out.map((s) => [s.id, s]));
  assert.deepEqual(by['Q-a-01'].depends, []);
  assert.deepEqual(by['Q-a-01'].later, ['Q-a-02']);
  assert.deepEqual(by['Q-a-02'].depends, ['Q-a-01']);
  assert.deepEqual(by['U-c-01'].depends, [], 'fewer dependencies goes first across specs');
  assert.deepEqual(by['T-b-01'].depends, ['Q-a-01', 'U-c-01']);
  assert.equal(analyse(out).tangled.size, 0);
});
