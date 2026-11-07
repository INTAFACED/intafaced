#!/usr/bin/env node
/**
 * LOCAL TEST owner switches: one service's owner setting, set blank or to a TEST value for a journey step, then put back.
 *
 *   node tooling/scripts/local-test-owner-switch.mjs set <service> <NAME>=blank|test|value:<text> [...] [--by <who>]
 *   node tooling/scripts/local-test-owner-switch.mjs clear [<service> ...]
 *   node tooling/scripts/local-test-owner-switch.mjs list
 *
 * A step that reads "with the owner's limit blank it refuses with ..._unset" needs that setting blank, and the next step
 * needs it set again. Until now each one needed its own `LOCAL_STACK_<SERVICE>_<NAME>=off` branch in the stack's service
 * file, which every builder wrote alone (local-stack-services/agents.mjs has a dozen). This takes any owner setting:
 *   - a name `services/svc-<service>/src/env.ts` marks as an owner setting (owner-settings.mjs `scanEnvFile`: its
 *     comment says NO DEFAULT, Never invent, or names an `_unset` code; wiring such as URLs, keys and ports is left out),
 *     or a name the service's TEST profile holds (tooling/profiles/test-owner-values/<service>.json). Nothing else, and
 *     from env.ts never a name shaped like a secret (`_SECRET`, `_KEY`, `_TOKEN`, `_PASSWORD`, `_DSN`), even one whose
 *     comment names an `_unset` code: only the reviewed TEST profile can make such a name switchable;
 *   - `blank` leaves it unset, so the service refuses with its own typed code;
 *   - `test` sets the profile's labelled TEST value (refused when the profile has none);
 *   - `value:<text>` sets a TEST value of the step's own (a second limit, a stricter rule). It is a TEST value on the local
 *     stack only and is recorded with who set it.
 *
 * The switches live in the running stack's state folder (owner-switches.json, mode 600). local-test-stack.mjs applies
 * them last to that service's settings whenever it starts it, so `set` and `clear` restart only the named services.
 * With no file, every service starts exactly as before. Journeys use `withOwnerSwitch` (apps/customer/tests/real-app/
 * stack.mjs), which always clears what it set, and journey.mjs's guard clears whatever a crashed or timed-out step left,
 * before and after every journey test. The CLI is for looking by hand: a journey run clears what it set. A start of the
 * stack with a switch on prints it, so a plain `pnpm local:stack` never runs on one silently.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadProfile, scanEnvFile } from './owner-settings.mjs';
import { localStackState } from './local-test-state.mjs';

export const SWITCH_FILE = 'owner-switches.json';
export const SWITCH_LABEL = 'LOCAL TEST owner switch: not an owner decision and not a product default';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = /^[A-Z][A-Z0-9_]*$/;
const SERVICE = /^[a-z][a-z0-9-]*$/;
const SECRET_SHAPED = /(_SECRET|_KEY|_TOKEN|_PASSWORD|_DSN)$/;

/** The names one service's owner settings may be switched by: env.ts's owner settings and its TEST profile's names. */
export function switchableNames(service, { repo = REPO, profile = loadProfile() } = {}) {
  if (!SERVICE.test(String(service))) throw new Error(`"${service}" is not a stack service name`);
  const envFile = path.join(repo, 'services', `svc-${service}`, 'src', 'env.ts');
  const fromEnv = existsSync(envFile) ? scanEnvFile(readFileSync(envFile, 'utf8'), service).map((s) => s.env) : [];
  const names = new Set(fromEnv.filter((name) => !SECRET_SHAPED.test(name)));
  for (const [name, v] of Object.entries(profile.values)) if (v.service === service) names.add(name);
  return names;
}

/**
 * One switch, checked: `{ value }` where null means blank (unset). Refuses a name that is not one of the service's owner
 * settings, `test` with no TEST value in the profile, and a value that is empty or spans lines.
 */
export function planSwitch(service, name, choice, { names = switchableNames(service), profile = loadProfile() } = {}) {
  if (!NAME.test(String(name))) throw new Error(`"${name}" is not a setting name`);
  if (!names.has(name))
    throw new Error(
      `${name} is not an owner setting of ${service}: only a name services/svc-${service}/src/env.ts marks as an owner ` +
        `setting, or one in tooling/profiles/test-owner-values/${service}.json, can be switched`,
    );
  if (choice === 'blank') return { value: null };
  if (choice === 'test') {
    const entry = profile.values[name];
    if (!entry || entry.service !== service)
      throw new Error(`${name} has no TEST value in tooling/profiles/test-owner-values/${service}.json; add one there first`);
    return { value: entry.value };
  }
  if (choice && typeof choice === 'object' && typeof choice.value === 'string') {
    if (choice.value === '' || /[\r\n\0]/.test(choice.value))
      throw new Error(`${name}: a TEST value is one non-empty line (use blank to unset it)`);
    return { value: choice.value };
  }
  throw new Error(`${name}: the choice is blank, test or { value: '<text>' }`);
}

/** `NAME=blank`, `NAME=test` or `NAME=value:<text>` from the command line. */
export function parseAssignment(text) {
  const at = String(text).indexOf('=');
  if (at < 1) throw new Error(`"${text}" is not NAME=blank, NAME=test or NAME=value:<text>`);
  const name = text.slice(0, at);
  const rest = text.slice(at + 1);
  if (rest === 'blank' || rest === 'test') return { name, choice: rest };
  if (rest.startsWith('value:')) return { name, choice: { value: rest.slice('value:'.length) } };
  throw new Error(`"${text}": after = comes blank, test or value:<text>`);
}

export const switchFile = (stateDir = localStackState()) => path.join(stateDir, SWITCH_FILE);

/** `{ <service>: { <NAME>: { value, by, at } } }`; an absent file is no switches. A file that does not parse refuses. */
export function readSwitches(stateDir = localStackState()) {
  const file = switchFile(stateDir);
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed?.label !== SWITCH_LABEL || typeof parsed.services !== 'object' || parsed.services === null)
    throw new Error(`${file} is not a LOCAL TEST owner switch file`);
  return parsed.services;
}

/** Writes the switches atomically (mode 600); no switch left removes the file, so the stack is back to its plain start. */
export function writeSwitches(services, stateDir = localStackState()) {
  const file = switchFile(stateDir);
  const kept = Object.fromEntries(Object.entries(services).filter(([, names]) => Object.keys(names).length > 0));
  if (Object.keys(kept).length === 0) return rmSync(file, { force: true });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ label: SWITCH_LABEL, services: kept }, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** The service's settings with its switches applied last: a blank switch removes the name, a value sets it. */
export function applyOwnerSwitches(service, env, services) {
  const mine = services?.[service];
  if (!mine) return env;
  const out = { ...env };
  for (const [name, { value }] of Object.entries(mine)) {
    if (value === null) delete out[name];
    else out[name] = value;
  }
  return out;
}

/** Adds checked switches for one service to `services` (a copy). `assignments` is [{ name, choice }]. */
export function withSwitches(services, service, assignments, { by = 'a journey', at = new Date().toISOString(), ...opts } = {}) {
  if (typeof by !== 'string' || by.trim() === '') throw new Error('a switch names who set it (--by <who>)');
  opts.profile ??= loadProfile();
  const names = opts.names ?? switchableNames(service, opts);
  const next = { ...services, [service]: { ...(services[service] ?? {}) } };
  for (const { name, choice } of assignments) next[service][name] = { ...planSwitch(service, name, choice, { ...opts, names }), by, at };
  return next;
}

/** `services` less the named services' switches (all of them when none are named). Returns [next, services cleared]. */
export function withoutSwitches(services, only = []) {
  const cleared = Object.keys(services).filter((s) => only.length === 0 || only.includes(s));
  return [Object.fromEntries(Object.entries(services).filter(([s]) => !cleared.includes(s))), cleared];
}

/**
 * Restarts the named services without blocking this process, so a journey's open pages and kept-alive connections keep
 * being answered while it runs (as J-agents-15's own restart did before this file).
 */
let restarts = Promise.resolve();
function restart(services) {
  if (services.length === 0) return Promise.resolve();
  // One restart at a time in this process: a step abandoned at its timeout may still be restarting a service when the
  // guard clears it, and two restarts of one service race on its port.
  const next = restarts.then(() => restartNow(services));
  restarts = next.catch(() => {});
  return next;
}

async function restartNow(services) {
  try {
    await promisify(execFile)(process.execPath, [path.join(REPO, 'tooling', 'scripts', 'local-test-stack.mjs'), 'restart', ...services], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 180_000,
    });
  } catch (err) {
    const tail = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n').slice(-5).join('\n');
    throw new Error(`restart of ${services.join(', ')} failed (exit ${err.code ?? err.signal}): ${tail}`);
  }
}

/** Sets switches on one service and restarts it. */
export async function setSwitches(service, assignments, { by, stateDir = localStackState() } = {}) {
  writeSwitches(withSwitches(readSwitches(stateDir), service, assignments, { by }), stateDir);
  await restart([service]);
}

/** Clears the named services' switches (all when none are named) and restarts each service that had one. */
export async function clearSwitches(only = [], { stateDir = localStackState() } = {}) {
  let current;
  try {
    current = readSwitches(stateDir);
  } catch (err) {
    // A file that does not parse is no switch anyone can read: remove it, so the stack can start again, and say so.
    if (only.length > 0) throw err;
    rmSync(switchFile(stateDir), { force: true });
    throw new Error(`${err instanceof Error ? err.message : String(err)}: removed; restart any service it held by hand`);
  }
  const [next, cleared] = withoutSwitches(current, only);
  writeSwitches(next, stateDir);
  await restart(cleared);
  return cleared;
}

/** `service NAME, ...` for a message: which switches are set, never their values. */
const describe = (services) =>
  Object.entries(services)
    .flatMap(([s, names]) => Object.entries(names).map(([n, v]) => `${s} ${n} (by ${v.by})`))
    .join(', ');

/**
 * Every journey test runs inside this (journey.mjs), so no owner switch outlives the step that set it, even when the
 * step timed out or its worker died before `withOwnerSwitch` could clear it:
 *   - before the test, a switch left by an earlier test (a worker that died mid-step) is cleared, and said, so this test
 *     starts on the stack's plain settings; it is not this test's fault, so it does not fail it;
 *   - after the test, a switch still set is cleared and the test fails with OWNER SWITCH LEAK, naming the switch.
 * `read` and `clear` are the switch file's (readSwitches, clearSwitches); `log` prints the before-test notice.
 */
export async function guardOwnerSwitches({
  title,
  body,
  read = () => readSwitches(),
  clear = () => clearSwitches(),
  log = (line) => console.log(line),
}) {
  const left = read();
  if (Object.keys(left).length > 0) {
    await clear();
    log(`OWNER SWITCH before "${title}": an earlier test left ${describe(left)}; cleared and restarted`);
  }
  await body();
  const after = read();
  if (Object.keys(after).length === 0) return;
  let cleared;
  try {
    await clear();
    cleared = 'the guard cleared it and restarted the service';
  } catch (err) {
    cleared = `the guard could NOT clear it (${err instanceof Error ? err.message : String(err)}); the next test clears it first`;
  }
  throw new Error(`OWNER SWITCH LEAK: "${title}" left ${describe(after)} set; ${cleared}`);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const byAt = rest.indexOf('--by');
  const by = byAt === -1 ? 'the command line' : rest[byAt + 1];
  if (byAt !== -1 && (!by || by.startsWith('--'))) throw new Error('--by needs who set it');
  const args = byAt === -1 ? rest : rest.filter((_, i) => i !== byAt && i !== byAt + 1);
  if (cmd === 'set') {
    const [service, ...pairs] = args;
    if (!service || pairs.length === 0) throw new Error('usage: set <service> <NAME>=blank|test|value:<text> [...] [--by <who>]');
    await setSwitches(service, pairs.map(parseAssignment), { by });
    console.log(`${service}: ${pairs.join(' ')} (${SWITCH_LABEL})`);
  } else if (cmd === 'clear') {
    const cleared = await clearSwitches(args);
    console.log(cleared.length ? `cleared and restarted: ${cleared.join(', ')}` : 'no owner switch was set');
  } else if (cmd === 'list') {
    const services = readSwitches();
    const lines = Object.entries(services).flatMap(([s, names]) =>
      Object.entries(names).map(([n, v]) => `${s} ${n}=${v.value === null ? 'blank' : 'TEST value'} (by ${v.by}, ${v.at})`),
    );
    console.log(lines.length ? lines.join('\n') : 'no owner switch is set');
  } else {
    throw new Error('usage: set <service> <NAME>=blank|test|value:<text> [...] [--by <who>] | clear [<service> ...] | list');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    console.error(`owner switch refused: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
