// Proves the local test stack's two safety properties without starting anything:
// local:fund refuses outside its own stack, and the script never supplies a sanctions list.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import {
  existsSync,
  realpathSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// The env a child gets when it should find its state under its own HOME. An inherited LOCAL_STACK_STATE (the INTAFACED
// cloud environment sets it to the machine's real stack) would point the child at that stack instead.
function homeEnv(home, extra = {}) {
  const { LOCAL_STACK_STATE: _state, ...env } = process.env;
  return { ...env, ...extra, HOME: home };
}
const script = resolve(here, 'local-test-stack.mjs');

// Start order: a service waits for every earlier service its env names (matching checks resting-order holds against
// the ledger as it boots), edge waits for every service, and services that call nothing start at once.
{
  const { startDependencies, localTestServiceEnvs } = await import('./local-test-stack.mjs');
  const defs = localTestServiceEnvs();
  const envOf = (d) => d.env;
  const waitsOf = (name) =>
    startDependencies(
      defs,
      defs.find((d) => d.name === name),
      envOf,
    ).map((d) => d.name);
  assert.deepEqual(waitsOf('ledger'), []);
  assert.ok(waitsOf('matching').includes('ledger'), 'matching waits for the ledger');
  assert.ok(waitsOf('identity').includes('ledger'), 'identity waits for the ledger');
  // Every service but svc-ws, which is not behind the edge: the Customer server proxies /ws to it directly.
  assert.deepEqual(
    waitsOf('edge').sort(),
    defs
      .map((d) => d.name)
      .filter((n) => n !== 'edge' && n !== 'ws')
      .sort(),
  );
  const wsPort = `:${defs.find((d) => d.name === 'ws').env.HTTP_PORT}`;
  assert.ok(
    !Object.values(defs.find((d) => d.name === 'edge').env).some((value) => String(value).includes(wsPort)),
    'the edge names no svc-ws port',
  );
  // Only services listed earlier are waited for, so the order can never deadlock.
  for (const def of defs) {
    for (const dep of startDependencies(defs, def, envOf)) assert.ok(defs.indexOf(dep) < defs.indexOf(def));
  }
  // A port is matched whole: 1450 is not 14501.
  const a = { name: 'a', env: { HTTP_PORT: '14501' } };
  const b = { name: 'b', env: { HTTP_PORT: '14502', A_URL: 'http://127.0.0.1:1450' } };
  assert.deepEqual(startDependencies([a, b], b, envOf), []);
  const b2 = { name: 'b', env: { HTTP_PORT: '14502', A_URL: 'http://127.0.0.1:14501/x' } };
  assert.deepEqual(
    startDependencies([a, b2], b2, envOf).map((d) => d.name),
    ['a'],
  );
}

// Service keys: off by default, so the journeys' stack is unchanged; LOCAL_STACK_S2S=dual gives every S2S service one
// shared public keyring and its own matching signing key, and keypair is refused.
{
  const { localTestServiceEnvs, s2sEnv, S2S_SERVICES, PLAN_SECRETS, newServiceKey, serviceKeyMatches } =
    await import('./local-test-stack.mjs');
  const { createPrivateKey, createPublicKey } = await import('node:crypto');
  const contractsNames = [
    ...readFileSync(resolve(here, '../../packages/contracts/src/service-keys.ts'), 'utf8')
      .match(/export const SERVICE_NAMES = \[([^\]]*)\]/)[1]
      .matchAll(/'(svc-[a-z0-9-]+)'/g),
  ].map((m) => m[1]);
  const stackSvcs = localTestServiceEnvs().map((d) => d.env.SERVICE_NAME);
  assert.deepEqual(
    [...S2S_SERVICES].sort(),
    stackSvcs.filter((n) => contractsNames.includes(n)).sort(),
    'every stack service that packages/contracts names has a key, and no other',
  );
  const s2sKeys = Object.fromEntries(S2S_SERVICES.map((svc) => [svc, newServiceKey(svc)]));
  // A stored key is kept only when its kid is the service's and its private key gives its public x.
  assert.ok(serviceKeyMatches('svc-trade', s2sKeys['svc-trade']));
  assert.ok(!serviceKeyMatches('svc-trade', { ...s2sKeys['svc-trade'], kid: 'svc-trade.old' }), 'another kid');
  assert.ok(!serviceKeyMatches('svc-trade', { ...s2sKeys['svc-trade'], x: s2sKeys['svc-ledger'].x }), 'another public key');
  assert.ok(!serviceKeyMatches('svc-trade', { ...s2sKeys['svc-trade'], key: 'not-a-key' }), 'a broken private key');
  assert.ok(!serviceKeyMatches('svc-trade', undefined), 'no key');
  const prior = process.env.LOCAL_STACK_S2S;
  try {
    delete process.env.LOCAL_STACK_S2S;
    for (const { name, env } of localTestServiceEnvs({ ...PLAN_SECRETS, s2sKeys })) {
      assert.ok(!Object.keys(env).some((k) => k.startsWith('S2S_')), `${name}: no S2S env by default`);
    }
    assert.deepEqual(s2sEnv({ s2sKeys }, 'svc-trade', 'off'), {});
    process.env.LOCAL_STACK_S2S = 'dual';
    const keyed = localTestServiceEnvs({ ...PLAN_SECRETS, s2sKeys });
    const rings = new Set();
    for (const { name, env } of keyed) {
      const svc = env.SERVICE_NAME;
      if (!S2S_SERVICES.includes(svc)) {
        assert.ok(!Object.keys(env).some((k) => k.startsWith('S2S_')), `${name}: no S2S role, no S2S env`);
        continue;
      }
      assert.equal(env.S2S_AUTH_MODE, 'dual', name);
      assert.equal(env.S2S_SIGNING_KID, `${svc}.local`, name);
      rings.add(env.S2S_KEYRING);
      const entry = JSON.parse(env.S2S_KEYRING).keys.find((k) => k.kid === env.S2S_SIGNING_KID);
      assert.equal(entry.svc, svc, name);
      const priv = createPrivateKey({ key: Buffer.from(env.S2S_SIGNING_KEY, 'base64url'), format: 'der', type: 'pkcs8' });
      assert.equal(createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'), entry.x, name);
    }
    assert.equal(rings.size, 1, 'one keyring for every service');
    const ring = JSON.parse([...rings][0]).keys;
    assert.equal(ring.length, S2S_SERVICES.length);
    assert.ok(
      ring.every((k) => Object.keys(k).sort().join() === 'kid,svc,use,x' && k.use === 's2s'),
      'public keys only',
    );
    assert.throws(() => s2sEnv({ s2sKeys }, 'svc-trade', 'keypair'), /off or dual/);
    assert.throws(() => s2sEnv({}, 'svc-trade', 'dual'), /no stack key for svc-academy/);
    // `plan` under dual shows the keyed env from placeholders, without reading secrets.json.
    assert.equal(localTestServiceEnvs().find((d) => d.env.SERVICE_NAME === 'svc-trade').env.S2S_SIGNING_KID, 'svc-trade.local');
  } finally {
    if (prior === undefined) delete process.env.LOCAL_STACK_S2S;
    else process.env.LOCAL_STACK_S2S = prior;
  }
}

// LOCAL_STACK_S2S is checked before a restart stops anything: a bad value, or a value other than the one the running
// services were started with, is refused with exit 2 and the running service is left alone.
{
  const { readProcessIdentity } = await import('./local-test-state.mjs');
  const s2sHome = mkdtempSync(join(tmpdir(), 'local-test-stack-s2s-'));
  const s2sState = join(s2sHome, '.intafaced', 'local-test-stack');
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    let id = null;
    for (let i = 0; i < 50 && !id; i++) {
      id = readProcessIdentity(child.pid);
      if (!id) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(id, 'the stand-in ledger process is visible to ps');
    mkdirSync(join(s2sState, 'run'), { recursive: true });
    writeFileSync(
      join(s2sState, 'run', 'processes.json'),
      JSON.stringify({ ledger: { pid: child.pid, argv: id.command.split(' '), startedAt: new Date(id.startedAt).toISOString() } }),
    );
    const { LOCAL_STACK_STATE: _state, ...env } = process.env;
    const restart = (mode) =>
      spawnSync(process.execPath, [script, 'restart', 'ledger'], {
        env: { ...env, HOME: s2sHome, LOCAL_STACK_S2S: mode },
        encoding: 'utf8',
      });
    let r = restart('keypair');
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /LOCAL_STACK_S2S must be off or dual, not "keypair"/);
    r = restart('dual');
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /services run with LOCAL_STACK_S2S=off \(ledger\); set the same value, or stop the stack first/);
    writeFileSync(join(s2sState, 'run', 's2s-mode'), 'dual\n');
    r = restart('');
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /services run with LOCAL_STACK_S2S=dual \(ledger\)/);
    assert.equal(child.exitCode, null, 'the running service was not stopped');
    console.log('local-test-stack: a restart with a bad or different LOCAL_STACK_S2S is refused before anything stops');
  } finally {
    child.kill();
    rmSync(s2sHome, { recursive: true, force: true });
  }
}

// inPool runs every item, never more than the limit at once.
{
  const { inPool } = await import('./local-test-stack.mjs');
  let running = 0;
  let peak = 0;
  const seen = [];
  await inPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    seen.push(n);
    running -= 1;
  });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
  await inPool([], 4, async () => assert.fail('no items, no calls'));
}

// p2p is the only service that carries the local-test instrument key, and only under APP_ENV=dev.
{
  const { localTestServiceEnvs } = await import('./local-test-stack.mjs');
  const { localStackState } = await import('./local-test-state.mjs');
  const services = localTestServiceEnvs();
  const p2p = services.find((service) => service.name === 'p2p');
  assert.ok(p2p, 'p2p service missing');
  assert.equal(p2p.env.APP_ENV, 'dev');
  assert.equal(p2p.env.LOCAL_TEST_KMS, '1');
  assert.equal(p2p.env.LOCAL_TEST_KMS_DIR, join(localStackState(), 'p2p-kms'));
  assert.equal(p2p.env.P2P_FEE_BPS, '0');
  for (const service of services) {
    if (service.name === 'p2p') continue;
    assert.equal(service.env.LOCAL_TEST_KMS, undefined, `${service.name} must not set LOCAL_TEST_KMS`);
    assert.equal(service.env.LOCAL_TEST_KMS_DIR, undefined, `${service.name} must not set LOCAL_TEST_KMS_DIR`);
  }
  console.log('local-test-stack: p2p local-test kms env checks passed');
}

// Every service file in local-stack-services/ is started, once, under its own name.
{
  const { localTestServiceEnvs } = await import('./local-test-stack.mjs');
  const files = readdirSync(join(here, 'local-stack-services'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.replace(/\.mjs$/, ''))
    .sort();
  assert.deepEqual(
    localTestServiceEnvs()
      .map((service) => service.name)
      .sort(),
    files,
    'every file in local-stack-services/ is a started service; a LOCAL TEST tool goes beside it as tooling/scripts/local-test-<name>.mjs',
  );
  // The rig the stack's `mining-share` command loads (cmdMiningShare) is one of those tools.
  assert.equal(typeof (await import('./local-test-mining-rig.mjs')).rigShare, 'function');
  console.log('local-test-stack: one service file per started service');
}

// The bank asks the stack's own svc-pay for the deposit catalogue and addresses; without PAY_URL every deposit answer is
// "not published" (bank.deposit_custody_unset).
{
  const { localTestServiceEnvs } = await import('./local-test-stack.mjs');
  const envs = localTestServiceEnvs();
  const bank = envs.find((service) => service.name === 'bank');
  const pay = envs.find((service) => service.name === 'pay');
  assert.equal(bank.env.PAY_URL, `http://127.0.0.1:${pay.env.HTTP_PORT}`);
  assert.match(pay.env.PAY_TEST_RAIL_RECORDS_DIR, /\/test-rail-records$/);
  console.log('local-test-stack: bank reads deposit custody from the stack svc-pay');
}

// `LOCAL_STACK_BANK_DEPOSIT_CUSTODY=off` starts the bank with no custody port at all (J-wallet-02 #1), and nothing else changes.
{
  const { localTestServiceEnvs } = await import('./local-test-stack.mjs');
  const bankEnv = () => localTestServiceEnvs().find((service) => service.name === 'bank').env;
  const before = process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY;
  try {
    delete process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY;
    const on = bankEnv();
    assert.ok(on.PAY_URL);
    process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY = 'off';
    const off = bankEnv();
    assert.equal('PAY_URL' in off, false);
    const { PAY_URL: _payUrl, ...rest } = on;
    assert.deepEqual(off, rest);
    // Any other value is a mistake, refused by name, never read as connected.
    process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY = 'OFF';
    assert.throws(bankEnv, /LOCAL_STACK_BANK_DEPOSIT_CUSTODY is "OFF"/);
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY;
    else process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY = before;
  }
  console.log('local-test-stack: bank can start with deposit custody unset');
}

// svc-ledger reads no outside snapshot by default; `LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT=unreachable` points it at a closed
// local port so a run shows ERROR (J-ops-console-07 #5), and nothing else changes.
{
  const { localTestServiceEnvs } = await import('./local-test-stack.mjs');
  const ledgerEnv = () => localTestServiceEnvs().find((service) => service.name === 'ledger').env;
  const before = process.env.LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT;
  try {
    delete process.env.LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT;
    const unset = ledgerEnv();
    assert.equal('LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL' in unset, false);
    // Each recorded rail reads its own statement from the stack's statement server; the TEST mint has none.
    const rails = Object.keys(unset).filter((name) => name.startsWith('LEDGER_RECONCILE_RAIL_'));
    assert.deepEqual(rails.sort(), ['LEDGER_RECONCILE_RAIL_CRYPTO_NATIVE_URL', 'LEDGER_RECONCILE_RAIL_PAYOUT_SIM_URL']);
    for (const name of rails) assert.equal(unset[name], 'http://127.0.0.1:14525/statement');
    process.env.LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT = 'unreachable';
    const { LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL: url, ...rest } = ledgerEnv();
    assert.equal(url, 'http://127.0.0.1:9/local-test-outside-snapshot');
    assert.deepEqual(rest, unset);
    process.env.LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT = 'on';
    assert.throws(ledgerEnv, /LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT is "on"/);
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT;
    else process.env.LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT = before;
  }
  console.log('local-test-stack: ledger can start with an unreachable outside snapshot');
}

// `LOCAL_STACK_MINING_POOL_PUBLISHED=off` starts the pool with every LOCAL TEST owner value blank (J-more-catalogue-05 #1, #2),
// and nothing else changes.
{
  const { localTestServiceEnvs } = await import('./local-test-stack.mjs');
  const poolEnv = () => localTestServiceEnvs().find((service) => service.name === 'mining-pool').env;
  const before = process.env.LOCAL_STACK_MINING_POOL_PUBLISHED;
  try {
    delete process.env.LOCAL_STACK_MINING_POOL_PUBLISHED;
    const on = poolEnv();
    assert.ok(on.MINING_POOL_HOST);
    process.env.LOCAL_STACK_MINING_POOL_PUBLISHED = 'off';
    const off = poolEnv();
    assert.equal(
      Object.keys(off).some((key) => key.startsWith('MINING_')),
      false,
    );
    assert.deepEqual(off, Object.fromEntries(Object.entries(on).filter(([key]) => !key.startsWith('MINING_'))));
    process.env.LOCAL_STACK_MINING_POOL_PUBLISHED = 'OFF';
    assert.throws(poolEnv, /LOCAL_STACK_MINING_POOL_PUBLISHED is "OFF"/);
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_MINING_POOL_PUBLISHED;
    else process.env.LOCAL_STACK_MINING_POOL_PUBLISHED = before;
  }
  console.log('local-test-stack: the mining pool can start with nothing published');
}

// The bank process carries its BK-xfer-07 TEST values from the bank profile, verbatim, so a global send on this
// stack meets the same payee list, exchange allowance and proof limits as CX-8 instead of the unset refusals.
{
  const { localTestServiceEnvs } = await import('./local-test-stack.mjs');
  const { loadProfile } = await import('./owner-settings.mjs');
  const bank = localTestServiceEnvs().find((service) => service.name === 'bank');
  const profile = loadProfile().values;
  for (const name of ['BANK_PAYEE_CONTROLS_JSON', 'BANK_EXCHANGE_ALLOWANCE_JSON', 'BANK_PROOF_LIMITS_JSON']) {
    assert.equal(profile[name]?.service, 'bank', `${name} is not in the bank profile`);
    assert.equal(bank.env[name], profile[name].value, `bank env ${name} differs from the bank profile`);
  }
  console.log('local-test-stack: bank BK-xfer-07 TEST values come from the bank profile');
}

// The token process carries the TEST proposer rule and proposal limit from the token profile, verbatim, so a governance
// journey meets the rule instead of the unset refusal.
{
  const { localTestServiceEnvs } = await import('./local-test-stack.mjs');
  const { loadProfile } = await import('./owner-settings.mjs');
  const token = localTestServiceEnvs().find((service) => service.name === 'token');
  const profile = loadProfile().values;
  for (const name of ['TOKEN_PROPOSER_RULE', 'TOKEN_PROPOSAL_LIMIT', 'EMISSIONS_EPOCH_MS']) {
    assert.equal(profile[name]?.service, 'token', `${name} is not in the token profile`);
    assert.equal(token.env[name], profile[name].value, `token env ${name} differs from the token profile`);
  }
  // LOCAL_STACK_TOKEN_PROPOSER_RULE=off leaves the rule blank, so a journey can restart the lane to show its refusal.
  process.env.LOCAL_STACK_TOKEN_PROPOSER_RULE = 'off';
  try {
    const blank = localTestServiceEnvs().find((service) => service.name === 'token');
    assert.equal('TOKEN_PROPOSER_RULE' in blank.env, false, 'the off switch must leave TOKEN_PROPOSER_RULE unset');
    assert.equal(blank.env.TOKEN_PROPOSAL_LIMIT, profile.TOKEN_PROPOSAL_LIMIT.value);
  } finally {
    delete process.env.LOCAL_STACK_TOKEN_PROPOSER_RULE;
  }
  console.log('local-test-stack: token governance TEST values come from the token profile');
}

// LOCAL_STACK_TRADE_COPY_JURISDICTION=blank leaves only the TEST copy country list blank, so J-copy-bots-otc-01 #5 can
// restart trade to show every follow refused; every other trade value stays as the profile sets it.
{
  const { localTestServiceEnvs } = await import('./local-test-stack.mjs');
  const { loadProfile } = await import('./owner-settings.mjs');
  const profile = loadProfile().values;
  const before = process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION;
  try {
    delete process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION;
    const set = localTestServiceEnvs().find((service) => service.name === 'trade').env;
    assert.equal(set.TRADE_COPY_JURISDICTION_LAW, profile.TRADE_COPY_JURISDICTION_LAW.value);
    process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION = 'blank';
    const blank = localTestServiceEnvs().find((service) => service.name === 'trade').env;
    assert.equal(blank.TRADE_COPY_JURISDICTION_LAW, '', 'the blank switch must leave the copy country list blank');
    assert.deepEqual(
      { ...blank, TRADE_COPY_JURISDICTION_LAW: set.TRADE_COPY_JURISDICTION_LAW },
      set,
      'the blank switch must change nothing else in trade',
    );
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION;
    else process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION = before;
  }
  console.log('local-test-stack: the copy country list blank switch blanks only TRADE_COPY_JURISDICTION_LAW');
}

// The agents process routes the TEST Coach task on the stand-in engine at the profile's TEST route, verbatim, and
// LOCAL_STACK_AGENTS_COACH_ROUTE=off drops only that route, so a journey can restart the lane to show "no Coach model".
{
  const { localTestServiceEnvs } = await import('./local-test-stack.mjs');
  const { loadProfile } = await import('./owner-settings.mjs');
  const profile = loadProfile().values;
  const coachRoute = JSON.parse(profile.AGENTS_COACH_ROUTE.value);
  const baseRoutes = JSON.parse(profile.AGENTS_ROUTING_TABLE.value).routes;
  assert.equal(profile.AGENTS_COACH_ROUTE.service, 'agents');
  assert.equal(coachRoute.task, 'coach.answer');
  assert.deepEqual(coachRoute.price, { inputPerMillion: '0', outputPerMillion: '0' }, 'the TEST Coach route bills 0');
  const routesOf = () => JSON.parse(localTestServiceEnvs().find((service) => service.name === 'agents').env.AGENTS_ROUTING_TABLE).routes;
  assert.deepEqual(routesOf(), [...baseRoutes, coachRoute]);
  process.env.LOCAL_STACK_AGENTS_COACH_ROUTE = 'off';
  try {
    assert.deepEqual(routesOf(), baseRoutes, 'the off switch must drop the Coach route and keep every other route');
  } finally {
    delete process.env.LOCAL_STACK_AGENTS_COACH_ROUTE;
  }
  console.log('local-test-stack: agents TEST Coach route comes from the agents profile, and its off switch drops it');
}

// The global-send stand-in is chosen on this stack only, and its TEST catalogue and send-field rules come from the bank
// profile verbatim, so no corridor, rate or reference length is typed anywhere else.
{
  const { localTestServiceEnvs } = await import('./local-test-stack.mjs');
  const { loadProfile } = await import('./owner-settings.mjs');
  const bank = localTestServiceEnvs().find((service) => service.name === 'bank');
  const profile = loadProfile().values;
  assert.equal(bank.env.BANK_GLOBAL_PARTNER, 'global-sim');
  assert.equal(bank.env.BANK_ONRAMP_RATES, 'ramp-sim');
  assert.equal(bank.env.BANK_PAYOUT_PARTNER, 'payout-sim');
  assert.match(bank.env.BANK_PAYOUT_SIM_RECORDS_DIR, /\/test-rail-records$/);
  assert.equal(bank.env.BANK_DD_SCHEME, 'dd-sim');
  for (const name of [
    'BANK_GLOBAL_SIM_JSON',
    'BANK_ONRAMP_SIM_JSON',
    'BANK_PAYOUT_SIM_JSON',
    'BANK_DD_SIM_JSON',
    'BANK_SEND_FIELD_RULES_JSON',
    'BANK_PAYEE_COOLING_HOURS',
    'BANK_GLOBAL_HOLD_CANCEL_HOURS',
    'BANK_GLOBAL_REFUND_FEE',
  ]) {
    assert.equal(profile[name]?.service, 'bank', `${name} is not in the bank profile`);
    assert.equal(bank.env[name], profile[name].value, `bank env ${name} differs from the bank profile`);
  }
  assert.match(JSON.parse(profile.BANK_GLOBAL_SIM_JSON.value).label, /^TEST\b/);
  console.log('local-test-stack: the global-send stand-in and its TEST catalogue come from the bank profile');
}

function fundWith(home, args = ['someone@example.invalid', 'USDT', '1000']) {
  return spawnSync(process.execPath, [script, 'fund', ...args], { env: homeEnv(home), encoding: 'utf8' });
}

const home = mkdtempSync(join(tmpdir(), 'local-test-stack-test-'));
const state = join(home, '.intafaced', 'local-test-stack');
try {
  // 1. No marker: refuses before reading anything else.
  let r = fundWith(home);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing: marker .* not found/);

  // 2. A marker that is not a local test stack marker.
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'secrets.json'), JSON.stringify({ pgService: 'x' }));
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), JSON.stringify({ kind: 'something-else', ports: { postgres: 15460 } }));
  r = fundWith(home);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /not a local test stack marker/);

  // 3. A hand-edited marker that names another database port (e.g. a shared 5432) is refused.
  //    The real containment is structural: the stack's addresses are fixed to 127.0.0.1:15460
  //    (Postgres) and :14501 (ledger) in the script, and fund also requires our own ledger process.
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), JSON.stringify({ kind: 'intafaced-local-test-stack', ports: { postgres: 5432 } }));
  r = fundWith(home);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /database is not 127\.0\.0\.1 on the local test stack port/);

  // 4. Correct marker, but this stack's own Postgres is not running.
  writeFileSync(join(state, 'LOCAL-TEST-STACK.json'), JSON.stringify({ kind: 'intafaced-local-test-stack', ports: { postgres: 15460 } }));
  r = fundWith(home);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /local stack Postgres is not running/);

  // 5. Money amounts must be plain decimal strings.
  for (const bad of ['1e3', '12.5.1', '-5', '0x10']) {
    r = fundWith(home, ['someone@example.invalid', 'USDT', bad]);
    assert.equal(r.status, 2, `${bad}: ${r.stderr}`);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

// 6. The script never writes a sanctions value of its own: every assignment of the two
// screening variables comes from the caller's environment or the machine-local file.
// The per-service env files are part of the script for these checks.
const serviceDir = join(here, 'local-stack-services');
const source = [
  script,
  join(here, 'local-test-mining-rig.mjs'),
  ...readdirSync(serviceDir)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => join(serviceDir, f)),
]
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');
for (const name of ['INTAFACED_SANCTIONS_REGIONS', 'INTAFACED_SANCTIONS_LIST_SOURCE']) {
  const literal = new RegExp(`${name}\\s*[:=]\\s*['"\`]`);
  assert.equal(literal.test(source), false, `${name} is given a literal value in the script`);
  for (const line of source.split('\n').filter((l) => new RegExp(`${name}\\s*:`).test(l))) {
    assert.match(line, /process\.env\.|file\.(regions|source)/, `unexpected source for ${name}: ${line.trim()}`);
  }
}
assert.equal(/screening\.local\.json/.test(source), true);
assert.equal(/\bZZ\b/.test(source), false, 'the repo script must not carry the ZZ fixture');

// The identity process takes its founder pair from the local test vault helper.
// The Docker founder files are not named here.
assert.match(source, /founderIdentityEnv\(/);
assert.equal(source.includes('.env.founder-secrets.local'), false);
assert.equal(source.includes('.env.founder.local'), false);
assert.equal(source.includes('local_nitro'), false);
assert.equal(source.includes('local_phantom'), false);

console.log('local-test-stack: 6 refusal checks passed');

// Matching reads order:<id> holds read-only from the ledger at boot. Without LEDGER_URL a
// journal with resting orders boots closed (matching.hold_check_unwired). Ledger already starts
// before matching; this only pins the env the matching process is given.
{
  const { localTestServiceEnvs } = await import('./local-test-stack.mjs');
  const envs = localTestServiceEnvs();
  const ledger = envs.find((service) => service.name === 'ledger');
  const matching = envs.find((service) => service.name === 'matching');
  assert.ok(matching, 'matching service missing');
  assert.equal(
    matching.env.LEDGER_URL,
    `http://${ledger.env.HTTP_HOST}:${ledger.env.HTTP_PORT}`,
    "matching env must contain LEDGER_URL: urlOf('ledger')",
  );
  console.log('local-test-stack: matching ledger hold wiring check passed');
}

// 7. Every Edge upstream, and every module the Customer app calls, points at a service this
// stack starts or is listed as intentionally absent with a reason. `plan` changes nothing.
const repo = resolve(here, '..', '..');
const planHome = mkdtempSync(join(tmpdir(), 'local-test-stack-plan-'));
try {
  const r = spawnSync(process.execPath, [script, 'plan', '--json'], { env: homeEnv(planHome), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(planHome, '.intafaced')), false, 'plan must not create the state directory');
  assert.equal(/x{32}/.test(r.stdout), false, 'plan output must not carry any secret value');
  const plan = JSON.parse(r.stdout);

  const names = plan.services.map((x) => x.name);
  assert.equal(new Set(names).size, names.length, 'duplicate service names');
  assert.equal(new Set(plan.services.map((x) => x.port)).size, names.length, 'two services share a port');
  for (const sv of plan.services) {
    assert.equal(sv.url, `http://127.0.0.1:${sv.port}`, `${sv.name} must bind loopback`);
    assert.equal(existsSync(join(repo, 'services', `svc-${sv.name}`, 'src', 'index.ts')), true, `no services/svc-${sv.name}`);
    assert.equal(plan.backendPackages.includes(`svc-${sv.name}`), true, `svc-${sv.name} is started but never built`);
  }
  for (const schema of plan.schemas) {
    // A service owns each schema (svc-mining-pool owns mining_pool), and has the migrate script the stack runs
    // (`pnpm --filter <service> db:migrate`), pointing at a file that exists (svc-ops keeps it in src/db).
    const owner = plan.services.find((x) => x.schema === schema);
    assert.ok(owner, `schema ${schema} has no service`);
    const dir = join(repo, 'services', `svc-${owner.name}`);
    const migrate = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts?.['db:migrate'] ?? '';
    const file = /^(?:tsx|node) (\S+\.(?:ts|mjs))$/.exec(migrate)?.[1];
    assert.ok(file, `svc-${owner.name} has no db:migrate script that runs one file`);
    assert.equal(existsSync(join(dir, file)), true, `svc-${owner.name} db:migrate names a missing file ${file}`);
  }
  assert.equal(names.at(-1), 'edge', 'Edge starts last');

  // Edge route table, read from source.
  const routes = readFileSync(join(repo, 'services', 'svc-edge', 'src', 'routes.ts'), 'utf8');
  const upstreams = [...routes.matchAll(/prefix: '\/api\/([a-z0-9]+)', module: '[a-z0-9-]+', envVar: '([A-Z0-9_]+)'/g)].map((m) => ({
    prefix: m[1],
    envVar: m[2],
  }));
  assert.ok(upstreams.length >= 20, `could not read the Edge route table (${upstreams.length} rows)`);
  const reachable = (envVar) => {
    const u = plan.edgeUpstreams[envVar];
    if (!u) return null;
    if (u.service) {
      // MINING_POOL_URL -> mining-pool: the env name's underscores are the service name's hyphens.
      assert.equal(
        u.service,
        envVar.replace(/_URL$/, '').toLowerCase().replaceAll('_', '-'),
        `${envVar} points at the wrong service (${u.service})`,
      );
    }
    if (u.service) return names.includes(u.service) && u.url === plan.services.find((x) => x.name === u.service).url ? 'started' : 'broken';
    return u.absentReason && u.absentReason.length > 20 ? 'absent' : 'broken';
  };
  for (const { prefix, envVar } of upstreams) {
    assert.ok(
      reachable(envVar) && reachable(envVar) !== 'broken',
      `Edge ${envVar} (/api/${prefix}) is neither a started service nor listed absent with a reason`,
    );
  }

  // Modules the Customer app calls (literal names in api.query/mutate/plain/rest-free helpers and /api/<module> paths).
  const walk = (dir) =>
    readdirSync(dir).flatMap((f) => {
      const full = join(dir, f);
      if (statSync(full).isDirectory()) return f === 'vendor' || f === 'node_modules' ? [] : walk(full);
      return /\.(ts|tsx)$/.test(f) && !/\.(test|pw|spec)\./.test(f) ? [full] : [];
    });
  const used = new Set();
  for (const f of walk(join(repo, 'apps', 'customer', 'src'))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b(?:query|mutate|plain)\(\s*'([a-z0-9]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/'\/api\/([a-z0-9]+)/g)) used.add(m[1]);
  }
  used.delete('v1'); // public exchange REST, served by svc-trade
  used.add('trade');
  used.delete('ledger'); // /api/ledger is deliberately not routed (a string in a comment/refusal)
  used.delete('v2');
  assert.ok(used.size >= 12, `found only ${used.size} Customer modules: ${[...used]}`);
  const unmapped = [...used].filter((m) => !upstreams.some((u) => u.prefix === m));
  assert.deepEqual(unmapped, [], `Customer calls modules Edge has no route for: ${unmapped}`);
  const absentButUsed = [];
  for (const m of used) {
    const envVar = upstreams.find((u) => u.prefix === m).envVar;
    const state = reachable(envVar);
    assert.equal(state === 'started' || state === 'absent', true, `Customer module ${m} (${envVar}) has no started service`);
    if (state === 'absent') absentButUsed.push(m);
  }
  // Absent on purpose, each with a reason in EDGE_ABSENT: indexer and dex are called by the Protocol rooms (#4835) and
  // stay unwired. protocol is started (J-dex-protocol-01) and mining too (svc-mining-pool binds HTTP_HOST since #5907).
  assert.deepEqual([...absentButUsed].sort(), ['dex', 'indexer'], `unexpected Customer modules without a service: ${absentButUsed}`);
} finally {
  rmSync(planHome, { recursive: true, force: true });
}
console.log('local-test-stack: edge upstream coverage checks passed');

// 8. Customer folder override (LOCAL_STACK_CUSTOMER_DIST / `customer-dist`): validated, saved with mode 600,
// shown in plan/status, and it stops ensureBuilt from building the Customer app. Nothing here starts a server.
const distHome = mkdtempSync(join(tmpdir(), 'local-test-stack-dist-'));
const outside = mkdtempSync(join(tmpdir(), 'local-test-stack-outside-'));
try {
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      env: homeEnv(distHome, { LOCAL_STACK_CUSTOMER_DIST: '', ...env }),
      encoding: 'utf8',
    });
  const saved = join(distHome, '.intafaced', 'local-test-stack', 'customer-dist.json');
  const good = join(distHome, 'review', 'dist');
  mkdirSync(good, { recursive: true });
  writeFileSync(join(good, 'index.html'), '<html><body>redesign</body></html>');
  const noIndex = join(distHome, 'empty');
  mkdirSync(noIndex);
  writeFileSync(join(outside, 'index.html'), '<html></html>');
  symlinkSync(outside, join(distHome, 'sneaky'));
  const sourceDir = join(distHome, 'src-folder');
  mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, 'index.html'), '<html></html>');
  writeFileSync(join(sourceDir, 'package.json'), '{}');
  const hiddenDir = join(distHome, '.intafaced', 'build');
  mkdirSync(hiddenDir, { recursive: true });
  writeFileSync(join(hiddenDir, 'index.html'), '<html></html>');
  const dotParent = join(distHome, '.ssh');
  mkdirSync(dotParent);
  writeFileSync(join(dotParent, 'index.html'), '<html></html>');

  // Refusals: relative, missing, no index.html, outside $HOME (also through a symlink). Nothing is saved.
  for (const [arg, re] of [
    ['review/dist', /absolute path/],
    [join(distHome, 'nope'), /does not exist/],
    [noIndex, /no index\.html/],
    [outside, /not inside your home folder/],
    [join(distHome, 'sneaky'), /not inside your home folder/],
    [join(distHome, 'review', 'dist', 'index.html'), /is not a folder/],
    [sourceDir, /contains package\.json/],
    [hiddenDir, /hidden folder \(\.intafaced\)/],
    [dotParent, /hidden folder \(\.ssh\)/],
  ]) {
    const r = run(['customer-dist', arg]);
    assert.equal(r.status, 1, `${arg}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, re, arg);
    assert.equal(existsSync(saved), false, `${arg}: must not be saved`);
  }

  // Without an override the Customer app is built as before.
  let plan = JSON.parse(run(['plan', '--json']).stdout);
  assert.equal(plan.customer.source, 'own');
  assert.equal(plan.customer.wouldBuild, true, 'no override: ensureBuilt builds the Customer app');

  // `pnpm local:stack customer-dist <path>` goes through `start`; it saves the choice at mode 600.
  let r = run(['start', 'customer-dist', good]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statSync(saved).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(saved, 'utf8')).path, realpathSync(good));
  plan = JSON.parse(run(['plan', '--json']).stdout);
  assert.equal(plan.customer.source, 'saved');
  assert.equal(plan.customer.dir, realpathSync(good));
  assert.equal(plan.customer.wouldBuild, false, 'override: ensureBuilt must not build the Customer app');
  assert.match(run(['customer-dist']).stdout, /override, saved by "customer-dist"; never rebuilt or overwritten/);
  assert.match(run(['status']).stdout, /customer app: .*review.*dist/);

  // A stamp from a build that skipped the Customer app cannot vouch for the checkout's own dist.
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const stampFile = join(distHome, '.intafaced', 'local-test-stack', 'build-stamp.json');
  writeFileSync(stampFile, JSON.stringify({ head, builtAt: 'x', customerBuilt: false }));
  plan = JSON.parse(run(['plan', '--json']).stdout);
  assert.equal(plan.customer.wouldBuild, false, 'override stays in force with a skipped-customer stamp');

  // Live check on a throwaway port (never 3210): symlink escapes and dotfiles are 404, normal files are served.
  writeFileSync(join(good, 'app.js'), 'console.log(1)');
  mkdirSync(join(good, '.git'));
  writeFileSync(join(good, '.git', 'config'), 'secret');
  writeFileSync(join(good, '.env'), 'secret');
  writeFileSync(join(outside, 'passwd.txt'), 'outside-secret');
  symlinkSync(join(outside, 'passwd.txt'), join(good, 'leak.txt'));
  symlinkSync(outside, join(good, 'leakdir'));
  const port = await new Promise((ok) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: pt } = probe.address();
      probe.close(() => ok(pt));
    });
  });
  const server = spawn(process.execPath, [script, '__serve-customer', String(port)], {
    env: homeEnv(distHome),
    stdio: 'ignore',
  });
  try {
    const get = async (path) => {
      for (let i = 0; i < 50; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}${path}`);
          return { status: res.status, text: await res.text() };
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      throw new Error('throwaway server did not answer');
    };
    assert.equal((await get('/app.js')).text, 'console.log(1)');
    assert.match((await get('/some/route')).text, /redesign/, 'unknown route falls back to the override index.html');
    for (const bad of ['/leak.txt', '/leakdir/passwd.txt', '/.env', '/.git/config']) {
      const res = await get(bad);
      assert.equal(res.status, 404, bad);
      assert.equal(res.text.includes('secret'), false, bad);
    }
    // Traversal never reaches a file outside the folder: it only gets the app shell.
    assert.match((await get('/%2e%2e/%2e%2e/etc/hosts')).text, /redesign/);
    // Clearing takes effect on the next request, with no restart.
    run(['customer-dist', '--clear']);
    assert.doesNotMatch((await get('/')).text, /redesign/);
    run(['customer-dist', good]);
    assert.match((await get('/')).text, /redesign/);
  } finally {
    server.kill('SIGTERM');
  }

  // The shell variable beats the saved choice; a bad one is reported, never silently ignored.
  const other = join(distHome, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'index.html'), '<html></html>');
  plan = JSON.parse(run(['plan', '--json'], { LOCAL_STACK_CUSTOMER_DIST: other }).stdout);
  assert.equal(plan.customer.source, 'env');
  assert.equal(plan.customer.dir, realpathSync(other));
  plan = JSON.parse(run(['plan', '--json'], { LOCAL_STACK_CUSTOMER_DIST: 'relative' }).stdout);
  assert.match(plan.customer.error, /absolute path/);
  assert.equal(plan.customer.wouldBuild, false);

  // --clear returns to the checkout's own build, and the skipped-customer stamp forces a Customer build.
  r = run(['customer-dist', '--clear']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(saved), false);
  plan = JSON.parse(run(['plan', '--json']).stdout);
  assert.equal(plan.customer.source, 'own');
  assert.equal(plan.customer.wouldBuild, true);
} finally {
  rmSync(distHome, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
// The only Customer build call is inside the `!override` guard in ensureBuilt.
assert.match(
  source,
  /if \(!override\) \{\s*say\('  build: customer app…'\);\s*runPnpm\(\['--filter', '@intafaced\/customer\.\.\.', 'build'\], 'build-customer'\);/,
);
assert.equal(source.split("'build-customer'").length - 1, 1, 'one place builds the Customer app');
console.log('local-test-stack: customer folder override checks passed');

// 9. The test market maker is part of `status`, and start / restart bring it back if it was running before.
{
  const mkHome = mkdtempSync(join(tmpdir(), 'local-test-stack-market-'));
  try {
    const state = join(mkHome, '.intafaced', 'local-test-stack');
    const status = () => spawnSync(process.execPath, [script, 'status'], { env: homeEnv(mkHome), encoding: 'utf8' });
    // Never started: shown, and not an error by itself.
    assert.match(status().stdout, /market-maker\s+-\s+-\s+not started/);
    // Started once, process gone: DOWN, and `status` exits non-zero so a script or a glance notices.
    mkdirSync(join(state, 'run'), { recursive: true });
    writeFileSync(join(state, 'run', 'market.json'), JSON.stringify({ pid: 99998, startedAt: '2026-10-14T00:00:00.000Z' }));
    const down = status();
    assert.match(down.stdout, /market-maker\s+-\s+99998\s+DOWN \(was running/);
    assert.equal(down.status, 1);
  } finally {
    rmSync(mkHome, { recursive: true, force: true });
  }
  // start (and restart, which ends in start) calls ensure after the services are up; it never starts one that was never started.
  // The founder console starts after the Customer app, the invitation site, the apex site and the host check, and before
  // the market check, and stops first.
  assert.match(
    source,
    /if \(!only \|\| only\.includes\('customer'\)\) await startCustomer\(\);\s*if \(!only \|\| only\.includes\('invitation'\)\) await startInvitation\(\);\s*if \(!only \|\| only\.includes\('apex'\)\) await startApex\(\);\s*if \(!only \|\| HOST_SITES\.some\(\(name\) => only\.includes\(name\)\)\) await checkLocalTestHosts\(\);\s*if \(!only \|\| only\.includes\('admin'\)\) await startAdmin\(secrets\);\s*ensureMarket\(\);/,
  );
  // The TEST chain (local-test-chain.mjs) stops after the services that read it (svc-protocol), before NATS.
  assert.match(
    source,
    /const order = \['admin', 'apex', 'invitation', 'customer', \.\.\.serviceNames\(\)\.reverse\(\), 'chain', 'video-store', 'rail-statements', 'nats'\];/,
  );
  // Its session key is canonical 32-byte base64url (apps/admin/src/lib/founder-session.ts), and it never runs in prod posture.
  assert.match(source, /s\.adminSession = crypto\.randomBytes\(32\)\.toString\('base64url'\);/);
  assert.match(source, /APP_ENV: 'dev',/);
  assert.match(source, /async function cmdRestart[\s\S]*?await cmdStart\(\[\]\);/);
  assert.match(source, /local-test-market\.mjs'\), 'ensure'\]/);
  console.log('local-test-stack: market supervision checks passed');
}

// /ws: blank CUSTOMER_WS_URL names the missing upstream (the upgrade body is the same JSON, not an empty 503); set, the
// Customer server proxies /ws/* to it with the prefix stripped, HTTP and WebSocket upgrade alike.
{
  const freePort = () =>
    new Promise((ok) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const pt = typeof address === 'object' && address ? address.port : 0;
        probe.close(() => ok(pt));
      });
    });
  const serve = async (wsUrl) => {
    const home = mkdtempSync(join(tmpdir(), 'local-test-stack-ws-'));
    const port = await freePort();
    const server = spawn(process.execPath, [script, '__serve-customer', String(port)], {
      env: homeEnv(home, { CUSTOMER_WS_URL: wsUrl }),
      stdio: 'ignore',
    });
    const get = async (path) => {
      for (let i = 0; i < 50; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { host: `127.0.0.1:${port}` } });
          return { status: res.status, text: await res.text() };
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      throw new Error('throwaway server did not answer');
    };
    const upgrade = (path) =>
      new Promise((resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1',
          port,
          path,
          method: 'GET',
          headers: {
            Host: `127.0.0.1:${port}`,
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          },
        });
        // The first bytes after the 101 may already be in `head`, so read them there before waiting on the socket.
        req.on('upgrade', (res, socket, head) => {
          const done = (chunk) => {
            socket.destroy();
            resolve({ status: res.statusCode, text: chunk.toString('utf8') });
          };
          if (head.length) done(head);
          else socket.once('data', done);
        });
        req.on('response', (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
      });
    const stop = () => {
      server.kill('SIGTERM');
      rmSync(home, { recursive: true, force: true });
    };
    return { get, upgrade, stop };
  };

  const blank = await serve('');
  try {
    const http = await blank.get('/ws/stream');
    assert.equal(http.status, 503);
    const body = JSON.parse(http.text);
    assert.equal(body.code, 'ws.upstream_unset');
    assert.equal(body.key, 'CUSTOMER_WS_URL');
    assert.match(body.message, /CUSTOMER_WS_URL is not wired/);
    const upgrade = await blank.upgrade('/ws/stream');
    assert.equal(upgrade.status, 503);
    assert.equal(upgrade.text.length > 0, true);
    const upgradeBody = JSON.parse(upgrade.text);
    assert.equal(upgradeBody.key, 'CUSTOMER_WS_URL');
    assert.equal(upgradeBody.code, 'ws.upstream_unset');
    console.log('local-test-stack: blank /ws refusal names CUSTOMER_WS_URL');
  } finally {
    blank.stop();
  }

  // A stand-in upstream that answers each request with the path it saw, and upgrades /stream by writing one frame-free line.
  const seen = [];
  const upstream = createHttpServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url }));
  });
  upstream.on('upgrade', (req, socket) => {
    seen.push(`upgrade ${req.url}`);
    if (req.url.endsWith('&channel=chunked')) {
      socket.end(
        'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nbad\r\n8\r\n chunked\r\n0\r\n\r\n',
      );
      return;
    }
    if (req.url !== '/stream?market=BTC-USDT') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 11\r\n\r\nbad channel');
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.write(`hello ${req.url}`);
  });
  await new Promise((ok) => upstream.listen(0, '127.0.0.1', ok));
  const wired = await serve(`http://127.0.0.1:${upstream.address().port}`);
  try {
    const http = await wired.get('/ws/streams');
    assert.equal(http.status, 200);
    assert.deepEqual(JSON.parse(http.text), { path: '/streams' });
    const upgraded = await wired.upgrade('/ws/stream?market=BTC-USDT');
    assert.deepEqual(upgraded, { status: 101, text: 'hello /stream?market=BTC-USDT' });
    const refused = await wired.upgrade('/ws/stream?market=BTC-USDT&channel=balance');
    assert.deepEqual(refused, { status: 400, text: 'bad channel' });
    // A chunked refusal reaches the client whole, not as a chunked frame Node has already undone.
    const chunked = await wired.upgrade('/ws/stream?market=BTC-USDT&channel=chunked');
    assert.deepEqual(chunked, { status: 400, text: 'bad chunked' });
    assert.deepEqual(seen, [
      '/streams',
      'upgrade /stream?market=BTC-USDT',
      'upgrade /stream?market=BTC-USDT&channel=balance',
      'upgrade /stream?market=BTC-USDT&channel=chunked',
    ]);
    console.log('local-test-stack: wired /ws proxies HTTP and upgrades with the prefix stripped');
  } finally {
    wired.stop();
    upstream.close();
  }
}

// The /api/ proxy keeps the status badge's own cache life, as nginx does, and stays no-store everywhere else.
{
  const { apiCacheControl } = await import('./local-test-stack.mjs');
  assert.equal(apiCacheControl('/api/notify/status/badge.svg', 'public, max-age=120'), 'public, max-age=120');
  assert.equal(apiCacheControl('/api/notify/status/badge.svg', 'no-cache, max-age=0'), 'no-cache, max-age=0');
  assert.equal(apiCacheControl('/api/notify/status/badge.svg', undefined), 'no-store');
  assert.equal(apiCacheControl('/api/notify/status/badge.svg', ''), 'no-store');
  for (const path of [
    '/api/notify/trpc/statusPage.badge',
    '/api/notify/status/badge.svg/',
    '/api/notify/status/badge.svgx',
    '/api/trade/trpc/orders.list',
  ]) {
    assert.equal(apiCacheControl(path, 'public, max-age=120'), 'no-store', path);
  }
}

// The Customer site carries the production security headers, and the browser's CSP reports are recorded and fail the run.
{
  const { customerSecurityHeaders, cspReportRows } = await import('./local-test-stack.mjs');
  const headers = customerSecurityHeaders();
  assert.match(headers['Content-Security-Policy'], /^default-src 'self'; script-src 'self';/);
  assert.match(headers['Content-Security-Policy'], /font-src 'self';/);
  assert.match(
    headers['Content-Security-Policy'],
    /media-src 'self' blob: http:\/\/127\.0\.0\.1:\d+;/,
    'the TEST video store stands in for the storage origin',
  );
  assert.match(headers['Content-Security-Policy'], /; report-uri \/__csp-report$/);
  assert.equal(headers['X-Frame-Options'], 'DENY');
  const legacy = cspReportRows(
    JSON.stringify({
      'csp-report': {
        'effective-directive': 'script-src-elem',
        'blocked-uri': 'inline',
        'document-uri': 'http://127.0.0.1:3210/home?x=1',
        'line-number': 3,
      },
    }),
    't',
  );
  assert.deepEqual(legacy, [
    { at: 't', directive: 'script-src-elem', blocked: 'inline', page: 'http://127.0.0.1:3210/home', source: '', line: 3, sample: '' },
  ]);
  const modern = cspReportRows(
    JSON.stringify([
      {
        type: 'csp-violation',
        body: { effectiveDirective: 'font-src', blockedURL: 'https://fonts.example/x.woff2', documentURL: 'http://127.0.0.1:3210/' },
      },
    ]),
    't',
  );
  assert.equal(modern[0].directive, 'font-src');
  assert.deepEqual(cspReportRows('not json'), []);

  const home = mkdtempSync(join(tmpdir(), 'local-test-stack-csp-'));
  const port = await new Promise((ok) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: pt } = probe.address();
      probe.close(() => ok(pt));
    });
  });
  // LOCAL_STACK_STATE would point the throwaway server at a running stack's record: send it to the temp folder.
  const env = { ...process.env, HOME: home, LOCAL_STACK_STATE: join(home, 'state') };
  const server = spawn(process.execPath, [script, '__serve-customer', String(port)], {
    env,
    stdio: 'ignore',
  });
  const report = (args) => spawnSync(process.execPath, [script, 'csp-report', ...args], { env, encoding: 'utf8' });
  try {
    let res;
    for (let i = 0; i < 50 && !res; i++) {
      try {
        res = await fetch(`http://127.0.0.1:${port}/some/room`);
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(res, 'throwaway server answered');
    assert.match(
      res.headers.get('content-security-policy') ?? '',
      /script-src 'self'/,
      'the app shell carries the CSP, even with no build',
    );
    assert.equal(report(['--fail']).status, 0, 'no violations yet');
    const posted = await fetch(`http://127.0.0.1:${port}/__csp-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report' },
      body: JSON.stringify({
        'csp-report': { 'effective-directive': 'script-src-elem', 'blocked-uri': 'inline', 'document-uri': `http://127.0.0.1:${port}/` },
      }),
    });
    assert.equal(posted.status, 204);
    const red = report(['--fail']);
    assert.equal(red.status, 1, 'a recorded violation fails the run');
    assert.match(red.stdout, /script-src-elem blocked inline/);
    assert.equal(report(['--clear']).status, 0);
    assert.equal(report(['--fail']).status, 0, 'cleared');
    console.log('local-test-stack: real CSP served, violations recorded and failing');
  } finally {
    server.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  }
}
