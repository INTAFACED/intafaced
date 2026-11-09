// The facts of the local test stack that the journeys need: its state folder, the TEST browser key and its cookies,
// file names in the state folder, the TEST chain's id and gate, and seeded TEST values. Plain values and a folder rule,
// with node built-ins as the only imports, so the journeys depend on these facts and on none of the stack's code
// (docs/runbooks/harness-rewrite-plan.md, piece 3). The stack's own scripts re-export each one from here, under the same
// name, so nothing else changes. Failure it prevents: a journey importing a stack script for one constant took in that
// script's code (local-stack-services/bank.mjs brought owner-settings.mjs), so every change to it reached every step.
// Every value here is a LOCAL TEST value with no meaning outside the stack.
import os from 'node:os';
import path from 'node:path';

// ── The state folder (local-test-state.mjs) ─────────────────────────────────

/**
 * One state root for the stack and every helper. Never silently fall back after a typo. As root, set it outside root's
 * home (for example /var/lib/intafaced/local-test-stack): the database's OS user (localPgOsUser) cannot enter /root.
 */
export function localStackState(home = os.homedir(), env = process.env) {
  if (env.LOCAL_STACK_STATE === undefined) return path.join(home, '.intafaced', 'local-test-stack');
  const state = env.LOCAL_STACK_STATE;
  if (!state.trim() || !path.isAbsolute(state)) throw new Error('LOCAL_STACK_STATE must be an absolute folder path');
  return path.resolve(state);
}

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
/** Every port the chains hold, the second network's included, so the stack's in-use check covers them all. */
export const CHAIN_PORTS = { gate: 14530, anvil: 14531, control: 14532, secondGate: 14533, secondAnvil: 14534, relay: 14535 };
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
