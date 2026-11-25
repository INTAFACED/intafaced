// A round's logic, driven with fakes (#10299, #10294): the tester sees the old stack or the updating page until the new
// stack passes its checks and is readied, and the status file reads `updating` all that time.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { READY_WAIT_MS, betaPaths, closedIssues, frontAction, frontUnitText, readied, round, syncFront } from './beta-host.mjs';
import { frontApp, holdOf } from './beta-front.mjs';

const OLD = 'a'.repeat(40);
/** The marker a launch on the beta's own settings writes (BETA_STACK_SETTINGS). */
const SETTINGS =
  'LOCAL_STACK_PASSKEY_ORIGIN=https://beta.intafaced.com LOCAL_STACK_USER_VENUE=hl-testnet LOCAL_STACK_TEST_MARKETS=off LOCAL_STACK_VALUATION_PRICES=test';
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
  {
    head = OLD,
    target = NEW,
    check = PASS,
    launch = 0,
    readyAfter = 0,
    warmBefore = true,
    chainNew = false,
    commits = [],
    issues = {},
  } = {},
) {
  let clock = Date.parse('2026-11-23T09:00:00Z');
  let calls = 0;
  const seen = [];
  const look = (step) => {
    const s = fs.existsSync(paths.status) ? readStatus(paths) : null;
    seen.push({ step, state: s?.state ?? null, shown: holdOf(s) ?? 'app' });
  };
  const io = {
    git: (_cwd, ...args) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${args[1] === 'HEAD' ? head : target}\n`, stderr: '' };
      if (args[0] === 'checkout') look('checkout');
      if (args[0] === 'log') return { status: 0, stdout: commits.map(([sha, msg]) => `${sha}\x00${msg}\x1e\n`).join(''), stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    run: async (_p, cmd, args) => {
      look(cmd === 'pnpm' ? 'install' : args.includes('launch') ? 'launch' : 'stop');
      return args.includes('launch') ? launch : 0;
    },
    anvil: () => ({ line: 'anvil: fake', fresh: chainNew }),
    check: async () => (look('check'), check),
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
    issue: async (n) => issues[n] ?? null,
  };
  return { io, seen };
}

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
  assert.equal(seen.filter((s) => s.step === 'readied').length, READY_WAIT_MS / 10_000 + 1);
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
    'a marker without LOCAL_STACK_PASSKEY_ORIGIN restarts the stack',
  );
  assert.equal(fs.readFileSync(paths.settings, 'utf8'), `${SETTINGS}\n`);
});

// ── A beta fix reaches the beta in the next round (#10612) ──────────────────

const FIX = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const BETA_ISSUE = { closed: true, pull: false, labels: ['bug', 'beta'] };
const PLAIN_ISSUE = { closed: true, pull: false, labels: ['bug'] };
const roundLog = (paths) => fs.readFileSync(paths.log, 'utf8');

test('within the 2-hour bound, main holding a merge that closed a beta issue moves the beta now, and round.log names both', async () => {
  const paths = home();
  // Updated 30 minutes ago: without the fix this round would only launch.
  fs.writeFileSync(paths.status, JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T08:30:00Z' }));
  const { io, seen } = fakes(paths, {
    commits: [
      [OTHER, 'fix(contracts): something else (#10606)\n\nCloses #10604.'],
      [FIX, 'fix(beta): the trade desks run on the test network (#10610)\n\nCloses #10603'],
    ],
    issues: { 10604: PLAIN_ISSUE, 10603: BETA_ISSUE },
  });
  const end = await round(paths, io);
  assert.ok(
    seen.some((s) => s.step === 'checkout'),
    'the checkout moves',
  );
  assert.equal(end.state, 'up');
  assert.equal(end.sha, NEW);
  assert.equal(end.updatedAt, '2026-11-23T09:00:00.000Z', 'the 2-hour bound counts again from this update');
  assert.match(
    roundLog(paths),
    new RegExp(`round: update \\(checkout aaaaaaaaa, main bbbbbbbbb; main holds ${FIX.slice(0, 9)}, which closed beta issue #10603\\)`),
  );
});

test('within the bound, merges that closed no beta issue (or an open or unreadable one) keep the beta where it is until the bound', async () => {
  const paths = home();
  fs.writeFileSync(
    paths.status,
    JSON.stringify({ state: 'up', sha: OLD, updatedAt: '2026-11-23T08:30:00Z', upSince: '2026-11-23T04:00:00Z' }),
  );
  const { io, seen } = fakes(paths, {
    commits: [
      [OTHER, 'fix(contracts): something else (#10606)\n\nCloses #10604.'],
      [FIX, 'fix(beta): refers to #10603 without closing it; Fixes #10611; Resolves #10613'],
    ],
    issues: { 10604: PLAIN_ISSUE, 10603: BETA_ISSUE, 10611: { closed: false, pull: false, labels: ['beta'] } },
  });
  const end = await round(paths, io);
  assert.ok(!seen.some((s) => s.step === 'checkout'), 'the checkout stays');
  assert.equal(end.sha, OLD);
  assert.equal(end.updatedAt, '2026-11-23T08:30:00Z');
  assert.match(roundLog(paths), /round: launch \(checkout aaaaaaaaa, main bbbbbbbbb; the next update is after 2026-11-23T10:30:00\.000Z\)/);
});

test('closedIssues reads GitHub closing words, once each', () => {
  assert.deepEqual(closedIssues('Closes #10603'), [10603]);
  assert.deepEqual(closedIssues('Fixes #10300. Also fixed #1 and resolves: #2; closes #10300'), [10300, 1, 2]);
  assert.deepEqual(closedIssues('refers to #5 (#10610); prefixes #6'), []);
});
