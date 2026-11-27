#!/usr/bin/env node
/**
 * THE TESTNET DRIVER (#11060): one command drives our own trading doors the way the desk does, on Hyperliquid's TEST
 * network only, signed by a test key held on the box, with no browser and no wallet-provider signature.
 *
 *   node tooling/beta/hl-drive.mjs <action> [options]
 *
 *   setup                       make (once) the driver's TEST customer on the beta stack, with Full, and its owner key;
 *                               print the key's address and its TEST USDC on the venue (fund it with hl-testnet-send.yml)
 *   status                      the door's session and the venue's own account: balances, positions, open orders
 *   spot   [--size <PURR>] [--off 5]  a resting PURR-USDC buy, --off percent under the best bid (GTC); its size by
 *                                     default just over the venue's 10 USDC least order
 *   perp   [--size 0.0004] [--sl 3] [--tp 3]   a BTC-PERP market buy, then a stop loss and a take profit on the position,
 *                                     --sl / --tp percent away from the fill, through the desk's protections door
 *   move-stop [--sl 4]          the stop moved (dragged) to --sl percent under the mark: the old one cancelled, a new one set
 *   cancel                      every open order the driver placed, cancelled through the door one by one
 *   close  [--pct 100]          the BTC-PERP position closed reduce-only (IOC at the market, bounded by the owner's cap)
 *   flatten                     every open order cancelled and every position closed, leg by leg, as desk A's Flatten
 *   --venue-url <url>           the venue's read door the driver checks against; anything but the testnet's is refused
 *   --draft <id>                the draft a run's keys are built on (each run prints its own): a run whose answer was lost
 *                               is run again with the same draft and sends the same orders, never second ones
 *
 * Each action prints our door's answer (`ours`) beside the venue's own record (`venue`, read straight from the testnet's
 * info door: orderStatus, openOrders, clearinghouseState), so a mismatch shows on one screen.
 *
 * What it keeps:
 *   - Testnet only: the venue read URL must be exactly the testnet's (assertTestnetInfoUrl), and the door's venue must be
 *     `hyperliquid-testnet` (assertTestnetVenue); either refusal stops it before anything is signed.
 *   - The key: HL_DRIVE_KEY (a GitHub secret) or `~/.intafaced/beta/hl-drive/owner.key` (mode 600, made by `setup`). Never
 *     printed, logged or sent anywhere; only its address is shown. It holds TEST USDC on the testnet only.
 *   - Business keys (AGENTS.md floor 3): each order's key is the desk's (`order:<owner>:<symbol>:drive-<action>-<draft>`),
 *     the draft printed by each run, so a run again with `--draft` is the same order. The driver moves no money of ours and the ledger posts
 *     nothing: the TEST USDC sits on the driver's own venue account.
 *   - Trades are signed by a session key the owner approved (`/api/v1/venue/session/start`), as the desk's are on a venue
 *     whose orders a wallet cannot sign; approvals stay the owner key's.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Hyperliquid's TEST network's read door: the only venue URL the driver reads. */
export const TESTNET_INFO_URL = 'https://api.hyperliquid-testnet.xyz/info';
/** The door's id for the Hyperliquid TEST network (packages/venue-hyperliquid core.ts HL_TESTNET_VENUE_ID). */
const TESTNET_VENUE_ID = 'hyperliquid-testnet';
const SPOT_SYMBOL = 'PURR-USDC';
const PERP_SYMBOL = 'BTC-PERP';
/** The spot USDC setup keeps for spot orders: the venue's least spot order is 10 USDC. */
const SPOT_FLOAT_USDC = '15';
/** A spot order's default value: just over the venue's least (10 USDC). */
const SPOT_ORDER_USDC = '11';
export const ACTIONS = Object.freeze(['setup', 'status', 'spot', 'perp', 'move-stop', 'cancel', 'close', 'flatten']);

const DEFAULTS = Object.freeze({
  spot: { off: '5' },
  perp: { size: '0.0004', sl: '3', tp: '3' },
  'move-stop': { sl: '4' },
  close: { pct: '100' },
});
const OPTION_NAMES = Object.freeze({
  setup: [],
  status: [],
  spot: ['size', 'off'],
  perp: ['size', 'sl', 'tp'],
  'move-stop': ['sl'],
  cancel: [],
  close: ['pct'],
  flatten: [],
});

export class DriveRefusal extends Error {}

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** The command line as one action and its options; anything unknown, missing or not a positive decimal is refused. */
export function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (!action || action === '--help' || action === '-h') throw new DriveRefusal(`usage: hl-drive.mjs <${ACTIONS.join('|')}> [options]`);
  if (!ACTIONS.includes(action)) throw new DriveRefusal(`unknown action "${action}": one of ${ACTIONS.join(', ')}`);
  const options = { ...DEFAULTS[action] };
  let venueUrl = TESTNET_INFO_URL;
  let draft = null;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag.startsWith('--')) throw new DriveRefusal(`unexpected "${flag}"`);
    const name = flag.slice(2);
    if (value === undefined || value.startsWith('--')) throw new DriveRefusal(`${flag} needs a value`);
    i++;
    if (name === 'venue-url') {
      venueUrl = value;
      continue;
    }
    if (name === 'draft') {
      if (!/^[a-z0-9]{1,16}$/.test(value)) throw new DriveRefusal(`--draft must be 1 to 16 lowercase letters or digits, not "${value}"`);
      draft = value;
      continue;
    }
    if (!OPTION_NAMES[action].includes(name)) throw new DriveRefusal(`${action} takes no ${flag}`);
    if (!DECIMAL.test(value) || /^0(?:\.0*)?$/.test(value)) throw new DriveRefusal(`${flag} must be a positive decimal, not "${value}"`);
    options[name] = value;
  }
  if (action === 'close' && !(Number.isInteger(Number(options.pct)) && Number(options.pct) >= 1 && Number(options.pct) <= 100))
    throw new DriveRefusal(`--pct must be a whole percent from 1 to 100, not "${options.pct}"`);
  return { action, options, draft, venueUrl: assertTestnetInfoUrl(venueUrl) };
}

/** The venue read URL, only when it is exactly the testnet's info door (a trailing slash aside). */
export function assertTestnetInfoUrl(url) {
  const trimmed = String(url ?? '').replace(/\/+$/, '');
  if (trimmed !== TESTNET_INFO_URL) throw new DriveRefusal(`refused: ${url} is not Hyperliquid's TEST network (${TESTNET_INFO_URL})`);
  return trimmed;
}

/** The door's venue status, only when it names the Hyperliquid TEST network and its TEST label. */
export function assertTestnetVenue(status) {
  const id = status?.venue?.id;
  if (status?.enabled === false) throw new DriveRefusal('refused: the venue door is off on this stack');
  if (id !== TESTNET_VENUE_ID) throw new DriveRefusal(`refused: the door's venue is "${id ?? 'none'}", not ${TESTNET_VENUE_ID}`);
  if (status.label !== 'TEST') throw new DriveRefusal(`refused: the door's venue is not labelled TEST (${status.label ?? 'none'})`);
  return status;
}

// ── Decimal arithmetic on strings (AGENTS.md floor 2: no money in a number) ─────────────────────────────────────────

const SCALE = 18n;
const ONE = 10n ** SCALE;
function toUnits(text) {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  if (!m) throw new DriveRefusal(`not a decimal: "${text}"`);
  const v = BigInt(m[2]) * ONE + BigInt((m[3] ?? '').slice(0, Number(SCALE)).padEnd(Number(SCALE), '0'));
  return m[1] ? -v : v;
}
function fromUnits(v) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % ONE).toString().padStart(Number(SCALE), '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / ONE}${frac ? `.${frac}` : ''}`;
}
/** `price` moved by `pct` percent (negative: down), rounded to the tick: down for a lower price, up for a higher one. */
export function shifted(price, pct, tick) {
  const p = toUnits(price);
  const moved = p + (p * toUnits(pct)) / (100n * ONE);
  const t = toUnits(tick);
  const down = (moved / t) * t;
  return fromUnits(toUnits(pct) < 0n || moved === down ? down : down + t);
}

/** A new draft id (apps/customer venue-api.ts `draftId`): the time it was made, base 36. */
const draftId = (now = Date.now()) => now.toString(36);

/** `bps` basis points as a percent string. */
const bpsPct = (bps) => fromUnits((toUnits(String(bps)) * ONE) / (100n * ONE));
/** `amount` rounded down to a multiple of `lot`. */
export function floorTo(amount, lot) {
  const l = toUnits(lot);
  return fromUnits((toUnits(amount) / l) * l);
}
/** `amount` rounded up to a multiple of `lot`. */
export function ceilTo(amount, lot) {
  const l = toUnits(lot);
  const v = toUnits(amount);
  return fromUnits(((v + l - 1n) / l) * l);
}
/** A price on Hyperliquid's rule: at most 5 significant figures, rounded down (`down`) or up. */
export function venuePrice(price, down) {
  const [int, frac = ''] = price.split('.');
  const digits = (int.replace(/^0+/, '') + frac).length;
  const lead = int.replace(/^0+/, '').length;
  if (digits <= 5) return price;
  const keep = lead >= 5 ? 0 : lead > 0 ? 5 - lead : 5 + frac.search(/[1-9]/);
  const step = lead >= 5 ? 10n ** BigInt(lead - 5) * ONE : ONE / 10n ** BigInt(keep);
  const v = toUnits(price);
  const floor = (v / step) * step;
  return fromUnits(down || floor === v ? floor : floor + step);
}

// ── Where things live ──────────────────────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HERE_REPO = path.resolve(HERE, '..', '..');
const home = () => process.env.HL_DRIVE_HOME ?? path.join(os.homedir(), '.intafaced', 'beta', 'hl-drive');
const files = () => ({
  key: path.join(home(), 'owner.key'),
  agent: path.join(home(), 'agent.key'),
  account: path.join(home(), 'account.json'),
  last: path.join(home(), 'last.json'),
});
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const writePrivate = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;

// ── The run ────────────────────────────────────────────────────────────────────────────────────────────────────────

const out = (label, value) => console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

async function main(argv) {
  const { action, options, draft, venueUrl } = parseArgs(argv);
  // The beta stack's slot and state, as beta-host.mjs runs its tools, unless the caller named another stack.
  const { betaPaths, stackEnv } = await import('./beta-host.mjs');
  if (!process.env.LOCAL_STACK_SLOT) Object.assign(process.env, stackEnv(betaPaths(), {}));
  // The stack's own built tools (its checkout's), as beta-invited.journey.mjs calls them; this checkout's otherwise.
  const REPO = process.env.HL_DRIVE_CHECKOUT ?? (fs.existsSync(betaPaths().checkout) ? betaPaths().checkout : HERE_REPO);
  const require = createRequire(path.join(REPO, 'packages', 'venue-hyperliquid', 'package.json'));
  const { privateKeyToAccount, generatePrivateKey } = await import(pathToFileURL(require.resolve('viem/accounts')).href);
  const gates = await import(pathToFileURL(path.join(REPO, 'tooling', 'scripts', 'local-test-gates.mjs')).href);
  const { localEmailOutboxPath } = await import(pathToFileURL(path.join(REPO, 'tooling', 'scripts', 'local-test-state.mjs')).href);
  const ctx = await gates.makeContext({ log: () => {} });
  const f = files();

  // The owner key: the secret's, else the box's file; `setup` makes the file once.
  let keyText = process.env.HL_DRIVE_KEY?.trim() || (fs.existsSync(f.key) ? fs.readFileSync(f.key, 'utf8').trim() : '');
  if (!keyText && action === 'setup') {
    keyText = generatePrivateKey();
    writePrivate(f.key, `${keyText}\n`);
  }
  if (!HEX_KEY.test(keyText)) throw new DriveRefusal(`no owner key: set HL_DRIVE_KEY or run setup (${f.key})`);
  const ownerKey = privateKeyToAccount(keyText);
  keyText = '';
  const owner = ownerKey.address.toLowerCase();

  // ── The venue's own record, straight from the testnet ──
  const info = async (body) => {
    const res = await fetch(venueUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { status: res.status, text: text.slice(0, 200) };
    }
  };
  const venueOrder = async (cloid) => {
    const r = await info({ type: 'orderStatus', user: owner, oid: cloid });
    const o = r?.order?.order;
    return r?.status === 'order'
      ? {
          oid: o?.oid,
          cloid: o?.cloid,
          coin: o?.coin,
          side: o?.side,
          sz: o?.sz,
          origSz: o?.origSz,
          limitPx: o?.limitPx,
          orderType: o?.orderType,
          isTrigger: o?.isTrigger,
          triggerPx: o?.triggerPx,
          tif: o?.tif,
          reduceOnly: o?.reduceOnly,
          status: r.order.status,
          at: new Date(r.order.statusTimestamp).toISOString(),
        }
      : r;
  };
  const venueAccount = async () => {
    const [perp, spot, open] = await Promise.all([
      info({ type: 'clearinghouseState', user: owner }),
      info({ type: 'spotClearinghouseState', user: owner }),
      info({ type: 'frontendOpenOrders', user: owner }),
    ]);
    return {
      perpWithdrawable: perp?.withdrawable,
      accountValue: perp?.marginSummary?.accountValue,
      positions: (perp?.assetPositions ?? []).map(({ position: p }) => ({
        coin: p.coin,
        szi: p.szi,
        entryPx: p.entryPx,
        upnl: p.unrealizedPnl,
      })),
      spot: (spot?.balances ?? []).filter((b) => b.total !== '0.0').map((b) => ({ coin: b.coin, total: b.total, hold: b.hold })),
      openOrders: (Array.isArray(open) ? open : []).map((o) => ({
        oid: o.oid,
        cloid: o.cloid,
        coin: o.coin,
        side: o.side,
        sz: o.sz,
        limitPx: o.limitPx,
        orderType: o.orderType,
        isTrigger: o.isTrigger,
        triggerPx: o.triggerPx,
        reduceOnly: o.reduceOnly,
      })),
    };
  };

  // ── Our door, signed in as the driver's TEST customer ──
  const account = readJson(f.account, null);
  const outbox = () => {
    try {
      return fs.readFileSync(localEmailOutboxPath(), 'utf8');
    } catch {
      return '';
    }
  };
  const codeFor = async (email, purpose, after = 0) => {
    for (let i = 0; i < 60; i++) {
      const lines = outbox().split('\n');
      const line = lines
        .slice(after)
        .filter((l) => l.includes(`purpose=${purpose}`) && l.includes(`email=${email}`))
        .at(-1);
      const code = line && /\bcode=(\d+)/.exec(line)?.[1];
      if (code) return code;
      await sleep(500);
    }
    throw new DriveRefusal(`no ${purpose} code for ${email} in the stack's TEST outbox`);
  };
  const data = (res) => res.json?.result?.data;
  /** An identity call as a native client makes it (no Origin): identity answers the device key in the body. */
  const native = async (proc, input) => {
    const res = await fetch(`${ctx.url('edge')}/api/identity/trpc/${proc}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text };
  };

  if (action === 'setup' && !account) {
    const id = crypto.randomBytes(4).toString('hex');
    const made = {
      handle: `hldrive${id}`,
      email: `hl-drive-${id}@local-test.invalid`,
      password: crypto.randomBytes(18).toString('base64url'),
    };
    const start = await ctx.edge.mutate('identity', 'auth.signUpStart', {
      channel: 'email',
      handle: made.handle,
      email: made.email,
      password: made.password,
      country: 'DE',
      usPerson: false,
      dateOfBirth: '1990-05-01',
      accountType: 'individual',
    });
    if (!data(start)?.flowId) throw new DriveRefusal(`sign-up refused: ${gates.refusalText(start)}`);
    const done = await native('auth.signUpConfirm', { flowId: data(start).flowId, code: await codeFor(made.email, 'signup-code') });
    if (!data(done)?.accessToken) throw new DriveRefusal(`sign-up confirm refused: ${gates.refusalText(done)}`);
    made.userId = data(done).userId;
    // The device key the sign-up issued, kept as a native client keeps it: each run signs in with it, no device step.
    made.deviceKey = data(done).deviceKey ?? null;
    writePrivate(f.account, `${JSON.stringify(made, null, 2)}\n`);
    const kyc = await ctx.edge.mutate('identity', 'kyc.submit', { tier: 'full', jurisdiction: 'ZZ' }, data(done).accessToken);
    if (!data(kyc)?.id) throw new DriveRefusal(`Full request refused: ${gates.refusalText(kyc)}`);
    const rows = await gates.approvePending(ctx, null, { userIds: [made.userId] });
    out('setup', { account: made.handle, userId: made.userId, full: rows.map((r) => `${r.tier} ${r.why}`) });
    return main(argv);
  }
  if (!account) throw new DriveRefusal(`no driver account on this stack: run setup (${f.account})`);

  // One sign-in kept across runs (its refresh token, as a native client keeps it), so the trading session this sign-in
  // approved stays this sign-in's and a run does not ask the venue for a new session key each time.
  const signIn = async () => {
    const keep = (d) => {
      account.refreshToken = d.refreshToken ?? account.refreshToken ?? null;
      writePrivate(f.account, `${JSON.stringify(account, null, 2)}\n`);
      return d.accessToken;
    };
    if (account.refreshToken) {
      const again = await native('auth.refresh', { refreshToken: account.refreshToken });
      if (data(again)?.accessToken) return keep(data(again));
    }
    const res = await native('auth.login', {
      identifier: account.email,
      password: account.password,
      deviceKey: account.deviceKey ?? undefined,
    });
    if (!data(res)?.accessToken)
      throw new DriveRefusal(`sign-in refused (${gates.refusalText(res)}): move ${f.account} aside and run setup`);
    return keep(data(res));
  };
  const token = await signIn();
  const door = async (method, route, body) => {
    const res = await ctx.edge.call(method, `/api/v1/venue${route}`, body, token);
    return { status: res.status, body: res.json ?? res.text?.slice(0, 300) };
  };
  const status = await door('GET', '/status');
  if (status.status !== 200)
    throw new DriveRefusal(`the door's venue status answered ${status.status}: ${JSON.stringify(status.body).slice(0, 300)}`);
  assertTestnetVenue(status.body);
  const markets = (await door('GET', '/markets')).body?.value ?? [];
  const market = (symbol) => {
    const m = markets.find((x) => x.symbol === symbol);
    if (!m) throw new DriveRefusal(`the door lists no ${symbol} on ${TESTNET_VENUE_ID}`);
    return m;
  };

  const sign = async (key, prepared) => {
    const t = prepared.typedData;
    const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    return { digest: prepared.digest, signature, signedBy: key.address.toLowerCase() };
  };
  /** One prepared action signed by `key` and sent: our door's answer to the prepare and to the submit. */
  const act = async (key, role, intent, actionKey) => {
    const prepared = await door('POST', '/prepare', { owner, signer: { role, address: key.address.toLowerCase() }, intent, actionKey });
    if (prepared.status !== 200) return { prepare: prepared };
    const sent = await door('POST', '/submit', { actionKey: prepared.body.actionKey, signature: await sign(key, prepared.body.prepared) });
    return { actionKey: prepared.body.actionKey, venueClientOrderId: prepared.body.prepared?.venueClientOrderId ?? null, submit: sent };
  };

  // ── The trading session: a key the owner approved on the venue, as the desk's ──
  const sessionKey = async () => {
    const held = fs.existsSync(f.agent) ? fs.readFileSync(f.agent, 'utf8').trim() : '';
    const now = await door('GET', `/session?owner=${owner}`);
    const heldAccount = HEX_KEY.test(held) ? privateKeyToAccount(held) : null;
    const cur = now.body?.current;
    if (heldAccount && cur?.state === 'live' && cur.agentAddress?.toLowerCase() === heldAccount.address.toLowerCase()) return heldAccount;
    for (let tries = 0; tries < 6; tries++) {
      // A key is approved once and never again (a venue that prunes nonces could replay its old actions): each try a new one.
      const fresh = generatePrivateKey();
      writePrivate(f.agent, `${fresh}\n`);
      const agent = privateKeyToAccount(fresh);
      const started = await door('POST', '/session/start', { owner, agentAddress: agent.address.toLowerCase() });
      if (started.status !== 200) throw new DriveRefusal(`session start refused: ${JSON.stringify(started.body).slice(0, 300)}`);
      const sent = await door('POST', '/submit', {
        actionKey: started.body.actionKey,
        signature: await sign(ownerKey, started.body.prepared),
      });
      const o = sent.body?.outcome;
      if (o?.accepted) {
        out('session', { agent: agent.address.toLowerCase(), sessionId: started.body.sessionId, venue: o });
        return agent;
      }
      // "User has pending agent removal" right after an End: the venue asks for a few seconds (#11051).
      out('session', { retry: tries + 1, answer: sent.body });
      await sleep(8_000);
    }
    throw new DriveRefusal('the venue did not approve the session key');
  };

  // The draft every key of this run is built on, as the desk's `draftId`: printed, so a run whose answer was lost is
  // run again with `--draft <id>` and sends the same orders, never second ones.
  const run = draft ?? draftId();
  out('draft', run);
  const last = readJson(f.last, {});
  const saveLast = () => writePrivate(f.last, `${JSON.stringify(last, null, 2)}\n`);
  const best = async (symbol) => (await door('GET', `/best-prices?symbol=${encodeURIComponent(symbol)}`)).body?.value;
  // The desk's business keys (apps/customer venue-api.ts `keys`), with the run as the draft: `order:<owner>:<symbol>:<draft>`.
  const part = (v) =>
    String(v)
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, '-');
  const orderKey = (what, symbol, kind = 'order') => `${kind}:${part(owner)}:${part(symbol)}:drive-${part(what)}-${run}`;
  const show = async (label, result) => {
    out(`ours ${label}`, result);
    if (result.venueClientOrderId) out(`venue ${label}`, await venueOrder(result.venueClientOrderId));
  };

  if (action === 'setup') {
    // A spot order spends spot USDC, which the venue keeps apart from perps margin on a default account: move a little.
    const v = await venueAccount();
    const spotUsdc = v.spot.find((b) => b.coin === 'USDC')?.total ?? '0';
    const short = toUnits(SPOT_FLOAT_USDC) - toUnits(spotUsdc);
    const move = fromUnits(((short + ONE - 1n) / ONE) * ONE); // whole USDC
    if (short > 0n && toUnits(v.perpWithdrawable ?? '0') >= toUnits(move) + toUnits('5')) {
      const intent = {
        kind: 'spot_perps_transfer',
        direction: 'perps_to_spot',
        asset: 'USDC',
        amount: move,
        moveKey: `class-move:${part(owner)}:drive-setup-${run}`,
      };
      const ours = await act(ownerKey, 'owner', intent, intent.moveKey);
      out('ours perps to spot', ours);
      // The door does not offer this move on Hyperliquid yet (#10964): setup alone makes it with the venue's own
      // usdClassTransfer, signed by the owner key and posted to the testnet's exchange door, so spot orders can run.
      if (ours.prepare?.body?.intafacedCode === 'trade.venue.not_offered') {
        const hl = await import(pathToFileURL(path.join(REPO, 'packages', 'venue-hyperliquid', 'dist', 'index.js')).href);
        const nonce = BigInt(Date.now());
        const { action: wire, typedData: t } = hl.usdClassTransferAction(move, false, nonce);
        const signature = await ownerKey.signTypedData({
          domain: t.domain,
          types: t.types,
          primaryType: t.primaryType,
          message: t.message,
        });
        const res = await fetch(venueUrl.replace(/\/info$/, '/exchange'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: wire,
            nonce: Number(nonce),
            signature: hl.splitSignature(signature),
            vaultAddress: null,
            expiresAfter: null,
          }),
          signal: AbortSignal.timeout(20_000),
        });
        out('venue perps to spot (usdClassTransfer)', await res.text());
      }
    }
  }
  if (action === 'setup' || action === 'status') {
    out('driver', { owner, account: account.handle, venue: status.body.venue.id, door: { tradesSignedBy: status.body.tradesSignedBy } });
    out('ours session', (await door('GET', `/session?owner=${owner}`)).body);
    out('ours balances', (await door('GET', `/balances?owner=${owner}`)).body);
    out('ours positions', (await door('GET', `/positions?owner=${owner}`)).body);
    out('ours open orders', (await door('GET', `/orders/open?owner=${owner}`)).body);
    out('venue account', await venueAccount());
    return;
  }

  const agent = await sessionKey();

  const capBps = status.body.closeSlippageBps ?? null;
  const bestOf = async (symbol) => {
    const b = await best(symbol);
    if (!b?.bid || !b?.ask) throw new DriveRefusal(`no best prices on ${symbol}: ${JSON.stringify(b).slice(0, 200)}`);
    return b;
  };
  /** A market order's worst price: `pct` percent past the best price against us, on the venue's price rule. */
  const worst = (m, b, side, bps) =>
    venuePrice(shifted(side === 'buy' ? b.ask : b.bid, side === 'buy' ? bpsPct(bps) : `-${bpsPct(bps)}`, m.tickSize), side === 'sell');
  const order = (symbol, side, type, amount, price, reduceOnly, what, kind = 'order') => ({
    kind: 'place_order',
    symbol,
    side,
    type,
    amount,
    price,
    timeInForce: type === 'market' ? 'IOC' : 'GTC',
    reduceOnly,
    clientOrderKey: orderKey(what, symbol, kind),
    builderFee: null,
  });
  const place = async (label, intent) => {
    const r = await act(agent, 'agent', intent, intent.clientOrderKey);
    await show(label, r);
    return r;
  };

  // ── The protections door (desk's Protect): a protection that rests on the venue comes back to sign; one the venue
  //    lacks is armed on our engine under the owner's protection agent. ──
  const protectionAgent = async () => {
    const a = await door('GET', `/protection-agent?owner=${owner}`);
    if (a.body?.approved) return;
    for (let tries = 0; tries < 8; tries++) {
      const prepared = await door('POST', '/protection-agent/prepare', { owner });
      if (prepared.status !== 200) return out('ours protection agent', prepared);
      const sent = await door('POST', '/submit', {
        actionKey: prepared.body.actionKey,
        signature: await sign(ownerKey, prepared.body.prepared),
      });
      out('ours protection agent', sent.body?.outcome ?? sent);
      // Right after a session change the venue still holds an agent removal and asks for a few seconds (#11051).
      // A replayed answer is the stored one: the door keeps this approval under one key, so trying again sends nothing.
      if (sent.body?.outcome?.refusal?.code !== 'agent_removal_pending' || sent.body?.replayed) return;
      await sleep(5_000);
    }
  };
  const protections = async () => (await door('GET', `/protections?owner=${owner}`)).body?.protections ?? [];
  /** A protection as the desk's Protect sends it; a stop loss the venue cannot judge falls back to our engine's stop market. */
  const protect = async (kind, side, quantity, triggerPrice) => {
    const first = await protectOnce(kind, side, quantity, triggerPrice);
    if (kind === 'stop_loss' && first === 'trade.trigger_source_unset') return protectOnce('stop_market', side, quantity, triggerPrice);
    return first;
  };
  const protectOnce = async (kind, side, quantity, triggerPrice) => {
    const created = await door('POST', '/protections', {
      owner,
      symbol: PERP_SYMBOL,
      kind,
      side,
      quantity,
      triggerPrice,
      triggerSource: 'mark',
      clientOrderId: `drive-${kind.replace('_', '-')}-${run}`,
    });
    out(`ours ${kind}`, created);
    if (created.status >= 400) return created.body?.intafacedCode ?? 'refused';
    if (created.body?.restsOn !== 'venue') return created.body?.protection ?? null;
    const p = created.body.prepared;
    const key = p.signer.role === 'owner' ? ownerKey : agent;
    const sent = await door('POST', '/submit', { actionKey: created.body.actionKey, signature: await sign(key, p) });
    await show(`${kind} sent`, { venueClientOrderId: p.venueClientOrderId, submit: sent });
    return { id: null, restsOn: 'venue', venueClientOrderId: p.venueClientOrderId, actionKey: created.body.actionKey };
  };
  const positionOf = async (symbol) => {
    const ps = (await door('GET', `/positions?owner=${owner}`)).body?.value ?? [];
    return ps.find((p) => p.symbol === symbol) ?? null;
  };
  const close = async (position, pct, what) => {
    const m = market(position.symbol);
    const side = position.side === 'long' ? 'sell' : 'buy';
    const amount =
      pct === '100' ? position.size : floorTo(fromUnits((toUnits(position.size) * toUnits(pct)) / (100n * 10n ** 18n)), m.lotSize);
    const type = m.orderTypes?.includes('market') ? 'market' : 'limit';
    // As the desk's Close: IOC at the market, bounded by the owner's close tolerance (blank: svc-trade refuses it by name).
    const price = worst(m, await bestOf(position.symbol), side, capBps ?? 0);
    return place(`close ${position.symbol} ${pct}%`, {
      ...order(position.symbol, side, type, amount, price, true, what, 'close'),
      timeInForce: 'IOC',
    });
  };
  const cancelAll = async () => {
    const open = (await door('GET', `/orders/open?owner=${owner}`)).body?.value ?? [];
    if (open.length === 0) out('ours cancel', 'no open orders');
    // Our own key for each order we placed (the door's record of this person's orders), as the desk cancels by it.
    const ours = new Map();
    for (let cursor = null, pages = 0; pages < 20; pages++) {
      const page = (await door('GET', `/orders?owner=${owner}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).body;
      for (const o of page?.orders ?? []) if (o.venueClientOrderId) ours.set(o.venueClientOrderId, o.actionKey);
      cursor = page?.nextCursor ?? null;
      if (!cursor) break;
    }
    for (const o of open) {
      const key = ours.get(o.venueClientOrderId);
      const r = key
        ? await act(agent, 'agent', { kind: 'cancel_order', symbol: o.symbol, clientOrderKey: key }, `cancel:${key}`)
        : await act(
            agent,
            'agent',
            { kind: 'cancel_orders', orders: [{ symbol: o.symbol, venueClientOrderId: o.venueClientOrderId }] },
            `cancel:${part(owner)}:${part(o.venueClientOrderId)}:${run}`,
          );
      out(`ours cancel ${o.symbol} ${o.venueClientOrderId}`, r);
      out(`venue cancel ${o.symbol} ${o.venueClientOrderId}`, await venueOrder(o.venueClientOrderId));
    }
    const prots = await protections();
    for (const p of prots.filter((x) => x.restsOn === 'engine' && x.status === 'armed')) {
      out(`ours cancel ${p.kind} ${p.id}`, await door('DELETE', `/protections/${encodeURIComponent(p.id)}`));
    }
  };

  // Our builder fee, as the desk asks it before a first order: the owner key approves it once on the venue.
  const builder = status.body.builder ?? null;
  if (['spot', 'perp', 'close', 'flatten'].includes(action) && builder?.feeBps) {
    const approval = await door('GET', `/builder-fee-approval?owner=${owner}&builder=${builder.address}`);
    const have = approval.body?.value?.maxFeeBps ?? approval.body?.value ?? null;
    if (typeof have !== 'string' || !DECIMAL.test(have) || toUnits(have) < toUnits(builder.feeBps)) {
      const intent = { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps };
      out(
        'ours builder fee approval',
        await act(ownerKey, 'owner', intent, `builder-approval:${part(owner)}:${part(builder.address)}:${builder.feeBps}:drive-${run}`),
      );
    }
  }

  if (action === 'spot') {
    const m = market(SPOT_SYMBOL);
    const b = await bestOf(SPOT_SYMBOL);
    const price = venuePrice(shifted(b.bid, `-${options.off}`, m.tickSize), true);
    const size = options.size ?? ceilTo(fromUnits((toUnits(SPOT_ORDER_USDC) * ONE) / toUnits(price)), m.lotSize);
    await place('spot buy', order(SPOT_SYMBOL, 'buy', 'limit', floorTo(size, m.lotSize), price, false, 'spot'));
  } else if (action === 'perp') {
    const m = market(PERP_SYMBOL);
    // A perp order uses the account's leverage on the market; the door refuses `leverage_not_set` without one.
    out(
      'ours leverage',
      await act(
        agent,
        'agent',
        { kind: 'update_leverage', symbol: PERP_SYMBOL, leverageBps: 200_000, marginMode: 'cross' },
        `leverage:${part(owner)}:${part(PERP_SYMBOL)}:cross:200000:${run}`,
      ),
    );
    const b = await bestOf(PERP_SYMBOL);
    const entry = await place(
      'perp buy',
      order(PERP_SYMBOL, 'buy', 'market', floorTo(options.size, m.lotSize), worst(m, b, 'buy', 100), false, 'perp'),
    );
    if (!entry.submit?.body?.outcome?.accepted) return;
    const position = await positionOf(PERP_SYMBOL);
    out('ours position', position);
    if (!position) return;
    await protectionAgent();
    const from = position.entryPrice ?? b.ask;
    const sl = await protect('stop_loss', 'sell', position.size, venuePrice(shifted(from, `-${options.sl}`, m.tickSize), true));
    const tp = await protect('take_profit', 'sell', position.size, venuePrice(shifted(from, options.tp, m.tickSize), false));
    Object.assign(last, { stop: sl, takeProfit: tp });
    saveLast();
    out('ours protections', await protections());
  } else if (action === 'move-stop') {
    const m = market(PERP_SYMBOL);
    const position = await positionOf(PERP_SYMBOL);
    if (!position) throw new DriveRefusal(`no ${PERP_SYMBOL} position to protect: run perp first`);
    const old = (await protections()).find((p) => p.role === 'stop_loss' && (p.status === 'armed' || p.status === 'open'));
    // A drag on the chart: the old stop goes, a new one takes its place at the new price.
    if (old?.restsOn === 'engine') out(`ours cancel stop ${old.id}`, await door('DELETE', `/protections/${encodeURIComponent(old.id)}`));
    else if (old)
      out(
        `ours cancel stop ${old.id}`,
        await act(
          agent,
          'agent',
          { kind: 'cancel_orders', orders: [{ symbol: PERP_SYMBOL, venueClientOrderId: old.clientOrderId }] },
          `cancel:${part(owner)}:${part(old.clientOrderId)}:${run}`,
        ),
      );
    else out('ours stop', 'none open to move');
    const b = await bestOf(PERP_SYMBOL);
    last.stop = await protect(
      'stop_loss',
      position.side === 'long' ? 'sell' : 'buy',
      position.size,
      venuePrice(shifted(b.bid, `-${options.sl}`, m.tickSize), true),
    );
    saveLast();
    out('ours protections', await protections());
  } else if (action === 'cancel') {
    await cancelAll();
  } else if (action === 'close') {
    const position = await positionOf(PERP_SYMBOL);
    if (!position) throw new DriveRefusal(`no ${PERP_SYMBOL} position to close`);
    await close(position, options.pct, `close-${options.pct}`);
  } else if (action === 'flatten') {
    // Desk A's Flatten: every open order cancelled, then every position closed whole, leg by leg.
    await cancelAll();
    const positions = (await door('GET', `/positions?owner=${owner}`)).body?.value ?? [];
    if (positions.length === 0) out('ours flatten', 'no open positions');
    for (const p of positions) await close(p, '100', `flatten-${p.symbol}`);
  }
  out('venue account', await venueAccount());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof DriveRefusal ? error.message : (error?.stack ?? String(error)));
      process.exit(error instanceof DriveRefusal ? 2 : 1);
    },
  );
}
