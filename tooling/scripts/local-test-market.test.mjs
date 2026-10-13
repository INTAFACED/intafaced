// Proves, without starting or touching anything: the living-market script refuses outside the
// local test stack, and its synthetic price walk and quote ladder are deterministic, bounded and
// integer-only. Run: pnpm local:market:test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GuardError,
  assertLocalTarget,
  buildLadder,
  createPriceWalk,
  crossingSide,
  fromScaled,
  toScaled,
  toScaledFloor,
} from './local-test-market.mjs';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'local-test-market.mjs');
const run = (home, args) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });

const home = mkdtempSync(join(tmpdir(), 'local-test-market-test-'));
const state = join(home, '.intafaced', 'local-test-stack');
const marker = (extra = {}) => JSON.stringify({ kind: 'intafaced-local-test-stack', ports: { edge: 14500, matching: 14505 }, ...extra });
try {
  // 1. No state directory at all.
  let r = run(home, ['start']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing: state directory .* not found/);

  // 2. State directory but no marker.
  mkdirSync(state, { recursive: true });
  r = run(home, ['stop']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing: marker .* not found/);

  // 3. A marker that is not ours.
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), JSON.stringify({ kind: 'something-else', ports: {} }));
  assert.throws(() => assertLocalTarget({ home }), /not a local test stack marker/);

  // 4. Good marker: the default local target passes; every non-local target is refused.
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), marker());
  assert.doesNotThrow(() => assertLocalTarget({ home }));
  for (const url of [
    'https://api.intafaced.com',
    'http://localhost:14500', // name, not the loopback address Edge accepts
    'http://10.0.0.5:14500',
    'http://127.0.0.1:5432', // local, but not a port of this stack
    'http://127.0.0.1', // default port 80
    'not a url',
    'https://127.0.0.1:14500', // wrong scheme
  ]) {
    assert.throws(() => assertLocalTarget({ home, urls: [url] }), GuardError, url);
  }
  // 5. Through the command line as well: a real-looking target never gets past the guard.
  r = run(home, ['start', '--edge-url', 'https://api.intafaced.com']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /is not http:\/\/127\.0\.0\.1/);
} finally {
  rmSync(home, { recursive: true, force: true });
}

// 6. Decimal helpers round-trip and refuse non-decimal text.
assert.equal(fromScaled(toScaled('0.00001')), '0.00001');
assert.equal(fromScaled(toScaled('65000')), '65000');
assert.equal(fromScaled(toScaledFloor('1069912.42670961408')), '1069912.42670961'); // balances can carry more than 8 places
for (const bad of ['1e3', '-1', '0x10', '1.123456789', '']) assert.throws(() => toScaled(bad), bad);

// 7. The walk is deterministic for a seed, differs across seeds and symbols, and stays in its band on its tick grid.
const cfg = { symbol: 'BTC/USDT', startScaled: toScaled('65000'), tickScaled: toScaled('0.01') };
const series = (seed, symbol = cfg.symbol) => {
  const w = createPriceWalk({ ...cfg, seed, symbol });
  return Array.from({ length: 500 }, () => w.next());
};
assert.deepEqual(series('1013'), series('1013'));
assert.notDeepEqual(series('1013'), series('1014'));
assert.notDeepEqual(series('1013'), series('1013', 'ETH/USDT'));
const lo = (cfg.startScaled * 8000n) / 10000n;
const hi = (cfg.startScaled * 12000n) / 10000n;
let moved = false;
let prev = cfg.startScaled;
for (const price of series('1013')) {
  assert.equal(price % cfg.tickScaled, 0n);
  assert.ok(price >= lo && price <= hi, `outside band: ${fromScaled(price)}`);
  assert.equal(typeof price, 'bigint');
  if (price !== prev) moved = true;
  prev = price;
}
assert.ok(moved, 'the walk never moved');
// Resuming from a saved step count reproduces the same series.
const a = createPriceWalk({ ...cfg, seed: '7' });
const b = createPriceWalk({ ...cfg, seed: '7' });
a.advance(40);
assert.equal(b.advance(40), a.current());
assert.equal(b.next(), a.next());

// 8. The ladder: bids below mid and asks above, on the tick grid, strictly ordered, sized above the market minimums.
const ladder = buildLadder({
  mid: toScaled('65000'),
  tick: toScaled('0.01'),
  lot: toScaled('0.00001'),
  minAmount: toScaled('0.00001'),
  minCost: toScaled('5'),
  levels: 3,
  halfSpreadBps: 6n,
  stepBps: 9n,
  levelNotional: toScaled('3000'),
});
assert.equal(ladder.length, 6);
const bids = ladder.filter((q) => q.side === 'buy').map((q) => toScaled(q.price));
const asks = ladder.filter((q) => q.side === 'sell').map((q) => toScaled(q.price));
assert.ok(
  bids.every((x, i) => x < toScaled('65000') && (i === 0 || x < bids[i - 1])),
  'bids must step down below mid',
);
assert.ok(
  asks.every((x, i) => x > toScaled('65000') && (i === 0 || x > asks[i - 1])),
  'asks must step up above mid',
);
for (const q of ladder) {
  assert.equal(toScaled(q.price) % toScaled('0.01'), 0n);
  assert.equal(toScaled(q.amount) % toScaled('0.00001'), 0n);
  assert.ok((toScaled(q.price) * toScaled(q.amount)) / toScaled('1') >= toScaled('5'), 'below minimum cost');
}

// The taker must alternate sides so it cannot drain one asset (it once bought forever and every order got 400).
assert.deepEqual([1, 2, 3, 4].map(crossingSide), ['buy', 'sell', 'buy', 'sell']);

console.log('local-test-market: guard and price-walk checks passed');
