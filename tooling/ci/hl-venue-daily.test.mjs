import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { optIn, optedInFiles } from './hl-venue-daily.mjs';

test('a venue file opts in by calling hyperliquidForThisFile once with its recording written out', () => {
  assert.equal(
    optIn('J-derivatives-01-venue.pw.mjs', "const hl = hyperliquidForThisFile(test, 'J-derivatives-01-venue');"),
    'J-derivatives-01-venue',
  );
  assert.equal(optIn('J-x.pw.mjs', 'hyperliquidForThisFile( test , "J-x" )'), 'J-x');
  assert.equal(optIn('a', 'venueForThisFile(test);'), null);
});

test("a recording named other than its file is refused, naming the file's own name", () => {
  assert.throws(
    () => optIn('J-x-hl-venue.pw.mjs', "hyperliquidForThisFile(test, 'J-y-hl-venue')"),
    /J-x-hl-venue\.pw\.mjs: name its recording after the file, hyperliquidForThisFile\(test, 'J-x-hl-venue'\), not 'J-y-hl-venue'/,
  );
});

test('a call it cannot read fails by the file name, never leaves the file out', () => {
  for (const text of [
    'hyperliquidForThisFile(test, NAME)',
    "hyperliquidForThisFile(test, 'a'); hyperliquidForThisFile(test, 'b')",
    'hyperliquidForThisFile(test, `x`)',
  ])
    assert.throws(() => optIn('J-x-venue.pw.mjs', text), /J-x-venue\.pw\.mjs: call hyperliquidForThisFile/);
});

test('only *-venue.pw.mjs files that opt in are listed, sorted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-daily-'));
  const files = {
    'J-b-venue.pw.mjs': "hyperliquidForThisFile(test, 'J-b-venue')",
    'J-a-venue.pw.mjs': "hyperliquidForThisFile(test, 'J-a-venue')",
    'J-c-venue.pw.mjs': 'venueForThisFile(test)',
    'J-d.pw.mjs': "hyperliquidForThisFile(test, 'J-d')",
    'venue.mjs': 'export function hyperliquidForThisFile(test, recording) {}',
  };
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), t);
  assert.deepEqual(optedInFiles(dir), ['J-a-venue.pw.mjs', 'J-b-venue.pw.mjs']);
  fs.rmSync(dir, { recursive: true });
});

test('the real folder reads clean', () => {
  assert.ok(Array.isArray(optedInFiles()));
});
