import { createHash } from 'node:crypto';
import { createPublicClient, erc20Abi, http, keccak256, toHex } from 'viem';
import { GATE_URL } from '../../../../tooling/scripts/local-test-facts.mjs';
import { privateKeyToAccount } from 'viem/accounts';
import { expect } from './journey.mjs';
import { restartWithSetting, stackUrl, toUnits } from './stack.mjs';
import { signIn } from './desk.mjs';
import { installTestWallet } from './test-wallet.mjs';
import { connectWhenAsked } from './dex.mjs';
import { HL_TRADER_KEY_ENV, HyperliquidFileError, hlLiveKey, hyperliquidFileRun } from './hl-file-run.mjs';

// What the venue journeys (J-derivatives-01-venue; J-cex-spot-01 had one until its own file covered its venue steps) share: svc-trade's user-venue door switched on
// for one file and off after it, the stack's LOCAL TEST venue simulator (tooling/scripts/local-test-venue.mjs) reached
// on loopback for its TEST controls and as the other TEST trader, and the desk opened with the browser TEST wallet.
// Every figure the TEST venue reports is TEST.

/** The stack's TEST venue (local-test-stack.mjs PORTS['test-venue']). */
export const TEST_VENUE = stackUrl('test-venue');
/** The setting that points svc-trade's door at it (tooling/scripts/local-stack-services/trade.mjs). */
const SWITCH = 'LOCAL_STACK_USER_VENUE';

/**
 * Turns the door on for this file and always off after it, so every other file in the shard sees the door off. Trade's
 * restart with the setting on also starts the TEST venue (local-test-stack.mjs `cmdStart`); off, the venue may keep
 * running, and trade no longer points at it. A worker that exits before afterAll (an uncaught error, process.exit)
 * switches the door off on its way out, so the next file in the shard does not start with it on. A worker killed outright
 * (SIGKILL, out of memory) runs no handler, so that case is not covered.
 */
export function venueForThisFile(test, value = 'on', { recording = null, trader = null } = {}) {
  let on = false;
  const hl = hyperliquidFileSettings(value, recording, trader);
  const offOnExit = () => {
    if (!on) return;
    on = false;
    try {
      restartWithSetting('trade', SWITCH, 'off');
    } catch {
      /* the worker is exiting: a failed switch-off has no one left to report to */
    }
  };
  test.beforeAll(() => {
    test.setTimeout(240_000);
    on = true;
    process.once('exit', offOnExit);
    // `on` is the one TEST venue; `two` adds the second (J-derivatives-28), started and stopped the same way.
    // `hl-recorded` and `hl-testnet` are Hyperliquid's test network, replayed from this file's recording or live and
    // recorded into it, for the address the file's wallet signs as.
    withSettings(hl, () => restartWithSetting('trade', SWITCH, value));
  });
  test.afterAll(async () => {
    test.setTimeout(240_000);
    // A replayed file fails on every request its recording had no answer for, by its key, even one no step checked.
    // Read before the switch-off and checked after it, so a miss never leaves the door on for the next file.
    const misses = value === 'hl-recorded' ? (await venueOk(TEST_VENUE, '/replay/misses')).misses : [];
    restartWithSetting('trade', SWITCH, 'off');
    on = false;
    process.off('exit', offOnExit);
    expect(misses, 'requests the Hyperliquid recording has no answer for').toEqual([]);
  });
}

/** The funded test-network wallet an `hl-testnet` file signs with (hl-file-run.mjs `hlLiveKey`). Never printed. */
const hlLiveTrader = (env = process.env) => privateKeyToAccount(hlLiveKey(env));

/**
 * A venue file that opts in to Hyperliquid's test network under its recording's name (hl-file-run.mjs
 * `hyperliquidFileRun`): live on main's daily run (.github/workflows/hl-venue-daily.yml finds the files that call this),
 * replayed strictly from its recording everywhere else, and on the TEST venue simulator until its first recording lands.
 * Returns `{ kind, key, trader }`: the wallet key the file signs with, null on the simulator (the file keeps its own).
 */
export function hyperliquidForThisFile(test, recording) {
  const run = hyperliquidFileRun(recording);
  if (run.kind === 'on') {
    venueForThisFile(test, 'on');
    test.beforeAll(() => {
      console.warn(
        `hl_recording_pending: no Hyperliquid recording "${recording}" yet, so this file runs on the TEST venue simulator until the daily run adds it`,
      );
    });
  } else venueForThisFile(test, run.kind, { recording, trader: run.trader });
  return run;
}

/**
 * The settings a Hyperliquid file restarts trade with (local-test-venue.mjs `hlSource`): its recording's name and the
 * address its wallet signs as. Null on the simulator. A Hyperliquid file must name both.
 */
function hyperliquidFileSettings(value, recording, trader) {
  if (value !== 'hl-recorded' && value !== 'hl-testnet') return null;
  if (!recording || !trader)
    throw new HyperliquidFileError(
      'hl_file_unnamed',
      `venueForThisFile(${value}) needs { recording, trader }: the recording's name and the wallet address`,
    );
  // Live, the file signs with the funded test-network wallet: no key refuses by name, and the trader must be its address.
  if (value === 'hl-testnet' && hlLiveTrader().address.toLowerCase() !== trader.toLowerCase())
    throw new HyperliquidFileError('hl_live_trader_mismatch', `hl-testnet records for ${HL_TRADER_KEY_ENV}'s address, not ${trader}`);
  return { LOCAL_STACK_HL_RECORDING: recording, LOCAL_STACK_HL_TRADER: trader.toLowerCase() };
}

/** `fn` with each setting in the environment, each put back after. */
function withSettings(settings, fn) {
  const saved = Object.fromEntries(Object.keys(settings ?? {}).map((k) => [k, process.env[k]]));
  Object.assign(process.env, settings ?? {});
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** One call to the TEST venue: its JSON answer and status. Amounts travel as decimal strings. */
export async function testVenue(path, body) {
  return testVenueAt(TEST_VENUE, path, body);
}

/**
 * A read sent again once when the keep-alive socket it went out on had already been closed by the venue
 * (`SocketError: other side closed`, as after a stack restart left the connection idle). Only a GET: it changes
 * nothing, so sending it twice can't double anything. A write is never sent again here.
 */
async function venueFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init.method !== 'GET' || err?.cause?.code !== 'UND_ERR_SOCKET') throw err;
    return fetch(url, init);
  }
}

/** The stack's second TEST venue (local-test-stack.mjs PORTS['test-venue-b']), on with LOCAL_STACK_USER_VENUE=two. */
export const TEST_VENUE_B = stackUrl('test-venue-b');

/** A TEST venue's id and name, by its base URL, with the base it was read at. */
export async function testVenueInfoAt(base) {
  const { status, body } = await testVenueAt(base, '/venue');
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  expect(body.label).toBe('TEST');
  return { id: body.venue.id, displayName: body.venue.displayName, base };
}

/** One call to either TEST venue by its base URL. */
export async function testVenueAt(base, path, body) {
  const res = await venueFetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** One call to either TEST venue that must answer 200: its JSON answer (a refusal fails the step with its words). */
export async function venueOk(base, path, body) {
  const { status, body: out } = await testVenueAt(base, path, body);
  expect(status, JSON.stringify(out).slice(0, 300)).toBe(200);
  return out;
}

/** The venue's id and the chain its signatures name. */
export async function venueInfo() {
  const { status, body } = await testVenue('/venue');
  expect(status, JSON.stringify(body)).toBe(200);
  expect(body.label).toBe('TEST');
  return { id: body.venue.id, chainId: body.chainId, displayName: body.venue.displayName };
}

export const venueAccount = async (owner) => ({ venueId: (await venueInfo()).id, owner: owner.toLowerCase(), subAccount: null });

/**
 * The venue's own record for `owner`, read directly (what the desk must equal). `base` is the TEST venue read: the
 * first by default, or TEST_VENUE_B for a journey that routes across both. `subAccount` reads one of the owner's
 * sub-accounts instead of the main account.
 */
export async function venueRecord(owner, path, extra = {}, base = TEST_VENUE, subAccount = null) {
  const at = await testVenueAt(base, '/venue');
  expect(at.status, JSON.stringify(at.body)).toBe(200);
  expect(at.body.label).toBe('TEST');
  const account = { venueId: at.body.venue.id, owner: owner.toLowerCase(), subAccount };
  const { status, body } = await testVenueAt(base, path, { account, ...extra });
  expect(status, JSON.stringify(body)).toBe(200);
  return body;
}

/**
 * TEST funding of a venue account by its TEST deposit control, keyed by a chain-transfer-shaped reference
 * (`<chainId>:<txHash>:<logIndex>`), so a replay of the same reference credits nothing.
 */
export async function testDeposit(owner, asset, amount, depositRef) {
  const { status, body } = await testVenue('/test/deposit', { account: await venueAccount(owner), asset, amount, depositRef });
  expect(status, JSON.stringify(body)).toBe(200);
  return body.credited;
}

/** A TEST key for another TEST trader, derived from a public name: it holds nothing outside the TEST venue's memory. */
export const otherTraderKey = (name) => privateKeyToAccount(keccak256(toHex(`intafaced TEST venue journey trader ${name}`)));

/** The other TEST trader signs and sends one action on the TEST venue directly, as an outside participant would. */
export async function otherTraderRun(name, intent) {
  const key = otherTraderKey(name);
  const owner = key.address.toLowerCase();
  const account = await venueAccount(owner);
  const signer = { role: 'owner', address: owner };
  const prepared = await testVenue('/prepare', { account, signer, intent });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const typed = prepared.body.typedData;
  const signature = await key.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  const sent = await testVenue('/submit', {
    prepared: prepared.body,
    signature: { digest: prepared.body.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  return sent.body;
}

/** The plain-words sheet that comes before every wallet prompt, answered: the wallet is then asked. */
export async function continueInWallet(page) {
  const sheet = page.getByRole('dialog', { name: 'Check before you sign' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(sheet).toHaveCount(0);
}

/**
 * Signs in, installs the browser TEST wallet with this run's key on the venue's chain, opens `path` in venue mode and
 * connects the wallet. Returns the wallet (its signature requests are counted).
 */
export async function openVenueDesk(page, who, path, privateKey) {
  const { chainId } = await venueInfo();
  const wallet = await installTestWallet(page, { chainId, privateKey });
  await signIn(page, who);
  await page.goto(path);
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Connect TEST Wallet' }).click();
  await expect(page.getByTestId('venue-wallet-address')).toHaveText(wallet.address);
  return wallet;
}

/**
 * Signs in, installs the browser TEST wallet with this key on the venue's chain, opens a venue page that is not a desk
 * (an order, the order history) and connects the wallet when the page asks. Returns the wallet.
 */
export async function openVenuePage(page, who, path, privateKey) {
  const { chainId } = await venueInfo();
  const wallet = await installTestWallet(page, { chainId, privateKey });
  await signIn(page, who);
  await page.goto(path);
  const address = page.getByTestId('venue-wallet-address');
  await connectWhenAsked(page, address);
  await expect(address).toHaveText(wallet.address.toLowerCase());
  return wallet;
}

/**
 * The desk's own account tab, opened beside its orders: the futures desk's Account (the trading session, the venue
 * balances, what the venue takes as margin) or the spot desk's Balances (the balances, Deposit, Withdraw, Flatten).
 */
export async function openAccountTab(page) {
  const tab = page
    .getByTestId('venue-blotter')
    .getByRole('button', { name: 'Account', exact: true })
    .or(page.getByTestId('venue-bottom').getByRole('tab', { name: 'Balances', exact: true }));
  await expect(tab).toBeVisible({ timeout: 30_000 });
  if ((await tab.getAttribute('aria-pressed')) !== 'true' && (await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(page.getByTestId('venue-balances').or(page.getByTestId('venue-account'))).toBeVisible();
}

/** A balance row of the desk's venue balances: free, used and total as the desk shows them. */
export async function shownBalance(page, asset) {
  await openAccountTab(page);
  const row = page.getByTestId('venue-balances').locator(`tr[data-asset="${asset}"]`);
  await expect(row).toBeVisible();
  const cell = async (name) => (await row.locator(`[data-cell="${name}"]`).innerText()).replace(/,/g, '');
  return { free: await cell('free'), used: await cell('used'), total: await cell('total') };
}

/** A decimal string's exact value, so "1000" and "1000.0" compare equal. */
export function sameDecimal(a, b) {
  const units = (x) => toUnits(String(x).replace(/,/g, '').replace('−', '-').trim());
  return units(a) === units(b);
}

/** The venue's balance of `asset` for `owner`, from its own record (on the TEST venue at `base`). */
export async function venueBalance(owner, asset, base = TEST_VENUE) {
  const body = await venueRecord(owner, '/balances', {}, base);
  return body.value.find((b) => b.asset === asset) ?? { asset, free: '0', locked: '0', total: '0' };
}

// cacheTime 0: viem otherwise answers a read from a 4 s cache, so a figure at a later block could repeat an earlier one.
const testChainClient = createPublicClient({ transport: http(GATE_URL), cacheTime: 0 });

/**
 * A wallet's token balance as the stack's TEST chain itself reports it (read straight through the chain's gate, never
 * through our door or our ledger), at `blockNumber` when given. The outside record for a step whose figure the chain
 * reports, as `venueBalance` is for a step whose figure the TEST venue reports. Raw token units, as a bigint.
 */
export async function chainBalance(token, owner, blockNumber) {
  return testChainClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
}

/**
 * A venue journey's run state: the account and wallet its #1 made, with the wallet's address as `owner`. A later step
 * that finds none fails naming #1, never acting as someone else.
 */
export function venueRunState(run, journey) {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${journey} #1 made no account and wallet, so this step has no one to act as`);
  return { ...s, owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}

/** Every signing write the page sends to the door (prepare, submit), so a step can show nothing was sent. */
export function venueWrites(page) {
  const sent = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (r.method() === 'POST' && (p === '/api/v1/venue/prepare' || p === '/api/v1/venue/submit')) sent.push(p);
  });
  return sent;
}

/** A reply our door accepted: its body, or the step fails with what it said. */
export function doorOk(res) {
  expect(res.status, JSON.stringify(res.body).slice(0, 600)).toBe(200);
  return res.body;
}

/** A prepared venue action signed by a wallet key, in the shape our door's submit takes. */
export async function signPrepared(key, prepared) {
  const t = prepared.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: key.address.toLowerCase() };
}

/** One action the person's own wallet signs, through our door: prepared, signed, sent, and accepted by the venue. */
export async function walletDoorAct(session, key, { subAccount = null, intent, actionKey = null }) {
  const owner = key.address.toLowerCase();
  const prepared = doorOk(
    await session.post('/api/v1/venue/prepare', { owner, subAccount, signer: { role: 'owner', address: owner }, intent, actionKey }),
  );
  const sent = doorOk(
    await session.post('/api/v1/venue/submit', { actionKey: prepared.actionKey, signature: await signPrepared(key, prepared.prepared) }),
  );
  expect(sent.outcome, JSON.stringify(sent.outcome).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  return sent;
}

/** Keys sorted, no spaces: the canonical form svc-trade hashes (services/svc-trade/src/admin/common.ts payloadHash). */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
/** The payload hash svc-trade binds an operator's two-person change to (`sha256:` over the canonical body). */
export const tradePayloadHash = (body) => `sha256:${createHash('sha256').update(canonical(body)).digest('hex')}`;
