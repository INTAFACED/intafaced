import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ANVIL_IMAGE,
  BETA_LINK,
  BETA_SLOT,
  MAILBOX_PORT,
  UPDATE_EVERY_MS,
  anvilLauncher,
  betaPaths,
  decide,
  ensureAnvil,
  environEntries,
  fundsCheck,
  HOSTED_TEST_NETWORK_HOSTS,
  hostedAllowList,
  mailboxPage,
  mailboxRows,
  outsideAddresses,
  reservedHost,
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

test('fundsCheck fails closed: no process, no readable process, no page, or a page with no TEST banner', () => {
  const ok = () => environ({ A: 'http://127.0.0.1:1' });
  assert.equal(fundsCheck({ records: {}, readEnviron: ok, page: PAGE }).ok, false);
  assert.equal(fundsCheck({ records: { a: { pid: 1 } }, readEnviron: () => null, page: PAGE }).ok, false);
  assert.equal(fundsCheck({ records: { a: { pid: 1 } }, readEnviron: ok, page: null }).ok, false);
  const noBanner = fundsCheck({ records: { a: { pid: 1 } }, readEnviron: ok, page: '<body>app</body>' });
  assert.equal(noBanner.ok, false);
  assert.match(noBanner.lines[0], /lacks the TEST banner/);
});

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

test('decide: a moved main updates at most once every 2 hours; between, the round only launches', () => {
  const now = Date.parse('2026-11-23T08:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(UPDATE_EVERY_MS, 2 * 3600_000);
  assert.equal(decide({ screening: true, head: 'a', target: 'b', updatedAt: ago(30 * 60_000), now }), 'launch');
  assert.equal(decide({ screening: true, head: 'a', target: 'b', updatedAt: ago(UPDATE_EVERY_MS - 1), now }), 'launch');
  assert.equal(decide({ screening: true, head: 'a', target: 'b', updatedAt: ago(UPDATE_EVERY_MS), now }), 'update');
  assert.equal(decide({ screening: true, head: 'a', target: 'b', updatedAt: undefined, now }), 'update');
  assert.equal(decide({ screening: false, head: 'a', target: 'b', updatedAt: ago(1), now }), 'blocked');
});

test('the page names the commit served, and the newer main it waits for', () => {
  const html = mailboxPage([], { status: { state: 'up', sha: 'aaaaaaaaa111', mainAt: 'bbbbbbbbb222' } });
  assert.match(html, /Beta: up on main aaaaaaaaa \(main is at bbbbbbbbb; the beta updates at most every 2 hours\)/);
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
