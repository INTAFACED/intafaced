/**
 * LOCAL TEST STACK founder pair. Not the Docker stack's founders.
 *
 * Seeds two labelled accounts (local_test_founder_a, local_test_founder_b) on the
 * test stack's own identity, through the same registerFounder + TOTP doors as
 * tooling/scripts/local-founder-seed.mjs. Password and TOTP live only in
 * <state>/founders.json (mode 600). svc-identity's IDENTITY_FOUNDER_* slots are
 * set to those two user ids and to nobody else.
 *
 * Refuses unless the local test stack marker exists and the edge is
 * http://127.0.0.1:<that marker's edge port>. Never reads or writes
 * .env.founder.local or .env.founder-secrets.local. Never enrols a test operator.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { GuardError, enrolFounderAccounts, generateInvites, randomPassword } from './local-founder-seed.mjs';
import { readLatestEmailConfirmToken } from './local-test-state.mjs';

export { GuardError };

export const FOUNDER_VAULT_NAME = 'founders.json';
/** Each founder's last used TOTP step (a, b), shared with local-test-gates.mjs so no tool replays a code. */
export const FOUNDER_STEPS_NAME = 'founder-totp-steps.json';
export const PIN_STAMP_NAME = 'identity-founder-pin.json';
/** How long one holder may keep the steps lock before another process counts it as abandoned (a killed worker). */
export const FOUNDER_STEPS_LOCK_STALE_MS = 10_000;
/** How long a process waits for the steps lock before it gives up with an error naming the lock. */
const FOUNDER_STEPS_LOCK_WAIT_MS = 15_000;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `fn(steps)` with the founders' TOTP steps file read under a lock that every process on the stack takes (the
 * journey workers, the world, the gates CLI, the freeze guard's lift), and writes back what `fn` returns as `next`.
 * Without it two processes could both read step N and both send step N + 1; identity accepts the first and refuses
 * the second as a replay (auth.mfa_invalid). Failure it prevents: J-copy-bots-otc-10 #4's founder sign-in to the
 * console refused in full run 1343 (#7209). The lock is a file created exclusively; one left by a process that died
 * holding it is taken over after FOUNDER_STEPS_LOCK_STALE_MS. The work inside is two small file reads and one write.
 */
export function withFounderSteps(stateDir, fn, { now = Date.now } = {}) {
  const file = path.join(stateDir, FOUNDER_STEPS_NAME);
  const lock = `${file}.lock`;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const until = now() + FOUNDER_STEPS_LOCK_WAIT_MS;
  let fd;
  for (;;) {
    try {
      fd = openSync(lock, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = 0;
      try {
        age = now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released between the open and the stat: try again at once
      }
      if (age > FOUNDER_STEPS_LOCK_STALE_MS) {
        try {
          unlinkSync(lock);
        } catch {
          /* another process took it over first */
        }
        continue;
      }
      if (now() > until) throw new Error(`the founders' TOTP steps lock ${lock} is held past ${FOUNDER_STEPS_LOCK_WAIT_MS} ms`);
      pause(20);
    }
  }
  try {
    let steps = {};
    try {
      steps = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      /* none yet, or unreadable: counts as no step used */
    }
    const { next, result } = fn(steps);
    if (next) {
      const tmp = `${file}.${process.pid}.tmp`;
      writePrivate(tmp, `${JSON.stringify(next, null, 2)}\n`);
      renameSync(tmp, file);
    }
    return result;
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      /* already taken over as stale */
    }
  }
}

/** Records that founder `key` used TOTP step `step`, never moving the recorded step back. */
export function recordFounderStep(stateDir, key, step) {
  withFounderSteps(stateDir, (steps) => {
    const recorded = Number(steps[key] ?? 0);
    const kept = Number.isFinite(recorded) ? recorded : 0;
    return { next: step > kept ? { ...steps, [key]: step } : null };
  });
}

export const VAULT_KIND = 'intafaced-local-test-founders';
/** Docker compose edge. This seed never talks to it. */
export const DOCKER_EDGE_PORT = '4000';
/** A shared Postgres, not this stack's. */
export const SHARED_POSTGRES_PORT = '5432';

/**
 * The two identity slots are the service's env names. The accounts behind them
 * on this stack are the labelled local-test pair, not the Docker accounts.
 */
export const LOCAL_TEST_FOUNDERS = [
  {
    key: 'a',
    handle: 'local_test_founder_a',
    email: 'local-test-founder-a@local-test.invalid',
    idVar: 'IDENTITY_FOUNDER_NITRO_USER_ID',
  },
  {
    key: 'b',
    handle: 'local_test_founder_b',
    email: 'local-test-founder-b@local-test.invalid',
    idVar: 'IDENTITY_FOUNDER_PHANTOM_USER_ID',
  },
];

const HANDLE_A = LOCAL_TEST_FOUNDERS[0].handle;
const HANDLE_B = LOCAL_TEST_FOUNDERS[1].handle;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function isLocalTestFounderHandle(handle) {
  return handle === HANDLE_A || handle === HANDLE_B;
}

export function isOperatorHandle(handle) {
  return /^local_test_operator_/i.test(String(handle ?? ''));
}

export function isDockerFounderHandle(handle) {
  return handle === 'local_nitro' || handle === 'local_phantom';
}

function writePrivate(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** The only vault the local test world may read. Absolute state dir, or nothing. */
export function founderVaultFiles({ stateDir } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) return [];
  return [path.join(stateDir, FOUNDER_VAULT_NAME)];
}

export function founderVaultPath(stateDir) {
  return path.join(stateDir, FOUNDER_VAULT_NAME);
}

/**
 * Throws GuardError unless this is the local test stack and the edge is its own
 * loopback port. A Docker edge (port 4000) and a shared Postgres (port 5432) refuse.
 */
export function assertLocalTestFounderTarget({ marker, stateDir, edgeUrl }) {
  if (!marker || marker.kind !== 'intafaced-local-test-stack') {
    throw new GuardError('refusing: local test founder seed requires the local test stack marker');
  }
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) {
    throw new GuardError('refusing: the local test founder vault needs an absolute state directory');
  }
  const db = marker.database ?? {};
  if (db.host !== '127.0.0.1') {
    throw new GuardError('refusing: the local test stack database is not on 127.0.0.1');
  }
  if (String(db.port ?? '') === SHARED_POSTGRES_PORT) {
    throw new GuardError('refusing: port 5432 is not the local test stack database');
  }
  const edgePort = marker.ports?.edge;
  if (edgePort === undefined || edgePort === null || String(edgePort).trim() === '') {
    throw new GuardError('refusing: the local test stack marker has no edge port');
  }
  if (String(edgePort) === DOCKER_EDGE_PORT) {
    throw new GuardError('refusing: port 4000 is the Docker stack edge. This seed only talks to the local test stack.');
  }
  let url;
  try {
    url = new URL(edgeUrl);
  } catch {
    throw new GuardError('refusing: the founder seed edge URL is not a URL');
  }
  const expected = `http://127.0.0.1:${edgePort}`;
  if (url.origin !== expected || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new GuardError(`refusing: founder seed edge must be ${expected}`);
  }
  const vaultPath = path.resolve(founderVaultPath(stateDir));
  if (vaultPath !== path.resolve(stateDir, FOUNDER_VAULT_NAME)) {
    throw new GuardError('refusing: the local test founder vault path is not <state>/founders.json');
  }
  if (path.basename(vaultPath) === '.env.founder-secrets.local' || vaultPath.endsWith(`${path.sep}.env.founder.local`)) {
    throw new GuardError('refusing: this seed does not write the Docker founder files');
  }
  return { vaultPath, edgeUrl: expected };
}

/** Throws when the vault is not exactly the two labelled local-test founders. */
export function assertVaultShape(vault) {
  if (!vault || vault.kind !== VAULT_KIND) {
    throw new GuardError('refusing: founder vault is not a local test stack vault');
  }
  const rows = vault.founders;
  if (!Array.isArray(rows) || rows.length !== 2) {
    throw new GuardError('refusing: the local test founder vault must contain exactly two founders');
  }
  const handles = [];
  for (const row of rows) {
    const handle = row?.handle;
    if (isOperatorHandle(handle)) throw new GuardError('refusing: test operators are not founders');
    if (isDockerFounderHandle(handle)) {
      throw new GuardError('refusing: Docker stack founders are not the local test stack pair');
    }
    if (!isLocalTestFounderHandle(handle)) {
      throw new GuardError('refusing: local test founder handles must be local_test_founder_a and local_test_founder_b');
    }
    handles.push(handle);
  }
  if (new Set(handles).size !== 2) throw new GuardError('refusing: the two local test founders must be distinct');
}

export function draftFounderVault({ now = new Date(), rand = randomBytes } = {}) {
  const invites = generateInvites({ now, rand });
  return {
    kind: VAULT_KIND,
    label: 'LOCAL TEST — not real founders',
    note: 'Password and TOTP for the local test stack only. Not the Docker stack founders. Never copy this file to staging or production.',
    invites: { hashes: invites.hashes, expiresAt: invites.expiresAt },
    founders: LOCAL_TEST_FOUNDERS.map((f, i) => ({
      key: f.key,
      handle: f.handle,
      email: f.email,
      idVar: f.idVar,
      password: randomPassword(rand),
      invite: invites.codes[i],
      userId: null,
      totpSecret: null,
      totpConfirmed: false,
    })),
  };
}

function invitesExpired(vault, now) {
  const at = Date.parse(vault?.invites?.expiresAt ?? '');
  return !Number.isFinite(at) || at <= now.getTime();
}

function anyoneEnrolled(vault) {
  return (vault?.founders ?? []).some((f) => f && f.userId);
}

/**
 * Create <state>/founders.json when it is missing. Refresh unused invites once
 * they have expired. Never replaces a vault that already names a created account.
 */
export function ensureFounderVaultDraft({ stateDir, marker, edgeUrl, now = new Date(), rand = randomBytes, log = () => {} } = {}) {
  const { vaultPath } = assertLocalTestFounderTarget({ marker, stateDir, edgeUrl });
  if (!existsSync(vaultPath)) {
    const vault = draftFounderVault({ now, rand });
    writePrivate(vaultPath, `${JSON.stringify(vault, null, 2)}\n`);
    log(`local test founders: wrote ${vaultPath} (mode 600)`);
    return { vaultPath, vault, created: true };
  }
  let vault;
  try {
    vault = JSON.parse(readFileSync(vaultPath, 'utf8'));
  } catch {
    throw new GuardError(`refusing: ${vaultPath} is not readable JSON`);
  }
  assertVaultShape(vault);
  if (!anyoneEnrolled(vault) && invitesExpired(vault, now)) {
    const fresh = draftFounderVault({ now, rand });
    writePrivate(vaultPath, `${JSON.stringify(fresh, null, 2)}\n`);
    log('local test founders: unused invites had expired; wrote a fresh pair');
    return { vaultPath, vault: fresh, created: true };
  }
  return { vaultPath, vault, created: false };
}

/**
 * Env for the test stack's svc-identity. Invite hashes when the vault has them.
 * The two user-id slots only after both labelled founders have a confirmed TOTP.
 * An operator handle, a Docker handle, or a bad vault yields no ids.
 */
export function founderIdentityEnv(vault) {
  if (!vault || vault.kind !== VAULT_KIND) return {};
  try {
    assertVaultShape(vault);
  } catch {
    return {};
  }
  const env = {};
  const hashes = vault.invites?.hashes;
  const expiresAt = vault.invites?.expiresAt;
  if (
    Array.isArray(hashes) &&
    hashes.length === 2 &&
    hashes.every((h) => SHA256_RE.test(h)) &&
    new Set(hashes).size === 2 &&
    typeof expiresAt === 'string' &&
    expiresAt
  ) {
    env.IDENTITY_FOUNDER_INVITE_HASHES = hashes.join(',');
    env.IDENTITY_FOUNDER_INVITE_EXPIRES_AT = expiresAt;
  }
  const byHandle = Object.fromEntries(vault.founders.map((f) => [f.handle, f]));
  const a = byHandle[HANDLE_A];
  const b = byHandle[HANDLE_B];
  const aVar = LOCAL_TEST_FOUNDERS[0].idVar;
  const bVar = LOCAL_TEST_FOUNDERS[1].idVar;
  // A missing slot name defaults to the handle. A wrong slot name is not pinned.
  if ((a.idVar && a.idVar !== aVar) || (b.idVar && b.idVar !== bVar)) return env;
  if (a.totpConfirmed !== true || b.totpConfirmed !== true) return env;
  if (!UUID_RE.test(String(a.userId ?? '')) || !UUID_RE.test(String(b.userId ?? ''))) return env;
  if (String(a.userId).toLowerCase() === String(b.userId).toLowerCase()) return env;
  env[aVar] = a.userId;
  env[bVar] = b.userId;
  return env;
}

/** What identity was last started with. Ids and invite expiry only; no secrets. */
export function founderPinStampFromEnv(env) {
  return {
    inviteExpiresAt: env?.IDENTITY_FOUNDER_INVITE_EXPIRES_AT ?? null,
    nitroUserId: env?.IDENTITY_FOUNDER_NITRO_USER_ID ?? null,
    phantomUserId: env?.IDENTITY_FOUNDER_PHANTOM_USER_ID ?? null,
  };
}

export function pinStampPath(stateDir) {
  return path.join(stateDir, 'run', PIN_STAMP_NAME);
}

export function writeFounderPinStamp(stateDir, env) {
  const stamp = founderPinStampFromEnv(env);
  writePrivate(pinStampPath(stateDir), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

export function readFounderPinStamp(stateDir) {
  const file = pinStampPath(stateDir);
  if (!existsSync(file)) return null;
  try {
    const stamp = JSON.parse(readFileSync(file, 'utf8'));
    if (!stamp || typeof stamp !== 'object') return null;
    return founderPinStampFromEnv({
      IDENTITY_FOUNDER_INVITE_EXPIRES_AT: stamp.inviteExpiresAt,
      IDENTITY_FOUNDER_NITRO_USER_ID: stamp.nitroUserId,
      IDENTITY_FOUNDER_PHANTOM_USER_ID: stamp.phantomUserId,
    });
  } catch {
    return null;
  }
}

export function foundersEnrolled(vault) {
  try {
    assertVaultShape(vault);
  } catch {
    return false;
  }
  const env = founderIdentityEnv(vault);
  return Boolean(env.IDENTITY_FOUNDER_NITRO_USER_ID && env.IDENTITY_FOUNDER_PHANTOM_USER_ID);
}

/** The vault's two founders once both have an account and a confirmed second factor, in a/b order; otherwise null. */
export function enrolledFounderPair(vault) {
  try {
    assertVaultShape(vault);
  } catch {
    return null;
  }
  const ready = (f) => typeof f.userId === 'string' && f.userId && f.password && f.totpSecret && f.totpConfirmed === true;
  const [a, b] = ['a', 'b'].map((k) => vault.founders.find((f) => f.key === k));
  return a && b && ready(a) && ready(b) && a.userId !== b.userId ? [a, b] : null;
}

/**
 * Whether identity must be restarted so it is running the vault's invites (before
 * enrolment) or the two user ids (after). A matching stamp means the running
 * process was started with that env.
 */
export function planFounderIdentityRestart({ enrolled, stamp, vault }) {
  const env = founderIdentityEnv(vault);
  const expiresAt = vault?.invites?.expiresAt ?? null;
  if (!enrolled) {
    const invitesApplied = Boolean(stamp && expiresAt && stamp.inviteExpiresAt === expiresAt);
    return { restartBeforeEnrol: !invitesApplied, restartToPin: false };
  }
  const idsApplied = Boolean(
    stamp &&
    env.IDENTITY_FOUNDER_NITRO_USER_ID &&
    stamp.nitroUserId === env.IDENTITY_FOUNDER_NITRO_USER_ID &&
    stamp.phantomUserId === env.IDENTITY_FOUNDER_PHANTOM_USER_ID,
  );
  return { restartBeforeEnrol: false, restartToPin: !idsApplied };
}

/** The LOCAL-TEST email-confirm lines identity has written for `email` so far, oldest first. */
function confirmLines(outboxPath, email) {
  if (!existsSync(outboxPath)) return [];
  return readFileSync(outboxPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes('purpose=email-confirm') && line.includes(` email=${email} `));
}

/**
 * Confirms each enrolled founder's email address the way its owner would, once: sign in (`signIn(founder)` returns an
 * access token), ask identity for the link (`auth.requestEmailConfirmation`), take the new line identity "mails" to this
 * stack's outbox file and confirm with its token (`auth.confirmEmail`). Nothing writes `email_verified_at` directly. A
 * confirmed address is what lets identity's new-device check mail a founder the code that approves a new browser
 * (docs/LOCAL-TEST-STACK.md, Founder console; J-ops-console-01 #1). Each founder is marked `emailConfirmed` in the vault
 * only after identity says so, so a run that stops halfway confirms the rest on the next start.
 */
export async function confirmFounderEmails({
  stateDir,
  marker,
  edgeUrl: requestedEdge,
  signIn,
  fetchImpl = fetch,
  waitMs = 10_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
}) {
  const { vaultPath, edgeUrl } = assertLocalTestFounderTarget({ marker, stateDir, edgeUrl: requestedEdge });
  const outboxPath = path.join(stateDir, 'email-outbox.log');
  const vault = JSON.parse(readFileSync(vaultPath, 'utf8'));
  assertVaultShape(vault);
  for (const f of vault.founders) {
    if (f.emailConfirmed === true || !f.userId || f.totpConfirmed !== true) continue;
    const token = await signIn(f);
    const call = async (procedure, input) => {
      const res = await fetchImpl(`${edgeUrl}/api/identity/trpc/${procedure}`, {
        method: input === undefined ? 'GET' : 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(input === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => null);
      if (res.status < 200 || res.status >= 300) {
        const code = body?.error?.data?.cause?.code ?? body?.error?.data?.intafacedCode ?? `http.${res.status}`;
        throw new GuardError(`${f.key}: identity refused ${procedure} (${code})`);
      }
      return body?.result?.data;
    };
    if ((await call('me'))?.emailVerified !== true) {
      const seen = confirmLines(outboxPath, f.email).length;
      await call('auth.requestEmailConfirmation', {});
      const until = Date.now() + waitMs;
      let line;
      while (!(line = confirmLines(outboxPath, f.email)[seen])) {
        if (Date.now() >= until) throw new GuardError(`${f.key}: no LOCAL-TEST confirm link reached ${outboxPath} for ${f.email}`);
        await sleep(250);
      }
      const confirmToken = readLatestEmailConfirmToken(line, f.email);
      if (!confirmToken) throw new GuardError(`${f.key}: the LOCAL-TEST confirm line for ${f.email} has no token`);
      await call('auth.confirmEmail', { token: confirmToken });
      if ((await call('me'))?.emailVerified !== true) throw new GuardError(`${f.key}: identity did not confirm ${f.email}`);
    }
    f.emailConfirmed = true;
    writePrivate(vaultPath, `${JSON.stringify(vault, null, 2)}\n`);
    log(`  founders: ${f.key}'s email address is confirmed`);
  }
  return vault;
}

/**
 * Enrol the vault's two founders on the test stack edge. Saves the vault after
 * each secret. Does not write a Docker env file and does not set IDENTITY_FOUNDER_*
 * itself: the stack reads founderIdentityEnv on the next identity start.
 */
export async function enrolTestStackFounders({
  stateDir,
  marker,
  edgeUrl,
  fetchImpl = fetch,
  now = () => new Date(),
  log = () => {},
} = {}) {
  const { vaultPath, edgeUrl: edge } = assertLocalTestFounderTarget({ marker, stateDir, edgeUrl });
  if (!existsSync(vaultPath)) throw new GuardError(`refusing: ${vaultPath} is missing. Start the local test stack first.`);
  const vault = JSON.parse(readFileSync(vaultPath, 'utf8'));
  assertVaultShape(vault);
  const save = () => writePrivate(vaultPath, `${JSON.stringify(vault, null, 2)}\n`);
  const confirmedBefore = new Set(vault.founders.filter((f) => f.totpConfirmed === true).map((f) => f.key));
  await enrolFounderAccounts({
    edge,
    founders: vault.founders,
    save,
    now,
    fetchImpl,
    log,
    vaultLabel: vaultPath,
  });
  assertVaultShape(vault);
  // A confirm here used the current TOTP step. Record it where the gates and the world look (founderTotp in
  // local-test-gates.mjs), or their first sign-in in the same 30 seconds is refused as a replay (auth.mfa_invalid).
  const fresh = vault.founders.filter((f) => f.totpConfirmed === true && !confirmedBefore.has(f.key)).map((f) => f.key);
  if (fresh.length) {
    const step = Math.floor(now().getTime() / 30_000);
    for (const key of fresh) recordFounderStep(stateDir, key, step);
  }
  return vault;
}
