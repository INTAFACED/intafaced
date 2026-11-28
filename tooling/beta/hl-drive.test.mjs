import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ACTIONS,
  DriveRefusal,
  TESTNET_INFO_URL,
  assertTestnetInfoUrl,
  assertTestnetVenue,
  ceilTo,
  floorTo,
  parseArgs,
  shifted,
  venuePrice,
} from './hl-drive.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hl-drive.mjs');
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof DriveRefusal && re.test(e.message));

test('#11060: each action parses with its defaults and the testnet read door', () => {
  assert.deepEqual(parseArgs(['perp']), {
    action: 'perp',
    options: { size: '0.0004', sl: '3', tp: '3' },
    draft: null,
    venueUrl: TESTNET_INFO_URL,
  });
  assert.deepEqual(parseArgs(['spot', '--off', '2.5']).options, { off: '2.5' });
  assert.deepEqual(parseArgs(['move-stop', '--sl', '4']).options, { sl: '4' });
  assert.deepEqual(parseArgs(['close', '--pct', '50']).options, { pct: '50' });
  for (const action of ['setup', 'status', 'cancel', 'flatten']) assert.deepEqual(parseArgs([action]).options, {});
  assert.deepEqual(ACTIONS, ['setup', 'status', 'spot', 'perp', 'move-stop', 'cancel', 'close', 'flatten']);
});

test('#11060: an unknown action, an option the action does not take, or a value that is not a positive decimal is refused', () => {
  refused(() => parseArgs([]), /usage/);
  refused(() => parseArgs(['buy']), /unknown action "buy"/);
  refused(() => parseArgs(['cancel', '--size', '1']), /cancel takes no --size/);
  refused(() => parseArgs(['perp', '--size']), /--size needs a value/);
  refused(() => parseArgs(['perp', '--size', '--sl']), /--size needs a value/);
  refused(() => parseArgs(['perp', 'size']), /unexpected "size"/);
  for (const bad of ['0', '0.0', '-1', '1e3', 'abc', '01', '.5'])
    refused(() => parseArgs(['perp', '--size', bad]), /must be a positive decimal/);
  refused(() => parseArgs(['close', '--pct', '101']), /whole percent from 1 to 100/);
  refused(() => parseArgs(['close', '--pct', '12.5']), /whole percent from 1 to 100/);
  // A lost answer is run again under the same draft, so the same keys: only a plain draft id is taken.
  assert.equal(parseArgs(['perp', '--draft', 'mwysw055']).draft, 'mwysw055');
  for (const bad of ['MWY', 'a:b', 'x'.repeat(17)]) refused(() => parseArgs(['perp', '--draft', bad]), /--draft must be/);
});

test('#11060: any venue URL but the TEST network read door is refused before anything is signed', () => {
  assert.equal(assertTestnetInfoUrl(`${TESTNET_INFO_URL}/`), TESTNET_INFO_URL);
  assert.equal(parseArgs(['status', '--venue-url', TESTNET_INFO_URL]).venueUrl, TESTNET_INFO_URL);
  for (const url of [
    'https://api.hyperliquid.xyz/info',
    'http://api.hyperliquid-testnet.xyz/info',
    'https://api.hyperliquid-testnet.xyz.evil.example/info',
    'https://api.hyperliquid-testnet.xyz/exchange',
    'https://api-ui.hyperliquid-testnet.xyz/info',
    '',
  ])
    refused(() => parseArgs(['perp', '--venue-url', url]), /not Hyperliquid's TEST network/);
});

test('#11060: a door whose venue is not the Hyperliquid TEST network, or not labelled TEST, is refused', () => {
  const ok = { venue: { id: 'hyperliquid-testnet' }, label: 'TEST' };
  assert.equal(assertTestnetVenue(ok), ok);
  refused(() => assertTestnetVenue({ venue: { id: 'hyperliquid' }, label: 'TEST' }), /"hyperliquid", not hyperliquid-testnet/);
  refused(() => assertTestnetVenue({ venue: { id: 'test-venue' }, label: 'TEST' }), /not hyperliquid-testnet/);
  refused(() => assertTestnetVenue({ venue: { id: 'hyperliquid-testnet' }, label: null }), /not labelled TEST/);
  refused(() => assertTestnetVenue({ enabled: false }), /door is off/);
  refused(() => assertTestnetVenue(null), /"none"/);
});

test('#11060: the command itself exits 2 on a mainnet URL, before reading any key or stack', () => {
  const run = spawnSync(process.execPath, [SCRIPT, 'flatten', '--venue-url', 'https://api.hyperliquid.xyz/info'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HL_DRIVE_HOME: '/nonexistent' },
  });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /not Hyperliquid's TEST network/);
  assert.equal(run.stdout, '');
});

test('#11060: prices and sizes are decimal strings on the venue rules, never floats', () => {
  assert.equal(shifted('62700', '-3', '1'), '60819');
  assert.equal(shifted('62700', '3', '1'), '64581');
  assert.equal(shifted('4.5341', '-5', '0.0001'), '4.3073');
  assert.equal(venuePrice('91234.5', true), '91234');
  assert.equal(venuePrice('91234.5', false), '91235');
  assert.equal(venuePrice('4.123456', true), '4.1234');
  assert.equal(venuePrice('0.0123456', false), '0.012346');
  assert.equal(venuePrice('123456', true), '123450');
  assert.equal(floorTo('0.00025', '0.0001'), '0.0002');
  assert.equal(ceilTo('2.55', '1'), '3');
  assert.equal(ceilTo('3', '1'), '3');
});
