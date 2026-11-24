#!/usr/bin/env node
/**
 * THE HOSTED BETA'S SECRETS — generated straight into a GitHub environment, never printed (#10209).
 *
 *   node tooling/beta/beta-secrets.mjs plan
 *       the dry run: every secret the beta's services read at boot, which service reads it under which name, and how
 *       it is made. Prints names only; makes no value and calls nothing.
 *   node tooling/beta/beta-secrets.mjs write --env <github environment> [--repo INTAFACED/intafaced] [--rotate]
 *       makes each value in memory and hands it to `gh secret set` on stdin, never on a command line, in a file or on
 *       screen. A secret the environment already holds is kept unless --rotate (a rotated database password also needs
 *       its role's password changed in Postgres before the services restart). The beta's three settings go in as
 *       environment variables, which are not secret. It refuses an environment that does not exist yet.
 *
 * Where the names come from: the local test stack (tooling/scripts/local-test-stack.mjs), which boots every service,
 * the founder console included, on every journey run, and so is the one place in the repo that knows every secret each
 * one needs. This file builds every environment the stack would hand its processes twice, each time with freshly minted
 * secrets, and reads off every setting whose value moved. Nothing is listed by hand, so a secret the stack gains is in
 * the next plan with no edit here; a setting that moves in a shape this file does not know stops the plan.
 *
 * What the beta value is: the same shape the stack mints (32 random bytes; hex, or base64url for the console's session
 * key), so whatever accepts the stack's value accepts it; one fresh value per secret the stack shares, so services that
 * must agree still agree; the stack's `local-test:` TEST marker dropped (production posture refuses it); and one
 * database password per role, not the stack's one shared password.
 *
 * Not here: the S2S keypair (LOCAL_STACK_S2S=dual; the beta runs S2S off), the stack's fixed TEST stand-ins such as the
 * test chain's keys (the beta posture's own work), and outside partners' credentials, which only their owner issues.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LOCAL_TEST_SECRET_SLOTS,
  PLAN_SECRETS,
  localTestAdminEnv,
  localTestServiceEnvs,
  mintLocalTestSecret,
} from '../scripts/local-test-stack.mjs';

/** What the hosted beta runs as (docs/adr/2026-08-08-staging-deploy-path.md, the 23 Nov amendment). Not secret. */
export const BETA_SETTINGS = Object.freeze({
  APP_ENV: 'staging',
  INTAFACED_BETA_POSTURE: 'test-networks',
  INTERNAL_SERVICE_BODY_BIND: 'require',
});

/** A secret the stack uses for itself, read by no service's environment. */
const STACK_OWN = { pgAdmin: { name: 'POSTGRES_PASSWORD', reads: ['postgres (the database superuser)'] } };

/**
 * The stack's TEST markers on a secret: `local-test:` (svc-identity's pay QR key) and `TEST-` (svc-protocol's wallet
 * session key). Staging refuses a secret that starts with either, so a beta value carries none.
 */
const TEST_MARKERS = ['local-test:', 'TEST-'];
const unmarked = (value) => {
  const marker = TEST_MARKERS.find((m) => value.startsWith(m));
  return marker ? value.slice(marker.length) : null;
};
const LOOKS_TEST = /^(?:test|local-test)/i;

export const DEFAULT_REPO = 'INTAFACED/intafaced';

/** Every environment the stack hands a process: its services, then the founder console. */
function stackEnvs(secrets) {
  return [...localTestServiceEnvs(secrets), { name: 'admin', env: localTestAdminEnv(secrets) }];
}

function minted() {
  return { ...PLAN_SECRETS, ...Object.fromEntries(LOCAL_TEST_SECRET_SLOTS.map((s) => [s, mintLocalTestSecret(s)])) };
}

/** The encoding and byte length of a value the stack minted. */
export function shapeOf(value) {
  if (/^(?:[0-9a-f]{2})+$/.test(value)) return { encoding: 'hex', bytes: value.length / 2 };
  if (/^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value)
    return { encoding: 'base64url', bytes: Buffer.from(value, 'base64url').length };
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value)
    return { encoding: 'base64', bytes: Buffer.from(value, 'base64').length };
  return null;
}

/** A fresh value of a shape. The only place a value is made. Never one that reads as a TEST secret. */
export function makeValue(shape) {
  for (;;) {
    const value = crypto.randomBytes(shape.bytes).toString(shape.encoding);
    if (!LOOKS_TEST.test(value)) return value;
  }
}

/**
 * Every place a stack secret reaches a process. Each use is one setting in one process: `slot` (the stack's own name
 * for the secret) and `form` (`plain`, `marked` for a value behind the TEST marker, `db` for the password inside a
 * database URL, `derived` for a value made from a secret, such as a digest).
 */
let memo;
export function secretUses() {
  memo ??= findUses();
  return memo;
}

function findUses() {
  const a = minted();
  const b = minted();
  const slotOf = new Map(LOCAL_TEST_SECRET_SLOTS.map((s) => [a[s], s]));
  const envsA = stackEnvs(a);
  const envsB = stackEnvs(b);
  const uses = [];
  envsA.forEach(({ name: service, env }, i) => {
    const other = envsB[i];
    if (other.name !== service) throw new Error(`the stack listed its processes in a different order (${service}, ${other.name})`);
    for (const [key, value] of Object.entries(env)) {
      if (value === other.env[key]) continue;
      if (typeof value !== 'string') throw new Error(`${service} ${key} moved with the secrets but is not text`);
      if (slotOf.has(value)) {
        uses.push({ service, key, slot: slotOf.get(value), form: 'plain' });
        continue;
      }
      if (slotOf.has(unmarked(value))) {
        uses.push({ service, key, slot: slotOf.get(unmarked(value)), form: 'marked' });
        continue;
      }
      const db = dbPasswordUse(value, slotOf);
      if (db) {
        uses.push({ service, key, slot: db.slot, form: 'db', role: db.role });
        continue;
      }
      if ([...slotOf.keys()].some((secret) => value.includes(secret)))
        throw new Error(`${service} ${key} carries a secret in a shape beta-secrets.mjs does not know; teach it this shape`);
      const shape = shapeOf(unmarked(value) ?? value);
      if (!shape) throw new Error(`${service} ${key} is made from a secret in a shape beta-secrets.mjs cannot copy`);
      uses.push({ service, key, slot: null, form: 'derived', shape });
    }
  });
  // A derived value's sources: the secrets that move it when they alone move. The stack derives a key so it needs no
  // new secret of its own (each is domain-separated from its source, and no process derives it again), so the beta
  // mints it on its own; the sources are kept only so the plan can say no stack secret goes unused.
  const derived = uses.filter((u) => u.form === 'derived');
  if (derived.length) {
    for (const slot of LOCAL_TEST_SECRET_SLOTS) {
      const moved = stackEnvs({ ...a, [slot]: mintLocalTestSecret(slot) });
      for (const u of derived) {
        const env = moved.find((e) => e.name === u.service).env;
        if (env[u.key] !== envsA.find((e) => e.name === u.service).env[u.key]) (u.from ??= []).push(slot);
      }
    }
    for (const u of derived) if (!u.from) throw new Error(`${u.service} ${u.key} moved with the secrets, but with no one secret`);
  }
  return uses;
}

function dbPasswordUse(value, slotOf) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!/^postgres(?:ql)?:$/.test(url.protocol)) return null;
  const password = decodeURIComponent(url.password);
  if (!slotOf.has(password) || !url.username) return null;
  return { slot: slotOf.get(password), role: decodeURIComponent(url.username) };
}

const shapeOfSlot = (slot) => shapeOf(mintLocalTestSecret(slot));
const dbSecretName = (role) => `${role.toUpperCase()}_DB_PASSWORD`;

/**
 * The plan: one GitHub secret per value the beta needs. `name` is the setting it is stored as (for a secret several
 * settings share, the one setting that carries nothing else), `reads` every `<process> <setting>` that reads it.
 * `unused` names the stack's secrets no beta process reads (a TEST stand-in that is off by default).
 */
export function betaSecretPlan(uses = secretUses()) {
  const secrets = new Map();
  const add = (name, shape, read, note) => {
    const row = secrets.get(name) ?? { name, shape, reads: [], note };
    if (row.shape.encoding !== shape.encoding || row.shape.bytes !== shape.bytes) throw new Error(`${name} is read in two shapes`);
    if (!row.reads.includes(read)) row.reads.push(read);
    secrets.set(name, row);
  };
  const shared = new Map();
  for (const u of uses.filter((u) => u.form === 'plain' || u.form === 'marked')) {
    const keys = shared.get(u.slot) ?? new Set();
    keys.add(u.key);
    shared.set(u.slot, keys);
  }
  const slotsOfKey = new Map();
  for (const u of uses.filter((u) => u.slot && u.form !== 'db')) {
    const slots = slotsOfKey.get(u.key) ?? new Set();
    slots.add(u.slot);
    slotsOfKey.set(u.key, slots);
  }
  for (const u of uses) {
    const read = `${u.service} ${u.key}`;
    if (u.form === 'db') add(dbSecretName(u.role), shapeOfSlot(u.slot), read, `the database role ${u.role}'s password`);
    else if (u.form === 'derived') add(u.key, u.shape, read, 'the stack makes it from another secret; the beta mints its own');
    else {
      const own = [...shared.get(u.slot)].filter((k) => slotsOfKey.get(k).size === 1).sort();
      if (own.length === 0) throw new Error(`no setting carries only the stack secret ${u.slot}; name its GitHub secret here`);
      add(own[0], shapeOfSlot(u.slot), read, u.form === 'marked' ? 'the stack marks it TEST; the beta value carries no marker' : undefined);
    }
  }
  const used = new Set(uses.flatMap((u) => (u.slot ? [u.slot] : (u.from ?? []))));
  for (const [slot, own] of Object.entries(STACK_OWN)) {
    if (!LOCAL_TEST_SECRET_SLOTS.includes(slot)) throw new Error(`the stack no longer mints ${slot}`);
    for (const read of own.reads) add(own.name, shapeOfSlot(slot), read, 'the stack itself');
    used.add(slot);
  }
  return {
    secrets: [...secrets.values()].sort((x, y) => x.name.localeCompare(y.name)),
    settings: BETA_SETTINGS,
    unused: LOCAL_TEST_SECRET_SLOTS.filter((s) => !used.has(s)),
  };
}

/** One fresh value for every secret in the plan, in memory only. */
export function generateValues(plan) {
  return new Map(plan.secrets.map((s) => [s.name, makeValue(s.shape)]));
}

/**
 * Every process's beta environment: the stack's, with the beta settings and every secret replaced by `values`. Used by
 * the boot check (beta-secrets.test.mjs); it never leaves this process.
 */
export function betaEnvs(values, uses = secretUses(), plan = betaSecretPlan(uses)) {
  const nameOf = new Map();
  for (const s of plan.secrets) for (const r of s.reads) nameOf.set(r, s.name);
  return stackEnvs(minted()).map(({ name: service, env }) => {
    const out = { ...env, ...BETA_SETTINGS, NODE_ENV: 'production' };
    for (const u of uses.filter((u) => u.service === service)) {
      const value = values.get(nameOf.get(`${service} ${u.key}`));
      if (value === undefined) throw new Error(`no value for ${service} ${u.key}`);
      if (u.form === 'db') {
        const url = new URL(env[u.key]);
        url.password = value;
        out[u.key] = url.href;
      } else out[u.key] = value;
    }
    return { name: service, env: out };
  });
}

export function planText(plan) {
  const lines = [`The hosted beta's secrets: ${plan.secrets.length}, written to a GitHub environment, never printed.`, ''];
  for (const s of plan.secrets) {
    lines.push(`${s.name}  (${s.shape.bytes} random bytes, ${s.shape.encoding})${s.note ? `  ${s.note}` : ''}`);
    for (const r of s.reads) lines.push(`    read by ${r}`);
  }
  lines.push('', 'Settings (environment variables, not secret):');
  for (const [k, v] of Object.entries(plan.settings)) lines.push(`${k}=${v}`);
  if (plan.unused.length) lines.push('', `Not used by any beta process (TEST stand-ins off by default): ${plan.unused.join(', ')}`);
  return lines.join('\n');
}

function runGh(args, input) {
  const r = spawnSync('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Writes the plan's secrets and settings to `env` in `repo`. Each value goes to gh on stdin only; gh's own output is
 * dropped and only this file's lines, which hold names, are said. Returns the names it set and kept.
 */
export function writeToGitHub({ env, repo = DEFAULT_REPO, rotate = false, plan = betaSecretPlan(), gh = runGh, say = console.log }) {
  if (!/^[A-Za-z0-9._-]+$/.test(env ?? '')) throw new Error('--env <github environment> is required');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`--repo must be owner/name, not ${repo}`);
  const where = ['--env', env, '--repo', repo];
  if (gh(['api', `repos/${repo}/environments/${env}`, '--silent']).status !== 0)
    throw new Error(`the GitHub environment ${env} does not exist in ${repo}: create it first (Settings, Environments)`);
  const listed = gh(['secret', 'list', ...where, '--json', 'name']);
  if (listed.status !== 0) throw new Error(`could not list ${env}'s secrets: ${listed.stderr.trim()}`);
  const existing = new Set(JSON.parse(listed.stdout || '[]').map((s) => s.name));
  const set = [];
  const kept = [];
  for (const s of plan.secrets) {
    if (existing.has(s.name) && !rotate) {
      kept.push(s.name);
      say(`kept   ${s.name} (already set; --rotate replaces it)`);
      continue;
    }
    const r = gh(['secret', 'set', s.name, ...where], makeValue(s.shape));
    if (r.status !== 0)
      throw new Error(`gh refused to set ${s.name} (exit ${r.status}); ${set.length} set before it: ${set.join(', ') || 'none'}`);
    set.push(s.name);
    say(`set    ${s.name}`);
  }
  for (const [k, v] of Object.entries(plan.settings)) {
    const r = gh(['variable', 'set', k, ...where, '--body', v]);
    if (r.status !== 0) throw new Error(`gh refused to set the variable ${k} (exit ${r.status})`);
    say(`set    ${k}=${v} (variable)`);
  }
  return { set, kept };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i === -1 ? undefined : rest[i + 1];
  };
  if (cmd === 'plan') {
    console.log(planText(betaSecretPlan()));
    return 0;
  }
  if (cmd === 'write') {
    const { set, kept } = writeToGitHub({ env: flag('--env'), repo: flag('--repo') ?? DEFAULT_REPO, rotate: rest.includes('--rotate') });
    console.log(`done: ${set.length} set, ${kept.length} kept`);
    return 0;
  }
  console.error('usage: node tooling/beta/beta-secrets.mjs plan | write --env <github environment> [--repo owner/name] [--rotate]');
  return 2;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`beta-secrets: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
