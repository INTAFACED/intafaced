// Proves, without starting or touching anything: the living-market script refuses outside the
// local test stack, and its synthetic price walk and quote ladder are deterministic, bounded and
// integer-only. Run: pnpm local:market:test
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProcessIdentity } from './local-test-state.mjs';
import {
  GuardError,
  assertLocalTarget,
  marketStatus,
  buildLadder,
  createPriceWalk,
  crossingSide,
  cycleMids,
  crossesOn,
  fromScaled,
  TAPE_CLIENT_PREFIX,
  tapeWindow,
  toScaled,
  toScaledFloor,
} from './local-test-market.mjs';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'local-test-market.mjs');
// The script reads the stack's folder from LOCAL_STACK_STATE when it is set (a cloud container sets it), so `start` below
// would start the TEST market maker on the running stack instead of refusing in this test's empty home (failure it
// prevents: it did, and a history run on that stack then met the maker's trades). These checks are about that home only.
delete process.env.LOCAL_STACK_STATE;
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
  // 5b. `history` sits behind the same guard, and refuses a nonsense bar count before any call.
  r = run(home, ['history', '--edge-url', 'https://api.intafaced.com']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /is not http:\/\/127\.0\.0\.1/);
  for (const bad of [
    ['--bars', '0'],
    ['--bars', '2001'],
    ['--bars', '1.5'],
    ['--step-minutes', '0'],
    ['--step-minutes', '1441'],
    ['--trades-per-bar', '0'],
    ['--trades-per-bar', '7'],
    ['--bars', '1000', '--trades-per-bar', '6'],
    ['--bars', '1000', '--step-minutes', '60'],
    ['--bars', '744', '--step-minutes', '60'], // exactly 31 days: one bar of slack is needed
  ]) {
    r = run(home, ['history', ...bad]);
    assert.equal(r.status, 2, `${bad.join(' ')}: ${r.stderr}`);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

// 5c. The tape history window: trades evenly spaced inside closed bars, the newest bar ending where the current bucket
// starts. svc-trade matches the client id prefix exactly (services/svc-trade/src/spot/local-test-tape.ts).
{
  const step = 15 * 60_000;
  const now = Date.UTC(2026, 9, 23, 0, 52, 13);
  const end = Date.UTC(2026, 9, 23, 0, 45);
  const one = tapeWindow({ nowMs: now, trades: 210, stepMs: step });
  assert.deepEqual(one, { startMs: end - 210 * step, stepMs: step });
  const three = tapeWindow({ nowMs: now, trades: 630, stepMs: step, perBar: 3 });
  assert.deepEqual(three, { startMs: end - 210 * step, stepMs: step / 3 });
  // Trade i lands in bar floor(i / 3): three per bar, and the last one before the current bucket.
  const bar = (i) => Math.floor((three.startMs + i * three.stepMs) / step);
  assert.deepEqual([bar(0), bar(1), bar(2), bar(3)], [bar(0), bar(0), bar(0), bar(0) + 1]);
  assert.ok(three.startMs + 629 * three.stepMs < end);
  assert.equal(bar(629), end / step - 1);
  assert.throws(() => tapeWindow({ nowMs: now, trades: 7, stepMs: 1000, perBar: 7 }), /divide evenly/);
  assert.equal(TAPE_CLIENT_PREFIX, 'LTEST-TAPE-');
  assert.ok(`${TAPE_CLIENT_PREFIX}abcdef-${5000 * 5}`.length <= 64); // the order contract's client id limit
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
// A follower is quoted at its leader's mid of the same cycle, even after `history` moved only the leader's walk on
// (failure it prevents: the TEST perp walked the spot series 420 steps behind, its bids sat more than the 50 bps
// market-open cap under the mark, and J-derivatives-03 #9's reverse open went unfilled on runs 640 and 641).
{
  const perp = { symbol: 'BTC/USDT:USDT' };
  const spot = { symbol: 'BTC/USDT' };
  const walks = new Map([
    [spot.symbol, createPriceWalk({ ...cfg, seed: '1013' })],
    [perp.symbol, createPriceWalk({ ...cfg, seed: '1013' })],
  ]);
  walks.get(spot.symbol).advance(420);
  for (let cycle = 0; cycle < 200; cycle += 1) {
    const mids = cycleMids([perp, spot], walks);
    assert.equal(mids.get(perp.symbol), mids.get(spot.symbol));
    assert.equal(mids.get(spot.symbol), walks.get(spot.symbol).current());
  }
  // Its leader not quoted in this run: the follower walks on its own.
  const alone = new Map([[perp.symbol, createPriceWalk({ ...cfg, seed: '1013' })]]);
  const before = alone.get(perp.symbol).steps;
  assert.equal(cycleMids([perp], alone).get(perp.symbol), alone.get(perp.symbol).current());
  assert.equal(alone.get(perp.symbol).steps, before + 1);
}

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
// The taker crosses each market every sixth cycle, half the markets at a time, and BTC/USDT (the one the journeys run
// waits for) on the very first cycle.
const crossCycles = (symbol) => Array.from({ length: 20 }, (_, i) => i + 1).filter((c) => crossesOn(c, symbol));
assert.deepEqual(crossCycles('BTC/USDT'), [1, 7, 13, 19]);
assert.deepEqual(crossCycles('ETH/USDT'), [1, 7, 13, 19]);
assert.deepEqual(crossCycles('ETH/BTC'), [4, 10, 16]);
assert.deepEqual(crossCycles('BTC/USDT:USDT'), [4, 10, 16]);

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
  const setPid = (pid, extra = {}) => {
    const fake = fakes.find((child) => child.pid === pid);
    const startedAt = fake ? new Date(readProcessIdentity(pid).startedAt).toISOString() : '2026-10-14T00:00:00.000Z';
    writeFileSync(pidFile, JSON.stringify({ pid, startedAt, ...(fake ? { argv: fake.spawnargs } : {}), ...extra }));
  };

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
  // PID reuse with the exact same argv must not authorize a signal.
  setPid(fake.pid, { startedAt: '2026-10-14T00:00:00.000Z' });
  r = run(sup, ['stop']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already down; forgot it/);
  assert.equal(alive(fake.pid), true, 'a reused PID must not receive SIGTERM');
  setPid(fake.pid);
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
