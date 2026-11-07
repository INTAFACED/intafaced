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
  unquotedMarkets,
  assertLocalTarget,
  bandEdgeQuote,
  crossingQuote,
  marketStatus,
  buildLadder,
  createPriceWalk,
  crossingSide,
  bookMid,
  parseShift,
  shiftedMid,
  quoteOrder,
  shiftQuoted,
  crossesOn,
  quotesInTheWay,
  stackNotActive,
  STACK_INACTIVE_LIMIT_MS,
  fromScaled,
  HISTORY_EDGE_WINDOW_MS,
  TAPE_CLIENT_PREFIX,
  historyBudgetWait,
  laterEdgeBudget,
  readEdgeBudget,
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

// 5d. The wait at the end of `history`: none while Edge says half its budget or more is left, until the window ends when
// less is, and the whole window after the last request when Edge said nothing. Readings come from every reply's headers;
// out-of-order replies keep the lowest remaining in a window, and a later window replaces an earlier one.
{
  const now = 1_000_000;
  const headers = (h) => new Headers(h);
  const reply = (remaining, reset = '40') =>
    readEdgeBudget(
      headers({ 'x-ratelimit-limit': '6000', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': reset }),
      now - 2000,
    );
  assert.deepEqual(reply(5160), { limit: 6000, remaining: 5160, endsAt: now + 38_000 });
  assert.equal(readEdgeBudget(headers({ 'x-ratelimit-limit': '6000', 'x-ratelimit-reset': '40' }), now), null);
  assert.equal(readEdgeBudget(headers({ 'x-ratelimit-limit': '0', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' }), now), null);
  assert.equal(readEdgeBudget(headers({ 'x-ratelimit-limit': '6000', 'x-ratelimit-remaining': 'x', 'x-ratelimit-reset': '1' }), now), null);
  assert.equal(readEdgeBudget(headers({}), now), null);

  assert.equal(historyBudgetWait({ budget: reply(5160), lastEdgeAt: now - 2000, nowMs: now }), 0);
  assert.equal(historyBudgetWait({ budget: reply(3000), lastEdgeAt: now - 2000, nowMs: now }), 0);
  assert.equal(historyBudgetWait({ budget: reply(2999), lastEdgeAt: now - 2000, nowMs: now }), 38_000);
  assert.equal(historyBudgetWait({ budget: reply(0, '1'), lastEdgeAt: now - 2000, nowMs: now }), 0);
  assert.equal(historyBudgetWait({ budget: null, lastEdgeAt: now - 2000, nowMs: now }), HISTORY_EDGE_WINDOW_MS - 2000);
  assert.equal(historyBudgetWait({ budget: null, lastEdgeAt: 0, nowMs: now }), 0);

  // A slow reply counted first arrives last: the lower remaining in the same window stays.
  const counted2nd = reply(2998);
  const counted1st = reply(2999);
  assert.equal(laterEdgeBudget(laterEdgeBudget(null, counted2nd), counted1st), counted2nd);
  assert.equal(laterEdgeBudget(counted2nd, null), counted2nd);
  // A reply from the next window replaces the old window's low figure, and an old window's late reply does not return.
  const next = readEdgeBudget(headers({ 'x-ratelimit-limit': '6000', 'x-ratelimit-remaining': '5990', 'x-ratelimit-reset': '60' }), now);
  const old = readEdgeBudget(headers({ 'x-ratelimit-limit': '6000', 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': '0' }), now);
  assert.equal(laterEdgeBudget(old, next), next);
  assert.equal(laterEdgeBudget(next, old), next);
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
// A follower is quoted right after its leader, around the leader's book (failure it prevents: the TEST perp walked the
// spot series 420 steps behind, its bids sat more than the 50 bps market-open cap under the mark, and
// J-derivatives-03 #9's reverse open went unfilled on runs 640 and 641).
{
  const mk = (symbol) => ({ symbol });
  const prices = {
    A: {},
    B: { follows: 'A' },
    C: { follows: 'B' },
    X: { follows: 'gone' },
    L1: { follows: 'L2' },
    L2: { follows: 'L1' },
    S: { follows: 'S' },
  };
  const pairs = (list) => list.map(({ market, leader }) => [market.symbol, leader]);
  const order = (symbols) => pairs(quoteOrder(symbols.map(mk), prices));
  // The follower listed first still goes after its leader, and a chain resolves in leader order.
  assert.deepEqual(order(['C', 'B', 'A']), [
    ['A', null],
    ['B', 'A'],
    ['C', 'B'],
  ]);
  // The real pair, whatever order the markets come back in: the perp right after BTC/USDT.
  assert.deepEqual(pairs(quoteOrder(['BTC/USDT:USDT', 'BTC/USDT', 'ETH/USDT'].map(mk))), [
    ['BTC/USDT', null],
    ['BTC/USDT:USDT', 'BTC/USDT'],
    ['ETH/USDT', null],
  ]);
  // A leader not quoted in this run, a loop and a market naming itself: each is quoted, none centred on a missing mid.
  assert.deepEqual(order(['X']), [['X', null]]);
  assert.deepEqual(order(['B']), [['B', null]]);
  assert.deepEqual(order(['S']), [['S', null]]);
  assert.deepEqual(order(['L1', 'L2']), [
    ['L1', null],
    ['L2', 'L1'],
  ]);
  // A `move` counts as on the book only once the maker has logged quoting it, at or after the move was asked. A line
  // from before the move, another market's or another shift's, is not it (J-derivatives-04 #2 aimed from a book that
  // still carried the stop half's -0.30%, main run 42419522734).
  {
    const log = [
      '2026-11-07T22:12:43.900Z [TEST MARKET] BTC/USDT TEST PRICE mid 64800.97 USDT: 6/6 quotes resting',
      '2026-11-07T22:12:43.901Z [TEST MARKET] BTC/USDT TEST PRICE shift -30 bps quoted',
      '2026-11-07T22:12:56.100Z [TEST MARKET] BTC/USDC TEST PRICE shift 0 bps quoted',
      '2026-11-07T22:12:56.500Z [TEST MARKET] BTC/USDT TEST PRICE shift 0 bps quoted',
    ].join('\n');
    const asked = new Date('2026-11-07T22:12:44.600Z');
    assert.equal(shiftQuoted(log, 'BTC/USDT', 0n, asked), true);
    assert.equal(shiftQuoted(log, 'BTC/USDT', -30n, asked), false, 'quoted before the move was asked');
    assert.equal(shiftQuoted(log, 'BTC/USDT', 0n, new Date('2026-11-07T22:12:57Z')), false, 'not yet quoted');
    assert.equal(shiftQuoted(log, 'BTC/USDT', -1000n, asked), false, 'another shift');
    assert.equal(shiftQuoted(log.split('\n').slice(0, 3).join('\n'), 'BTC/USDT', 0n, asked), false, 'only another market');
    assert.equal(shiftQuoted('', 'BTC/USDT', 0n, asked), false);
  }
  // The leader's book mid, from the best bid and ask; an empty or unreadable side is no mid.
  assert.equal(bookMid({ bids: [['65000', '1']], asks: [['65001', '1']] }), toScaled('65000.5'));
  assert.equal(bookMid({ bids: [], asks: [['65001', '1']] }), null);
  assert.equal(bookMid({ bids: [['65000', '1']] }), null);
  assert.equal(bookMid(null), null);
  assert.equal(bookMid({ bids: [['1e3', '1']], asks: [['65001', '1']] }), null);
}

// 7b. A quote the price band refused goes in at the band's edge (as the order check names it), on the tick, nearer the
// book; a buy moved down keeps its notional. Anything else is left alone. The book J-portfolio-04 met on main (run 1247):
// the maker's own bids gone, a TEST buy resting at 52,074, its asks at 65,431.81, so svc-trade's band ran 52,848.24 to
// 64,592.29 and refused every maker bid at the walk's price.
{
  const grid = { tick: toScaled('0.01'), lot: toScaled('0.00001') };
  const band = { low: '52848.24', high: '64592.29', collar: '0.1' };
  const bid = { side: 'buy', level: 0, price: '65351.37', amount: '0.0459' };
  const edgedBid = bandEdgeQuote(bid, band, grid);
  assert.equal(edgedBid.price, '64592.29');
  assert.equal(edgedBid.side, 'buy');
  assert.equal(edgedBid.level, 0);
  // 65351.37 x 0.0459 = 2999.627883; at 64592.29 that needs 0.046439..., rounded up to the lot: 0.04644.
  assert.equal(edgedBid.amount, '0.04644');
  assert.ok(toScaled(edgedBid.price) * toScaled(edgedBid.amount) >= toScaled(bid.price) * toScaled(bid.amount));
  const ask = { side: 'sell', level: 1, price: '52000.5', amount: '0.1' };
  assert.deepEqual(bandEdgeQuote(ask, band, grid), { ...ask, price: '52848.24' });
  // An edge off the tick is moved inside the band: down for a buy, up for a sell.
  const offTick = { low: '52848.235', high: '64592.299' };
  assert.equal(bandEdgeQuote(bid, offTick, grid).price, '64592.29');
  assert.equal(bandEdgeQuote(ask, offTick, grid).price, '52848.24');
  // No band named, an edge that is not a plain decimal, or an edge that is not nearer the book: nothing to re-place.
  assert.equal(bandEdgeQuote(bid, null, grid), null);
  assert.equal(bandEdgeQuote(bid, {}, grid), null);
  assert.equal(bandEdgeQuote(bid, { high: '6.4e4' }, grid), null);
  assert.equal(bandEdgeQuote({ ...bid, price: '64000' }, band, grid), null);
  assert.equal(bandEdgeQuote({ ...ask, price: '60000' }, band, grid), null);
}

// 7c. A crossing meets only the maker's own level-0 quote: resting at the ladder's price and amount, and alone at the
// top of the book on that side. Anything at or ahead of it (run 42171557580, J-cex-spot-01 #7: a person's TEST buy one
// cent above the best bid, filled by test_taker's crossing) means no crossing.
{
  const bid0 = { side: 'buy', level: 0, price: '65000', amount: '0.046' };
  const bid1 = { side: 'buy', level: 1, price: '64941.5', amount: '0.046' };
  const ask0 = { side: 'sell', level: 0, price: '65078', amount: '0.046' };
  const plan = [bid0, bid1, ask0];
  const resting = [{ ...bid0 }, { ...bid1 }, { ...ask0 }];
  const book = { bids: [['65000', '0.046']], asks: [['65078.00', '0.04600']] };
  assert.equal(crossingQuote(plan, resting, 'sell', book), bid0);
  assert.equal(crossingQuote(plan, resting, 'buy', book), ask0);
  // A person's buy one cent above the maker's best bid: the sell would fill it first.
  assert.equal(crossingQuote(plan, resting, 'sell', { ...book, bids: [['65000.01', '0.1']] }), null);
  // A person's buy at the maker's price, queued first: the level's size is more than the maker's.
  assert.equal(crossingQuote(plan, resting, 'sell', { ...book, bids: [['65000', '0.146']] }), null);
  // The maker's quote part-filled: less than its amount at its price.
  assert.equal(crossingQuote(plan, resting, 'sell', { ...book, bids: [['65000', '0.02']] }), null);
  // The level-0 bid did not rest, or rests only at a band edge: no crossing, not a deeper bid.
  assert.equal(crossingQuote(plan, [{ ...bid1 }, { ...ask0 }], 'sell', { ...book, bids: [['64941.5', '0.046']] }), null);
  assert.equal(
    crossingQuote(plan, [{ ...bid0, price: '58000', amount: '0.0515' }], 'sell', { ...book, bids: [['58000', '0.0515']] }),
    null,
  );
  // No book read: no crossing.
  assert.equal(crossingQuote(plan, resting, 'sell', null), null);
  assert.equal(crossingQuote(plan, resting, 'buy', { bids: [], asks: [] }), null);
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

// A restarted maker takes down first only the earlier run's quotes its new ladder would meet (#7110): a run that died
// mid-`move` left asks at 64,610 under a new ladder whose bids start at 65,296; the bid side's quotes were refused.
const fresh = [
  { side: 'buy', level: 0, price: '65296.7', amount: '0.04' },
  { side: 'sell', level: 0, price: '65375.11', amount: '0.04' },
  { side: 'buy', level: 1, price: '65237.9', amount: '0.09' },
  { side: 'sell', level: 1, price: '65433.91', amount: '0.09' },
];
const resting = [
  { id: 'old-ask-under-bid', side: 'sell', price: '64610.12' },
  { id: 'old-ask-at-bid', side: 'sell', price: '65296.7' },
  { id: 'old-ask-above', side: 'sell', price: '65300' },
  { id: 'old-bid-under', side: 'buy', price: '65200' },
  { id: 'old-bid-at-ask', side: 'buy', price: '65375.11' },
  { id: 'no-price', side: 'buy' },
];
assert.deepEqual(quotesInTheWay(resting, fresh), ['old-ask-under-bid', 'old-ask-at-bid', 'old-bid-at-ask']);
assert.deepEqual(quotesInTheWay(resting, []), []);
// A service restarting makes the stack guard refuse; the market waits that out (#7110), and only that refusal.
assert.equal(stackNotActive(new Error('refusing: selected local stack is not active (trade is not listening)')), true);
assert.equal(stackNotActive(new Error('refusing: some other guard')), false);
assert.equal(stackNotActive(new Error('ledger.insufficient_funds')), false);
assert.equal(stackNotActive(undefined), false);
assert.ok(STACK_INACTIVE_LIMIT_MS >= 60_000 && STACK_INACTIVE_LIMIT_MS <= 10 * 60_000);

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

// `move`: a percent becomes whole basis points within -50% to +100%; the walk mid moves by it, floored to the tick.
assert.equal(parseShift('+2%'), 200n);
assert.equal(parseShift('-6%'), -600n);
assert.equal(parseShift('0.5%'), 50n);
assert.equal(parseShift('0%'), 0n);
assert.equal(parseShift('-50%'), -5000n);
assert.equal(parseShift('-51%'), null);
assert.equal(parseShift('101%'), null);
assert.equal(parseShift('2'), null);
assert.equal(parseShift('1.234%'), null);
assert.equal(parseShift(undefined), null);
assert.equal(shiftedMid(toScaled('1'), 200n, toScaled('0.0001')), toScaled('1.02'));
assert.equal(shiftedMid(toScaled('65000'), -600n, toScaled('0.01')), toScaled('61100'));
assert.equal(shiftedMid(toScaled('1.00005'), 0n, toScaled('0.0001')), toScaled('1.00005'));
assert.equal(shiftedMid(toScaled('1'), undefined, toScaled('0.0001')), toScaled('1'));

// A maker restart is ready only once its newest run has quoted every market it named, the perpetual (quoted last) too.
{
  const T = (line) => `2026-11-07T13:32:40.000Z [TEST MARKET] ${line}`;
  const older = [
    T('LOCAL TEST MARKET — TEST PRICES, not a market feed, not real money. seed=7, requote every 3s'),
    T('BTC/USDT: TEST PRICE reference 65000 USDT, walking from step 1 at 65000'),
    T('BTC/USDT TEST PRICE mid 65000 USDT: 6/6 quotes resting'),
  ];
  const start = [
    T('LOCAL TEST MARKET — TEST PRICES, not a market feed, not real money. seed=7, requote every 3s'),
    T('BTC/USDT: TEST PRICE reference 65000 USDT, walking from step 40 at 65100'),
    T("BTC/USDT:USDT: quoted around the BTC/USDT book's mid each cycle"),
  ];
  assert.deepEqual(unquotedMarkets(''), { announced: [], waiting: [] });
  assert.deepEqual(unquotedMarkets(older.slice(0, 1).join('\n')), { announced: [], waiting: [] });
  // The newest run counts, not an older one's quotes still in the log.
  assert.deepEqual(unquotedMarkets([...older, ...start].join('\n')), {
    announced: ['BTC/USDT', 'BTC/USDT:USDT'],
    waiting: ['BTC/USDT', 'BTC/USDT:USDT'],
  });
  const spot = T('BTC/USDT TEST PRICE mid 65100 USDT: 6/6 quotes resting');
  assert.deepEqual(unquotedMarkets([...older, ...start, spot].join('\n')).waiting, ['BTC/USDT:USDT']);
  // A cycle that rested nothing on the perpetual is not quoted yet.
  const none = T('BTC/USDT:USDT TEST PRICE mid 65100 USDT: 0/6 quotes resting; last refusal 400');
  assert.deepEqual(unquotedMarkets([...older, ...start, spot, none].join('\n')).waiting, ['BTC/USDT:USDT']);
  const perp = T('BTC/USDT:USDT TEST PRICE mid 65100 USDT: 6/6 quotes resting');
  assert.deepEqual(unquotedMarkets([...older, ...start, spot, none, perp].join('\n')).waiting, []);
}
