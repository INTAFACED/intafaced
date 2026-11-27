// A round's logic, driven with fakes (#10299, #10294): the tester sees the old stack or the updating page until the new
// stack passes its checks and is readied, and the status file reads `updating` all that time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BETA_MOVE_AT,
  READY_WAIT_MS,
  askBack,
  askMove,
  betaPaths,
  decide,
  frontAction,
  frontUnitText,
  moveDue,
  readied,
  round,
  slotStart,
  statusLine,
  syncFront,
  venueReadied,
} from './beta-host.mjs';
import { frontApp, holdOf } from './beta-front.mjs';

const OLD = 'a'.repeat(40);
/** The marker a launch on the beta's own settings writes (BETA_STACK_SETTINGS). */
const SETTINGS =
  'LOCAL_STACK_PUBLIC_ORIGIN=https://beta.intafaced.com LOCAL_STACK_USER_VENUE=hl-testnet LOCAL_STACK_TEST_MARKETS=off LOCAL_STACK_VALUATION_PRICES=test LOCAL_STACK_PROTOCOL_EMBEDDED_WALLET=turnkey LOCAL_STACK_CUSTODY_LAYER=off';
const NEW = 'b'.repeat(40);
const PASS = { ok: true, lines: ['ok   the Customer page carries the TEST banner ("TEST FUNDS")'] };

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-round-'));
  const paths = betaPaths(dir);
  fs.mkdirSync(path.join(paths.checkout, 'tooling', 'beta'), { recursive: true });
  fs.writeFileSync(path.join(paths.checkout, '.git'), 'gitdir: x\n');
  fs.mkdirSync(paths.state, { recursive: true });
  fs.writeFileSync(paths.screening, '{}');
  // The running stack is already on the beta's own settings; the settings tests below take this away.
  fs.writeFileSync(paths.settings, `${SETTINGS}\n`);
  return paths;
}
const readStatus = (paths) => JSON.parse(fs.readFileSync(paths.status, 'utf8'));

/** Fakes for one round. `seen` records the status file and what the front shows at every outside step. */
function fakes(
  paths,
  { head = OLD, target = NEW, check = PASS, checkFor = () => check, launch = 0, readyAfter = 0, warmBefore = true, chainNew = false } = {},
) {
  let clock = Date.parse('2026-11-23T09:00:00Z');
  let current = head;
  let calls = 0;
  const seen = [];
  const look = (step) => {
    const s = fs.existsSync(paths.status) ? readStatus(paths) : null;
    seen.push({ step, state: s?.state ?? null, shown: holdOf(s) ?? 'app' });
  };
  const io = {
    git: (_cwd, ...args) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${args[1] === 'HEAD' ? head : target}\n`, stderr: '' };
      if (args[0] === 'checkout') {
        current = args.at(-1);
        look('checkout');
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    run: async (_p, cmd, args) => {
      look(cmd === 'pnpm' ? 'install' : args.includes('launch') ? 'launch' : 'stop');
      return args.includes('launch') ? launch : 0;
    },
    anvil: () => ({ line: 'anvil: fake', fresh: chainNew }),
    check: async () => (look('check'), checkFor(current)),
    readied: async () => {
      const first = calls++ === 0;
      if (first && seen.length === 0) return { ok: warmBefore, why: 'before the round' };
      look('readied');
      return calls - 1 > readyAfter ? { ok: true, why: '20 of 27 markets have a price' } : { ok: false, why: 'none yet' };
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { io, seen };
}

test("readied with custody off reads the venue's own prices, since our own book's markets have none at launch (#11019)", () => {
  // svc-trade's reply on a custody-off stack with the beta's venue (27 Nov 2026, slot 0, LOCAL_STACK_CUSTODY_LAYER=off).
  const live = JSON.stringify({
    venueId: 'hyperliquid-testnet',
    value: {
      'PURR-USDC': { symbol: 'PURR-USDC', last: '4.5795', bid: '4.5342', ask: '4.5795' },
      'BTC-USDC': { symbol: 'BTC-USDC', last: '6100', bid: null, ask: '6100' },
    },
    asOf: '2026-11-27T03:38:04.606Z',
    test: true,
  });
  assert.deepEqual(venueReadied(live), { ok: true, why: "2 of 2 of the venue's markets (hyperliquid-testnet) have a price" });
  assert.equal(venueReadied(JSON.stringify({ venueId: 'x', value: { A: { last: null } } })).ok, false);
  assert.equal(venueReadied(JSON.stringify({ code: 'trade.user_venue_off' })).ok, false);
  assert.equal(venueReadied(null).ok, false);
  // The same stack's own-book reads: every market unpriced, so the custody-on gate would never ready the beta.
  assert.equal(
    readied({ markets: JSON.stringify([{ symbol: 'BTC/USDC', test: false }]), tickers: JSON.stringify({ 'BTC/USDC': { last: null } }) }).ok,
    false,
  );
});

test('a database served custody on is kept aside once, so svc-ledger starts custody off on a fresh book (#11019)', async () => {
  const paths = home();
  const records = (custodyLayer) =>
    fs.writeFileSync(path.join(paths.state, 'run', 'processes.json'), JSON.stringify({ ledger: { pid: 1, custodyLayer } }));
  fs.mkdirSync(path.join(paths.state, 'run'), { recursive: true });
  fs.mkdirSync(path.join(paths.state, 'data', 'postgres'), { recursive: true });
  fs.writeFileSync(path.join(paths.state, 'data', 'postgres', 'PG_VERSION'), '16\n');
  records('on');
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, upSince: '2026-11-23T04:00:00Z' }));
  const { io, seen } = fakes(paths, { target: OLD });
  const end = await round(paths, io);
  assert.equal(end.state, 'up');
  assert.deepEqual(seen.map((s) => s.step).slice(0, 3), ['stop', 'stop', 'launch'], 'stopped whole before the move, then launched');
  assert.equal(fs.existsSync(path.join(paths.state, 'data')), false, 'the custody-on database no longer serves');
  const kept = fs.readdirSync(paths.state).filter((n) => n.startsWith('data-custody-on-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(paths.state, kept[0], 'postgres', 'PG_VERSION'), 'utf8'), '16\n', 'kept, never deleted');
  assert.match(
    fs.readFileSync(paths.log, 'utf8'),
    /custody: the database was served custody on, so it is kept at .*data-custody-on-\d{8}T\d{6}Z/,
  );
  // The next round, on the custody-off stack the launch started: nothing moves again.
  fs.mkdirSync(path.join(paths.state, 'data', 'postgres'), { recursive: true });
  records('off');
  await round(paths, fakes(paths, { target: OLD }).io);
  assert.equal(fs.existsSync(path.join(paths.state, 'data', 'postgres')), true);
  assert.equal(fs.readdirSync(paths.state).filter((n) => n.startsWith('data-custody-')).length, 1);
});

test('an update round: status reads updating, and the front shows its updating page, from before the checkout moves until the new stack is readied', async () => {
  const paths = home();
  fs.writeFileSync(
    paths.status,
    JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T06:00:00Z', upSince: '2026-11-23T04:00:00Z' }),
  );
  const { io, seen } = fakes(paths, { readyAfter: 3 });
  const end = await round(paths, io);
  assert.deepEqual(
    seen.map((s) => s.step),
    ['checkout', 'install', 'launch', 'check', 'readied', 'readied', 'readied', 'readied', 'readied'],
  );
  for (const s of seen) assert.deepEqual([s.state, s.shown], ['updating', 'updating'], s.step);
  assert.equal(end.state, 'up');
  assert.equal(end.sha, NEW);
  assert.equal(end.upSince, '2026-11-23T09:00:40.000Z', 'up since the new stack was readied, not since before the update');
  assert.equal(holdOf(readStatus(paths)), null, 'the app is shown once it is up');
});

test('a stack that never readies is down after the wait, never up, and the front keeps it closed', async () => {
  const paths = home();
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T06:00:00Z' }));
  const { io, seen } = fakes(paths, { readyAfter: Infinity });
  const end = await round(paths, io);
  assert.equal(end.state, 'down');
  assert.match(end.reason, /not readied 5 minutes after the launch: none yet/);
  // The new commit waits its full time, then the round goes back to the last good one (#11029), which here never
  // readies either: each waits the full time, and the round ends down.
  assert.equal(seen.filter((s) => s.step === 'readied').length, 2 * (READY_WAIT_MS / 10_000 + 1));
  assert.equal(end.refused.sha, NEW);
  assert.equal(holdOf(readStatus(paths)), 'closed');
});

test('the TEST funds check still decides first: a failed check stops the stack and refuses, whatever readied says', async () => {
  const paths = home();
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T06:00:00Z' }));
  const { io, seen } = fakes(paths, { check: { ok: false, lines: ['FAIL svc-x names https://api.real.xyz'] } });
  const end = await round(paths, io);
  assert.equal(end.state, 'refused');
  assert.ok(seen.some((s) => s.step === 'stop'));
  assert.ok(!seen.some((s) => s.step === 'readied'));
  assert.equal(holdOf(readStatus(paths)), 'closed');
});

test('a launch on a stack that was up and readied (same commit) stays up: no updating page every half hour', async () => {
  const paths = home();
  fs.writeFileSync(
    paths.status,
    JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T08:00:00Z', upSince: '2026-11-23T04:00:00Z' }),
  );
  const { io, seen } = fakes(paths, { target: OLD });
  const end = await round(paths, io);
  for (const s of seen) assert.deepEqual([s.state, s.shown], ['up', 'app'], s.step);
  assert.equal(end.state, 'up');
  assert.equal(end.upSince, '2026-11-23T04:00:00Z');
});

test('a launch that finds the stack not readied (a crash, a stop by hand) reads updating until it is', async () => {
  const paths = home();
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T08:00:00Z' }));
  const { io, seen } = fakes(paths, { target: OLD, warmBefore: false });
  const end = await round(paths, io);
  assert.deepEqual(
    seen.map((s) => s.state),
    ['updating', 'updating', 'updating'],
  );
  assert.equal(end.state, 'up');
});

test('readied: a market that is not a TEST pair has a last price; the TEST pairs alone, blank prices or no answer are not', () => {
  const markets = JSON.stringify([
    { symbol: 'BTC/USDT', test: false },
    { symbol: 'TNEW/USDT', test: true },
  ]);
  assert.equal(readied({ markets, tickers: JSON.stringify({ 'BTC/USDT': { last: '65569.02' } }) }).ok, true);
  assert.equal(readied({ markets, tickers: JSON.stringify({ 'TNEW/USDT': { last: '1.2' } }) }).ok, false);
  assert.equal(readied({ markets, tickers: JSON.stringify({ 'BTC/USDT': { last: null } }) }).ok, false);
  assert.equal(readied({ markets: JSON.stringify([{ symbol: 'TNEW/USDT', test: true }]), tickers: '{}' }).ok, false);
  assert.equal(readied({ markets: null, tickers: null }).ok, false);
  assert.equal(readied({ markets: '<html>', tickers: '{}' }).ok, false);
});

// ── The front during a round ────────────────────────────────────────────────

async function withFront(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-front-'));
  const statusFile = path.join(dir, 'status.json');
  const app = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end('<html><head><title>app</title></head><body>TEST FUNDS</body></html>');
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const front = frontApp({ upstream: app.address().port, statusFile, cacheMs: 0 });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const port = front.address().port;
  const get = (url, accept = 'text/html') =>
    new Promise((resolve, reject) =>
      http
        .get({ host: '127.0.0.1', port, path: url, headers: { host: 'beta.intafaced.com', accept } }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
        })
        .on('error', reject),
    );
  const setState = (state) => fs.writeFileSync(statusFile, JSON.stringify({ state }));
  try {
    await fn({ get, setState, stopApp: () => new Promise((r) => app.close(r)) });
  } finally {
    front.close();
    app.close();
  }
}

test('the front: the app while up (with the watch script), the updating page while updating, the closed page when the app refuses', async () => {
  await withFront(async ({ get, setState, stopApp }) => {
    setState('up');
    let r = await get('/home');
    assert.equal(r.status, 200);
    assert.match(r.body, /<script src="\/__beta\/watch\.js" defer><\/script><\/head>/);
    assert.equal(Number(r.headers['content-length']), Buffer.byteLength(r.body));
    assert.deepEqual(JSON.parse((await get('/__beta/state', '*/*')).body), { hold: null });
    assert.equal((await get('/__beta/watch.js', '*/*')).status, 200);

    setState('updating');
    r = await get('/home');
    assert.equal(r.status, 503);
    assert.match(r.body, /Updating the beta/);
    assert.match(r.headers['content-security-policy'], /default-src 'none'/);
    assert.deepEqual(JSON.parse((await get('/__beta/state', '*/*')).body), { hold: 'updating' }, 'an open tab reloads onto the page');
    assert.equal((await get('/api/v1/tickers', 'application/json')).status, 200, 'calls still reach the old stack while it serves');

    setState('up');
    await stopApp();
    r = await get('/home');
    assert.equal(r.status, 503, 'a refused app is the closed page, never a browser error');
    assert.match(r.body, /The beta is resting/);
    assert.equal((await get('/api/v1/tickers', 'application/json')).status, 502);
  });
});

// ── The front follows main (#10294) ─────────────────────────────────────────

test('the front runs from the beta checkout: a round that changes beta-front.mjs restarts it; a round that does not leaves it running', () => {
  const paths = home();
  const file = path.join(paths.checkout, 'tooling', 'beta', 'beta-front.mjs');
  const calls = [];
  const systemctl = (...args) => (calls.push(args.join(' ')), { status: 0 });

  assert.equal(syncFront(paths, systemctl), 'none', 'no front installed: nothing to do');
  assert.deepEqual(calls, []);

  fs.mkdirSync(path.dirname(paths.frontUnit), { recursive: true });
  fs.writeFileSync(paths.frontUnit, '[Service]\nExecStart=/usr/bin/node /home/x/.intafaced/beta/public/front.mjs\n');
  fs.writeFileSync(file, '// front v1\n');
  assert.equal(syncFront(paths, systemctl), 'install');
  assert.equal(fs.readFileSync(paths.frontUnit, 'utf8'), frontUnitText(paths));
  assert.match(frontUnitText(paths), new RegExp(`WorkingDirectory=${paths.checkout}\\n`));
  assert.match(frontUnitText(paths), /ExecStart=\/bin\/bash -lc 'exec node tooling\/beta\/beta-front\.mjs'/);
  assert.deepEqual(calls.splice(0), ['daemon-reload', 'restart intafaced-beta-front.service']);

  assert.equal(syncFront(paths, systemctl), 'keep');
  assert.deepEqual(calls, []);

  fs.writeFileSync(file, '// front v2\n');
  assert.equal(syncFront(paths, systemctl), 'restart');
  assert.deepEqual(calls.splice(0), ['restart intafaced-beta-front.service']);
  assert.equal(syncFront(paths, systemctl), 'keep');

  // A failed restart is tried again next round.
  fs.writeFileSync(file, '// front v3\n');
  assert.equal(
    syncFront(paths, () => ({ status: 1 })),
    'restart',
  );
  assert.equal(syncFront(paths, systemctl), 'restart');
  assert.equal(frontAction({ unitOnDisk: 'a', unitWanted: 'a', startedOn: 'h', fileHash: null }), 'none');
});

test('the first round with a TEST chain stops the running stack and starts it whole on the chain, behind the updating page (#10305)', async () => {
  const paths = home();
  fs.writeFileSync(
    paths.status,
    JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T08:30:00Z', upSince: '2026-11-23T04:00:00Z' }),
  );
  const { io, seen } = fakes(paths, { head: OLD, target: OLD, chainNew: true });
  const end = await round(paths, io);
  assert.deepEqual(
    seen.map((s) => s.step),
    ['stop', 'stop', 'launch', 'check', 'readied', 'readied'],
  );
  for (const s of seen) assert.deepEqual([s.state, s.shown], ['updating', 'updating'], s.step);
  assert.equal(end.state, 'up');
  assert.notEqual(end.upSince, '2026-11-23T04:00:00Z', 'up since the restart onto the chain');
});

test('a round on a stack already on its chain restarts nothing', async () => {
  const paths = home();
  fs.writeFileSync(
    paths.status,
    JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T08:30:00Z', upSince: '2026-11-23T04:00:00Z' }),
  );
  const { io, seen } = fakes(paths, { head: OLD, target: OLD });
  const end = await round(paths, io);
  assert.ok(!seen.some((s) => s.step === 'stop'));
  assert.equal(end.upSince, '2026-11-23T04:00:00Z');
});

test('the first round wanting the Hyperliquid test network stops the stack on the stand-in venue and starts it whole there, behind the updating page (#10603)', async () => {
  const paths = home();
  fs.rmSync(paths.settings);
  fs.writeFileSync(
    paths.status,
    JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T08:30:00Z', upSince: '2026-11-23T04:00:00Z' }),
  );
  const { io, seen } = fakes(paths, { head: OLD, target: OLD });
  const end = await round(paths, io);
  assert.deepEqual(
    seen.map((s) => s.step),
    ['stop', 'stop', 'launch', 'check', 'readied', 'readied'],
  );
  for (const s of seen) assert.deepEqual([s.state, s.shown], ['updating', 'updating'], s.step);
  assert.equal(end.state, 'up');
  assert.equal(fs.readFileSync(paths.settings, 'utf8'), `${SETTINGS}\n`, 'the launch records the settings it started on');
  // The next round finds the stack on its settings and restarts nothing.
  const again = fakes(paths, { head: OLD, target: OLD });
  await round(paths, again.io);
  assert.ok(!again.seen.some((s) => s.step === 'stop'));
});

test('a launch that fails leaves the settings unrecorded, so the next round restarts onto them again', async () => {
  const paths = home();
  fs.writeFileSync(paths.settings, 'LOCAL_STACK_USER_VENUE=on\n');
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T08:30:00Z' }));
  const { io, seen } = fakes(paths, { head: OLD, target: OLD, launch: 1 });
  const end = await round(paths, io);
  assert.equal(end.state, 'down');
  assert.ok(
    seen.some((s) => s.step === 'stop'),
    'a marker naming another venue restarts the stack',
  );
  assert.equal(fs.readFileSync(paths.settings, 'utf8'), 'LOCAL_STACK_USER_VENUE=on\n');
});

test("a stack on the beta's venue that still lists the journeys' TEST markets is stopped and started whole without them (#10599)", async () => {
  const paths = home();
  // The marker #10603's launch wrote: the venue alone, so svc-trade still runs with the TEST listings on its board.
  fs.writeFileSync(paths.settings, 'LOCAL_STACK_USER_VENUE=hl-testnet\n');
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T08:30:00Z' }));
  const { io, seen } = fakes(paths, { head: OLD, target: OLD });
  const end = await round(paths, io);
  assert.equal(end.state, 'up');
  assert.ok(
    seen.some((s) => s.step === 'stop'),
    'a marker without the TEST markets setting restarts the stack',
  );
  assert.equal(fs.readFileSync(paths.settings, 'utf8'), `${SETTINGS}\n`);
});

test('a stack without TEST valuation prices is stopped and started whole with them so Home and Money show a total (#10632)', async () => {
  const paths = home();
  // The marker #10614's launch wrote: venue and TEST markets off, so svc-ops still returns valuation.prices_unset.
  fs.writeFileSync(paths.settings, 'LOCAL_STACK_USER_VENUE=hl-testnet LOCAL_STACK_TEST_MARKETS=off\n');
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T08:30:00Z' }));
  const { io, seen } = fakes(paths, { head: OLD, target: OLD });
  const end = await round(paths, io);
  assert.equal(end.state, 'up');
  assert.ok(
    seen.some((s) => s.step === 'stop'),
    'a marker without LOCAL_STACK_VALUATION_PRICES=test restarts the stack',
  );
  assert.equal(fs.readFileSync(paths.settings, 'utf8'), `${SETTINGS}\n`);
});

test("a stack on the TEST wallet provider is stopped and started whole on the owner's provider, so a new tester's wallet is made there", async () => {
  const paths = home();
  // The marker the beta wrote before it took the owner's wallet provider.
  fs.writeFileSync(
    paths.settings,
    'LOCAL_STACK_PUBLIC_ORIGIN=https://beta.intafaced.com LOCAL_STACK_USER_VENUE=hl-testnet LOCAL_STACK_TEST_MARKETS=off LOCAL_STACK_VALUATION_PRICES=test\n',
  );
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-25T06:00:00Z' }));
  const { io, seen } = fakes(paths, { head: OLD, target: OLD });
  const end = await round(paths, io);
  assert.equal(end.state, 'up');
  assert.ok(
    seen.some((s) => s.step === 'stop'),
    'a marker without LOCAL_STACK_PROTOCOL_EMBEDDED_WALLET=turnkey restarts the stack',
  );
  assert.equal(fs.readFileSync(paths.settings, 'utf8'), `${SETTINGS}\n`);
});

test('a stack on localhost passkeys is stopped and started whole on the public name, so passkeys work there', async () => {
  const paths = home();
  // The marker the beta wrote before passkeys took its public name.
  fs.writeFileSync(paths.settings, 'LOCAL_STACK_USER_VENUE=hl-testnet LOCAL_STACK_TEST_MARKETS=off LOCAL_STACK_VALUATION_PRICES=test\n');
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T08:30:00Z' }));
  const { io, seen } = fakes(paths, { head: OLD, target: OLD });
  const end = await round(paths, io);
  assert.equal(end.state, 'up');
  assert.ok(
    seen.some((s) => s.step === 'stop'),
    'a marker without LOCAL_STACK_PUBLIC_ORIGIN restarts the stack',
  );
  assert.equal(fs.readFileSync(paths.settings, 'utf8'), `${SETTINGS}\n`);
});

// ── Each merge reaches the beta in the next round ──────────────────────────────

test('a round 30 minutes after the last update still moves to a moved main, and round.log names both commits', async () => {
  const paths = home();
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T08:30:00Z' }));
  const { io, seen } = fakes(paths);
  const end = await round(paths, io);
  assert.ok(
    seen.some((s) => s.step === 'checkout'),
    'the checkout moves',
  );
  assert.equal(end.state, 'up');
  assert.equal(end.sha, NEW);
  assert.equal(end.updatedAt, '2026-11-23T09:00:00.000Z');
  assert.match(fs.readFileSync(paths.log, 'utf8'), /round: update \(checkout aaaaaaaaa, main bbbbbbbbb\)/);
});

// ── While testers are on: a daily slot, on demand, and back to the last good commit (#11029) ──────────────

const THIRD = 'c'.repeat(40);
/** Testers are on: someone invited has opened the TEST mailbox (beta-invited.mjs invited.json). */
const invite = (paths) =>
  fs.writeFileSync(paths.invited, JSON.stringify({ kind: 'intafaced-beta-invited', tokens: { tester1: '2026-11-22T10:00:00Z' } }));
const steps = (seen) => seen.map((s) => s.step);

test('moveDue: nobody invited follows main; with testers, main moves once a day at the slot, or when asked', () => {
  const now = Date.parse('2026-11-23T09:00:00Z');
  assert.equal(BETA_MOVE_AT, '20:00');
  assert.equal(new Date(slotStart(now)).toISOString(), '2026-11-22T20:00:00.000Z');
  assert.equal(new Date(slotStart(Date.parse('2026-11-23T20:00:00Z'))).toISOString(), '2026-11-23T20:00:00.000Z');
  assert.equal(moveDue({ testers: 0, now, updatedAt: '2026-11-23T08:59:00Z' }).due, true);
  assert.match(moveDue({ testers: 0, now, updatedAt: '2026-11-23T08:59:00Z' }).why, /nobody is invited/);
  const held = moveDue({ testers: 2, now, updatedAt: '2026-11-23T06:00:00Z' });
  assert.equal(held.due, false);
  assert.match(held.why, /2 invited testers seen in the last 24 hours: main waits for the daily slot at 20:00 UTC/);
  const stale = moveDue({ testers: 0, invited: 1, now, updatedAt: '2026-11-23T08:59:00Z' });
  assert.equal(stale.due, true, 'invited, but nobody seen in the last 24 hours (#11046)');
  assert.match(stale.why, /with each merge: 1 invited, none seen in the last 24 hours/);
  assert.equal(moveDue({ testers: 2, now, updatedAt: '2026-11-22T19:59:00Z' }).due, true, 'not moved since the last slot');
  assert.match(moveDue({ testers: 2, now, updatedAt: '2026-11-22T19:59:00Z' }).why, /the daily slot/);
  assert.equal(moveDue({ testers: 2, now, updatedAt: '2026-11-23T06:00:00Z', asked: true }).due, true);
  assert.match(moveDue({ testers: 2, now, updatedAt: '2026-11-23T06:00:00Z', asked: true }).why, /on demand/);
  assert.equal(moveDue({ testers: 2, now, updatedAt: '2026-11-23T06:00:00Z', at: '09:00' }).due, true, 'a slot set by BETA_MOVE_AT');
  assert.throws(() => slotStart(now, '25:00'), /BETA_MOVE_AT/);
  assert.equal(decide({ screening: true, head: 'a', target: 'b', due: false }), 'launch');
  assert.equal(decide({ screening: true, head: 'a', target: 'b', refused: 'b' }), 'launch');
  assert.equal(decide({ screening: true, head: 'a', target: 'b', refused: 'c' }), 'update');
});

test('with testers on, a merge between slots does not reach them: the stack stays up on its commit, and status says why', async () => {
  const paths = home();
  invite(paths);
  fs.writeFileSync(
    paths.status,
    JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T06:00:00Z', upSince: '2026-11-23T06:05:00Z' }),
  );
  const { io, seen } = fakes(paths);
  const end = await round(paths, io);
  assert.ok(!steps(seen).includes('checkout'), 'the checkout does not move');
  for (const s of seen) assert.deepEqual([s.state, s.shown], ['up', 'app'], s.step);
  assert.equal(end.state, 'up');
  assert.equal(end.sha, OLD);
  assert.equal(end.mainAt, NEW);
  assert.equal(end.upSince, '2026-11-23T06:05:00Z', 'no restart, so no tab reloads');
  assert.match(end.why, /1 invited tester seen in the last 24 hours: main waits for the daily slot at 20:00 UTC/);
  assert.match(
    statusLine(readStatus(paths)),
    /^up: serves aaaaaaaaa; main is at bbbbbbbbb; 1 invited tester seen in the last 24 hours: main waits/,
  );
});

test('a viewer last seen 25 hours ago holds nothing: the beta moves with the merge (#11046)', async () => {
  const paths = home();
  fs.writeFileSync(paths.invited, JSON.stringify({ kind: 'intafaced-beta-invited', tokens: { tester1: '2026-11-22T08:00:00Z' } }));
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T06:00:00Z' }));
  const { io, seen } = fakes(paths);
  const end = await round(paths, io);
  assert.ok(steps(seen).includes('checkout'), 'the checkout moves to main');
  assert.equal(end.sha, NEW);
  assert.match(end.why, /moved to main bbbbbbbbb with each merge: 1 invited, none seen in the last 24 hours/);
});

test('with testers on, the first round after the daily slot moves to main', async () => {
  const paths = home();
  invite(paths);
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-22T08:00:00Z' }));
  const { io, seen } = fakes(paths);
  const end = await round(paths, io);
  assert.ok(steps(seen).includes('checkout'));
  assert.equal(end.state, 'up');
  assert.equal(end.sha, NEW);
  assert.match(end.why, /moved to main bbbbbbbbb at the daily slot/);
});

test('on demand: `beta-host.mjs move` moves to main at the next round, between slots, once', async () => {
  const paths = home();
  invite(paths);
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T06:00:00Z' }));
  askMove(paths, new Date('2026-11-23T08:58:00Z'));
  assert.ok(fs.existsSync(paths.moveNow));
  const { io, seen } = fakes(paths);
  const end = await round(paths, io);
  assert.ok(steps(seen).includes('checkout'));
  assert.equal(end.sha, NEW);
  assert.match(end.why, /on demand/);
  assert.equal(fs.existsSync(paths.moveNow), false, 'the ask is used once');
  // The next merge waits for the slot again.
  const again = await round(paths, fakes(paths, { head: NEW, target: THIRD }).io);
  assert.equal(again.sha, NEW);
  assert.match(again.why, /waits for the daily slot/);
});

test('a moved commit that fails its check goes back to the last good commit, which it refuses until main moves past it', async () => {
  const paths = home();
  invite(paths);
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-22T08:00:00Z' }));
  const bad = { ok: false, lines: ['FAIL svc-x names https://api.real.xyz'] };
  const { io, seen } = fakes(paths, { checkFor: (sha) => (sha === NEW ? bad : PASS) });
  const end = await round(paths, io);
  assert.deepEqual(steps(seen).slice(0, 4), ['checkout', 'install', 'launch', 'check'], 'the new commit is tried first');
  assert.ok(steps(seen).slice(4).includes('stop'), 'the failed stack is stopped');
  const back = steps(seen).slice(steps(seen).lastIndexOf('checkout'));
  assert.deepEqual(back.slice(0, 4), ['checkout', 'install', 'launch', 'check'], 'then the last good one is started');
  assert.equal(back.at(-1), 'readied');
  for (const s of seen) assert.equal(s.shown, 'updating', `${s.step}: testers see the updating page, never the failed build`);
  assert.equal(end.state, 'up');
  assert.equal(end.sha, OLD);
  assert.equal(end.refused.sha, NEW);
  assert.match(end.refused.reason, /the TEST funds check failed/);
  assert.match(end.why, /back on the last good commit aaaaaaaaa: main bbbbbbbbb failed its check/);
  // Main has not moved: the refused commit is not tried again, even on demand or at the slot.
  askMove(paths);
  const held = await round(paths, fakes(paths, { head: OLD, target: NEW }).io);
  assert.equal(held.sha, OLD);
  assert.equal(held.refused.sha, NEW);
  assert.match(held.why, /main bbbbbbbbb is refused/);
  // Main moves past it: the next due move tries the new main.
  askMove(paths);
  const past = await round(paths, fakes(paths, { head: OLD, target: THIRD }).io);
  assert.equal(past.sha, THIRD);
  assert.equal(past.state, 'up');
  assert.equal(past.refused ?? null, null, 'forgotten once main moved past it');
});

test('a moved commit whose launch fails goes back too; a good commit that fails the same way, or none known, is down', async () => {
  const paths = home();
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T06:00:00Z' }));
  const { io } = fakes(paths, { launch: 1 });
  const end = await round(paths, io);
  assert.equal(end.state, 'down', 'the good commit fails the same way here, so it stays down');
  assert.equal(end.refused.sha, NEW);
  const fresh = home();
  const first = await round(fresh, fakes(fresh, { launch: 1 }).io);
  assert.equal(first.state, 'down');
  assert.equal(first.sha, NEW, 'no last good commit: nothing to go back to');
});

test('`beta-host.mjs back`: the beta goes back to the named commit behind the updating page and is held there until main moves past the main of the ask (#11065)', async () => {
  const paths = home();
  // NEW came up and broke testers; main is still on it.
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: NEW, updatedAt: '2026-11-23T06:00:00Z' }));
  fs.writeFileSync(paths.served, JSON.stringify({ good: NEW, refused: null }));
  askBack(paths, { sha: OLD, bad: NEW });
  const { io, seen } = fakes(paths, { head: NEW, target: NEW });
  const end = await round(paths, io);
  assert.deepEqual(steps(seen).slice(0, 4), ['checkout', 'install', 'launch', 'check'], 'it moves, though main has not');
  for (const s of seen) assert.equal(s.shown, 'updating', `${s.step}: testers see the updating page until the commit is readied`);
  assert.equal(end.state, 'up');
  assert.equal(end.sha, OLD);
  assert.equal(end.mainAt, NEW);
  assert.deepEqual({ sha: end.held.sha, bad: end.held.bad, mainAt: end.held.mainAt }, { sha: OLD, bad: NEW, mainAt: NEW });
  assert.match(end.why, /held on aaaaaaaaa \(beta-host\.mjs back\): bbbbbbbbb broke testers; main waits until it moves past bbbbbbbbb/);
  assert.match(statusLine(readStatus(paths)), /^up: serves aaaaaaaaa; main is at bbbbbbbbb; held on aaaaaaaaa/);
  assert.equal(fs.existsSync(paths.backTo), false, 'the ask is used once');
  // Main has not moved: every round keeps the held commit, though nobody is invited (which would follow each merge).
  const again = await round(paths, fakes(paths, { head: OLD, target: NEW }).io);
  assert.equal(again.sha, OLD);
  assert.equal(again.held.sha, OLD);
  assert.match(again.why, /held on aaaaaaaaa/);
  // Main moves past it: the hold ends and the beta follows main again.
  const past = await round(paths, fakes(paths, { head: OLD, target: THIRD }).io);
  assert.equal(past.sha, THIRD);
  assert.equal(past.state, 'up');
  assert.equal(past.held ?? null, null);
  assert.equal(JSON.parse(fs.readFileSync(paths.served, 'utf8')).held, undefined, 'forgotten once main moved past it');
  assert.match(fs.readFileSync(paths.log, 'utf8'), /back: main moved past bbbbbbbbb to ccccccccc, so the hold on aaaaaaaaa ends/);
});

test('a hold ends on demand (`beta-host.mjs move`); a held commit that fails is down, never sent back to the commit that broke testers', async () => {
  const paths = home();
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: NEW, updatedAt: '2026-11-23T06:00:00Z' }));
  askBack(paths, { sha: OLD, bad: NEW });
  await round(paths, fakes(paths, { head: NEW, target: NEW }).io);
  askMove(paths);
  const moved = await round(paths, fakes(paths, { head: OLD, target: NEW }).io);
  assert.equal(moved.sha, NEW);
  assert.equal(moved.held ?? null, null);
  assert.match(moved.why, /on demand/);

  const failing = home();
  fs.writeFileSync(failing.status, JSON.stringify({ state: 'up', sha: NEW, updatedAt: '2026-11-23T06:00:00Z' }));
  fs.writeFileSync(failing.served, JSON.stringify({ good: NEW, refused: null }));
  askBack(failing, { sha: OLD, bad: NEW });
  const { io, seen } = fakes(failing, { head: NEW, target: NEW, launch: 1 });
  const down = await round(failing, io);
  assert.equal(down.state, 'down');
  assert.equal(down.sha, OLD);
  assert.equal(steps(seen).filter((s) => s === 'checkout').length, 1, 'no go-back onto the bad commit');
  assert.equal(down.held.sha, OLD, 'the hold stands, so the next round tries the named commit again');
});

test('`beta-host.mjs back` takes only a commit on main, other than the one served, and defaults to the one before it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-back-'));
  const paths = betaPaths(home);
  const g = (...args) => {
    const r = spawnSync('git', ['-C', paths.checkout, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  fs.mkdirSync(paths.checkout, { recursive: true });
  g('init', '--quiet');
  const commit = (m) => (
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', m),
    g('rev-parse', 'HEAD')
  );
  const first = commit('first');
  const second = commit('second');
  g('update-ref', 'refs/remotes/origin/main', second);
  g('switch', '--quiet', '-c', 'side');
  const side = commit('side');
  const cli = (...args) =>
    spawnSync(process.execPath, [path.join(import.meta.dirname, 'beta-host.mjs'), 'back', ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: second }));
  const off = cli(side);
  assert.equal(off.status, 1);
  assert.match(off.stderr, /is not on main/);
  assert.match(cli(second).stderr, /already serves/);
  assert.match(cli('nope').stderr, /nope is not a commit/);
  assert.equal(fs.existsSync(paths.backTo), false, 'a refused ask asks nothing');
  const ok = cli();
  assert.equal(ok.status, 0, ok.stderr);
  const ask = JSON.parse(fs.readFileSync(paths.backTo, 'utf8'));
  assert.deepEqual({ sha: ask.sha, bad: ask.bad }, { sha: first, bad: second });
});
