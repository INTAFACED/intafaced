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
 *     or a name the service's TEST profile holds (tooling/profiles/test-owner-values/<service>.json). Nothing else:
 *     no secret, URL or port can be switched here;
 *   - `blank` leaves it unset, so the service refuses with its own typed code;
 *   - `test` sets the profile's labelled TEST value (refused when the profile has none);
 *   - `value:<text>` sets a TEST value of the step's own (a second limit, a stricter rule). It is a TEST value on the local
 *     stack only and is recorded with who set it.
 *
 * The switches live in the running stack's state folder (owner-switches.json, mode 600). local-test-stack.mjs applies
 * them last to that service's settings whenever it starts it, so `set` and `clear` restart only the named services.
 * With no file, every service starts exactly as before. Journeys use `withOwnerSwitch` (apps/customer/tests/real-app/
 * stack.mjs), which always clears what it set, so no switch outlives its step.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, scanEnvFile } from './owner-settings.mjs';
import { localStackState } from './local-test-state.mjs';

export const SWITCH_FILE = 'owner-switches.json';
export const SWITCH_LABEL = 'LOCAL TEST owner switch: not an owner decision and not a product default';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = /^[A-Z][A-Z0-9_]*$/;
const SERVICE = /^[a-z][a-z0-9-]*$/;

/** The names one service's owner settings may be switched by: env.ts's owner settings and its TEST profile's names. */
export function switchableNames(service, { repo = REPO, profile = loadProfile() } = {}) {
  if (!SERVICE.test(String(service))) throw new Error(`"${service}" is not a stack service name`);
  const envFile = path.join(repo, 'services', `svc-${service}`, 'src', 'env.ts');
  const names = new Set(existsSync(envFile) ? scanEnvFile(readFileSync(envFile, 'utf8'), service).map((s) => s.env) : []);
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

function restart(services) {
  if (services.length === 0) return;
  const res = spawnSync(process.execPath, [path.join(REPO, 'tooling', 'scripts', 'local-test-stack.mjs'), 'restart', ...services], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });
  if (res.status !== 0) {
    const tail = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().split('\n').slice(-5).join('\n');
    throw new Error(`restart of ${services.join(', ')} failed (exit ${res.status ?? res.signal}): ${tail}`);
  }
}

/** Sets switches on one service and restarts it. */
export function setSwitches(service, assignments, { by, stateDir = localStackState() } = {}) {
  writeSwitches(withSwitches(readSwitches(stateDir), service, assignments, { by }), stateDir);
  restart([service]);
}

/** Clears the named services' switches (all when none are named) and restarts each service that had one. */
export function clearSwitches(only = [], { stateDir = localStackState() } = {}) {
  const [next, cleared] = withoutSwitches(readSwitches(stateDir), only);
  writeSwitches(next, stateDir);
  restart(cleared);
  return cleared;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const byAt = rest.indexOf('--by');
  const by = byAt === -1 ? 'the command line' : rest[byAt + 1];
  const args = byAt === -1 ? rest : rest.filter((_, i) => i !== byAt && i !== byAt + 1);
  if (cmd === 'set') {
    const [service, ...pairs] = args;
    if (!service || pairs.length === 0) throw new Error('usage: set <service> <NAME>=blank|test|value:<text> [...] [--by <who>]');
    setSwitches(service, pairs.map(parseAssignment), { by });
    console.log(`${service}: ${pairs.join(' ')} (${SWITCH_LABEL})`);
  } else if (cmd === 'clear') {
    const cleared = clearSwitches(args);
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
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`owner switch refused: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
