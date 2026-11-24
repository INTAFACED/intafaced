#!/usr/bin/env node
/**
 * `compose-env`: the env file a fresh `docker compose --profile tester up` needs (J-home-ia-11 #1), from the same source
 * `pnpm local:stack` runs on, never a second copy of it.
 *
 *   node tooling/scripts/local-test-compose-env.mjs [--out .env.tester.local]
 *   docker compose --env-file .env.example --env-file .env.tester.local -f docker-compose.yml -f docker-compose.apps.yml \
 *     -f docker-compose.tester.yml \
 *     --profile tester up seed
 *
 * .env.example leaves deployment values blank on purpose, and compose refuses a blank `${VAR:?}`. For every compose service
 * the local stack also runs (svc-<name> and local-stack-services/<name>.mjs), each variable compose would leave blank gets
 * the value that service runs with on the stack: its LOCAL TEST settings, this stack's generated keys (STATE/secrets.json,
 * created on first use) and the screening fixture when STATE/screening.local.json holds one. A variable two services fill
 * differently refuses by name. The AI gateway's two values only let compose parse its `ai` profile, which never starts
 * here. The file is written mode 600 and is git-ignored (`.env.*.local`): it holds keys and is never committed.
 * LOCAL TEST only; nothing here is an owner decision.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.apps.yml', 'docker-compose.tester.yml'];

/**
 * The host user that owns the state folder: the tester profile's containers that write there (docker-compose.tester.yml)
 * run as it, so a folder only its owner may open is still theirs to write.
 */
const testerUser = (uid = process.getuid?.(), gid = process.getgid?.()) => {
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid))
    throw new Error('compose-env needs a POSIX host user for the tester profile');
  return { LOCAL_TESTER_UID: String(uid), LOCAL_TESTER_GID: String(gid) };
};

/** Values compose needs only to parse a profile the tester never starts (`ai`): not a key and no config. */
export const PARSE_ONLY = {
  LITELLM_MASTER_KEY: 'placeholder-not-a-key-tester-profile',
  LITELLM_CONFIG_PATH: '/dev/null',
};

/** The variable an un-interpolated compose value names when it is only that variable with no non-blank default. */
export function blankableVariable(raw) {
  const m = /^\$\{([A-Z][A-Z0-9_]*)(?:(:?\?)[^}]*|:?-)?\}$/.exec(String(raw ?? ''));
  return m ? m[1] : null;
}

/** An env-file value as compose reads it for blankness: an inline comment and a pair of empty quotes are no value. */
const envValue = (raw) =>
  raw
    .replace(/(^|\s)#.*$/, '')
    .trim()
    .replace(/^(["'])\1$/, '');

/** `KEY=` lines (also `export KEY=`) with no value in an env file, and those with one, as sets. */
export function blankKeys(text) {
  const blank = new Set();
  const set = new Set();
  for (const line of text.split('\n')) {
    const m = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    if (envValue(m[2]) === '') blank.add(m[1]);
    else set.add(m[1]);
  }
  return { blank, set };
}

/**
 * A value that names the stack's own host: a loopback address or host name. `pnpm local:stack` runs every service on
 * the host, so its addresses are 127.0.0.1 ports; inside a compose container that address is the container itself, so
 * such a value is never copied (a blank compose value stays blank, and a required one refuses by name).
 */
export const hostOnly = (value) => /(^|[/@,\s])(127\.0\.0\.1|localhost|\[::1\])(?=[:/,\s]|$)/i.test(String(value));

const WHOLE_VALUE = /^\s+[A-Z][A-Z0-9_]*:\s*["']?(\$\{[A-Z][A-Z0-9_]*(?::?\?[^}]*|:?-)?\})["']?\s*$/;

/**
 * The variables to read back through markers: each one some service's environment names as its whole value with no
 * non-blank default, that .env.example leaves blank or unset and that no other compose field uses (a port or a path
 * cannot hold a marker). Returns a map from variable to how compose names it (`${X:?}` or `${X:-}`).
 */
export function markedVariables(composeText, example) {
  const { set } = blankKeys(example);
  const whole = new Map();
  const elsewhere = new Set();
  for (const line of composeText.split('\n')) {
    // A YAML comment is not a use: only the line's text before its comment counts.
    if (/^\s*#/.test(line)) continue;
    const text = line.replace(/\s#.*$/, '');
    const m = WHOLE_VALUE.exec(text);
    if (m) {
      const variable = blankableVariable(m[1]);
      if (!whole.has(variable) || /:?\?/.test(m[1])) whole.set(variable, /:?\?/.test(m[1]) ? `\${${variable}:?}` : `\${${variable}:-}`);
      continue;
    }
    for (const r of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) elsewhere.add(r[1]);
  }
  for (const variable of [...whole.keys()])
    if (set.has(variable) || elsewhere.has(variable) || variable in PARSE_ONLY) whole.delete(variable);
  return whole;
}

export const marker = (variable) => `__compose_env_${variable}__`;

/** An env file that sets every marked variable to its marker, plus PARSE_ONLY, for one interpolated compose read. */
export function markerEnvFile(marked) {
  return Object.entries({ ...Object.fromEntries([...marked.keys()].map((v) => [v, marker(v)])), ...PARSE_ONLY })
    .map(([k, v]) => `${k}=${v}\n`)
    .join('');
}

/** Interpolated services with each marker turned back into the compose reference it came from. */
export function unmark(services, marked) {
  const back = new Map([...marked].map(([variable, raw]) => [marker(variable), raw]));
  return Object.fromEntries(
    Object.entries(services).map(([name, svc]) => [
      name,
      { ...svc, environment: Object.fromEntries(Object.entries(svc.environment ?? {}).map(([k, v]) => [k, back.get(v) ?? v])) },
    ]),
  );
}

/** `root` and every service it depends on, transitively: what `docker compose up <root>` starts. */
export function startedBy(services, root) {
  const seen = new Set([root]);
  const todo = [root];
  while (todo.length) {
    const deps = services[todo.pop()]?.depends_on ?? {};
    for (const dep of Array.isArray(deps) ? deps : Object.keys(deps))
      if (!seen.has(dep)) {
        seen.add(dep);
        todo.push(dep);
      }
  }
  return seen;
}

/**
 * The values to write: `services` is compose's service map with each blankable value as its compose reference (unmark),
 * `stackEnvs` maps a stack name (`edge`) to that service's stack env, `example` is .env.example's text, `started` the
 * services `up seed` starts (null: all). Values come only from started services, and never one that names the stack's
 * own host (`hostOnly`). Compose refuses a blank `${X:?}` in every service, started or not, so each of those left blank
 * is `unfilled`. Returns { values, conflicts, unfilled }.
 */
export function composeEnvValues({ services, stackEnvs, example, started = null }) {
  const { set } = blankKeys(example);
  const values = {};
  const from = {};
  const conflicts = [];
  const unfilled = new Set();
  for (const [name, svc] of Object.entries(services)) {
    const runs = !started || started.has(name);
    const stack = runs ? stackEnvs[name.replace(/^svc-/, '')] : undefined;
    for (const [key, raw] of Object.entries(svc.environment ?? {})) {
      const variable = blankableVariable(raw);
      if (!variable || set.has(variable) || variable in PARSE_ONLY) continue;
      const value = stack?.[key];
      if (value === undefined || value === '' || hostOnly(value)) {
        if (/:?\?/.test(String(raw))) unfilled.add(variable);
        continue;
      }
      if (variable in values && values[variable] !== String(value)) {
        conflicts.push(`${variable}: ${from[variable]} and ${name} run with different values`);
        continue;
      }
      values[variable] = String(value);
      from[variable] ??= name;
    }
  }
  for (const variable of Object.keys(values)) unfilled.delete(variable);
  return { values: { ...values, ...PARSE_ONLY }, conflicts, unfilled: [...unfilled].sort() };
}

/**
 * One value as compose's env-file parser reads it back unchanged: bare when plain, single-quoted (literal) when it has
 * spaces or quotes but no single quote, otherwise double-quoted with `\\`, `"` escaped and `$` doubled (no interpolation).
 */
export function envFileValue(value) {
  if (!/[\s#"'$`\\]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '$$$$')}"`;
}

export function renderEnvFile(values) {
  const lines = [
    '# LOCAL TEST values for the tester profile only; never a live value. Generated by',
    "# tooling/scripts/local-test-compose-env.mjs from what `pnpm local:stack` runs with; holds this stack's generated keys,",
    '# so it is git-ignored and never committed. Run the generator again rather than editing it.',
    '',
  ];
  for (const key of Object.keys(values).sort()) {
    const value = values[key];
    if (/[\n\r]/.test(value)) throw new Error(`${key} has a line break, which an env file cannot hold`);
    lines.push(`${key}=${envFileValue(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The compose services the tester overlay gives a per-service env file (docker-compose.tester.yml `env_file`), and the
 * `pnpm local:stack` service each one copies.
 */
const TESTER_ENV_FILES = {
  'svc-identity': 'identity',
  'svc-edge': 'edge',
  'svc-ledger': 'ledger',
  'svc-trade': 'trade',
  'svc-bank': 'bank',
};
/** Those of them that mount the state folder at its own path, so a setting naming a file in it holds there too. */
const MOUNTS_STATE = new Set(['svc-identity', 'svc-edge']);

/** The host process's own settings a `pnpm local:stack` service inherits; a container has its own. */
const HOST_PROCESS_KEYS = new Set(['HOME', 'PATH', 'LANG', 'TMPDIR', 'USER', 'SHELL', 'PWD', 'NODE_OPTIONS', 'LOCAL_STACK_STATE']);

/**
 * One tester service's env file: every setting its `pnpm local:stack` service runs with (`stackEnv`) that no compose
 * service sets itself (`composeKeys`: so a secret two services must share, such as JWT_ACCESS_SECRET, always keeps
 * compose's one value), never the host process's own settings, a blank value,
 * one naming the stack's own host (hostOnly), a path in this checkout (the container's is /app), or a path in the state
 * folder for a service that does not mount it. Pure.
 */
export function testerServiceEnv(stackEnv, composeKeys, { root, state, mountsState }) {
  const out = {};
  for (const [key, raw] of Object.entries(stackEnv ?? {})) {
    if (raw === undefined || raw === null || HOST_PROCESS_KEYS.has(key)) continue;
    const value = String(raw);
    if (value === '' || composeKeys.has(key) || hostOnly(value) || value.includes(root)) continue;
    if (value.includes(state) && !mountsState) continue;
    out[key] = value;
  }
  return out;
}

/** The tester stack's marker file in its state folder, the one every LOCAL TEST tool reads. */
const MARKER_FILE = 'LOCAL-TEST-STACK.json';

/**
 * The compose stack's id: the one its marker already holds, else 32 fresh random hex digits. A state folder whose marker
 * is a `pnpm local:stack` marker refuses: one folder is one stack.
 */
function composeStackId(stateDir) {
  const file = path.join(stateDir, MARKER_FILE);
  if (!fs.existsSync(file)) return randomBytes(16).toString('hex');
  const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (prior?.runtime !== 'compose' || !/^[0-9a-f]{32}$/.test(prior.stackId ?? ''))
    throw new Error(`refusing: ${file} is another stack's marker; give the tester profile its own LOCAL_STACK_STATE`);
  return prior.stackId;
}

/** Each marker port and the compose service whose loopback port it is (docker-compose.tester.yml publishes them). */
const COMPOSE_PORT_SERVICES = {
  postgres: 'postgres',
  edge: 'svc-edge',
  ledger: 'svc-ledger',
  identity: 'svc-identity',
  trade: 'svc-trade',
  matching: 'svc-matching',
};

/**
 * The compose marker: what the LOCAL TEST tools need to find this stack (each service's published loopback port, its
 * database) and the stack id its Postgres starts with, its ownership proof (local-test-state.mjs assertComposeOwnership).
 * `services` is compose's interpolated service map. Pure.
 */
export function composeMarker(services, stackId, now = new Date()) {
  const ports = {};
  for (const [name, svc] of Object.entries(COMPOSE_PORT_SERVICES)) {
    const published = (services[svc]?.ports ?? []).find((p) => p.host_ip === '127.0.0.1' && p.published);
    if (!published) throw new Error(`refusing: compose publishes no loopback port for ${svc}`);
    ports[name] = Number(published.published);
  }
  const custodyLayer = services['svc-ledger']?.environment?.LEDGER_CUSTODY_LAYER ?? 'on';
  if (custodyLayer !== 'on' && custodyLayer !== 'off') throw new Error(`refusing: svc-ledger's custody switch is "${custodyLayer}"`);
  return {
    kind: 'intafaced-local-test-stack',
    runtime: 'compose',
    warning: 'LOCAL TEST STACK — balances are test funds, not real money',
    repo: '/app',
    stackId,
    custodyLayer,
    ports,
    database: { host: '127.0.0.1', port: ports.postgres, name: 'intafaced' },
    updatedAt: now.toISOString(),
  };
}

/**
 * The edge's kill-switch file for the compose stack (docker-compose.tester.yml): "nothing is killed", written once, as
 * `pnpm local:stack` does. A file already there (the edge's own, or an operator's) is left as it is.
 */
function writeEdgeKillState(stateDir, now = new Date()) {
  const file = path.join(stateDir, 'edge-kill-state.json');
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, `${JSON.stringify({ killed: [], updatedAt: now.toISOString() }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

function writeComposeMarker(stateDir, services, stackId) {
  const marker = composeMarker(services, stackId);
  const file = path.join(stateDir, MARKER_FILE);
  fs.writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return marker;
}

async function main(argv) {
  const at = argv.indexOf('--out');
  if (at >= 0 && (!argv[at + 1] || argv[at + 1].startsWith('--'))) throw new Error('usage: local-test-compose-env.mjs [--out <file>]');
  const out = path.resolve(ROOT, at >= 0 ? argv[at + 1] : '.env.tester.local');
  if (!process.env.LOCAL_STACK_STATE) throw new Error('LOCAL_STACK_STATE must name the state folder the tester profile mounts');
  const { loadOrCreateSecrets, localTestServiceEnvs } = await import('./local-test-stack.mjs');
  const stackId = composeStackId(process.env.LOCAL_STACK_STATE);
  // An interpolated read: older compose cannot parse a volume spec without interpolation, so each variable to fill is
  // set to a marker and read back from where the marker lands.
  const composeText = COMPOSE_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const marked = markedVariables(composeText, example);
  const markers = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-env-'));
  const markerFile = path.join(markers, 'markers.env');
  fs.writeFileSync(markerFile, markerEnvFile(marked), { mode: 0o600 });
  const config = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      '.env.example',
      '--env-file',
      markerFile,
      ...COMPOSE_FILES.flatMap((f) => ['-f', f]),
      '--profile',
      'tester',
      'config',
      '--format',
      'json',
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...testerUser(), LOCAL_TESTER_STACK_ID: stackId } },
  );
  fs.rmSync(markers, { recursive: true, force: true });
  if (config.status !== 0) throw new Error(`docker compose config failed:\n${config.error?.message ?? config.stderr}`);
  const services = unmark(JSON.parse(config.stdout).services, marked);
  const secrets = loadOrCreateSecrets();
  // The compose stack's marker and its founder pair's draft, before the stack's envs are read: identity's env then holds
  // the draft's invites, so the founder seed can enrol on the first compose up.
  const marker = writeComposeMarker(process.env.LOCAL_STACK_STATE, services, stackId);
  writeEdgeKillState(process.env.LOCAL_STACK_STATE);
  const { ensureFounderVaultDraft } = await import('./local-test-founders.mjs');
  ensureFounderVaultDraft({ stateDir: process.env.LOCAL_STACK_STATE, marker, edgeUrl: `http://127.0.0.1:${marker.ports.edge}` });
  const stackEnvs = Object.fromEntries(localTestServiceEnvs(secrets).map((s) => [s.name, s.env]));
  const started = startedBy(services, 'seed');
  const { values, conflicts, unfilled } = composeEnvValues({ services, stackEnvs, example, started });
  if (conflicts.length)
    throw new Error(`refusing: compose shares a variable the stack sets differently per service:\n  ${conflicts.join('\n  ')}`);
  if (unfilled.length) throw new Error(`refusing: compose requires values the stack does not run with: ${unfilled.join(', ')}`);
  fs.writeFileSync(out, renderEnvFile({ ...values, ...testerUser(), LOCAL_TESTER_STACK_ID: stackId }), { mode: 0o600 });
  const composeKeys = new Set(Object.values(services).flatMap((svc) => Object.keys(svc.environment ?? {})));
  for (const [svc, name] of Object.entries(TESTER_ENV_FILES)) {
    const file = path.join(process.env.LOCAL_STACK_STATE, `tester-${name}.env`);
    const env = testerServiceEnv(stackEnvs[name], composeKeys, {
      root: ROOT,
      state: process.env.LOCAL_STACK_STATE,
      mountsState: MOUNTS_STATE.has(svc),
    });
    fs.writeFileSync(file, renderEnvFile(env), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  fs.chmodSync(out, 0o600);
  console.log(
    `compose-env: ${Object.keys(values).length} LOCAL TEST values written to ${path.relative(ROOT, out)} (git-ignored, mode 600)`,
  );
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
