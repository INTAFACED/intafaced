// The facts of the local test stack that the journeys need: its state folder, the TEST browser key and its cookies,
// file names in the state folder, the TEST chain's id and gate, and seeded TEST values. Plain values and a folder rule,
// with node built-ins as the only imports, so the journeys depend on these facts and on none of the stack's code
// (docs/runbooks/harness-rewrite-plan.md, piece 3). The stack's own scripts re-export each one from here, under the same
// name, so nothing else changes. Failure it prevents: a journey importing a stack script for one constant took in that
// script's code (local-stack-services/bank.mjs brought owner-settings.mjs), so every change to it reached every step.
// Every value here is a LOCAL TEST value with no meaning outside the stack.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── The state folder (local-test-state.mjs) ─────────────────────────────────

/**
 * One state root for the stack and every helper. Never silently fall back after a typo. As root, set it outside root's
 * home (for example /var/lib/intafaced/local-test-stack): the database's OS user (localPgOsUser) cannot enter /root.
 */
export function localStackState(home = os.homedir(), env = process.env) {
  if (env.LOCAL_STACK_STATE === undefined) {
    const slot = localStackSlot(env, home);
    return path.join(home, '.intafaced', slot ? `local-test-stack-${slot}` : 'local-test-stack');
  }
  const state = env.LOCAL_STACK_STATE;
  if (!state.trim() || !path.isAbsolute(state)) throw new Error('LOCAL_STACK_STATE must be an absolute folder path');
  return path.resolve(state);
}

// ── Which stack on this machine: its slot ──────────────────────────────────

/**
 * Up to four stacks run side by side on one machine, one per slot. Slot 0 is the stack as it always was: the ports
 * below, the state folder above and /tmp/intafaced-real-app. Slot n adds n × 1000 to every port and takes its own state
 * folder (local-test-stack-<n>) and run folder (/tmp/intafaced-real-app-<n>). A start takes the first free slot itself and
 * claims it for its checkout in ~/.intafaced/slots/<n>.json, the moment it begins (local-test-stack.mjs takeSlot); every
 * script and journey run from that checkout then reads the slot from that claim. LOCAL_STACK_SLOT names one by hand.
 */
export const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SLOTS = [0, 1, 2, 3];
const slotFile = (slot, home = os.homedir()) => path.join(home, '.intafaced', 'slots', `${slot}.json`);
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};
const readJsonOr = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
/**
 * The one record of every process a state folder's stack started, by name: each service `local-test-stack.mjs` starts
 * and the TEST market maker `local-test-market.mjs` starts (`market`). The owner test (`stackPids`), `stop` and the
 * market's own commands all read this, so a process the stack started can never read as someone else's. Failure it
 * prevents: the market kept its pid in a file of its own, so a finished build's stack read as owned for as long as its
 * market ran (slots 0 and 1 held 21 and 19 hours on 17 Nov), and `stop` left the market running.
 */
export const stackRecordsFile = (state) => path.join(state, 'run', 'processes.json');
// Before the market's record moved here it lived in run/market.json; a stack started then is still read whole.
// Drop this fallback once no running stack predates it (after 2026-12-01).
const legacyMarketFile = (state) => path.join(state, 'run', 'market.json');

export function stackRecords(state) {
  const records = readJsonOr(stackRecordsFile(state), {}) ?? {};
  if (!records.market) {
    const legacy = readJsonOr(legacyMarketFile(state), null);
    if (Number.isInteger(legacy?.pid)) records.market = legacy;
  }
  return records;
}

/**
 * Sets (or with null, removes) one process's record in `stackRecords`, written whole through a rename so a reader never
 * sees half a file. Returns the records written.
 */
export function writeStackRecord(state, name, rec) {
  const records = stackRecords(state);
  if (rec) records[name] = rec;
  else delete records[name];
  writeStackRecords(state, records);
  if (name === 'market') fs.rmSync(legacyMarketFile(state), { force: true });
  return records;
}

/** Writes the whole of `stackRecords` through a rename. */
export function writeStackRecords(state, records) {
  const file = stackRecordsFile(state);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The PIDs a state folder's stack runs: every process in its one record (`stackRecords`) and its Postgres. */
export function stackPids(state) {
  const procs = Object.values(stackRecords(state)).map((r) => r?.pid);
  let pg = null;
  try {
    pg = Number(fs.readFileSync(path.join(state, 'data', 'postgres', 'postmaster.pid'), 'utf8').split('\n')[0]);
  } catch {}
  return [...procs, pg].filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * Each slot's claim: the checkout, the start's PID and the state folder, and whether it is live. A claim is live while
 * its start runs or its stack has a process left; a start killed mid-build and a stack that died leave a dead claim,
 * which the next start takes over.
 */
export function slotClaims(home = os.homedir()) {
  return SLOTS.map((slot) => {
    const claim = readJsonOr(slotFile(slot, home), null);
    return { slot, claim, live: Boolean(claim) && [claim.pid, ...stackPids(claim.state ?? '')].some(alive) };
  });
}

/**
 * Claims `slot` for this checkout, atomically: true when it is now this checkout's. Two starts that both see a dead
 * claim move it aside under their own names, and only one of them then creates the file (`wx`).
 */
export function claimSlot(slot, { state, pid = process.pid, owner = null, home = os.homedir() }) {
  const file = slotFile(slot, home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const mine = JSON.stringify({ repo: CHECKOUT, pid, state, takenAt: new Date().toISOString(), ...(owner ? { owner } : {}) });
  const now = slotClaims(home)[slot];
  if (now.claim?.repo === CHECKOUT) {
    fs.writeFileSync(file, mine, { mode: 0o600 });
    return true;
  }
  if (now.claim && now.live) return false;
  if (now.claim)
    try {
      fs.renameSync(file, `${file}.${pid}.dead`);
      fs.rmSync(`${file}.${pid}.dead`, { force: true });
    } catch {
      return false;
    }
  try {
    fs.writeFileSync(file, mine, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Lets go of `slot`'s claim when it is still exactly `claim` and nothing of its stack is left (a gone owner's, reaped). */
export function dropClaim(slot, claim, home = os.homedir()) {
  const now = slotClaims(home)[slot];
  if (now.live || !now.claim || now.claim.repo !== claim.repo || now.claim.pid !== claim.pid) return false;
  fs.rmSync(slotFile(slot, home), { force: true });
  return true;
}

/** Lets this checkout's slot go (a full `stop`). */
export function releaseSlot(home = os.homedir()) {
  for (const { slot, claim } of slotClaims(home)) if (claim?.repo === CHECKOUT) fs.rmSync(slotFile(slot, home), { force: true });
}

/** LOCAL_STACK_SLOT when set; else the slot this checkout's claim holds; else 0. */
export function localStackSlot(env = process.env, home = os.homedir()) {
  if (env.LOCAL_STACK_SLOT !== undefined) {
    if (!/^[0-3]$/.test(env.LOCAL_STACK_SLOT)) throw new Error('LOCAL_STACK_SLOT must be 0, 1, 2 or 3');
    return Number(env.LOCAL_STACK_SLOT);
  }
  return slotClaims(home).find((c) => c.claim?.repo === CHECKOUT)?.slot ?? 0;
}
/**
 * Why this checkout must not act on the stack its slot points at, or null. A checkout that holds no claim reads slot 0,
 * and when slot 0 is another checkout's live stack, a journey run or a stack command here would act on that stack: its
 * ports, its data and its run folder (Playwright empties `<run folder>/results` as it begins). Failure it prevents: on
 * 15 Nov, with all four slots held, a journey run from a checkout whose start was refused ran against slot 0's stack.
 */
export function anotherCheckoutsStack(env = process.env, home = os.homedir()) {
  if (env.LOCAL_STACK_SLOT !== undefined || env.LOCAL_STACK_STATE !== undefined) return null;
  const claims = slotClaims(home);
  if (claims.some((c) => c.claim?.repo === CHECKOUT)) return null;
  const zero = claims[0];
  if (!zero.claim || !zero.live || zero.claim.repo === CHECKOUT) return null;
  const free = claims.filter((c) => !(c.claim && c.live)).map((c) => c.slot);
  return (
    `refusing: this checkout has no stack of its own, and slot 0 is ${zero.claim.repo}'s (pid ${zero.claim.pid}). ` +
    (free.length
      ? `Start yours first: pnpm local:stack takes a free slot (${free.join(', ')} free now).`
      : "Every slot is held now; prove the journey on CI's stack instead (Real-app journeys, workflow_dispatch with journeys).")
  );
}
// The stack's one table of ports, before the slot's shift. Every script and journey reads a port from here.
const BASE_PORTS = {
  postgres: 15460,
  nats: 14232,
  natsMonitor: 18232,
  edge: 14500,
  ledger: 14501,
  identity: 14502,
  trade: 14504,
  matching: 14505,
  pay: 14506,
  bank: 14509,
  // Services the Customer app calls through Edge (More door, Notifications, P2P, Trade tools).
  token: 14503,
  agents: 14507,
  p2p: 14508,
  notify: 14510,
  academy: 14511,
  support: 14512,
  market: 14513,
  blueprint: 14514,
  quant: 14515,
  execution: 14516,
  tax: 14517,
  'mining-pool': 14518,
  // The outreach intake behind the invitation site, and the founders' CRM.
  ops: 14519,
  // The Web3 rooms' read side; its RPC is the TEST chain's gate (local-test-chain.mjs, 14530-14532) when anvil is found.
  protocol: 14520,
  // The chain explorer's read model; follows the TEST chain through the same gate (local-stack-services/indexer.mjs).
  indexer: 14524,
  // The Protocol plane's order door: the wallet-signed order session and the person's own vault orders (J-dex-protocol-10).
  dex: 14529,
  // LOCAL TEST stand-in for the object store Academy signs video URLs for (local-video-store.mjs).
  'video-store': 14521,
  // Seasons, limited drops and the TGE claim (the drop room).
  campaigns: 14522,
  // The live market-data and private streams the Customer app opens through /ws.
  ws: 14523,
  // LOCAL TEST statements of each rail stand-in's own records, read by svc-ledger's per-rail outside controls
  // (local-test-rail-statements.mjs).
  'rail-statements': 14525,
  // The LOCAL TEST venue simulator behind svc-trade's user-venue door (local-test-venue.mjs). Started only with
  // LOCAL_STACK_USER_VENUE=on (userVenueOn).
  'test-venue': 14560,
  // The second LOCAL TEST venue (J-derivatives-28, routing over two venues). Started only with LOCAL_STACK_USER_VENUE=two.
  'test-venue-b': 14562,
  // The LOCAL TEST embedded-wallet provider (local-test-wallet-provider.mjs, J-wallet-22): svc-protocol's provider on
  // this stack. It holds its TEST keys in its own state file, never in a svc-* database. Always started with protocol.
  'test-wallet-provider': 14561,
  // The FIX adapter (svc-fix, Java): its HTTP listener (health, drop-copy ingest, the adapter status). Its two FIX
  // sockets are FIX_SOCKET_PORTS, kept out of this table: one key here is one service (the marker's inventory).
  fix: 14526,
  customer: 3210,
  invitation: 3220,
  // LOCAL TEST stand-in for the apex host (the host check); the real apex site is not in this repo.
  apex: 3260,
  admin: 3100,
  // LOCAL TEST HTTPS front for the founder console (local-test-team-tls.mjs): the Customer build's Team link.
  'team-tls': 3143,
};
/** svc-fix's order-entry and drop-copy FIX sockets (local-stack-services/fix.mjs): ports of the fix service, not services. */
const BASE_FIX_SOCKET_PORTS = { orderEntry: 14527, dropCopy: 14528 };
/** The TEST webhook receivers the journeys run on the stack's machine (svc-notify allows the alert one). */
const BASE_HOOK_PORTS = { alert: 14590, developer: 14591 };
/** Every port the chains hold, the second network's included, so the stack's in-use check covers them all. */
const BASE_CHAIN_PORTS = { gate: 14530, anvil: 14531, control: 14532, secondGate: 14533, secondAnvil: 14534, relay: 14535 };

/** Every port one slot's stack holds, table by table. */
export function slotPorts(slot) {
  const shift = (ports) => Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, port + 1000 * slot]));
  return {
    stack: shift(BASE_PORTS),
    fixSockets: shift(BASE_FIX_SOCKET_PORTS),
    hooks: shift(BASE_HOOK_PORTS),
    chain: shift(BASE_CHAIN_PORTS),
  };
}
const SLOT = localStackSlot();
const PORTS_NOW = slotPorts(SLOT);
export const STACK_PORTS = PORTS_NOW.stack;
export const FIX_SOCKET_PORTS = PORTS_NOW.fixSockets;
export const HOOK_PORTS = PORTS_NOW.hooks;
export const CHAIN_PORTS = PORTS_NOW.chain;
/** The slot for a child given a clean environment: nothing when unset, so slot 0's children run as they always did. */
export const slotEnv = () => (process.env.LOCAL_STACK_SLOT === undefined ? {} : { LOCAL_STACK_SLOT: process.env.LOCAL_STACK_SLOT });
/** `http://127.0.0.1:<port>` of one stack part, by its name in STACK_PORTS. */
export const stackUrl = (name, host = '127.0.0.1') => `http://${host}:${STACK_PORTS[name]}`;
/** The journeys' folder for results, report and run files (JOURNEY_RUN_DIR, JOURNEY_REPORT and --output move parts of it). */
export const JOURNEY_TMP = SLOT ? `/tmp/intafaced-real-app-${SLOT}` : '/tmp/intafaced-real-app';

// ── The TEST browser key (local-test-device.mjs) ────────────────────────────

// The one TEST browser key the local stack's journeys sign in with (I-signin-sessions-07). Identity trusts a browser by
// its device key; every journey context, and every scripted sign-in that stands for the same person, presents this one,
// so a journey account is asked to authorise a device only where a journey means to ask (J-identity-02 #5 clears it).
// It is a LOCAL TEST value with no meaning outside the stack: identity keeps only its hash, per account.
export const LOCAL_TEST_DEVICE_KEY = 'LOCAL-TEST-journey-browser-device-key';

/**
 * The device cookie as a Playwright storage state, for the customer app on the stack: on 127.0.0.1 and on localhost
 * (the passkey journeys' origin), since a cookie belongs to one host name.
 */
export function localTestDeviceState(hosts = ['127.0.0.1', 'localhost']) {
  return {
    cookies: hosts.map((domain) => ({
      name: 'ifc_dk',
      value: LOCAL_TEST_DEVICE_KEY,
      domain,
      path: '/api/identity/trpc',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    })),
    origins: [],
  };
}

/** The same cookie as a `Set-Cookie` value, for a door that hands the stack's TEST browser key to a visitor (Try it). */
export function localTestDeviceCookie({ secure = false } = {}) {
  return `ifc_dk=${LOCAL_TEST_DEVICE_KEY}; Path=/api/identity/trpc; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? '; Secure' : ''}`;
}

/**
 * The founder console's own device cookie (apps/admin), holding the same TEST key, as a Playwright cookie for `adminUrl`'s
 * host. It is given by domain and path: Chromium refuses a Secure cookie given with an http URL, but sends it to http on
 * 127.0.0.1 and localhost.
 */
export function localTestAdminDeviceCookie(adminUrl) {
  return {
    name: '__Host-intafaced-admin-device',
    value: LOCAL_TEST_DEVICE_KEY,
    domain: new URL(adminUrl).hostname,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
  };
}

// ── File names in the state folder ──────────────────────────────────────────

/** The founders' vault (local-test-founders.mjs). */
export const FOUNDER_VAULT_NAME = 'founders.json';
/** The stack identity's LOCAL-TEST mail file (local-test-entry.mjs; tooling/scripts/local-stack-services/identity.mjs). */
export const OUTBOX_NAME = 'email-outbox.log';

// ── The TEST chain (local-test-chain.mjs) ───────────────────────────────────

export const CHAIN_HOST = '127.0.0.1';
/** The app's network id (apps/customer/src/features/protocol/wallet/eip1193.ts APP_CHAIN_ID). */
export const TEST_CHAIN_ID = 84532;
export const GATE_URL = `http://${CHAIN_HOST}:${CHAIN_PORTS.gate}`;
/** What the seed put on the chain (addresses), written by `serve`'s seed step; absent when no chain runs. */
export const chainRecordPath = (state = localStackState()) => path.join(state, 'test-chain.json');

// ── Seeded TEST values ──────────────────────────────────────────────────────

// The founder's Home content (local-test-home.mjs, HM-desks-03, J-home-ia-11 #3).
export const HOME_ASSET = 'USDT';
export const HOME_NETWORK = 'ethereum';
export const HOME_DEPOSIT_AMOUNT = '100';
/** The published minimum on TEST Ethereum is 6 confirmations (local-test-gates.mjs TEST_DEPOSIT_TERMS). */
export const HOME_DEPOSIT_CONFIRMATIONS = 6;
/** One fixed transfer: the same label to the same address is the same chain event (local-test-stack.mjs chainTxHash). */
export const HOME_DEPOSIT_LABEL = 'LOCAL-TEST-seed-home-deposit-v1';
export const HOME_NOTICE_TITLE = 'TEST · This is a test build';
export const HOME_NOTICE_BODY = 'TEST notice from the tester seed. Balances here are TEST funds, not real money.';
/** The TEST notice stays open as long as a test stack is likely to live, unless the caller asks for a shorter window. */
export const HOME_NOTICE_DAYS = 30;

/** LOCAL TEST sanctioned destination, not a real list (J-wallet-05 #2; local-stack-services/bank.mjs). */
export const LOCAL_TEST_SANCTIONED_ADDRESS = '0x5a7c7100000000000000000000000000000ba5ed';
