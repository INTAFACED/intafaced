#!/usr/bin/env node
/**
 * LOCAL founder access for the Docker stack (customer :8090, founder console :3100).
 *
 *   INTAFACED_LOCAL_FOUNDER=1 node tooling/scripts/local-founder-seed.mjs init     (pnpm local:founder init)
 *       re-init on a wiped database: init --force --force-new-db (old files are kept as .bak copies)
 *   INTAFACED_LOCAL_FOUNDER=1 node tooling/scripts/local-founder-seed.mjs enrol
 *   INTAFACED_LOCAL_FOUNDER=1 node tooling/scripts/local-founder-seed.mjs code nitro|phantom
 *
 * WHAT IT DOES NOT DO: it never touches SQL. The two founders are created through
 * svc-identity's own public door, `auth.registerFounder`, using single-use invite
 * codes whose sha256 hashes are the only thing the service is configured with, and
 * their second factor is enrolled through the real `totp.enrol` / `totp.confirm`
 * procedures. Every invariant (password policy, invite spend-once under an advisory
 * lock, the factor gate, the founder pair pin) is the service's, not this file's.
 *
 * WHAT IT REFUSES. It exits before reading or writing anything unless ALL hold:
 *   - NODE_ENV is not "production";
 *   - INTAFACED_LOCAL_FOUNDER=1 is set (an explicit, per-invocation LOCAL flag);
 *   - APP_ENV (process env, else ./.env) is exactly "dev" or "test" - "staging",
 *     "prod", blank and missing all refuse;
 *   - for `enrol`, the edge URL is http on a loopback host (localhost, 127.0.0.1, ::1).
 * Nothing here can reach a deployed stack, and the service-side production guards
 * (posture scan, WebAuthn posture, `:?` secrets) are untouched.
 *
 * SECRETS. Generated with node:crypto. They are written only to two git-ignored files
 * in the repo root, mode 0600, and are never printed; stdout carries "written to
 * <path>" lines and non-secret progress only. The one deliberate exception is the
 * `code` command, which prints a single 6-digit one-time code that is valid for
 * under a minute. The files:
 *   .env.founder.local          compose env file (pass with --env-file after .env)
 *   .env.founder-secrets.local  founder invite codes, passwords, TOTP secrets, recovery codes
 * Both match the existing `.env.*.local` ignore rule.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCAL_TEST_DEVICE_KEY } from './local-test-device.mjs';

export const ENV_FILE = '.env.founder.local';
export const FOUNDER_VAULT_PATH = '.env.founder-secrets.local';
export const LOCAL_FLAG = 'INTAFACED_LOCAL_FOUNDER';
export const ADMIN_ORIGIN = 'http://localhost:3100';
export const WEBAUTHN_ORIGINS = 'http://localhost:8090,http://localhost:3100';
export const DEFAULT_EDGE_URL = 'http://localhost:4000';
/** Matches svc-identity `INVITE_TTL_HOURS`. */
export const INVITE_TTL_HOURS = 72;
export const FOUNDERS = [
  { key: 'nitro', handle: 'local_nitro', email: 'local-nitro@local.invalid', idVar: 'IDENTITY_FOUNDER_NITRO_USER_ID' },
  { key: 'phantom', handle: 'local_phantom', email: 'local-phantom@local.invalid', idVar: 'IDENTITY_FOUNDER_PHANTOM_USER_ID' },
];

export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardError';
  }
}

// ── Guards ────────────────────────────────────────────────────────────────────

/** Minimal dotenv reader: KEY=VALUE lines, optional quotes, `#` comment lines ignored. */
export function parseDotenv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2))
      v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function isLoopbackHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'http:' && !url.username && !url.password && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/**
 * Throws GuardError unless this is an explicit local invocation. Pure: callers pass the
 * process env and the text of ./.env (or null). Returns the APP_ENV that was accepted.
 */
export function assertLocalOnly({ env, dotenvText = null, needEdge = false }) {
  if (env.NODE_ENV === 'production') throw new GuardError('refusing: NODE_ENV is "production". This script is local-only.');
  if (env[LOCAL_FLAG] !== '1') {
    throw new GuardError(`refusing: set ${LOCAL_FLAG}=1 to confirm this is the local Docker stack on this machine.`);
  }
  const appEnv = env.APP_ENV ?? (dotenvText === null ? undefined : parseDotenv(dotenvText).APP_ENV);
  if (appEnv !== 'dev' && appEnv !== 'test') {
    throw new GuardError(
      `refusing: APP_ENV is ${appEnv === undefined || appEnv === '' ? 'not set' : `"${appEnv}"`}; it must be exactly "dev" or "test" (set it in .env).`,
    );
  }
  if (needEdge) {
    const edge = env.INTAFACED_LOCAL_EDGE_URL ?? DEFAULT_EDGE_URL;
    if (!isLoopbackHttpUrl(edge)) throw new GuardError('refusing: the edge URL must be http on localhost / 127.0.0.1 / [::1].');
  }
  return appEnv;
}

// ── Secret + invite generation ───────────────────────────────────────────────

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input) {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = BASE32.indexOf(ch);
    if (i === -1) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Same canonical form as svc-identity founder-enrolment.ts: upper case, no spaces or dashes. */
export function canonicalInvite(code) {
  return code.replace(/[\s-]/g, '').toUpperCase();
}
export function hashInvite(canonical) {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
function groupInvite(canonical) {
  return canonical.match(/.{1,4}/g).join('-');
}

/** Two single-use invites: 160 bits each as 32 base32 chars, plus the config values for their hashes. */
export function generateInvites({ now = new Date(), rand = randomBytes } = {}) {
  const canon = [];
  while (canon.length < 2) {
    const c = base32Encode(rand(20));
    if (!canon.includes(c)) canon.push(c);
  }
  return {
    codes: canon.map(groupInvite),
    hashes: canon.map(hashInvite),
    expiresAt: new Date(now.getTime() + INVITE_TTL_HOURS * 3600 * 1000).toISOString(),
  };
}

export const randomKeyBase64 = (rand = randomBytes) => rand(32).toString('base64');
export const randomKeyBase64url = (rand = randomBytes) => rand(32).toString('base64url');
export const randomPassword = (rand = randomBytes) => rand(24).toString('base64url');

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30 s - what svc-identity verifies) ───────

export function hotp(secret, counter, digits = 6) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const d = createHmac('sha1', secret).update(buf).digest();
  const o = d[d.length - 1] & 0x0f;
  const n = ((d[o] & 0x7f) << 24) | ((d[o + 1] & 0xff) << 16) | ((d[o + 2] & 0xff) << 8) | (d[o + 3] & 0xff);
  return String(n % 10 ** digits).padStart(digits, '0');
}
export function totpNow(secretBase32, at = new Date(), digits = 6) {
  return hotp(base32Decode(secretBase32), Math.floor(at.getTime() / 1000 / 30), digits);
}

// ── Files ─────────────────────────────────────────────────────────────────────

/** Replace `KEY=` lines in place or append them; leaves every other line alone. */
export function upsertEnv(text, values) {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const seen = new Set();
  const next = lines.map((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (m && Object.hasOwn(values, m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${values[m[1]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(values)) if (!seen.has(k)) next.push(`${k}=${v}`);
  return `${next.join('\n')}\n`;
}

export function buildEnvFile({ totpKey, adminSessionSecret, invites }) {
  return [
    '# LOCAL DOCKER STACK ONLY - generated by tooling/scripts/local-founder-seed.mjs. Git-ignored. Never reuse in staging or production.',
    '# Use:  docker compose --env-file .env --env-file .env.founder.local -f docker-compose.apps.yml up -d --build',
    `IDENTITY_TOTP_SECRET_KEY=${totpKey}`,
    `ADMIN_SESSION_SECRET=${adminSessionSecret}`,
    `ADMIN_ORIGIN=${ADMIN_ORIGIN}`,
    'WEBAUTHN_RP_ID=localhost',
    `WEBAUTHN_ORIGIN=${WEBAUTHN_ORIGINS}`,
    `IDENTITY_FOUNDER_INVITE_HASHES=${invites.hashes.join(',')}`,
    `IDENTITY_FOUNDER_INVITE_EXPIRES_AT=${invites.expiresAt}`,
    '',
  ].join('\n');
}

export function buildSecrets({ invites, rand = randomBytes }) {
  return {
    note: 'LOCAL DOCKER STACK ONLY. Contains passwords and 2FA secrets. Git-ignored. Do not share.',
    founders: FOUNDERS.map((f, i) => ({
      key: f.key,
      handle: f.handle,
      email: f.email,
      password: randomPassword(rand),
      invite: invites.codes[i],
      userId: null,
      totpSecret: null,
      recoveryCodes: null,
    })),
  };
}

function writePrivate(path, text, { overwrite }) {
  writeFileSync(path, text, { mode: 0o600, flag: overwrite ? 'w' : 'wx' });
  chmodSync(path, 0o600);
}

// ── tRPC over the edge ───────────────────────────────────────────────────────

/** A tRPC refusal reduced to its codes. Never carries the response body. */
export class TrpcError extends Error {
  constructor(message, intafacedCode) {
    super(message);
    this.name = 'TrpcError';
    this.intafacedCode = typeof intafacedCode === 'string' ? intafacedCode : undefined;
  }
}

/** Unwrap `{result:{data}}` (and `{json}`) exactly as apps/admin does; throw a SHORT error with no body echo. */
export function unwrapTrpc(status, body) {
  if (status < 200 || status >= 300) {
    const code = body?.error?.data?.code ?? body?.error?.json?.data?.code ?? `HTTP_${status}`;
    const intafaced = body?.error?.data?.intafacedCode ?? body?.error?.json?.data?.intafacedCode ?? body?.error?.cause?.code;
    throw new TrpcError(`${code}${typeof intafaced === 'string' ? ` (${intafaced})` : ''}`, intafaced);
  }
  const data = body?.result?.data;
  if (data === undefined) throw new Error('unexpected response shape');
  return data && typeof data === 'object' && 'json' in data ? data.json : data;
}

async function call(edge, procedure, input, token, fetchImpl = fetch) {
  const res = await fetchImpl(`${edge}/api/identity/trpc/${procedure}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(input ?? {}),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => null);
  return unwrapTrpc(res.status, body);
}

// ── Commands ──────────────────────────────────────────────────────────────────

function paths(root) {
  return { env: join(root, ENV_FILE), secrets: join(root, FOUNDER_VAULT_PATH), dotenv: join(root, '.env') };
}
const readDotenv = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

/** `.env.founder.local` -> `.env.founder.bak-<ts>.local`: still matches the `.env.*.local` ignore rule. */
export function backupName(file, now) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return file.replace(/\.local$/, `.bak-${stamp}.local`);
}

export function init({ root, env, now = new Date(), rand = randomBytes, force = false, forceNewDb = false, log = console.log }) {
  const p = paths(root);
  assertLocalOnly({ env, dotenvText: readDotenv(p.dotenv) });
  const existing = [p.env, p.secrets].filter((f) => existsSync(f));
  if (existing.length > 0) {
    if (!force) {
      throw new GuardError(
        `refusing: ${ENV_FILE} or ${FOUNDER_VAULT_PATH} already exists. Overwriting would change IDENTITY_TOTP_SECRET_KEY and lock out any founder already enrolled in the existing database. Re-run with --force only on a fresh database (pnpm platform:reset).`,
      );
    }
    // The secrets file is the only copy of the founders' passwords and 2FA secrets. If it names a
    // created founder (or cannot be read), the database may hold them: demand an explicit second flag.
    let created = true;
    try {
      created = existsSync(p.secrets) && JSON.parse(readFileSync(p.secrets, 'utf8')).founders.some((f) => Boolean(f.userId));
    } catch {
      created = true;
    }
    if (created && !forceNewDb) {
      throw new GuardError(
        `refusing: ${FOUNDER_VAULT_PATH} records founders that may already exist in the database (or cannot be read). --force would orphan them. If the database is being wiped (pnpm platform:reset), add --force-new-db; the old files are kept as .bak copies either way.`,
      );
    }
    for (const f of existing) {
      const dest = backupName(f, now);
      renameSync(f, dest);
      chmodSync(dest, 0o600);
      log(`kept old file as ${dest} (mode 600)`);
    }
  }
  const invites = generateInvites({ now, rand });
  writePrivate(p.env, buildEnvFile({ totpKey: randomKeyBase64(rand), adminSessionSecret: randomKeyBase64url(rand), invites }), {
    overwrite: false,
  });
  writePrivate(p.secrets, `${JSON.stringify(buildSecrets({ invites, rand }), null, 2)}\n`, { overwrite: false });
  log(`written to ${p.env} (mode 600): compose env file with fresh local secrets and invite hashes`);
  log(`written to ${p.secrets} (mode 600): founder invite codes, passwords and (later) 2FA secrets`);
  log(`The invites expire at ${invites.expiresAt} (${INVITE_TTL_HOURS} h). Next: start the stack, then run "enrol". See docs/RUNNING.md.`);
}

/**
 * Register each founder through `auth.registerFounder` and enrol TOTP.
 * Mutates `founders` in place and calls `save` after every secret is learned.
 * Callers pass an edge they have already guarded. This function does not choose
 * a vault path and does not write the Docker env file.
 */
export async function enrolFounderAccounts({
  edge,
  founders,
  save,
  now = () => new Date(),
  fetchImpl = fetch,
  log = console.log,
  vaultLabel = FOUNDER_VAULT_PATH,
}) {
  const startEnrolment = async (f, accessToken) => {
    const started = await call(edge, 'totp.enrol', {}, accessToken, fetchImpl);
    // Persist BEFORE confirming: a crash between the two must not lose the only copy of the secret.
    f.totpSecret = started.secret;
    f.recoveryCodes = started.recoveryCodes;
    f.totpConfirmed = false;
    save();
  };
  const confirm = (f, accessToken) =>
    call(edge, 'totp.confirm', { secret: f.totpSecret, code: totpNow(f.totpSecret, now()) }, accessToken, fetchImpl);

  for (const f of founders) {
    if (f.userId && f.totpConfirmed === true) continue; // fully enrolled on an earlier run
    let session;
    if (f.userId) {
      // Resumed run. A password login WITHOUT a code tells us where the server is:
      //  - `auth.mfa_required`: TOTP is already enrolled there (the confirm succeeded but its reply was lost).
      //    Nothing to redo. Deliberately no code is sent, so a code from the step the confirm already
      //    consumed can never be refused as a replay.
      //  - a session: TOTP is still pending (or never started), so confirm/enrol below.
      try {
        session = await call(
          edge,
          'auth.login',
          { identifier: f.handle, password: f.password, deviceKey: LOCAL_TEST_DEVICE_KEY },
          null,
          fetchImpl,
        );
      } catch (err) {
        if (!(err instanceof TrpcError) || err.intafacedCode !== 'auth.mfa_required') throw err;
        if (!f.totpSecret) {
          const recovery =
            vaultLabel === FOUNDER_VAULT_PATH
              ? 'wipe the database (pnpm platform:reset) and run init --force --force-new-db'
              : 'recreate the local test stack database before enrolling this pair again';
          throw new Error(`${f.key} already has an authenticator on the server but its secret is not in ${vaultLabel}; ${recovery}`);
        }
        f.totpConfirmed = true;
        save();
        log(`${f.key}: authenticator (TOTP) was already enrolled`);
        continue;
      }
    } else {
      session = await call(
        edge,
        'auth.registerFounder',
        { invite: f.invite, handle: f.handle, email: f.email, password: f.password, deviceKey: LOCAL_TEST_DEVICE_KEY },
        null,
        fetchImpl,
      );
      f.userId = session.userId;
      save();
      log(`${f.key}: founder account created`);
    }
    if (!f.totpSecret) await startEnrolment(f, session.accessToken);
    try {
      await confirm(f, session.accessToken);
    } catch (err) {
      // The server forgets a pending secret after 15 minutes (or if it restarted): `auth.mfa_invalid`.
      // Start a fresh enrolment (the account has no factor yet) and confirm that one.
      if (!(err instanceof TrpcError) || err.intafacedCode !== 'auth.mfa_invalid') throw err;
      await startEnrolment(f, session.accessToken);
      await confirm(f, session.accessToken);
    }
    f.totpConfirmed = true;
    save();
    log(`${f.key}: authenticator (TOTP) enrolled`);
  }
}

export async function enrol({ root, env, now = () => new Date(), fetchImpl = fetch, log = console.log }) {
  const p = paths(root);
  assertLocalOnly({ env, dotenvText: readDotenv(p.dotenv), needEdge: true });
  if (!existsSync(p.env) || !existsSync(p.secrets))
    throw new GuardError(`refusing: run "init" first (${ENV_FILE} / ${FOUNDER_VAULT_PATH} missing).`);
  const edge = (env.INTAFACED_LOCAL_EDGE_URL ?? DEFAULT_EDGE_URL).replace(/\/$/, '');
  const secrets = JSON.parse(readFileSync(p.secrets, 'utf8'));
  const save = () => writePrivate(p.secrets, `${JSON.stringify(secrets, null, 2)}\n`, { overwrite: true });
  await enrolFounderAccounts({ edge, founders: secrets.founders, save, now, fetchImpl, log });

  const pair = Object.fromEntries(FOUNDERS.map((f) => [f.idVar, secrets.founders.find((s) => s.key === f.key).userId]));
  writePrivate(p.env, upsertEnv(readFileSync(p.env, 'utf8'), pair), { overwrite: true });
  log(`written to ${p.env}: the two founder user ids`);
  log('Next: recreate the stack so svc-identity pins the pair (command in docs/RUNNING.md). The pin is permanent for this database.');
}

export function currentCode({ root, env, who, at = new Date() }) {
  const p = paths(root);
  assertLocalOnly({ env, dotenvText: readDotenv(p.dotenv) });
  if (!existsSync(p.secrets)) throw new GuardError(`refusing: ${FOUNDER_VAULT_PATH} not found. Run "init" and "enrol" first.`);
  const f = JSON.parse(readFileSync(p.secrets, 'utf8')).founders.find((x) => x.key === who);
  if (!f) throw new GuardError('usage: code nitro|phantom');
  if (!f.totpSecret) throw new GuardError(`${who} has no authenticator yet; run "enrol" first.`);
  return { code: totpNow(f.totpSecret, at), secondsLeft: 30 - (Math.floor(at.getTime() / 1000) % 30) };
}

async function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const [cmd, arg] = argv;
  try {
    if (cmd === 'init') init({ root, env: process.env, force: argv.includes('--force'), forceNewDb: argv.includes('--force-new-db') });
    else if (cmd === 'enrol') await enrol({ root, env: process.env });
    else if (cmd === 'code') {
      const { code, secondsLeft } = currentCode({ root, env: process.env, who: arg });
      console.log(`${code}  (valid for about ${secondsLeft} s; a code can be used once, so wait for the next one to sign in again)`);
    } else {
      console.error(
        'usage: INTAFACED_LOCAL_FOUNDER=1 node tooling/scripts/local-founder-seed.mjs init [--force [--force-new-db]] | enrol | code nitro|phantom',
      );
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(err instanceof GuardError ? err.message : `failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
