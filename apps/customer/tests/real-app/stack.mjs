import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
export const LEDGER = 'http://127.0.0.1:14501';
export const ORIGIN = 'http://127.0.0.1:3210';
// The stack's own rule for its state folder (LOCAL_STACK_STATE, else per user, else /var/lib as root).
const STATE = localStackState();

/** A file in the running stack's own state folder (for example the stand-in engine's hold file). */
export const stackFile = (name) => path.join(STATE, name);
const RUN = process.env.JOURNEY_RUN_DIR ?? '/tmp/intafaced-real-app';

/**
 * The shared-world state of this worker's current journey file (journey.mjs, `worldBetweenFiles`): which file it is,
 * the options the market maker was running with when it began, and the TEST accounts it signed up or acted as. Kept in
 * the stack's own state folder (mode 600), one per worker slot, so it outlives the run: a worker Playwright starts again
 * after a failed step carries on with the same file, and the next run on the same stack first puts back what the last
 * run's last file left. A file run again straight after itself is the same file, and is not put back.
 */
const WORLD_FILE = path.join(STATE, 'run', `journey-world-${process.env.TEST_PARALLEL_INDEX ?? '0'}.json`);
export const worldState = {
  read() {
    try {
      const state = JSON.parse(readFileSync(WORLD_FILE, 'utf8'));
      return { file: state.file ?? null, makerArgs: state.makerArgs ?? null, accounts: state.accounts ?? [] };
    } catch {
      return { file: null, makerArgs: null, accounts: [] };
    }
  },
  write(state) {
    mkdirSync(path.dirname(WORLD_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(WORLD_FILE, JSON.stringify(state), { mode: 0o600 });
  },
};
/** Record that this journey file acts as TEST account `who` (an email or handle and its password), so its resting
 * orders come down before the next file. */
export function actedAs(who) {
  const identifier = who?.email ?? who?.identifier;
  if (!identifier || !who?.password) return;
  const state = worldState.read();
  if (state.accounts.some((a) => a.email === identifier)) return;
  worldState.write({ ...state, accounts: [...state.accounts, { email: identifier, password: who.password }] });
}

/**
 * Records the account behind a sign-in or sign-up request, from its own body, whichever helper or page sent it (an
 * identity `auth.login` or `auth.register`, as JSON or a tRPC batch). Journeys sign people in through many local
 * helpers; reading the request itself misses none of them.
 */
export function recordSignIn(url, body) {
  if (typeof url !== 'string' || !/\/api\/identity\/trpc\/[^?]*auth\.(login|register)/.test(url) || typeof body !== 'string') return;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  const inputs = [];
  const walk = (v, depth = 0) => {
    if (!v || typeof v !== 'object' || depth > 4) return;
    if (typeof v.password === 'string' && (typeof v.identifier === 'string' || typeof v.email === 'string')) inputs.push(v);
    for (const child of Object.values(v)) walk(child, depth + 1);
  };
  walk(parsed);
  for (const input of inputs) actedAs({ email: input.identifier ?? input.email, password: input.password });
}

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

/** How long a stack tool may run. A restart and the health check after it share it (#7463). */
const TOOL_CAP_MS = 120_000;
/** How much of a tool's own output its error keeps, from the end, so a timed-out restart says where it stood. */
const OUTPUT_TAIL = 4_000;
/**
 * Set when a restart leaves a service unhealthy: the services, when, and why. Every later journey file on this stack
 * fails at once, naming them, rather than waiting out its timeouts on a dead stack (`assertStackUp`, world-restore.mjs).
 */
const STACK_DOWN = path.join(STATE, 'run', 'journey-stack-down.json');

/**
 * The stack script's name, kept out of the function bodies below: journey-world.mjs counts a helper whose body names a
 * stack script as running the stack's tools, but `tool` only reads it here, and every `tool(...)` call is counted where
 * it is made, by its own arguments.
 */
const STACK_SCRIPT = 'local-test-stack.mjs';

const tail = (text) => {
  const t = String(text ?? '').trimEnd();
  return t.length > OUTPUT_TAIL ? `...${t.slice(-OUTPUT_TAIL)}` : t;
};

/** The error a tool threw, with the command and the end of its own stdout and stderr in the message (a timeout too). */
function withOutput(error, script, args) {
  const out = tail(error.stdout);
  const err = tail(error.stderr);
  error.message = `${error.message}\n  tool: ${script} ${args.join(' ')}\n  its stdout:${out ? `\n${out}` : ' (none)'}\n  its stderr:${err ? `\n${err}` : ' (none)'}`;
  return error;
}

const run = (script, args, timeout) =>
  execFileSync(process.execPath, [path.join(ROOT, 'tooling/scripts', script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Which of `names` (as `restart` takes them: identity, edge, customer) the stack's health table does not read as ok. */
export function unhealthy(names) {
  let out;
  try {
    out = run(STACK_SCRIPT, ['status'], 30_000);
  } catch (error) {
    // `status` exits 1 when any row is not ok; its table is still the answer.
    out = String(error.stdout ?? '');
  }
  const health = new Map();
  for (const line of out.split('\n')) {
    const m = /^ {2}(\S+) +\S+ +\S+ +(.+)$/.exec(line);
    if (m) health.set(m[1], m[2].trim());
  }
  return names.filter((n) => !/^ok\b/.test(health.get(`svc-${n}`) ?? health.get(n) ?? ''));
}

/**
 * A stack tool, as `node tooling/scripts/<script> ...args`; returns its output. A failure, a timeout included, carries
 * the tool's own stdout and stderr. A `restart` is followed by the stack's health check for the services it names,
 * within the same cap: one left unhealthy fails here, by name, and marks the stack down for every later file.
 */
export function tool(script, ...args) {
  const started = Date.now();
  if (!(script === STACK_SCRIPT && args[0] === 'restart')) {
    try {
      return run(script, args, TOOL_CAP_MS);
    } catch (error) {
      throw withOutput(error, script, args);
    }
  }
  let out;
  let failed;
  try {
    out = run(script, args, TOOL_CAP_MS);
  } catch (error) {
    failed = withOutput(error, script, args);
  }
  const names = args.slice(1).filter((a) => !a.startsWith('-'));
  let down = unhealthy(names);
  while (down.length && Date.now() - started < TOOL_CAP_MS) {
    sleep(2_000);
    down = unhealthy(down);
  }
  if (down.length) {
    const why = failed ? failed.message.split('\n')[0] : 'the restart returned, but the health check never read ok';
    mkdirSync(path.dirname(STACK_DOWN), { recursive: true });
    writeFileSync(STACK_DOWN, JSON.stringify({ services: down, at: new Date().toISOString(), restart: args.join(' '), why }));
    throw new Error(
      `stack: ${down.join(', ')} not healthy after \`${args.join(' ')}\` (${Math.round((Date.now() - started) / 1000)} s of the ${TOOL_CAP_MS / 1000} s cap): ` +
        `every later journey file on this stack fails at once, naming it${failed ? `\n${failed.message}` : ''}`,
      { cause: failed },
    );
  }
  if (failed) throw failed;
  return out;
}

/**
 * Throws, naming the services, while a restart has left the stack down (`tool`), so a journey file fails at once rather
 * than waiting out its timeouts on a dead stack. A service that answers again (someone restarted it) clears the mark.
 */
export function assertStackUp() {
  let down;
  try {
    down = JSON.parse(readFileSync(STACK_DOWN, 'utf8'));
  } catch {
    return;
  }
  const still = unhealthy(down.services ?? []);
  if (!still.length) return rmSync(STACK_DOWN, { force: true });
  throw new Error(
    `stack: ${still.join(', ')} down since ${down.at}, when \`${down.restart}\` left it unhealthy (${down.why}); ` +
      `this file's steps would only wait out their timeouts on a dead stack`,
  );
}

/**
 * A stack service restarted with one of its TEST settings switched `off` (blank), or back on: the switch is set for the
 * restart only, and this process's environment is put back as it was.
 */
export function restartWith(service, envKey, on) {
  const before = process.env[envKey];
  if (on) delete process.env[envKey];
  else process.env[envKey] = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', service);
  } finally {
    if (before === undefined) delete process.env[envKey];
    else process.env[envKey] = before;
  }
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
  actedAs(who);
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

/**
 * The customer's own API through Edge, signed in as `who` with a session of its own (not the browser's). An account
 * with an authenticator signs in with a fresh code from it (`totpCode`).
 */
export async function api(who, { totpCode } = {}) {
  actedAs(who);
  const signIn = () =>
    fetch(`${EDGE}/api/identity/trpc/auth.login`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password, ...(totpCode ? { totpCode } : {}) }),
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
    put: (route, body) => call('PUT', route, body),
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
