// Each journey file gets a TEST venue of its own (apps/customer/tests/real-app/world-restore.mjs `ownVenueFor`): entering
// a new file stops the venue if it runs and names the next one by a fresh id, which the stack passes to the venue it
// starts (local-test-stack.mjs startTestVenue; local-test-venue.mjs testVenueId). Failures it prevents: J-cex-spot-02 #7
// met the bid J-bank-13 left on the TEST venue's BTC-USDC (#8546), and J-campaigns-11 #3 met the seeded 59,990 bid
// J-agents-18 had sold into (#8594 to #8596). The real venue process is proved in the Real-app journeys run; this holds
// the harness's part of it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { testVenueId } from './local-test-venue.mjs';

import * as restore from '../../apps/customer/tests/real-app/world-restore.mjs';

const realApp = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/customer/tests/real-app');

test("the venue's id: blank is the simulator's own, a fresh one is test-venue-sim- and 4 to 16 letters or digits", () => {
  for (const blank of [undefined, '', '  ']) assert.equal(testVenueId(blank), null);
  assert.equal(testVenueId('test-venue-sim-0a1b2c3d'), 'test-venue-sim-0a1b2c3d');
  assert.equal(testVenueId(' test-venue-sim-abcd '), 'test-venue-sim-abcd');
  // Anything that is not plainly a TEST venue's id, or that the ledger's builder-fee venue id would refuse, is refused.
  for (const bad of [
    'venue-1',
    'test-venue-sim',
    'test-venue-sim-',
    'test-venue-sim-ABCD',
    'test-venue-sim-abc',
    'test-venue-sim-a_b1',
    'hyperliquid',
  ]) {
    assert.throws(() => testVenueId(bad), /TEST_VENUE_ID must be/, bad);
  }
});

test('a fresh id is a valid venue id and never the same twice', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const id = restore.freshVenueId();
    assert.equal(testVenueId(id), id);
    ids.add(id);
  }
  assert.equal(ids.size, 200);
});

test('entering a file stops the running TEST venues and names the next one fresh', async () => {
  const stopped = [];
  const env = {};
  const first = await restore.ownVenueFor({ up: async (name) => name === 'test-venue', stop: async (names) => stopped.push(names), env });
  assert.deepEqual(stopped, [['test-venue']], 'the running venue is stopped, and only it');
  assert.equal(env[restore.VENUE_ID_SETTING], first.id);
  assert.deepEqual(first.said, []);
  // Both venues running (J-derivatives-28 ran last): both stop. A new file never has the last file's id.
  const second = await restore.ownVenueFor({ up: async () => true, stop: async (names) => stopped.push(names), env });
  assert.deepEqual(stopped.at(-1), ['test-venue', 'test-venue-b']);
  assert.notEqual(second.id, first.id);
  assert.equal(env[restore.VENUE_ID_SETTING], second.id);
  // None running: nothing is stopped, and the file still gets its own id for the venue it may start.
  const before = stopped.length;
  const third = await restore.ownVenueFor({ up: async () => false, stop: async (names) => stopped.push(names), env });
  assert.equal(stopped.length, before);
  assert.equal(env[restore.VENUE_ID_SETTING], third.id);
});

test('a venue that could not be stopped is said, never hidden', async () => {
  const env = {};
  const run = await restore.ownVenueFor({
    up: async (name) => name === 'test-venue',
    stop: async () => {
      throw Object.assign(new Error('Command failed'), { stderr: 'test-venue: pid 42 no longer matches' });
    },
    env,
  });
  assert.equal(run.said.length, 1);
  assert.match(run.said[0], /TEST venue not stopped \(test-venue\), so this file meets the last file's venue: test-venue: pid 42/);
});

test('the restore and the venue stop fit inside the time journey.mjs gives a file entry', () => {
  assert.ok(restore.RESTORE_MS + restore.VENUE_STOP_MS <= 150_000);
});

test('a file keeps its venue id when its worker starts again; the next file gets another (the world record)', () => {
  const home = mkdtempSync(join(tmpdir(), 'journey-own-venue-'));
  const index = `own-venue-${process.pid}`;
  const enter = (file) =>
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const w = await import(${JSON.stringify(join(realApp, 'world-restore.mjs'))});
         await w.enterFile(${JSON.stringify(join(realApp, file))});
         console.log('VENUE_ID=' + process.env[w.VENUE_ID_SETTING]);`,
      ],
      { env: { ...process.env, HOME: home, TEST_PARALLEL_INDEX: index, LOCAL_STACK_TEST_VENUE_ID: '' }, encoding: 'utf8' },
    );
  const idOf = (r) => {
    assert.equal(r.status, 0, r.stderr);
    return /VENUE_ID=(\S+)/.exec(r.stdout)?.[1];
  };
  const record = () => JSON.parse(readFileSync(join(home, '.intafaced', 'local-test-stack', 'run', `journey-world-${index}.json`), 'utf8'));
  try {
    const a = idOf(enter('J-academy-02.pw.mjs'));
    assert.equal(testVenueId(a), a);
    assert.equal(record().venueId, a, 'the world record keeps the file its venue id');
    // The same file again, in a new worker process (a retry): the same venue, so the file's own state on it stays.
    assert.equal(idOf(enter('J-academy-02.pw.mjs')), a);
    const b = idOf(enter('J-academy-03.pw.mjs'));
    assert.notEqual(b, a, 'the next file meets a venue of its own');
    assert.equal(record().venueId, b);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
