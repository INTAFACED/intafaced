// A chart sweep is indexed by loaded bar the same way whether or not the live feed appends a bar during it
// (apps/customer/tests/real-app/bar-sweep.mjs `indexSweep`). Failure it prevents: #8589, run 43781915407 on `e2c0b251`,
// J-charts-desk-06 #1 refused "the chart moved during the sweep: {"from":-2.84e-14,"to":216,"loaded":211,…} then
// {…"loaded":212}" when a 15-minute bar formed mid-sweep, though no swept bar had moved. Every value here is fake.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexSweep } from '../../apps/customer/tests/real-app/bar-sweep.mjs';

const BAR = 15 * 60; // seconds
const T0 = 1_763_000_000 - (1_763_000_000 % BAR);
const at = (i) => T0 + i * BAR;
/** The view of `loaded` bars from bar `drop` on, at the #8589 run's edges. */
const view = (loaded, { from = -2.84e-14, to = 216, drop = 0 } = {}) => ({
  from,
  to,
  loaded,
  firstAt: at(drop) * 1000,
  lastAt: at(drop + loaded - 1) * 1000,
});
/** Bars `a..b` as a sweep finds them, 6 pixels each. */
const swept = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => ({ time: at(a + k), min: k * 6, max: k * 6 + 5 }));

test('#8589: a bar appended mid-sweep, before the sweep reached it, keeps every index', () => {
  const byIndex = indexSweep(view(211), view(212), swept(0, 210));
  assert.equal(byIndex.size, 211);
  assert.equal(byIndex.get(50).time, at(50));
  assert.equal(byIndex.get(80).time, at(80));
});

test('#8589: a bar appended mid-sweep that the sweep reached is indexed after the rest', () => {
  const byIndex = indexSweep(view(211), view(212), swept(0, 211));
  assert.equal(byIndex.size, 212);
  assert.equal(byIndex.get(50).time, at(50));
  assert.equal(byIndex.get(211).time, at(211));
});

test('a still chart is indexed from its first loaded bar', () => {
  const byIndex = indexSweep(view(211), view(211), swept(0, 210));
  assert.equal(byIndex.get(0).time, at(0));
  assert.equal(byIndex.get(80).time, at(80));
});

test('#7978: a left edge just past 0 still shows bar 0, indexed by its own time', () => {
  const v = view(215, { from: 0.3, to: 220 });
  assert.equal(indexSweep(v, v, swept(0, 214)).get(50).time, at(50));
});

test('a chart scrolled to its last bars is indexed from the last loaded bar', () => {
  const v = view(211, { from: 100.5, to: 210 });
  const byIndex = indexSweep(v, v, swept(100, 210));
  assert.equal(byIndex.get(100).time, at(100));
  assert.equal(byIndex.get(210).time, at(210));
});

test('a sweep is refused when the chart moved under the pointer', () => {
  const moved = /the chart moved during the sweep/;
  assert.throws(() => indexSweep(view(211), view(211, { drop: 1 }), swept(0, 210)), moved, 'the oldest bar dropped');
  assert.throws(() => indexSweep(view(211), view(211, { from: 1, to: 217 }), swept(0, 210)), moved, 'the edges scrolled');
  assert.throws(() => indexSweep(view(212), view(211), swept(0, 210)), moved, 'a bar went away');
  assert.throws(() => indexSweep(view(211), { ...view(212), lastAt: view(211).lastAt }, swept(0, 210)), moved, 'more bars, same last time');
});

test('a sweep that skipped a bar is refused', () => {
  const gap = [...swept(0, 49), ...swept(51, 210)];
  assert.throws(() => indexSweep(view(211), view(211), gap), /the sweep found bars 0\.\.209 of the 0\.\.210/);
  assert.throws(() => indexSweep(view(211), view(212), gap), /the sweep found bars 0\.\.209 of the 0\.\.210/, 'and with a bar appended');
});

test('a sweep that reached neither end is refused', () => {
  const v = view(211, { from: 10, to: 200 });
  assert.throws(() => indexSweep(v, v, swept(10, 200)), /reached neither the first nor the last loaded bar/);
});
