import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, dependsOn, laneFor, parseSpec, queue } from './roadmap.mjs';

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

test('"slice 03" means slice 03 of the same group; "not needed" is not a dependency', () => {
  const known = new Set(['I-signin-sessions-01', 'I-signin-sessions-03', 'I-signin-sessions-04', 'I-signin-sessions-05']);
  assert.deepEqual(dependsOn('Slice 03 for reset wiring.', known, 'I-signin-sessions-04'), ['I-signin-sessions-03']);
  assert.deepEqual(dependsOn('Slice 01 not needed (sign-out is not guarded).', known, 'I-signin-sessions-05'), []);
  assert.deepEqual(dependsOn('None; uses the flows table also needed by slices 19 and 20.', known, 'I-signin-sessions-03'), []);
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
