// Proves launch's custody switch has one home that the beta and CI's launch-desk journeys both read (#11077).
// Run: node --test tooling/scripts/launch-custody.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FROZEN_CUSTODY_LAYER,
  LAUNCH_CUSTODY_LAYER,
  fileCustody,
  journeyIdOf,
  launchJourneyIds,
  readLaunchJourneyIds,
  shardCustody,
} from './launch-custody.mjs';
import { BETA_CUSTODY } from '../beta/beta-host.mjs';
import { startCustodyLayer } from './local-test-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('launch runs custody off, the beta reads it from here, and frozen journeys keep the stack default', () => {
  assert.equal(LAUNCH_CUSTODY_LAYER, 'off');
  assert.equal(BETA_CUSTODY, LAUNCH_CUSTODY_LAYER);
  assert.equal(FROZEN_CUSTODY_LAYER, startCustodyLayer({}));
});

test('a journey file names its journey; a part file names its journey too', () => {
  assert.equal(journeyIdOf('J-cex-spot-10.pw.mjs'), 'J-cex-spot-10');
  assert.equal(journeyIdOf('J-cex-spot-10-venue.pw.mjs'), 'J-cex-spot-10');
  assert.equal(journeyIdOf('apps/customer/tests/real-app/J-identity-06-trusted.pw.mjs'), 'J-identity-06');
  assert.equal(journeyIdOf('menu-reach.pw.mjs'), null);
});

test('the launch desk is the Order 1 journeys; every other file keeps the stack default', () => {
  const ids = launchJourneyIds([
    { id: 'J-a-1', order: 1 },
    { id: 'J-b-1', order: 2 },
  ]);
  assert.deepEqual([...ids], ['J-a-1']);
  assert.equal(fileCustody('J-a-1-venue.pw.mjs', ids), 'off');
  assert.equal(fileCustody('J-b-1.pw.mjs', ids), 'on');
  assert.equal(fileCustody('menu-reach.pw.mjs', ids), 'on');
  assert.throws(() => launchJourneyIds([]), /no journey/);
});

test("a shard's switch is its files' one switch; a mix is refused by name", () => {
  const ids = new Set(['J-a-1']);
  assert.equal(shardCustody(['J-a-1.pw.mjs', 'J-a-1-venue.pw.mjs'], ids), 'off');
  assert.equal(shardCustody(['J-b-1.pw.mjs', ''], ids), 'on');
  assert.throws(
    () => shardCustody(['J-a-1.pw.mjs', 'J-b-1.pw.mjs'], ids),
    /mixes custody off \(J-a-1\.pw\.mjs\) and on \(J-b-1\.pw\.mjs\)/,
  );
  assert.throws(() => shardCustody([''], ids), /no journey file/);
});

test("the real journeys list has a launch desk, and the command prints a shard's switch or refuses a mix", () => {
  const ids = readLaunchJourneyIds();
  assert.ok(ids.has('J-cex-spot-01') && ids.has('J-wallet-01') && ids.has('J-identity-01'), [...ids].join(' '));
  const run = (files) => spawnSync('node', ['tooling/scripts/launch-custody.mjs', '--files', files], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run('J-cex-spot-01.pw.mjs J-identity-01.pw.mjs').stdout, 'off\n');
  assert.equal(run('J-p2p-01.pw.mjs').stdout, 'on\n');
  const mixed = run('J-cex-spot-01.pw.mjs J-p2p-01.pw.mjs');
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /::error::one shard mixes custody/);
});
