import assert from 'node:assert/strict';
import { userVenueKind } from '../scripts/local-test-venue.mjs';
import opsService from '../scripts/local-stack-services/ops.mjs';
import tradeService from '../scripts/local-stack-services/trade.mjs';
import { GRANT } from './beta-invited.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ANVIL_IMAGE,
  BETA_CUSTODY,
  BETA_LINK,
  BETA_OWN_HOSTS,
  BETA_SLOT,
  MAILBOX_PORT,
  anvilLauncher,
  betaPaths,
  decide,
  ensureAnvil,
  environEntries,
  fundsCheck,
  listeningSockets,
  procHost,
  readListeners,
  HOSTED_TEST_NETWORK_HOSTS,
  hostedAllowList,
  mailboxPage,
  mailboxRows,
  outsideAddresses,
  reservedHost,
  selfRestart,
  stackEnv,
  stopCommands,
  unitText,
} from './beta-host.mjs';
import { stopDecision } from '../scripts/verify-app.mjs';
import { slotPorts } from '../scripts/local-test-facts.mjs';
import { MARKET_INTERVAL_ENV, staleAfterMs, startArgs } from '../scripts/local-test-market.mjs';
import { STACK_CODE_REACH_ENV, nodeServiceReach } from '../scripts/service-reach.mjs';
import { pgDurable, pgServerFlags } from '../scripts/local-test-db-state.mjs';

const environ = (obj) =>
  Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join('\0') + '\0';
const PAGE = '<body><div id="local-test-stack-banner">LOCAL TEST STACK — TEST PRICES · TEST FUNDS · not real money</div>';

test('the link is the Customer port of the beta slot, as localhost, and the mailbox port is free on that slot', () => {
  const ports = slotPorts(BETA_SLOT);
  assert.equal(BETA_LINK, `http://localhost:${ports.stack.customer}/`);
  const used = Object.values(ports).flatMap((group) => Object.values(group));
  assert.ok(!used.includes(MAILBOX_PORT), `mailbox port ${MAILBOX_PORT} collides with a slot ${BETA_SLOT} port`);
});

test('every stack command of the beta runs on its own slot and state folder', () => {
  const paths = betaPaths('/home/x');
  assert.deepEqual(
    { slot: stackEnv(paths, { A: '1' }).LOCAL_STACK_SLOT, state: stackEnv(paths, {}).LOCAL_STACK_STATE, a: stackEnv(paths, { A: '1' }).A },
    { slot: String(BETA_SLOT), state: '/home/x/.intafaced/beta/state', a: '1' },
  );
  assert.equal(paths.screening, '/home/x/.intafaced/beta/state/screening.local.json');
});

test('the beta, which no journey runs on, records no code reach and quotes its TEST market and captures its lake every five minutes', () => {
  const env = stackEnv(betaPaths('/home/x'), {});
  assert.equal(env[STACK_CODE_REACH_ENV], 'off');
  assert.equal(env[MARKET_INTERVAL_ENV], '300');
  assert.equal(env.LOCAL_STACK_QUANT_LAKE_CAPTURE_SECONDS, '300');
  assert.deepEqual(nodeServiceReach('/home/x/code', 'bank', { A: '1' }, env), { flags: [], env: { A: '1' } });
  assert.deepEqual(startArgs([], env), ['--interval', '300']);
  assert.ok(staleAfterMs(startArgs([], env)) > 300_000, 'a quiet log between two beta cycles is not STALE');
});

test('the beta keeps its database through a box restart: durable writes and no throwaway flags (#10352)', () => {
  const env = stackEnv(betaPaths('/home/x'), {});
  assert.equal(pgDurable(env), true);
  assert.equal(pgServerFlags(env), '');
  assert.equal(pgDurable({}), false, 'a journeys stack keeps the throwaway server');
  assert.match(pgServerFlags({}), /fsync=off/);
});

test('outsideAddresses: loopback passes, any other host is named by key and host, never by value', () => {
  const found = outsideAddresses(
    environEntries(
      environ({
        LEDGER_URL: 'http://127.0.0.1:17501',
        DATABASE_URL: 'postgres://svc@127.0.0.1:18460/db',
        NATS_URL: 'nats://localhost:17232',
        V6: 'http://[::1]:9',
        CHAIN_RPC: 'https://svc@rpc.mainnet-node.io/v1?key=KEYVALUE',
        LIST: 'http://127.0.0.1:1,https://api.venue-live.net:443/x',
        PLAIN: 'not a url',
      }),
    ),
  );
  assert.deepEqual(found, [
    { key: 'CHAIN_RPC', scheme: 'https', host: 'rpc.mainnet-node.io' },
    { key: 'LIST', scheme: 'https', host: 'api.venue-live.net' },
  ]);
  assert.ok(!JSON.stringify(found).includes('KEYVALUE'), 'a credential in the value is never returned');
});

test('fundsCheck passes a stack whose every route stays on this machine and whose page carries the TEST banner', () => {
  const envs = { 11: environ({ EDGE_URL: 'http://127.0.0.1:17500' }), 12: environ({ X: 'nats://127.0.0.1:1' }) };
  const r = fundsCheck({
    records: { edge: { pid: 11 }, ledger: { pid: 12 }, gone: { pid: 13 } },
    readEnviron: (pid) => envs[pid] ?? null,
    page: PAGE,
  });
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /2 of 2 running processes/);
});

test('fundsCheck fails on a route off the machine, naming the process, key and host', () => {
  const r = fundsCheck({
    records: { pay: { pid: 21 } },
    readEnviron: () => environ({ RAIL_URL: 'https://rail.bank-live.com/api', SECRET: 'zzz' }),
    page: PAGE,
  });
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes('FAIL pay (pid 21): RAIL_URL names https://rail.bank-live.com, off this machine'), r.lines.join('\n'));
  assert.ok(!r.lines.join('\n').includes('zzz'));
});

test("the beta's own round passes the stack's TEST official-channel list, which names the beta's help centre, and nothing else off the machine", () => {
  // The value the stack gives svc-support (tooling/profiles/test-owner-values/support.json): with NO_HOSTS the beta
  // refused it and stopped the stack on 23 Nov 2026 (#10305).
  const profile = JSON.parse(fs.readFileSync(new URL('../profiles/test-owner-values/support.json', import.meta.url), 'utf8'));
  const channels = profile.values.SUPPORT_OFFICIAL_CHANNELS.value;
  assert.deepEqual([...BETA_OWN_HOSTS], ['beta.intafaced.com']);
  const records = { support: { pid: 41 } };
  const support = { SUPPORT_OFFICIAL_CHANNELS: channels, EDGE_URL: 'http://127.0.0.1:17500' };
  const before = fundsCheck({ records, readEnviron: () => environ(support), page: PAGE });
  assert.equal(before.ok, false, 'without the allow the beta host is off the machine');
  const pass = fundsCheck({ records, readEnviron: () => environ(support), page: PAGE, allow: BETA_OWN_HOSTS });
  assert.equal(pass.ok, true, pass.lines.join('\n'));
  for (const off of [
    'https://intafaced.com/help',
    'https://evil.intafaced.com/x',
    'https://beta.intafaced.com.evil.xyz/',
    'https://api.hyperliquid-testnet.xyz',
  ]) {
    const r = fundsCheck({ records, readEnviron: () => environ({ ...support, OTHER_URL: off }), page: PAGE, allow: BETA_OWN_HOSTS });
    assert.equal(r.ok, false, off);
  }
});

test("the beta's stack runs the custody layer off, as launch does, and its check fails any process that runs it otherwise (#11019)", async () => {
  // The beta's settings start every carrier off together (local-test-state.mjs startCustodyLayer), and win over a shell.
  assert.equal(BETA_CUSTODY, 'off');
  assert.equal(stackEnv(betaPaths('/home/x'), {}).LOCAL_STACK_CUSTODY_LAYER, 'off');
  assert.equal(stackEnv(betaPaths('/home/x'), { LOCAL_STACK_CUSTODY_LAYER: 'on' }).LOCAL_STACK_CUSTODY_LAYER, 'off');
  const { startCustodyLayer } = await import('../scripts/local-test-state.mjs');
  assert.equal(startCustodyLayer(stackEnv(betaPaths('/home/x'), {})), 'off');
  const ok = () => environ({ A: 'http://127.0.0.1:1' });
  const off = {
    ledger: { pid: 1, custodyLayer: 'off' },
    bank: { pid: 2, custodyLayer: 'off' },
    trade: { pid: 3, custodyLayer: 'off' },
    edge: { pid: 4 },
  };
  const pass = fundsCheck({ records: off, readEnviron: ok, page: PAGE, custody: BETA_CUSTODY });
  assert.equal(pass.ok, true, pass.lines.join('\n'));
  assert.ok(pass.lines.includes('ok   ledger, bank, trade: LEDGER_CUSTODY_LAYER off, as launch runs it'), pass.lines.join('\n'));
  // The beta as it ran before #11019: every carrier on.
  const on = Object.fromEntries(Object.entries(off).map(([k, v]) => [k, v.custodyLayer ? { ...v, custodyLayer: 'on' } : v]));
  const before = fundsCheck({ records: on, readEnviron: ok, page: PAGE, custody: BETA_CUSTODY });
  assert.equal(before.ok, false);
  assert.ok(before.lines.includes('FAIL trade (pid 3): runs LEDGER_CUSTODY_LAYER on, not off as launch does'), before.lines.join('\n'));
  // One carrier left on, a ledger with no recorded switch (read as on), or no ledger at all: each a finding.
  assert.equal(
    fundsCheck({ records: { ...off, trade: { pid: 3, custodyLayer: 'on' } }, readEnviron: ok, page: PAGE, custody: 'off' }).ok,
    false,
  );
  const unrecorded = fundsCheck({ records: { ...off, ledger: { pid: 1 } }, readEnviron: ok, page: PAGE, custody: 'off' });
  assert.ok(unrecorded.lines.includes('FAIL ledger (pid 1): runs LEDGER_CUSTODY_LAYER unrecorded (on), not off as launch does'));
  const { ledger: _ledger, ...noLedger } = off;
  assert.equal(fundsCheck({ records: noLedger, readEnviron: ok, page: PAGE, custody: 'off' }).ok, false);
  // Another stack's check (`check --state`) asks for no switch: its custody is its own.
  assert.equal(fundsCheck({ records: on, readEnviron: ok, page: PAGE }).ok, true);
});

test('fundsCheck fails closed: no process, no readable process, no page, or a page with no TEST banner', () => {
  const ok = () => environ({ A: 'http://127.0.0.1:1' });
  assert.equal(fundsCheck({ records: {}, readEnviron: ok, page: PAGE }).ok, false);
  assert.equal(fundsCheck({ records: { a: { pid: 1 } }, readEnviron: () => null, page: PAGE }).ok, false);
  assert.equal(fundsCheck({ records: { a: { pid: 1 } }, readEnviron: ok, page: null }).ok, false);
  const noBanner = fundsCheck({ records: { a: { pid: 1 } }, readEnviron: ok, page: '<body>app</body>' });
  assert.equal(noBanner.ok, false);
  assert.match(noBanner.lines[0], /lacks the TEST banner/);
});

test('procHost and listeningSockets read the kernel tables: only LISTEN rows, every address family', () => {
  assert.equal(procHost('00000000'), '0.0.0.0');
  assert.equal(procHost('0100007F'), '127.0.0.1');
  assert.equal(procHost('00000000000000000000000000000000'), '::');
  assert.equal(procHost('00000000000000000000000001000000'), '::1');
  assert.equal(procHost('0000000000000000FFFF00000100007F'), '::ffff:127.0.0.1');
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000:446F 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0 100 0 0 10 0',
    '   1: 0100007F:4470 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1 0 100 0 0 10 0',
    '   2: 0100007F:4470 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0 20 4 30 10 -1',
  ].join('\n');
  assert.deepEqual(listeningSockets(table), [
    { inode: '111', host: '0.0.0.0', port: 17519 },
    { inode: '222', host: '127.0.0.1', port: 17520 },
  ]);
});

test('fundsCheck fails a listener on every interface, naming the process, host and port; loopback passes (#10244)', () => {
  const ok = () => environ({ A: 'http://127.0.0.1:1' });
  const check = (listeners) => fundsCheck({ records: { fix: { pid: 31 } }, readEnviron: ok, readListeners: () => listeners, page: PAGE });
  for (const host of ['0.0.0.0', '::', '192.168.1.20']) {
    const r = check([
      { host: '127.0.0.1', port: 17526 },
      { host, port: 17527 },
    ]);
    assert.equal(r.ok, false, host);
    assert.ok(r.lines.includes(`FAIL fix (pid 31): listens on ${host} port 17527, reachable off this machine`), r.lines.join('\n'));
  }
  assert.equal(
    check([
      { host: '127.0.0.1', port: 17526 },
      { host: '::1', port: 17527 },
      { host: '::ffff:127.0.0.1', port: 17528 },
    ]).ok,
    true,
  );
});

test(
  'the real check fails a planted all-interfaces listener in a live process and passes it on loopback (#10244)',
  { skip: process.platform !== 'linux' && 'reads /proc' },
  async () => {
    const net = await import('node:net');
    const listenOn = (host) =>
      new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, host, () => resolve(s));
      });
    const run = () => fundsCheck({ records: { planted: { pid: process.pid } }, readEnviron: () => environ({}), readListeners, page: PAGE });
    const wild = await listenOn('0.0.0.0');
    try {
      const r = run();
      assert.equal(r.ok, false);
      assert.ok(
        r.lines.includes(`FAIL planted (pid ${process.pid}): listens on 0.0.0.0 port ${wild.address().port}, reachable off this machine`),
        r.lines.join('\n'),
      );
    } finally {
      await new Promise((resolve) => wild.close(resolve));
    }
    const local = await listenOn('127.0.0.1');
    try {
      assert.equal(run().ok, true, run().lines.join('\n'));
    } finally {
      await new Promise((resolve) => local.close(resolve));
    }
  },
);
test('hosted allow list (#10208): the test networks and the beta host pass; a planted mainnet or bank host fails', () => {
  const allow = hostedAllowList('Beta.Example-Host.com');
  assert.deepEqual([...allow].sort(), [...HOSTED_TEST_NETWORK_HOSTS, 'beta.example-host.com'].sort());
  const records = { trade: { pid: 31 } };
  const hosted = {
    TRADE_USER_VENUE_URL: 'https://api.hyperliquid-testnet.xyz',
    PAY_CRYPTO_RPC_URL: 'https://sepolia.base.org',
    PUBLIC_URL: 'https://beta.example-host.com/app',
    EDGE_URL: 'http://127.0.0.1:17500',
  };
  const pass = fundsCheck({ records, readEnviron: () => environ(hosted), page: PAGE, allow });
  assert.equal(pass.ok, true, pass.lines.join('\n'));
  assert.match(
    pass.lines.join('\n'),
    /1 of 1 running processes: every address in their environments is this machine, a reserved name or the hosted allow list/,
  );

  // Without the allow list, the same hosted environment is three findings: the loopback check is unchanged.
  assert.equal(fundsCheck({ records, readEnviron: () => environ(hosted), page: PAGE }).ok, false);

  for (const [key, url, host] of [
    ['TRADE_USER_VENUE_URL', 'https://api.hyperliquid.xyz', 'api.hyperliquid.xyz'],
    ['PAY_CRYPTO_RPC_URL', 'https://mainnet.base.org', 'mainnet.base.org'],
    ['BANK_RAIL_URL', 'https://api.bank-live.com/v1', 'api.bank-live.com'],
    ['PAY_CRYPTO_RPC_URL', 'https://sepolia.base.org.attacker.net', 'sepolia.base.org.attacker.net'],
    ['TRADE_USER_VENUE_URL', 'wss://ws.api.hyperliquid-testnet.xyz', 'ws.api.hyperliquid-testnet.xyz'],
  ]) {
    const r = fundsCheck({ records, readEnviron: () => environ({ ...hosted, [key]: url }), page: PAGE, allow });
    assert.equal(r.ok, false, `${url} must fail`);
    assert.ok(
      r.lines.includes(`FAIL trade (pid 31): ${key} names ${url.split(':')[0]}://${host}, off this machine and the hosted allow list`),
      r.lines.join('\n'),
    );
  }
});

test('hosted allow list (#10208): the beta host is one plain DNS name, else it throws and nothing runs open', () => {
  for (const bad of [
    undefined,
    '',
    'localhost',
    '*.example.com',
    'https://beta.example.com',
    'beta.example.com:443',
    'beta.example.com/x',
    'a b.com',
  ])
    assert.throws(() => hostedAllowList(bad), /one plain DNS name/, String(bad));
});

test('decide: no screening file builds nothing; a moved main updates; the same commit only launches', () => {
  assert.equal(decide({ screening: false, head: 'a', target: 'b' }), 'blocked');
  assert.equal(decide({ screening: true, head: 'a', target: 'b' }), 'update');
  assert.equal(decide({ screening: true, head: 'a', target: 'a' }), 'launch');
});

test('decide: every round moves to a moved main; the same commit only launches', () => {
  assert.equal(decide({ screening: true, head: 'a', target: 'b' }), 'update');
  assert.equal(decide({ screening: true, head: 'a', target: 'a' }), 'launch');
  assert.equal(decide({ screening: false, head: 'a', target: 'b' }), 'blocked');
});

test('the page names the commit served, and the newer main it waits for', () => {
  const html = mailboxPage([], { status: { state: 'up', sha: 'aaaaaaaaa111', mainAt: 'bbbbbbbbb222' } });
  assert.match(html, /Beta: up on main aaaaaaaaa \(main is at bbbbbbbbb; the beta moves to it in its next round\)/);
  assert.doesNotMatch(mailboxPage([], { status: { state: 'up', sha: 'aaaaaaaaa111', mainAt: 'aaaaaaaaa111' } }), /main is at/);
});

test("the beta's stop stops the stack it runs even when the latest verify launch found it already up", () => {
  const paths = betaPaths('/home/x');
  // Every round after the first runs verify launch on a running stack: its record says it did not start it.
  const launch = { startedByUs: false, stack: 's1' };
  const gated = (args) =>
    args.includes('verify') && stopDecision({ claim: { slot: BETA_SLOT, live: true }, launch, stack: 's1' }) !== 'stop';
  const cmds = stopCommands(paths);
  assert.ok(cmds.length > 0);
  for (const args of cmds) assert.ok(!gated(args), `${args.join(' ')} goes through verify stop, which leaves this stack running`);
  assert.deepEqual(cmds.at(-1), ['/home/x/.intafaced/beta/checkout/tooling/scripts/local-test-stack.mjs', 'stop']);
});

test('mailboxRows: the last day, newest first, codes and links read from the outbox lines', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  const text = [
    'LOCAL-TEST purpose=signup-code email=old@local-test.invalid expires=2026-11-20T10:00:00.000Z code=111111',
    'LOCAL-TEST purpose=signup-code email=a@local-test.invalid expires=2026-11-22T11:10:00.000Z code=222222',
    'something else',
    'LOCAL-TEST purpose=email-confirm email=a@local-test.invalid expires=2026-11-22T13:00:00.000Z link=confirm-email?token=abc',
  ].join('\n');
  const rows = mailboxRows(text, { now });
  assert.deepEqual(
    rows.map((r) => [r.purpose, r.email, r.code, r.link]),
    [
      ['email-confirm', 'a@local-test.invalid', null, 'confirm-email?token=abc'],
      ['signup-code', 'a@local-test.invalid', '222222', null],
    ],
  );
  const page = mailboxPage(rows);
  assert.match(page, /TEST MAILBOX/);
  assert.match(page, /222222/);
  assert.ok(page.includes(`href="${BETA_LINK}confirm-email?token=abc"`), 'a mailed link opens on the beta app');
  assert.match(mailboxPage([]), /No mail yet/);
  assert.ok(!mailboxPage([{ purpose: '<script>', email: 'x', code: '1' }]).includes('<script>'), 'escaped');
});

test('the service keeps the supervisor running from the beta checkout and leaves the stack up across its restarts', () => {
  const unit = unitText(betaPaths('/home/x'));
  assert.match(unit, /WorkingDirectory=\/home\/x\/\.intafaced\/beta\/checkout/);
  assert.match(unit, /ExecStart=\/bin\/bash -lc 'exec node tooling\/beta\/beta-host\.mjs serve'/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /KillMode=process/);
});

test('a new copy of the supervisor starts at once, so the TEST mailbox is never down for the restart delay (#10888)', () => {
  // Exiting left systemd's RestartSec=60 between the old copy and the new one: the mailbox (MAILBOX_PORT) refused
  // every tester waiting for a sign-up code for that minute. Under its own unit, the supervisor asks systemd to
  // restart it now; run by hand, it exits as before.
  const calls = [];
  const systemctl =
    (pid) =>
    (...args) => {
      calls.push(args);
      if (args[0] === 'show') return { status: 0, stdout: `MainPID=${pid}\n` };
      return { status: 0, stdout: '' };
    };
  assert.equal(selfRestart({ pid: 4242, systemctl: systemctl(4242) }), 'restart');
  assert.deepEqual(calls.at(-1), ['restart', '--no-block', 'intafaced-beta.service']);

  calls.length = 0;
  assert.equal(selfRestart({ pid: 4242, systemctl: systemctl(999) }), 'exit', 'run by hand, not as the unit');
  assert.ok(!calls.some((a) => a[0] === 'restart'));

  const refused = (...args) => (args[0] === 'show' ? { status: 0, stdout: 'MainPID=4242\n' } : { status: 1, stdout: '' });
  assert.equal(selfRestart({ pid: 4242, systemctl: refused }), 'exit', 'a refused restart falls back to exiting');
  assert.equal(selfRestart({ pid: 4242, systemctl: () => ({ status: 1, stdout: '' }) }), 'exit', 'no systemd');
});

test('reserved names never reach a service, so they pass; a real host that only looks like one does not', () => {
  // What a real stack held on 22 Nov: svc-mining-pool, svc-pay and svc-ops settings on reserved names.
  for (const h of [
    '198.51.100.1',
    '192.0.2.7',
    '203.0.113.9',
    'terms.example',
    'archive.test.invalid',
    'a.test',
    'x.localhost',
    'example.com',
    'www.example.org',
  ])
    assert.equal(reservedHost(h), true, h);
  for (const h of ['198.51.101.1', 'example.io', 'notexample.com', 'test.com', 'api.hyperliquid.xyz', 'invalid.org', '8.8.8.8'])
    assert.equal(reservedHost(h), false, h);
  const found = outsideAddresses([
    ['MINING_POOL_SECURE_URL', 'stratum+ssl://198.51.100.1:3334'],
    ['PAY_MERCHANT_TERMS_URL', 'https://terms.example/t'],
  ]);
  assert.deepEqual(found, []);
});

test("the beta's Customer build shows only rooms finished in Volt; the switch is the beta's alone", () => {
  assert.equal(stackEnv(betaPaths('/home/x'), {}).INTAFACED_BETA_VOLT_ONLY, '1');
  // The trade desks run on Hyperliquid's test network, not the stack's stand-in venue (#10603); the stack's own switch
  // reads it (local-test-venue.mjs userVenueKind), so a value it refuses could never reach the beta.
  assert.equal(stackEnv(betaPaths('/home/x'), {}).LOCAL_STACK_USER_VENUE, 'hl-testnet');
  assert.equal(
    stackEnv(betaPaths('/home/x'), { LOCAL_STACK_USER_VENUE: 'on' }).LOCAL_STACK_USER_VENUE,
    'hl-testnet',
    'the beta wins over a shell',
  );
  assert.equal(userVenueKind(stackEnv(betaPaths('/home/x'), {}).LOCAL_STACK_USER_VENUE), 'hl-testnet');
  // The journeys' TEST markets stay off the beta's board (#10599): the stack's switch (local-stack-services/trade.mjs)
  // reads exactly 'off', and the beta wins over a shell.
  assert.equal(stackEnv(betaPaths('/home/x'), {}).LOCAL_STACK_TEST_MARKETS, 'off');
  assert.equal(stackEnv(betaPaths('/home/x'), { LOCAL_STACK_TEST_MARKETS: 'on' }).LOCAL_STACK_TEST_MARKETS, 'off');
  // The beta publishes svc-ops' labelled TEST price list (#10632): without it valuation.prices returns
  // valuation.prices_unset and Home and Money show "No total" even after the tester's TEST partner account is funded.
  const betaVal = stackEnv(betaPaths('/home/x'), {}).LOCAL_STACK_VALUATION_PRICES;
  assert.equal(betaVal, 'test');
  assert.equal(stackEnv(betaPaths('/home/x'), { LOCAL_STACK_VALUATION_PRICES: 'off' }).LOCAL_STACK_VALUATION_PRICES, 'test');
  const opsProfile = JSON.parse(fs.readFileSync(new URL('../profiles/test-owner-values/ops.json', import.meta.url), 'utf8'));
  const prices = opsProfile.values.OPS_VALUATION_TEST_PRICES?.value ?? '';
  assert.match(
    prices,
    new RegExp(`(?:^|,)${GRANT.asset}=\\d+(?:\\.\\d+)?(?:,|$)`),
    `OPS_VALUATION_TEST_PRICES must price the invited tester's ${GRANT.asset} grant`,
  );
  // Check the exact wiring into local-stack-services/ops.mjs: setting the beta's value populates OPS_VALUATION_TEST_PRICES
  // from the ops profile, and leaving it unset leaves it absent (the journeys' default).
  const readOpsEnv = () =>
    opsService({
      c: () => ({}),
      secrets: {},
      dbUrl: () => 'postgres://127.0.0.1/db',
      urlOf: (n) => `http://127.0.0.1/${n}`,
      PORTS: { ops: 1 },
      opsOutreachEnv: () => ({}),
    }).env();
  const prevVal = process.env.LOCAL_STACK_VALUATION_PRICES;
  try {
    delete process.env.LOCAL_STACK_VALUATION_PRICES;
    assert.equal(readOpsEnv().OPS_VALUATION_TEST_PRICES, undefined);
    process.env.LOCAL_STACK_VALUATION_PRICES = betaVal;
    assert.equal(readOpsEnv().OPS_VALUATION_TEST_PRICES, prices);
  } finally {
    if (prevVal === undefined) delete process.env.LOCAL_STACK_VALUATION_PRICES;
    else process.env.LOCAL_STACK_VALUATION_PRICES = prevVal;
  }
});

test("the beta's balance watch reads the test network every 15 s, inside its 1200 weight a minute per IP; the TEST venue keeps the engine's second", () => {
  const tradeEnv = (venue) => {
    const prev = process.env.LOCAL_STACK_USER_VENUE;
    try {
      process.env.LOCAL_STACK_USER_VENUE = venue;
      return tradeService({
        c: () => ({}),
        secrets: {},
        dbUrl: () => 'postgres://127.0.0.1/db',
        urlOf: (n) => `http://127.0.0.1/${n}`,
        PORTS: { trade: 1 },
        P: { data: '/tmp/beta-data', root: '/tmp/beta', state: '/tmp/beta-state' },
        TEST_FUTURES_LADDER_POLICY: '',
      }).env();
    } finally {
      if (prev === undefined) delete process.env.LOCAL_STACK_USER_VENUE;
      else process.env.LOCAL_STACK_USER_VENUE = prev;
    }
  };
  const beta = tradeEnv(stackEnv(betaPaths('/home/x'), {}).LOCAL_STACK_USER_VENUE);
  assert.equal(beta.TRADE_VENUE_BALANCE_WATCH_INTERVAL_MS, '15000');
  assert.equal(beta.TRADE_PROTECTION_ENGINE_INTERVAL_MS, '1000');
  for (const venue of ['on', 'hl-recorded']) assert.equal(tradeEnv(venue).TRADE_VENUE_BALANCE_WATCH_INTERVAL_MS, undefined, venue);
});

test("the beta runs its TEST chain with the journeys' pinned anvil image, so the indexer starts and the protocol has a node (#10305)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-anvil-'));
  const paths = betaPaths(dir);
  fs.mkdirSync(paths.root, { recursive: true });
  const calls = [];
  const sh = (ok) => (cmd, args) => (calls.push([cmd, ...args].join(' ')), { status: ok(args) ? 0 : 1 });

  // The image is missing: it is pulled, then the launcher is written and the stack is given it.
  assert.deepEqual(
    ensureAnvil(
      paths,
      sh((a) => a[0] === 'pull'),
    ).fresh,
    true,
    'a new launcher',
  );
  assert.match(
    ensureAnvil(
      paths,
      sh(() => true),
    ).line,
    /on the box/,
  );
  assert.deepEqual(calls, [
    `docker image inspect --format {{.Id}} ${ANVIL_IMAGE}`,
    `docker pull --quiet ${ANVIL_IMAGE}`,
    `docker image inspect --format {{.Id}} ${ANVIL_IMAGE}`,
  ]);
  assert.equal(
    ensureAnvil(
      paths,
      sh(() => true),
    ).fresh,
    false,
    'the same launcher is not new',
  );
  assert.equal(fs.readFileSync(paths.anvil, 'utf8'), anvilLauncher());
  assert.match(
    anvilLauncher(),
    /^#!\/bin\/sh\nexec docker run --rm --init --network host ghcr\.io\/foundry-rs\/foundry:v1\.5\.1 "anvil \$\*"\n$/,
  );
  assert.equal(fs.statSync(paths.anvil).mode & 0o777, 0o755);
  assert.equal(stackEnv(paths, {}).LOCAL_STACK_ANVIL_BIN, paths.anvil);
  assert.equal(stackEnv(paths, { LOCAL_STACK_ANVIL_BIN: '/opt/anvil' }).LOCAL_STACK_ANVIL_BIN, '/opt/anvil', 'a chosen anvil wins');

  // The image is the one CI's journeys run their chain with.
  const workflow = fs.readFileSync(new URL('../../.github/workflows/real-app-journeys.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes(`docker run --rm --init --network host ${ANVIL_IMAGE} "anvil $*"`));

  // No docker, or a failed pull: no launcher, and the stack starts as before, with no TEST chain.
  calls.length = 0;
  assert.match(
    ensureAnvil(
      paths,
      sh(() => false),
    ).line,
    /no TEST chain/,
  );
  assert.equal(fs.existsSync(paths.anvil), false);
  assert.equal(stackEnv(paths, {}).LOCAL_STACK_ANVIL_BIN, undefined);
});

test("passkeys and wallet messages work on the beta's public name: svc-identity's relying party is its host, svc-protocol accepts its origin, and the TEST funds check still passes", async () => {
  const { localTestServiceEnvs, PLAN_SECRETS, publicOrigin } = await import('../scripts/local-test-stack.mjs');
  const origin = stackEnv(betaPaths('/home/x'), { LOCAL_STACK_PUBLIC_ORIGIN: 'https://other.example.com' }).LOCAL_STACK_PUBLIC_ORIGIN;
  assert.equal(origin, 'https://beta.intafaced.com', 'the beta wins over a shell');
  const identityEnv = () => localTestServiceEnvs(PLAN_SECRETS).find((d) => d.name === 'identity').env;
  const prior = process.env.LOCAL_STACK_PUBLIC_ORIGIN;
  try {
    delete process.env.LOCAL_STACK_PUBLIC_ORIGIN;
    assert.equal(identityEnv().WEBAUTHN_RP_ID, 'localhost', 'unset: the stack keeps its localhost relying party');
    process.env.LOCAL_STACK_PUBLIC_ORIGIN = origin;
    const identity = identityEnv();
    assert.equal(identity.WEBAUTHN_RP_ID, 'beta.intafaced.com');
    assert.equal(identity.WEBAUTHN_ORIGIN, 'https://beta.intafaced.com');
    assert.deepEqual(
      outsideAddresses(Object.entries(identity), BETA_OWN_HOSTS).filter((a) => a.key.startsWith('WEBAUTHN')),
      [],
    );
    // Connect to the venue signs a wallet message naming the page's origin (protocol.wallet_session_origin_unlisted).
    const protocol = localTestServiceEnvs(PLAN_SECRETS).find((d) => d.name === 'protocol').env;
    assert.ok(protocol.PROTOCOL_WALLET_SESSION_ORIGINS.split(',').includes('https://beta.intafaced.com'));
    assert.ok(
      protocol.PROTOCOL_WALLET_SESSION_ORIGINS.split(',').some((o) => /^http:\/\/localhost:\d+$/.test(o)),
      'the stack keeps its own',
    );
  } finally {
    if (prior === undefined) delete process.env.LOCAL_STACK_PUBLIC_ORIGIN;
    else process.env.LOCAL_STACK_PUBLIC_ORIGIN = prior;
  }
  for (const bad of ['http://beta.intafaced.com', 'https://beta.intafaced.com/', 'https://beta.intafaced.com/app', 'beta.intafaced.com'])
    assert.throws(() => publicOrigin({ LOCAL_STACK_PUBLIC_ORIGIN: bad }), /LOCAL_STACK_PUBLIC_ORIGIN must be one https origin/, bad);
});
