import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The parts of a real-app journey that are not the customer's browser: the stack's own tools (the TEST operators,
// TEST funding, the other TEST trader) and the customer's own API through Edge, to read what the ledger holds.
export const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
export const EDGE = 'http://127.0.0.1:14500';
const ORIGIN = 'http://127.0.0.1:3210';
const STATE = process.env.LOCAL_STACK_STATE ?? path.join(homedir(), '.intafaced', 'local-test-stack');
const RUN = process.env.JOURNEY_RUN_DIR ?? '/tmp/intafaced-real-app';

/** One file per journey run, so a later step (a new worker after a failure) finds the account an earlier step made. */
export function journeyState(id) {
  const file = path.join(RUN, `${id}.json`);
  return {
    read: () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}),
    write(patch) {
      return this.reset({ ...this.read(), ...patch });
    },
    /** Step 1 starts the file again, so nothing from an earlier run is read as this run's. */
    reset(state) {
      mkdirSync(RUN, { recursive: true });
      writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
      return state;
    },
  };
}

/** A stack tool, as `node tooling/scripts/<script> ...args`; returns its output. */
export function tool(script, ...args) {
  return execFileSync(process.execPath, [path.join(ROOT, 'tooling/scripts', script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}

/** TEST funding through the real ledger; `ref` makes a replay of the same deposit. */
export function fund(email, asset, amount, ref) {
  const out = tool('local-test-stack.mjs', 'fund', email, asset, amount, ...(ref ? ['--ref', ref] : []));
  return { out, tx: /ledger tx\s+(\S+)/.exec(out)?.[1], ref: /--ref\s+([A-Za-z0-9-]+)/.exec(out)?.[1] };
}

async function json(res) {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/** The customer's own API through Edge, signed in as `who` with a session of its own (not the browser's). */
export async function api(who) {
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: who.email, password: who.password }),
  }).then(json);
  const token = login.body?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${login.status} ${JSON.stringify(login.body).slice(0, 300)}`);
  const call = (method, route, body) =>
    fetch(`${EDGE}${route}`, {
      method,
      headers: { origin: ORIGIN, authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).then(json);
  return {
    get: (route) => call('GET', route),
    post: (route, body) => call('POST', route, body),
    delete: (route) => call('DELETE', route),
    /** { asset: { free, used, total } } from the ledger, as decimal strings. */
    async balances() {
      const { status, body } = await call('GET', '/api/v1/account/balance');
      if (status !== 200) throw new Error(`balance read refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
      return body.balances;
    },
  };
}

/** The other TEST trader of the journey: the stack's taker account, through the same front door. */
export function otherTrader() {
  const accounts = JSON.parse(readFileSync(path.join(STATE, 'market-accounts.json'), 'utf8'));
  return accounts.taker;
}

/** Best bid and ask on the real book, as decimal strings. */
export async function bestPrices(symbol = 'BTC/USDT') {
  const { status, body } = await fetch(`${EDGE}/api/v1/orderbook/${encodeURIComponent(symbol)}?limit=5`, {
    headers: { origin: ORIGIN },
  }).then(json);
  if (status !== 200) throw new Error(`depth read refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
  const bid = body.bids?.[0]?.[0];
  const ask = body.asks?.[0]?.[0];
  if (!bid || !ask) throw new Error(`the ${symbol} book has no bid or no ask: ${JSON.stringify(body).slice(0, 300)}`);
  return { bid, ask, body };
}

/** Decimal strings as scaled bigints, 18 places (the ledger answers USDT with more than 8; no floats near money). */
const PLACES = 18;
const SCALE = 10n ** BigInt(PLACES);
export function toUnits(decimal) {
  if (typeof decimal !== 'string' || !/^-?\d+(\.\d{1,18})?$/.test(decimal))
    throw new Error(`not a decimal with at most ${PLACES} places: ${decimal}`);
  const [whole, frac = ''] = decimal.split('.');
  const sign = whole.startsWith('-') ? -1n : 1n;
  return sign * (BigInt(whole.replace('-', '') || '0') * SCALE + BigInt(frac.padEnd(PLACES, '0')));
}
export function fromUnits(units) {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  const frac = (abs % SCALE).toString().padStart(PLACES, '0').replace(/0+$/, '');
  return `${sign}${abs / SCALE}${frac ? `.${frac}` : ''}`;
}
/** price x amount, in units. */
export const times = (a, b) => (toUnits(a) * toUnits(b)) / SCALE;
