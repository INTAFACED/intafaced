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
  venueDoorLeftOnGuard();
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

/** How long a stack tool may run. */
const TOOL_CAP_MS = 120_000;
/** How much of a tool's shown output its error keeps, from the end, so a timed-out restart says where it stood. */
const OUTPUT_TAIL = 4_000;

/**
 * The gates script's name, kept out of the function bodies below (`toolError`'s scoped-session rule): journey-world.mjs
 * counts a helper whose body names a stack script as running the stack's tools.
 */
const GATES_SCRIPT = 'local-test-gates.mjs';

/**
 * The only lines of a tool's output that a failure shows, by shape (an allow-list: anything else is withheld and only
 * counted, so an output nobody foresaw shows nothing). A failure's text reaches the public job log and report.
 *   - a status line, `  matching: stopped`, `test market: ok`, `  host dispatch (TEST): app … served`;
 *   - a row of the stack's health table;
 *   - a typed refusal, `refusing [code]: …`;
 *   - the header of a service that exited during start or never became healthy. The log tail that the stack prints
 *     under an "exited during start" header is never shown: every line after it is withheld.
 * A line that names a credential (NAMES_CREDENTIAL) is withheld whatever its shape.
 */
const SHOWN = [
  /^ {0,4}[a-z][A-Za-z0-9 ,()/'._-]{0,48}: \S/,
  /^ {2}(SERVICE|svc-[a-z0-9-]+|postgres|nats|chain \(TEST\)|video-store|rail-statements|customer|invitation|apex|admin|team-tls) +\S/,
  /^ *refusing \[[a-z0-9._-]+\]/,
  /^ *(?:local-test-[a-z]+: )?[a-z][a-z0-9-]* did not become healthy at \S+ within \d+s\b/,
  /^INTAFACED local test stack$/,
  /^LOCAL TEST GATES — /,
];
/**
 * The headers under which a tool prints a raw log tail, each as far as it is shown; every line after one is withheld.
 * A stack script's `fail()` writes `local-test-<script>: <message>` (local-test-stack.mjs `fail`, and the same in
 * -gates, -market, -world), so each header takes that prefix or none. The emitters (#7465 review round 2):
 *   - local-test-stack.mjs `waitHealthy`: `<service> exited during start. Log <path>:` and 20 log lines;
 *   - local-test-stack.mjs `startTeamTls`: `team-tls exited during start. Log <path>` (no tail; the header holds it);
 *   - local-test-stack.mjs `pnpmRun`: `<label> failed (exit <n>). Log: <path>` and 25 log lines;
 *   - local-test-market.mjs `start --wait`: `test market starting (pid <n>). Watch: …` and 6 log lines, on stdout.
 */
const TAIL_HEADERS = [
  /^ *(?:local-test-[a-z]+: )?[a-z][a-z0-9-]* exited during start\b/,
  /^ *(?:local-test-[a-z]+: )?[a-z][a-z0-9 ()/._-]* failed \(exit [^)]*\)\. Log\b/,
  /^ *(?:local-test-[a-z]+: )?test market starting \(pid \d+\)/,
];
/** A line naming a credential is withheld whatever its shape: a short value beside it would not be masked as opaque. */
const NAMES_CREDENTIAL = /password|passphrase|secret|cookie|bearer|authori[sz]ation|private[ _-]?key|api[ _-]?key|totp/i;
/** A run of 24 or more base64, base64url or hex characters (a generated key, a token, a hash) inside a shown line. */
const OPAQUE = /[A-Za-z0-9+/_=-]{24,}/g;
const SHOWN_WIDTH = 160;

/** One line as shown: opaque runs masked, then cut to SHOWN_WIDTH characters. */
const shownLine = (line) => {
  const masked = line.replace(OPAQUE, '[withheld]');
  return masked.length > SHOWN_WIDTH ? `${masked.slice(0, SHOWN_WIDTH)}…` : masked;
};

/** What of one output stream a failure may show: the allow-listed lines (masked and cut) and how many were withheld. */
export function shownOutput(text) {
  const shown = [];
  let withheld = 0;
  let inTail = false;
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') continue;
    if (inTail) {
      withheld += 1;
      continue;
    }
    const header = TAIL_HEADERS.map((re) => re.exec(line)).find(Boolean);
    if (header) {
      // The header only, as far as it matched: what follows on the line is the log's path, then its tail.
      shown.push(shownLine(header[0]));
      inTail = true;
    } else if (!NAMES_CREDENTIAL.test(line) && SHOWN.some((re) => re.test(line))) shown.push(shownLine(line));
    else withheld += 1;
  }
  let kept = shown;
  while (kept.length > 1 && kept.join('\n').length > OUTPUT_TAIL) kept = kept.slice(1);
  return { text: kept.join('\n'), lines: kept.length, withheld: withheld + (shown.length - kept.length) };
}

/** A stream that is never shown: nothing of it, only how many lines it had. */
const withheldAll = (text) => ({
  text: '',
  lines: 0,
  withheld: String(text ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '').length,
});

/**
 * The only error `tool` throws: a new Error, never Node's, whose message, `stdout` and `stderr` hold only the shown
 * output (`shownOutput`). Node's own message appends a failed command's raw stderr, and its error keeps the raw output,
 * so neither is ever thrown or kept as a cause. `status`, `signal` and `code` are Node's.
 */
export function toolError(raw, script, args) {
  // `gates scoped-session` prints only a TEST console session's cookies: its stdout is never shown, even on a failure.
  const out = script === GATES_SCRIPT && args[0] === 'scoped-session' ? withheldAll(raw?.stdout) : shownOutput(raw?.stdout);
  const err = shownOutput(raw?.stderr);
  const status = typeof raw?.status === 'number' ? raw.status : null;
  const code = raw?.code ?? raw?.error?.code ?? null;
  // A timeout reads as Node said it ("spawnSync <node> ETIMEDOUT"), which is how a runner error is told apart.
  const why =
    code === 'ETIMEDOUT'
      ? `timed out after ${TOOL_CAP_MS / 1000} s (spawnSync ${process.execPath} ETIMEDOUT)`
      : status !== null
        ? `exit ${status}`
        : `failed (${code ?? raw?.signal ?? 'no exit status'})`;
  const block = (name, s) =>
    `  its ${name} (${s.lines} line(s) shown, ${s.withheld} withheld):${s.text ? `\n${s.text.replace(/^/gm, '    ')}` : ''}`;
  const error = new Error(`tool ${shownLine([script, ...args].join(' '))} ${why}\n${block('stdout', out)}\n${block('stderr', err)}`);
  return Object.assign(error, { status, signal: raw?.signal ?? null, code, stdout: out.text, stderr: err.text });
}

const run = (script, args, timeout) =>
  execFileSync(process.execPath, [path.join(ROOT, 'tooling/scripts', script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });

/**
 * A stack tool, as `node tooling/scripts/<script> ...args`; returns its output. A failure, a timeout included, carries
 * the tool's own stdout and stderr.
 */
export function tool(script, ...args) {
  try {
    return run(script, args, TOOL_CAP_MS);
  } catch (error) {
    throw toolError(error, script, args);
  }
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

/**
 * A stack service restarted with one TEST setting set to `value` (`null` unsets it), for a setting that is off by
 * default (`LOCAL_STACK_USER_VENUE=on`). As `restartWith`, this process's environment is put back as it was.
 */
export function restartWithSetting(service, envKey, value) {
  const before = process.env[envKey];
  if (value === null) delete process.env[envKey];
  else process.env[envKey] = value;
  try {
    tool('local-test-stack.mjs', 'restart', service);
  } finally {
    if (before === undefined) delete process.env[envKey];
    else process.env[envKey] = before;
  }
}

/** The setting that points svc-trade's user-venue door at the stack's TEST venue (local-stack-services/trade.mjs). */
export const VENUE_DOOR_SETTING = 'LOCAL_STACK_USER_VENUE';
/** Written while a venue journey file holds the door on: the worker that switched it on. */
const VENUE_DOOR_MARK = path.join(RUN, 'venue-door-on.json');

/** A venue file switched the door on (`on`), or off again: the mark names this worker, so a crash before off is seen. */
export function markVenueDoor(on) {
  if (on) {
    mkdirSync(RUN, { recursive: true });
    writeFileSync(VENUE_DOOR_MARK, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  } else rmSync(VENUE_DOOR_MARK, { force: true });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

/**
 * A venue file's worker that died before its afterAll left the door on for the next file in the shard. The next file's
 * first sign-in (`actedAs`) sees the mark of a worker that is gone and switches the door off before it goes on.
 */
export function venueDoorLeftOnGuard() {
  if (!existsSync(VENUE_DOOR_MARK)) return;
  let pid = null;
  try {
    pid = JSON.parse(readFileSync(VENUE_DOOR_MARK, 'utf8')).pid;
  } catch {
    pid = null;
  }
  if (pid === process.pid || (Number.isInteger(pid) && alive(pid))) return;
  restartWithSetting('trade', VENUE_DOOR_SETTING, 'off');
  markVenueDoor(false);
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
