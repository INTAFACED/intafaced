// Proves, without starting or touching anything: the living-market script refuses outside the
// local test stack, and its synthetic price walk and quote ladder are deterministic, bounded and
// integer-only. Run: pnpm local:market:test
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Governor,
  GuardError,
  RequestBudget,
  TEST_PRICES,
  assertLocalTarget,
  createPriceWalk,
  describePlan,
  fromScaled,
  fundTargets,
  gridStepFor,
  ledgerPosting,
  levelSize,
  marketStatus,
  pairConfig,
  pickSide,
  planCross,
  planRefresh,
  targetBook,
  toScaled,
  toScaledFloor,
} from './local-test-market.mjs';
import { assetsSql, describePairs, marketsSql } from './local-test-listing.mjs';
import { MAX_LOG_BYTES, rotateAll, rotateLog } from './local-test-logs.mjs';
import { LOCAL_PAIRS, localOnlyAssets, localOnlyPairs } from './local-test-pairs.mjs';

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

// 7b. Volatility clusters: calm and busy stretches both occur, and a big move makes the next one more likely to be big.
{
  const w = createPriceWalk({ ...cfg, seed: '99', maxStepBps: 12n });
  let minVol = 1;
  let maxVol = 0;
  for (let i = 0; i < 3000; i += 1) {
    w.next();
    minVol = Math.min(minVol, w.vol);
    maxVol = Math.max(maxVol, w.vol);
  }
  assert.ok(minVol < 0.45 && maxVol > 0.75, `volatility never changed regime: ${minVol}..${maxVol}`);
}

// 8. The book: bids below mid and asks above on a fixed grid, strictly ordered, sizes varied and above the market minimums.
const bookCfg = {
  start: toScaled('65000'),
  tick: toScaled('0.01'),
  lot: toScaled('0.00001'),
  minAmount: toScaled('0.00001'),
  minCost: toScaled('5'),
};
const step = gridStepFor({ start: bookCfg.start, tick: bookCfg.tick, gridCbps: 80n });
assert.equal(step % bookCfg.tick, 0n);
assert.ok(step >= bookCfg.tick);
assert.equal(gridStepFor({ start: toScaled('1'), tick: toScaled('0.0001'), gridCbps: 1n }), toScaled('0.0001'), 'never finer than a tick');
const tb = targetBook({ mid: toScaled('65000.37'), step, halfSpreadCbps: 40n, levels: 20 });
assert.equal(tb.bids.length, 20);
assert.equal(tb.asks.length, 20);
assert.ok(tb.bestBid < toScaled('65000.37') && tb.bestAsk > toScaled('65000.37') && tb.bestBid < tb.bestAsk);
assert.ok(
  tb.bids.every((x, i) => x % step === 0n && (i === 0 || x === tb.bids[i - 1] - step)),
  'bids step down one grid step at a time',
);
assert.ok(
  tb.asks.every((x, i) => x % step === 0n && (i === 0 || x === tb.asks[i - 1] + step)),
  'asks step up one grid step at a time',
);
const sizeAt = (side, price, rank) =>
  levelSize({
    seed: '1013',
    symbol: 'BTC/USDT',
    side,
    price,
    rank,
    notional: toScaled('20000'),
    lot: bookCfg.lot,
    minAmount: bookCfg.minAmount,
    minCost: bookCfg.minCost,
  });
const sizes = tb.bids.map((p, rank) => sizeAt('buy', p, rank));
assert.deepEqual(
  sizes,
  tb.bids.map((p, rank) => sizeAt('buy', p, rank)),
  'the same grid point always gets the same size',
);
assert.ok(new Set(sizes.map(String)).size >= 12, 'sizes must vary from level to level');
for (const [i, amount] of sizes.entries()) {
  assert.equal(amount % bookCfg.lot, 0n);
  assert.ok((tb.bids[i] * amount) / toScaled('1') >= bookCfg.minCost, 'below minimum cost');
}
assert.ok(Math.max(...sizes.map(Number)) / Math.min(...sizes.map(Number)) > 3, 'a real book has thin and thick levels');

// 8b. Re-quoting changes only what the price move made stale.
const rest = (side, prices, from = 0) => prices.map((price, i) => ({ id: `${side}${from + i}`, side, price }));
const ideal = [...rest('buy', tb.bids), ...rest('sell', tb.asks)];
let plan = planRefresh({ target: tb, resting: ideal, step, levels: 20 });
assert.deepEqual([plan.cancels.length, plan.places.length, plan.massCancel], [0, 0, false], 'an unchanged book costs nothing');
// The price rises two grid steps: the two lowest asks are now inside the spread and must go, two new inner bids and two outer asks come in.
const up = targetBook({ mid: toScaled('65000.37') + 2n * step, step, halfSpreadCbps: 40n, levels: 20 });
plan = planRefresh({ target: up, resting: ideal, step, levels: 20 });
assert.ok(plan.cancels.length >= 2 && plan.cancels.length <= 4, `cancels ${plan.cancels.length}`);
assert.ok(
  plan.cancels.every((c) => c.side === 'sell' && c.price < up.bestAsk) ||
    plan.cancels.every((c) => c.price < up.bestAsk || c.price > up.bestBid),
);
assert.ok(plan.places.length >= 2 && plan.places.length <= 6, `places ${plan.places.length}`);
assert.ok(
  plan.places.every((q) => (q.side === 'buy' ? q.price <= up.bestBid : q.price >= up.bestAsk)),
  'a new quote never lands on the wrong side of the new touch',
);
assert.ok(plan.places.length + plan.cancels.length < 12, 'a small move touches few orders, not the whole book');
// Applying the plan leaves a book that is not crossed and holds every target price.
{
  const gone = new Set(plan.cancels.map((c) => c.id));
  const after = [...ideal.filter((r) => !gone.has(r.id)), ...plan.places.map((q, i) => ({ id: `n${i}`, side: q.side, price: q.price }))];
  const bidsAfter = after.filter((r) => r.side === 'buy').map((r) => r.price);
  const asksAfter = after.filter((r) => r.side === 'sell').map((r) => r.price);
  const bmax = (xs) => xs.reduce((a, b) => (b > a ? b : a));
  const bmin = (xs) => xs.reduce((a, b) => (b < a ? b : a));
  assert.ok(bmax(bidsAfter) < bmin(asksAfter), 'the book must not be crossed');
  for (const price of [...up.bids, ...up.asks])
    assert.ok(
      after.some((r) => r.price === price),
      `missing ${fromScaled(price)}`,
    );
}
// A cap defers work: cancels go first, and no quote is placed while a wrong-side order is still standing.
plan = planRefresh({ target: up, resting: ideal, step, levels: 20, capCancels: 1, capPlaces: 5 });
assert.equal(plan.cancels.length, 1);
assert.equal(plan.places.length, 0);
assert.equal(plan.deferred, true);
// Depth beyond levels + 8 is trimmed from the far end; a duplicate price and an off-grid price are cancelled.
const deep = targetBook({ mid: toScaled('65000.37'), step, halfSpreadCbps: 40n, levels: 32 });
plan = planRefresh({
  target: tb,
  resting: [
    ...ideal,
    ...rest('buy', deep.bids.slice(20, 32), 20),
    { id: 'dup', side: 'buy', price: tb.bids[0] },
    { id: 'off', side: 'sell', price: tb.asks[0] + 1n },
  ],
  step,
  levels: 20,
});
assert.ok(plan.cancels.some((c) => c.id === 'dup') && plan.cancels.some((c) => c.id === 'off'));
assert.ok(plan.cancels.length >= 4 && plan.cancels.length <= 6, `trim cancels ${plan.cancels.length}`);
// A book far from the price is cancelled in one call and rebuilt.
plan = planRefresh({
  target: targetBook({ mid: toScaled('70000'), step, halfSpreadCbps: 40n, levels: 20 }),
  resting: ideal,
  step,
  levels: 20,
  capPlaces: 8,
});
assert.equal(plan.massCancel, true);
assert.equal(plan.places.length, 8);
assert.equal(plan.places[0].rank, 0, 'inner levels first');
// An empty book is seeded inner-first and alternating sides.
plan = planRefresh({ target: tb, resting: [], step, levels: 20, capPlaces: 6 });
assert.deepEqual(
  plan.places.map((q) => q.side),
  ['buy', 'sell', 'buy', 'sell', 'buy', 'sell'],
);
assert.deepEqual(
  plan.places.map((q) => q.rank),
  [0, 0, 1, 1, 2, 2],
);

// 8c. The taker: varied sizes, both sides, bounded inventory, never past the book or the notional cap.
{
  const asks = Array.from({ length: 8 }, (_, i) => ({ price: toScaled('65000') + BigInt(i) * step, amount: toScaled('0.3') }));
  const bids = Array.from({ length: 8 }, (_, i) => ({ price: toScaled('64990') - BigInt(i) * step, amount: toScaled('0.3') }));
  let seq = 1;
  const rand = () => (seq = (seq * 48271) % 2147483647) / 2147483647;
  const seen = new Set();
  let sweeps = 0;
  for (let i = 0; i < 400; i += 1) {
    const side = i % 2 ? 'buy' : 'sell';
    const c = planCross({
      side,
      book: { asks, bids },
      rand,
      lot: bookCfg.lot,
      minAmount: bookCfg.minAmount,
      minCost: bookCfg.minCost,
      maxNotional: toScaled('50000'),
    });
    assert.ok(c, 'a deep book can always be traded against');
    const amount = toScaled(c.amount);
    assert.equal(amount % bookCfg.lot, 0n);
    assert.ok(amount >= bookCfg.minAmount && (toScaled(c.price) * amount) / toScaled('1') >= bookCfg.minCost);
    assert.ok((toScaled(c.price) * amount) / toScaled('1') <= toScaled('50000') + toScaled('70000'), 'notional cap');
    assert.ok(amount <= toScaled('0.3') * 5n, 'never more than the first levels hold');
    if (c.touched > 1) sweeps += 1;
    seen.add(c.amount);
  }
  assert.ok(seen.size > 40, `trade sizes must vary (${seen.size} distinct)`);
  assert.ok(sweeps > 20 && sweeps < 200, `some orders sweep several levels, most do not (${sweeps} of 400)`);
  assert.equal(
    planCross({
      side: 'buy',
      book: { asks: asks.slice(0, 1), bids },
      rand,
      lot: bookCfg.lot,
      minAmount: bookCfg.minAmount,
      minCost: 0n,
      maxNotional: toScaled('1000'),
    }),
    null,
    'a one-level book is too thin',
  );
  // Both sides occur, and inventory stays bounded: it once only bought, drained its quote asset, and every order got 400.
  let net = 0n;
  let hi = 0n;
  let buys = 0;
  const cap = toScaled('1.8');
  for (let i = 0; i < 6000; i += 1) {
    const side = pickSide(net, cap, rand);
    net += side === 'buy' ? toScaled('0.1') : -toScaled('0.1');
    if (side === 'buy') buys += 1;
    hi = net > hi ? net : hi;
    assert.ok(net < cap * 3n && net > -cap * 3n, `inventory ran away: ${fromScaled(net < 0n ? -net : net)}`);
  }
  assert.ok(buys > 2400 && buys < 3600, `sides must be roughly balanced (${buys} buys of 6000)`);
}

console.log('local-test-market: guard and price-walk checks passed');

// 9. Supervision: status, restart ("ensure"), no accidental or second start, and exit logging.
// Everything runs under a throwaway HOME. The "market" here is a harmless node process whose command line looks like
// the real one (the script finds the market by its command line), and the one real child that ensure starts fails
// on its own because its Edge port is closed. Nothing touches ~/.intafaced or the running stack.
const freePort = () =>
  new Promise((ok) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
const waitFor = async (check, what, ms = 15000) => {
  for (let t = 0; t < ms; t += 100) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const fakeMarket = () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1e3)', 'local-test-market.mjs', '__run'], { stdio: 'ignore' });
const deadPid = async () => {
  const c = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((r) => c.on('exit', r));
  return c.pid;
};

const sup = mkdtempSync(join(tmpdir(), 'local-test-market-supervise-'));
const supState = join(sup, '.intafaced', 'local-test-stack');
const supRun = join(supState, 'run');
const pidFile = join(supRun, 'market.json');
const logFile = join(supState, 'logs', 'market.log');
const deadEdge = await freePort();
const fakes = [];
try {
  mkdirSync(supRun, { recursive: true });
  mkdirSync(join(supState, 'logs'), { recursive: true });
  writeFileSync(join(supState, 'LOCAL-TEST-STACK.json'), marker({ ports: { edge: 14500, closed: deadEdge } }));
  const setPid = (pid, extra = {}) => writeFileSync(pidFile, JSON.stringify({ pid, startedAt: '2026-10-14T00:00:00.000Z', ...extra }));

  // 9a. A stray word never starts a copy (`pnpm local:market status` once meant `start status`).
  let r = run(sup, ['start', 'status']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /unexpected argument "status"/);
  assert.equal(existsSync(pidFile), false, 'a stray argument must not start the market');

  // 9b. status: never started -> off; died on its own -> DOWN (exit 1); alive and writing -> ok; alive but silent -> STALE (exit 1).
  r = run(sup, ['status']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not started/);
  setPid(await deadPid());
  r = run(sup, ['status']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /DOWN \(was running/);
  const fake = fakeMarket();
  fakes.push(fake);
  setPid(fake.pid);
  writeFileSync(logFile, '2026-10-14T00:00:00.000Z [TEST MARKET] BTC/USDT TEST PRICE mid 64000 USDT: 6/6 quotes resting\n');
  r = run(sup, ['status']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`ok \\(last log \\d+s ago\\).*pid ${fake.pid}`));
  const old = new Date(Date.now() - 3 * 60 * 1000);
  utimesSync(logFile, old, old);
  r = run(sup, ['status']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /STALE \(last log 3m ago/);
  // The same answer, as the stack's own status table asks for it.
  const st = marketStatus({ home: sup, now: Date.now() });
  assert.equal(st.state, 'stale');
  assert.equal(st.pid, fake.pid);
  assert.equal(marketStatus({ home: sup, now: old.getTime() + 119_000 }).state, 'ok');
  assert.equal(marketStatus({ home: sup, now: old.getTime() + 121_000 }).state, 'stale');

  // 9c. Never twice: start and ensure see the running copy and leave its pid alone; a start already in progress also blocks.
  for (const cmd of ['start', 'ensure']) {
    r = run(sup, [cmd]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /already running/, cmd);
    assert.equal(JSON.parse(readFileSync(pidFile, 'utf8')).pid, fake.pid, `${cmd} must not replace the running copy`);
  }
  writeFileSync(join(supRun, 'market.lock'), String(process.pid)); // held by a live process that is not the script
  setPid(await deadPid());
  r = run(sup, ['start']);
  assert.match(r.stdout, /another start is in progress/);
  r = run(sup, ['ensure']);
  assert.match(r.stdout, /another start is in progress/);
  rmSync(join(supRun, 'market.lock'));
  // A foreground run would fight the background copy for the same account's orders.
  setPid(fake.pid);
  r = run(sup, ['check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /background test market is running/);

  // 9d. stop: ends the process and forgets it, so ensure then leaves it off.
  r = run(sup, ['stop']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /test market stopped/);
  await waitFor(() => fake.exitCode !== null || fake.signalCode !== null, 'the stopped market to exit');
  assert.equal(existsSync(pidFile), false);
  r = run(sup, ['ensure']);
  assert.match(r.stdout, /not started; leaving it off/);
  assert.equal(existsSync(pidFile), false, 'ensure must not start a market that was never started or was stopped');
  // stop after it died on its own also forgets it.
  setPid(await deadPid());
  r = run(sup, ['stop']);
  assert.match(r.stdout, /already down; forgot it/);
  assert.equal(existsSync(pidFile), false);

  // 9e. ensure restarts a market that was running and died, with the same options, and the new copy names why it ended.
  const dead = await deadPid();
  const args = ['--seed', '77', '--edge-url', `http://127.0.0.1:${deadEdge}`];
  setPid(dead, { args });
  r = run(sup, ['ensure']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /was running \(pid \d+\) and is not now; starting it again/);
  const rec = JSON.parse(readFileSync(pidFile, 'utf8'));
  assert.notEqual(rec.pid, dead);
  assert.deepEqual(rec.args, args);
  await waitFor(
    () => existsSync(logFile) && /EXIT pid \d+ code/.test(readFileSync(logFile, 'utf8')),
    'the restarted market to log its exit',
  );
  const text = readFileSync(logFile, 'utf8');
  assert.match(text, /FATAL crashed:/, 'the cause is in the log, not lost');
  assert.match(text, new RegExp(`EXIT pid ${rec.pid} code 1: crashed`));
} finally {
  for (const f of fakes) if (alive(f.pid)) process.kill(f.pid, 'SIGKILL');
  rmSync(sup, { recursive: true, force: true });
}

// 9f. Exit logging: a signal, an uncaught exception and an unhandled rejection each leave an EXIT line with the cause.
const exitHome = mkdtempSync(join(tmpdir(), 'local-test-market-exit-'));
try {
  const exitLog = join(exitHome, 'logs', 'market.log');
  const child = (body) =>
    new Promise((done) => {
      const c = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import * as m from ${JSON.stringify(script)}; m.installExitLogging(${JSON.stringify(exitLog)}); ` +
            `console.log('ready'); setInterval(() => { if (m.STOP.requested) process.exit(0); }, 50); ${body}`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      c.stdout.on('data', (d) => {
        out += d;
        if (out.includes('ready') && body === '') c.kill('SIGTERM');
      });
      c.on('exit', (code) => done(code));
    });
  assert.equal(await child(''), 0);
  let log = readFileSync(exitLog, 'utf8');
  assert.match(log, /received SIGTERM; stopping/);
  assert.match(log, /EXIT pid \d+ code 0: received SIGTERM/);
  rmSync(exitLog);
  assert.equal(await child('setTimeout(() => { throw new Error("boom-sync"); }, 100)'), 70);
  log = readFileSync(exitLog, 'utf8');
  assert.match(log, /uncaught exception: Error: boom-sync/);
  assert.match(log, /EXIT pid \d+ code 70: uncaught exception/);
  rmSync(exitLog);
  assert.equal(await child('setTimeout(() => { Promise.reject(new Error("boom-async")); }, 100)'), 71);
  log = readFileSync(exitLog, 'utf8');
  assert.match(log, /unhandled rejection: Error: boom-async/);
  assert.match(log, /EXIT pid \d+ code 71: unhandled rejection/);
} finally {
  rmSync(exitHome, { recursive: true, force: true });
}

console.log('local-test-market: supervision and exit-logging checks passed');

// 10. The pairs table: about twenty USDT pairs and a few USDC, real tick and lot grids, sizes that clear the minimums.
{
  const usdt = LOCAL_PAIRS.filter((p) => p.quote === 'USDT');
  const usdc = LOCAL_PAIRS.filter((p) => p.quote === 'USDC');
  assert.ok(usdt.length >= 20 && usdc.length >= 4, `${usdt.length} USDT, ${usdc.length} USDC`);
  for (const base of [
    'SOL',
    'BNB',
    'XRP',
    'DOGE',
    'ADA',
    'AVAX',
    'LINK',
    'DOT',
    'POL',
    'LTC',
    'TRX',
    'TON',
    'ARB',
    'OP',
    'SUI',
    'APT',
    'NEAR',
  ])
    assert.ok(
      usdt.some((p) => p.base === base),
      `${base}/USDT missing`,
    );
  assert.equal(new Set(LOCAL_PAIRS.map((p) => p.symbol)).size, LOCAL_PAIRS.length, 'one row per symbol');
  for (const p of LOCAL_PAIRS) {
    const tick = toScaled(p.tick);
    const lot = toScaled(p.lot);
    const price = toScaled(p.start);
    assert.equal(price % tick, 0n, `${p.symbol}: start is off the tick grid`);
    assert.ok(TEST_PRICES[p.symbol], `${p.symbol} has no TEST PRICE`);
    const cfg = pairConfig(p.symbol);
    const gridStep = gridStepFor({ start: price, tick, gridCbps: cfg.gridCbps });
    // Twenty levels each side must stay well inside the walk's 20% band, or the book would reach into prices it never trades at.
    assert.ok(gridStep * 40n < price / 5n, `${p.symbol}: grid too coarse for its price`);
    const t = targetBook({ mid: price, step: gridStep, halfSpreadCbps: cfg.halfSpreadCbps, levels: 25 });
    for (const [rank, px] of t.bids.entries()) {
      const amount = levelSize({
        seed: 's',
        symbol: p.symbol,
        side: 'buy',
        price: px,
        rank,
        notional: toScaled(cfg.notional),
        lot,
        minAmount: lot,
        minCost: toScaled(p.minNotional),
      });
      assert.ok(
        amount > 0n && amount % lot === 0n && (px * amount) / toScaled('1') >= toScaled(p.minNotional),
        `${p.symbol}: level ${rank} breaks a market minimum`,
      );
    }
  }
  // The pairs production already lists keep its catalogue's tick and lot, so the local book is believable there too.
  assert.deepEqual(
    ['BTC/USDT', 'ETH/USDT', 'IFC/USDT'].map((s) => LOCAL_PAIRS.find((p) => p.symbol === s)).map((p) => [p.tick, p.lot]),
    [
      ['0.01', '0.00001'],
      ['0.01', '0.0001'],
      ['0.0001', '0.01'],
    ],
  );
  assert.equal(localOnlyPairs().length, LOCAL_PAIRS.length - 5);
  assert.ok(!localOnlyAssets().some((a) => ['BTC', 'ETH', 'IFC', 'USDT', 'USDC'].includes(a.id)));
  assert.match(
    describePlan({ levels: 20, seconds: 30, ops: 3, trades: 2, maxRpm: 360, symbols: null }),
    /26 pairs, 20 levels a side \(1040 resting orders/,
  );
}

// 11. Load control: the request cap holds, a struggling stack slows the market, a 429 pauses it, quiet time wins the pace back.
{
  let t = 1_000_000;
  const budget = new RequestBudget(5, () => t);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(budget.waitMs(), 0);
    budget.record();
    t += 100;
  }
  assert.ok(budget.waitMs() > 59_000 - 500, 'the sixth request in a minute must wait for the first to age out');
  t += 60_000;
  assert.equal(budget.waitMs(), 0);

  const gov = new Governor({ makerPerSec: 4, takerPerSec: 2, now: () => t });
  t += 10_000;
  assert.equal(gov.available('maker'), 16, 'the burst is four seconds of budget');
  gov.take('maker', 20);
  assert.equal(gov.available('maker'), 0);
  t += 1000;
  assert.equal(gov.available('maker'), 0, 'a big cancel is paid back by waiting (tokens can go negative)');
  t += 2000;
  assert.ok(gov.available('maker') >= 4);
  // Slow answers (over 3 s per order), 5xx and 429 each cut the pace to 60%; it never drops under 15%.
  assert.equal(gov.observe({ ms: 200, status: 200 }), false);
  assert.equal(gov.observe({ ms: 31_000, status: 201, items: 10 }), true);
  assert.equal(gov.scale, 0.6);
  assert.equal(gov.observe({ ms: 20, status: 500 }), true);
  assert.equal(gov.observe({ ms: 20, status: 429, retryAfterS: 7 }), true);
  assert.equal(gov.pausedUntil, t + 7000);
  for (let i = 0; i < 10; i += 1) gov.observe({ ms: 20, status: 503 });
  assert.equal(gov.scale, 0.15);
  gov.take('maker', gov.available('maker'));
  t += 1000;
  assert.ok(gov.available('maker') <= 1, 'at 15% a 4/s budget yields well under one order a second');
  t += 25_000;
  gov.observe({ ms: 20, status: 200 });
  assert.ok(gov.scale > 0.15 && gov.scale <= 0.2, 'quiet time wins the pace back a step at a time');
}

// 12. Funding stays ahead of the book: targets grow with depth and cover both sides of every market.
{
  const m = (base, quote, notional, start, levels) => ({
    base,
    quote,
    notional: toScaled(String(notional)),
    start: toScaled(start),
    levels,
  });
  const t = fundTargets([m('BTC', 'USDT', 20000, '65000', 20), m('SOL', 'USDT', 6000, '150', 20), m('BTC', 'USDC', 8000, '65000', 20)]);
  assert.equal(fromScaled(t.get('USDT')), '4400000'); // (20000 + 6000) x (20 + 8 levels) x 2 x 3 = 4,368,000, rounded up to two significant digits
  assert.ok(t.get('BTC') > toScaled('50') && t.get('BTC') < toScaled('100'), fromScaled(t.get('BTC')));
  assert.ok(t.has('SOL') && t.has('USDC'));
  assert.ok(
    fundTargets([m('BTC', 'USDT', 20000, '65000', 40)]).get('USDT') > fundTargets([m('BTC', 'USDT', 20000, '65000', 20)]).get('USDT'),
  );
}

// 13. The ledger gate: a frozen ledger is named, never mistaken for an ordinary refusal (the 14 Oct outage).
{
  assert.equal(ledgerPosting('{"ok":true,"service":"svc-ledger","postingEnabled":true}').frozen, false);
  assert.equal(ledgerPosting('not json').frozen, false);
  const f = ledgerPosting(
    '{"ok":true,"service":"svc-ledger","postingEnabled":false,"frozenReason":"reconciliation mismatch","frozenBy":"reconciliation"}',
  );
  assert.equal(f.frozen, true);
  assert.match(f.text, /FROZEN \(reconciliation mismatch, by reconciliation\)/);
  const stackSource = readFileSync(join(dirname(script), 'local-test-stack.mjs'), 'utf8');
  // Root cause of the 14 Oct outage: the hourly reconcile outgrew the ledger's fixed 15 s statement timeout, threw, and a throw freezes posting.
  const cadence = Number(/RECONCILE_CRON_MINUTES: '(\d+)'/.exec(stackSource)?.[1]);
  assert.ok(cadence >= 1440, `RECONCILE_CRON_MINUTES is ${cadence}: an hourly reconcile on a busy local ledger freezes posting`);
  assert.match(stackSource, /posting\?\.frozen \? `FROZEN/, 'stack status must show a frozen ledger as not ok');
  assert.match(
    stackSource,
    /MATCHING_OPERATOR_IDS: localOperatorIds\(\)/,
    'matching must be told which operators may open a market (#4742)',
  );
  assert.match(stackSource, /rotateLog\(logPath\)/, 'service logs are capped when a service starts');
  assert.match(stackSource, /rotateAll\(P\.logs\)/, 'every log is capped when the stack starts');
}

// 14. Log rotation: at most 3 files per log, each at most the cap; a huge log keeps only its newest tail.
{
  const dir = mkdtempSync(join(tmpdir(), 'local-test-logs-'));
  try {
    assert.equal(MAX_LOG_BYTES, 50 * 1024 * 1024);
    const line = (n) => `line ${String(n).padStart(6, '0')}\n`; // 12 bytes
    const live = join(dir, 'matching.log');
    writeFileSync(live, Array.from({ length: 1000 }, (_, n) => line(n)).join(''));
    assert.equal(rotateLog(live, { maxBytes: 12_000 }), 0, 'under the cap is left alone');
    writeFileSync(live, Array.from({ length: 5000 }, (_, n) => line(n)).join('')); // 60,000 bytes
    assert.equal(rotateLog(live, { maxBytes: 12_000 }), 60_000);
    assert.equal(readFileSync(live, 'utf8'), '');
    assert.equal(readFileSync(`${live}.1`, 'utf8').length, 12_000, 'the newest cap-worth is kept');
    assert.ok(readFileSync(`${live}.1`, 'utf8').endsWith(line(4999)));
    for (let round = 0; round < 4; round += 1) {
      writeFileSync(live, Array.from({ length: 1500 }, (_, n) => line(round * 10_000 + n)).join(''));
      rotateLog(live, { maxBytes: 12_000, files: 3 });
    }
    assert.deepEqual(readdirSync(dir).sort(), ['matching.log', 'matching.log.1', 'matching.log.2'], 'three files at most');
    assert.ok(readFileSync(`${live}.1`, 'utf8').endsWith(line(30_000 + 1499)));
    assert.ok(readFileSync(`${live}.2`, 'utf8').endsWith(line(20_000 + 1499)));
    // rotateAll takes only *.log files, and a writer that appends keeps working after the truncate.
    writeFileSync(join(dir, 'notes.txt'), 'x'.repeat(30_000));
    writeFileSync(join(dir, 'edge.log'), 'y'.repeat(30_000));
    const done = rotateAll(dir, { maxBytes: 12_000 });
    assert.deepEqual(done.map((d) => d.file.split('/').pop()).sort(), ['edge.log']);
    assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8').length, 30_000);
    appendFileSync(join(dir, 'edge.log'), 'after\n');
    assert.equal(readFileSync(join(dir, 'edge.log'), 'utf8'), 'after\n');
    assert.deepEqual(rotateAll(join(dir, 'nowhere')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 15. Listing: SQL for the local database only, idempotent, same columns as the seed, injection-proof.
{
  const m = marketsSql();
  const a = assetsSql();
  assert.match(m, /INSERT INTO "trade"\."markets"/);
  assert.match(m, /ON CONFLICT \("symbol"\) DO NOTHING/);
  assert.match(m, /ARRAY\['fiat'\]::text\[\]/, 'no protocol-plane book exists for these');
  assert.equal((m.match(/crypto-24x7/g) ?? []).length, localOnlyPairs().length);
  assert.match(m, /\('SOL\/USDT', 'SOL', 'USDT', 'Solana', 'crypto', 'spot', 'unit', 1, NULL, 0\.01, 0\.001, 0\.001, 5,/);
  assert.match(a, /INSERT INTO "ledger"\."assets"/);
  assert.match(a, /ON CONFLICT \("id"\) DO NOTHING/);
  assert.ok(!/'(BTC|ETH|IFC|USDT|USDC)'/.test(a), 'production assets are never re-inserted');
  assert.doesNotMatch(m + a, /DELETE|UPDATE|DROP|TRUNCATE/);
  assert.equal(assetsSql([]), null);
  for (const bad of [{ symbol: "X/USDT'; DROP TABLE trade.markets;--" }, { symbol: 'BTC-USDT' }])
    assert.throws(() => marketsSql([{ ...LOCAL_PAIRS[3], ...bad }]), /unexpected shape/);
  assert.throws(() => marketsSql([{ ...LOCAL_PAIRS[3], lot: '1; select 1' }]), /unexpected shape/);
  assert.throws(() => assetsSql([{ id: "SOL'--", decimals: 8 }]), /unexpected shape/);
  assert.match(describePairs(), /LOCAL TEST/);
  const listing = join(dirname(script), 'local-test-listing.mjs');
  // plan needs no stack; status and apply refuse outside one.
  let r = spawnSync(process.execPath, [listing, 'plan'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`would list ${localOnlyPairs().length} pairs`));
  const empty = mkdtempSync(join(tmpdir(), 'local-test-listing-'));
  try {
    for (const cmd of ['apply', 'status']) {
      r = spawnSync(process.execPath, [listing, cmd], { env: { ...process.env, HOME: empty }, encoding: 'utf8' });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /refusing: state directory .* not found/);
    }
    mkdirSync(join(empty, '.intafaced', 'local-test-stack'), { recursive: true });
    writeFileSync(
      join(empty, '.intafaced', 'local-test-stack', 'LOCAL-TEST-STACK.json'),
      JSON.stringify({
        kind: 'intafaced-local-test-stack',
        ports: { postgres: 5432 },
        database: { host: '127.0.0.1', port: 5432, name: 'prod' },
      }),
    );
    r = spawnSync(process.execPath, [listing, 'apply'], { env: { ...process.env, HOME: empty }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /marker does not name database intafaced_local_test/);
    r = spawnSync(process.execPath, [listing, 'nonsense'], { env: { ...process.env, HOME: empty }, encoding: 'utf8' });
    assert.equal(r.status, 2);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

console.log('local-test-market: pairs, load-control, funding, ledger-gate, log-rotation and listing checks passed');

// 16. The whole loop against a stand-in Edge (a local HTTP server in this test, no stack, no database): it builds the
// book to depth with varied sizes and never crosses it, trades both ways, tops up an empty taker through the ledger, stays
// inside its request cap, and sends nothing at all while the ledger reports posting frozen (the 14 Oct outage).
{
  const { createServer: httpServer } = await import('node:http');
  const symbols = ['BTC/USDT', 'SOL/USDT', 'DOGE/USDT'];
  const books = new Map(); // id -> order
  const state = { frozen: true, requests: [], orderRequests: 0, crossed: false, trades: [], funds: [], seq: 0, refused: 0 };
  const markets = symbols.map((symbol) => {
    const p = LOCAL_PAIRS.find((x) => x.symbol === symbol);
    return {
      id: symbol,
      symbol,
      base: p.base,
      quote: p.quote,
      active: true,
      orderable: true,
      spot: true,
      paper: false,
      precision: { price: p.tick, amount: p.lot },
      limits: { amount: { min: p.lot }, cost: { min: p.minNotional } },
    };
  });
  const sideOrders = (symbol, side) => [...books.values()].filter((o) => o.symbol === symbol && o.side === side && o.remaining > 0n);
  const wire = (o) => ({
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    type: 'limit',
    status: o.remaining > 0n ? 'open' : 'closed',
    price: fromScaled(o.price),
    amount: fromScaled(o.amount),
    remaining: fromScaled(o.remaining),
    filled: fromScaled(o.amount - o.remaining),
  });
  const checkCrossed = (symbol) => {
    const b = sideOrders(symbol, 'buy').map((o) => o.price);
    const a = sideOrders(symbol, 'sell').map((o) => o.price);
    if (b.length && a.length && b.reduce((x, y) => (y > x ? y : x)) >= a.reduce((x, y) => (y < x ? y : x))) state.crossed = true;
  };
  const handler = (kind) => async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    const send = (code, obj, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    if (kind === 'matching') return send(200, { ok: true, venueHalted: false });
    if (kind === 'ledger')
      return send(200, {
        ok: true,
        service: 'svc-ledger',
        postingEnabled: !state.frozen,
        ...(state.frozen ? { frozenReason: 'reconciliation mismatch', frozenBy: 'reconciliation' } : {}),
      });
    if (url.pathname === '/health') return send(200, { ok: true });
    state.requests.push(Date.now());
    const who = (req.headers.authorization ?? '').replace('Bearer ', '');
    const isOrderWrite = (req.method === 'POST' || req.method === 'DELETE') && url.pathname.startsWith('/api/v1/orders');
    if (isOrderWrite) {
      state.orderRequests += 1;
      if (state.frozen) return send(400, { code: 'LedgerError', message: 'posting is frozen', intafacedCode: 'LedgerError' });
    }
    if (url.pathname === '/api/identity/trpc/auth.login') {
      return send(200, {
        result: {
          data: {
            accessToken: json.identifier.startsWith('test-taker') ? 'taker' : 'maker',
            userId: json.identifier.startsWith('test-taker') ? 'u-taker' : 'u-maker',
          },
        },
      });
    }
    if (url.pathname === '/api/v1/markets') return send(200, markets);
    if (url.pathname.startsWith('/api/v1/account/market-lifecycle/')) return send(200, { allowedActions: ['PLACE_POST_ONLY'] });
    if (url.pathname === '/api/v1/account/balance') {
      const big = { free: '1000000000' };
      const empty = who === 'taker' && !state.funds.some((f) => f.userId === 'u-taker' && f.asset === 'USDT');
      return send(200, {
        balances: Object.fromEntries(['BTC', 'SOL', 'DOGE', 'USDT'].map((a) => [a, empty && a === 'USDT' ? { free: '0' } : big])),
      });
    }
    if (url.pathname === '/api/v1/orders/open') {
      const symbol = url.searchParams.get('symbol');
      return send(200, [...books.values()].filter((o) => o.symbol === symbol && o.remaining > 0n && o.owner === who).map(wire));
    }
    if (url.pathname === '/api/v1/orders/batch' && req.method === 'POST') {
      const results = json.orders.map((o, index) => {
        const price = toScaled(o.price);
        const amount = toScaled(o.amount);
        const opposite = sideOrders(o.symbol, o.side === 'buy' ? 'sell' : 'buy');
        const wouldCross = opposite.some((x) => (o.side === 'buy' ? x.price <= price : x.price >= price));
        if (wouldCross || !o.postOnly) {
          state.refused += 1;
          return { index, clientOrderId: o.clientOrderId, status: 'refused', error: { intafacedCode: 'trade.post_only_would_cross' } };
        }
        const order = { id: `o${(state.seq += 1)}`, owner: who, symbol: o.symbol, side: o.side, price, amount, remaining: amount };
        books.set(order.id, order);
        checkCrossed(o.symbol);
        return { index, clientOrderId: o.clientOrderId, status: 'success', order: wire(order) };
      });
      return send(200, { results });
    }
    if (url.pathname === '/api/v1/orders' && req.method === 'POST') {
      let left = toScaled(json.amount);
      const limit = toScaled(json.price);
      const opposite = sideOrders(json.symbol, json.side === 'buy' ? 'sell' : 'buy').sort((a, b) =>
        a.price === b.price ? 0 : a.price < b.price === (json.side === 'buy') ? -1 : 1,
      );
      let filled = 0n;
      for (const o of opposite) {
        if (left === 0n || (json.side === 'buy' ? o.price > limit : o.price < limit)) break;
        const take = o.remaining < left ? o.remaining : left;
        o.remaining -= take;
        left -= take;
        filled += take;
        state.trades.push({ symbol: json.symbol, side: json.side, price: o.price, amount: take });
      }
      return send(201, { id: `t${(state.seq += 1)}`, status: 'closed', filled: fromScaled(filled), remaining: fromScaled(left) });
    }
    if (url.pathname.startsWith('/api/v1/orders/') && req.method === 'DELETE') {
      books.delete(decodeURIComponent(url.pathname.split('/').pop()));
      return send(200, {});
    }
    if (url.pathname === '/api/v1/orders' && req.method === 'DELETE') {
      for (const [id, o] of books) if (o.symbol === url.searchParams.get('symbol')) books.delete(id);
      return send(200, []);
    }
    if (url.pathname === '/__fund') {
      state.funds.push({
        userId: url.searchParams.get('userId'),
        asset: url.searchParams.get('asset'),
        amount: url.searchParams.get('amount'),
      });
      return send(200, {});
    }
    return send(404, { code: 'NotFound' });
  };
  const listen = (kind) =>
    new Promise((ok) => {
      const srv = httpServer(handler(kind)).listen(0, '127.0.0.1', () => ok(srv));
    });
  const [edgeSrv, matchSrv, ledgerSrv] = await Promise.all([listen('edge'), listen('matching'), listen('ledger')]);
  const port = (s) => s.address().port;
  const loopHome = mkdtempSync(join(tmpdir(), 'local-test-market-loop-'));
  let child = null;
  try {
    mkdirSync(join(loopHome, '.intafaced', 'local-test-stack'), { recursive: true });
    writeFileSync(
      join(loopHome, '.intafaced', 'local-test-stack', 'LOCAL-TEST-STACK.json'),
      JSON.stringify({
        kind: 'intafaced-local-test-stack',
        ports: { edge: port(edgeSrv), matching: port(matchSrv), ledger: port(ledgerSrv) },
      }),
    );
    const opts = {
      seed: '7',
      seconds: 1,
      refreshMs: 300,
      levels: 6,
      trades: 10,
      ops: 400,
      maxRpm: 600,
      warmup: true,
      symbols,
      edge: `http://127.0.0.1:${port(edgeSrv)}`,
      ledgerCheckMs: 300,
    };
    child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import * as m from ${JSON.stringify(script)};
         const opts = ${JSON.stringify(opts)};
         const fund = async (userId, asset, amount) => { await fetch(process.env.MOCK + '/__fund?userId=' + userId + '&asset=' + asset + '&amount=' + amount); };
         setTimeout(() => { m.STOP.requested = true; }, 40000);
         process.exit(await m.runLoop(opts, process.env.HOME, { fund }));`,
      ],
      { env: { ...process.env, HOME: loopHome, MOCK: opts.edge }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let childOut = '';
    child.stdout.on('data', (d) => (childOut += d));
    child.stderr.on('data', (d) => (childOut += d));
    const exited = new Promise((done) => child.on('exit', done));

    // Frozen from the start: the loop waits and sends nothing.
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(state.orderRequests, 0, `orders sent into a frozen ledger: ${state.orderRequests}`);
    assert.equal(state.funds.length, 0, 'nothing is funded while the ledger is frozen');
    state.frozen = false;
    const t0 = Date.now();
    await waitFor(
      () => symbols.every((s) => sideOrders(s, 'buy').length >= 6 && sideOrders(s, 'sell').length >= 6),
      'every market to reach depth',
      8000,
    );
    assert.ok(Date.now() - t0 < 8000);
    // Frozen again mid-run: order traffic stops (a request already in flight may land), then resumes on thaw.
    await new Promise((r) => setTimeout(r, 1200));
    state.frozen = true;
    await new Promise((r) => setTimeout(r, 600));
    const during = state.orderRequests;
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(state.orderRequests, during, 'no order traffic while the ledger is frozen');
    state.frozen = false;
    const before = state.orderRequests;
    await waitFor(() => state.orderRequests > before, 'orders to resume after the thaw', 4000);
    const depthOf = (s, side) => sideOrders(s, side).length;
    for (const s of symbols) {
      assert.ok(depthOf(s, 'buy') >= 6 && depthOf(s, 'sell') >= 6, `${s} depth ${depthOf(s, 'buy')}/${depthOf(s, 'sell')}`);
      assert.ok(new Set(sideOrders(s, 'buy').map((o) => o.amount)).size >= 3, `${s}: bid sizes must vary`);
      const p = LOCAL_PAIRS.find((x) => x.symbol === s);
      for (const o of [...books.values()].filter((x) => x.symbol === s)) {
        assert.equal(o.price % toScaled(p.tick), 0n, `${s}: off the tick grid`);
        assert.equal(o.amount % toScaled(p.lot), 0n, `${s}: off the lot grid`);
      }
    }
    assert.equal(state.crossed, false, 'the book was crossed');
    assert.ok(state.trades.length >= 4, `only ${state.trades.length} fills`);
    assert.ok(state.trades.some((t) => t.side === 'buy') && state.trades.some((t) => t.side === 'sell'), 'trades must go both ways');
    assert.ok(new Set(state.trades.map((t) => String(t.amount))).size >= 3, 'trade sizes must vary');
    assert.ok(
      state.funds.some((f) => f.userId === 'u-taker' && f.asset === 'USDT'),
      'an empty taker is topped up through the ledger',
    );
    assert.ok(!state.funds.some((f) => f.userId === 'u-maker'), 'a stocked maker is not');
    // The request cap holds: every minute-long window holds at most maxRpm requests.
    const stamps = state.requests;
    for (const t of stamps) assert.ok(stamps.filter((x) => x >= t && x < t + 60_000).length <= opts.maxRpm, 'request cap exceeded');
    child.kill('SIGTERM'); // stop it the way `local:market stop` does
    assert.equal(await exited, 0, childOut);
    const log = readFileSync(join(loopHome, '.intafaced', 'local-test-stack', 'logs', 'market.log'), 'utf8');
    assert.match(log, /WAITING\. LEDGER POSTING IS FROZEN \(reconciliation mismatch/);
    assert.match(log, /PAUSED\. LEDGER POSTING IS FROZEN/);
    assert.match(log, /RESUMED\. ledger is accepting posts/);
    assert.match(log, /load budget: 400 maker orders\/s, 10 taker orders\/s/);
    assert.match(log, /quoting 3 markets/);
    assert.match(log, /EXIT pid \d+ code 0/);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    for (const s of [edgeSrv, matchSrv, ledgerSrv]) {
      s.closeAllConnections();
      s.close();
    }
    rmSync(loopHome, { recursive: true, force: true });
  }
}

console.log('local-test-market: loop checks passed (depth, no crossed book, both-way trades, funding, request cap, frozen-ledger pause)');
