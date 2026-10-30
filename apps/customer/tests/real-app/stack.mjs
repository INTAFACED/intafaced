import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_TEST_DEVICE_KEY, localTestDeviceState } from '../../../../tooling/scripts/local-test-device.mjs';
import { localStackState } from '../../../../tooling/scripts/local-test-state.mjs';

// The parts of a real-app journey that are not the customer's browser: the stack's own tools (the TEST operators,
// TEST funding, the other TEST trader) and the customer's own API through Edge, to read what the ledger holds.
/** The stack's one TEST browser key (local-test-device.mjs): scripted sign-ins present it as the journey's browser does. */
export const DEVICE_KEY = LOCAL_TEST_DEVICE_KEY;

/**
 * Signs this browser out the way clearing its cookies does, and keeps it the same TEST browser: its device key goes back,
 * so the next sign-in is not a new device. A journey that means a new device clears the cookies itself (J-identity-02 #5).
 */
const DEVICE_COOKIES = localTestDeviceState().cookies;
export async function signOutBrowser(context) {
  await context.clearCookies();
  await context.addCookies(DEVICE_COOKIES);
}

export const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
export const EDGE = 'http://127.0.0.1:14500';
export const ORIGIN = 'http://127.0.0.1:3210';
// The stack's own rule for its state folder (LOCAL_STACK_STATE, else per user, else /var/lib as root).
const STATE = localStackState();

/** A file in the running stack's own state folder (for example the stand-in engine's hold file). */
export const stackFile = (name) => path.join(STATE, name);
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

/** Every LOCAL-TEST sign-up code the stack's identity service mailed to `email`, oldest first (its outbox file). */
export function mailedCodes(email, purpose = 'signup-code') {
  const file = path.join(STATE, 'email-outbox.log');
  if (!existsSync(file)) return [];
  const wanted = email.replace(/\s+/g, '');
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.includes(`purpose=${purpose} `) && line.includes(` email=${wanted} `))
    .map((line) => /\bcode=(\d{6})\b/.exec(line)?.[1])
    .filter(Boolean);
}

/** Every email-confirmation link mailed to `email` (an app path), oldest first, read from the LOCAL-TEST outbox like an inbox. */
export function mailedConfirmLinks(email) {
  const file = path.join(STATE, 'email-outbox.log');
  if (!existsSync(file)) return [];
  const wanted = email.replace(/\s+/g, '');
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.includes('purpose=email-confirm') && line.includes(` email=${wanted} `))
    .map((line) => /\blink=(\S+)/.exec(line)?.[1])
    .filter(Boolean)
    .map((link) => `/${link}`);
}

/** Every LOCAL-TEST mail line for `purpose` sent to `email`, oldest first, read from the outbox like an inbox. */
export function mailedLines(email, purpose) {
  const file = path.join(STATE, 'email-outbox.log');
  if (!existsSync(file)) return [];
  const wanted = email.replace(/\s+/g, '');
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.includes(`purpose=${purpose} `) && line.includes(` email=${wanted} `));
}

/** Every LOCAL-TEST status subscription message to `email`, oldest first, from svc-notify's status outbox file. */
export function statusMail(email) {
  const file = path.join(STATE, 'status-mail-outbox.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('LOCAL-TEST '))
    .map((line) => JSON.parse(line.slice('LOCAL-TEST '.length)))
    .filter((mail) => mail.purpose === 'status' && mail.to === email);
}

/** The next code mailed to `email` once more than `seen` have arrived. The relay sends right after the request commits. */
export async function nextMailedCode(email, seen = 0, waitMs = 20_000, purpose = 'signup-code') {
  const until = Date.now() + waitMs;
  for (;;) {
    const codes = mailedCodes(email, purpose);
    if (codes.length > seen) return codes.at(-1);
    if (Date.now() >= until) throw new Error(`no ${purpose} reached ${email} within ${waitMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Sign up through /register as a real person would: details, then the mailed code. `who` needs handle, email and
 * password; the country and birth date are TEST answers. Lands signed in, off /register.
 */
export async function signUpInBrowser(page, who, { country = 'DE', dateOfBirth = '1990-05-01', accountType = 'individual' } = {}) {
  const seen = mailedCodes(who.email).length;
  await page.goto('/register');
  if (accountType === 'business') await page.getByRole('radio', { name: /Business/ }).check();
  await page.getByLabel('Email address').fill(who.email);
  await page.getByLabel('Handle').fill(who.handle);
  await page.getByLabel('Password').fill(who.password);
  await page.getByLabel('Country you live in').selectOption(country);
  await page.getByLabel('Date of birth').fill(dateOfBirth);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  await page.getByLabel('Code from the email').fill(await nextMailedCode(who.email, seen));
  await page.getByRole('button', { name: 'Confirm and open my account' }).click();
  await page.waitForURL((url) => url.pathname !== '/register');
}

/** TEST funding through the real ledger; `ref` makes a replay of the same deposit. */
export function fund(email, asset, amount, ref) {
  const out = tool('local-test-stack.mjs', 'fund', email, asset, amount, ...(ref ? ['--ref', ref] : []));
  return { out, tx: /ledger tx\s+(\S+)/.exec(out)?.[1], ref: /--ref\s+([A-Za-z0-9-]+)/.exec(out)?.[1] };
}

/** A response as `{ status, body }`: the parsed JSON, or the raw text when it isn't JSON. */
export async function json(res) {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/** The customer's own API through Edge, signed in as `who` with a session of its own (not the browser's). */
export async function api(who) {
  const signIn = () =>
    fetch(`${EDGE}/api/identity/trpc/auth.login`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
    }).then(json);
  // A sign-in on a kept-alive socket Edge closed while the test waited fails before any answer; it is sent once more on
  // a fresh socket (it moves nothing, and a second session is harmless).
  const login = await signIn().catch((error) => {
    if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
    return signIn();
  });
  const token = login.body?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${login.status} ${JSON.stringify(login.body).slice(0, 300)}`);
  const send = (method, route, body) =>
    fetch(`${EDGE}${route}`, {
      method,
      headers: { origin: ORIGIN, authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).then(json);
  // A kept-alive socket that Edge closed while the test waited (a lane restart takes longer than Edge's idle timeout)
  // fails before any answer. A read is sent once more on a fresh socket; a write never is.
  const call = (method, route, body) =>
    send(method, route, body).catch((error) => {
      if (method !== 'GET' || error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
      return send(method, route, body);
    });
  return {
    /** The account's user id, as identity answered the sign-in. */
    userId: login.body.result.data.userId,
    get: (route) => call('GET', route),
    post: (route, body) => call('POST', route, body),
    patch: (route, body) => call('PATCH', route, body),
    delete: (route) => call('DELETE', route),
    /** { asset: { free, used, total } } from the ledger, as decimal strings. */
    async balances() {
      const { status, body } = await call('GET', '/api/v1/account/balance');
      if (status !== 200) throw new Error(`balance read refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
      return body.balances;
    },
  };
}

/**
 * A staff freeze of `who`'s account through identity's own compliance control, made by the stack's TEST founder (the
 * only principal that control accepts), as an operator would. Returns the account's user id.
 */
export async function staffFreeze(who, reason = 'LOCAL TEST journey freeze') {
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then(json);
  const userId = login.body?.result?.data?.userId;
  if (!userId) throw new Error(`sign-in for ${who.email} refused: ${login.status} ${JSON.stringify(login.body).slice(0, 300)}`);
  frozenAt.set(userId, await staffControl(userId, reason));
  return userId;
}

/** The account version each `staffFreeze` left, by user id: a restore's approval binds the version the founder read. */
const frozenAt = new Map();

/**
 * Lifts a `staffFreeze` by the user id it returned (a frozen account cannot sign in), the way identity requires: founder
 * a proposes an `identity.account_unfreeze` over the account and reason at its frozen version, founder b approves it,
 * and founder a's restore spends it (services/svc-identity/src/controls/founder-controls.ts).
 */
export async function staffRestore(userId, reason = 'LOCAL TEST journey freeze lifted') {
  const expectedVersion = frozenAt.get(userId);
  if (!expectedVersion) throw new Error(`no staffFreeze of ${userId} in this run to lift`);
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const founders = await gates.approverSessions(ctx);
  const { approvalId } = await gates.twoPerson(ctx, founders, {
    actionType: 'identity.account_unfreeze',
    targetService: 'svc-identity',
    targetId: userId,
    expectedVersion,
    payloadHash: gates.identityPayloadHash(userId, { reason }),
    policyVersion: 'local-test:v1',
  });
  const res = await ctx.edge.mutate(
    'identity',
    'compliance.unfreezeIdentity',
    { requestId: randomUUID(), target: { area: 'identity', userId }, action: 'restore', reason, expectedVersion, approvalId },
    founders.a.token,
  );
  if (res.json?.result?.data?.outcome !== 'changed') throw new Error(`staff restore refused: ${res.status} ${res.text.slice(0, 300)}`);
  frozenAt.delete(userId);
}

/** Restricts the account through identity's compliance control; returns the version the freeze left. */
async function staffControl(userId, reason) {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const founders = await gates.approverSessions(ctx);
  const freeze = (expectedVersion) =>
    ctx.edge.mutate(
      'identity',
      'compliance.freezeIdentity',
      { requestId: randomUUID(), target: { area: 'identity', userId }, action: 'restrict', reason, expectedVersion },
      founders.a.token,
    );
  // A new account starts at version 0; one an earlier control changed answers `conflict` with its current version.
  let res = await freeze('0');
  const current = res.json?.result?.data?.outcome === 'conflict' ? res.json.result.data.current?.version : undefined;
  if (current) res = await freeze(current);
  if (res.json?.result?.data?.outcome !== 'changed') throw new Error(`staff freeze refused: ${res.status} ${res.text.slice(0, 300)}`);
  return res.json.result.data.after.version;
}

/** The other TEST trader of the journey: the stack's taker account, through the same front door. */
export function otherTrader() {
  const accounts = JSON.parse(readFileSync(path.join(STATE, 'market-accounts.json'), 'utf8'));
  return accounts.taker;
}

/** Best bid and ask on the real book, as decimal strings, with up to `depth` levels a side in `body`. The journey's own
 * fills can take one side for a moment, so this waits for the market maker's next quote before it refuses. */
export async function bestPrices(symbol = 'BTC/USDT', depth = 50, waitMs = 15_000) {
  const until = Date.now() + waitMs;
  for (;;) {
    const { status, body } = await fetch(`${EDGE}/api/v1/orderbook/${encodeURIComponent(symbol)}?limit=${depth}`, {
      headers: { origin: ORIGIN },
    }).then(json);
    if (status !== 200) throw new Error(`depth read refused: ${status} ${JSON.stringify(body).slice(0, 300)}`);
    const bid = body.bids?.[0]?.[0];
    const ask = body.asks?.[0]?.[0];
    if (bid && ask) return { bid, ask, body };
    if (Date.now() >= until) throw new Error(`the ${symbol} book has no bid or no ask: ${JSON.stringify(body).slice(0, 300)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
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
