import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * The Postgres client and server binaries the local test stack uses: LOCAL_STACK_PG_BIN, else Homebrew's (macOS), else
 * the newest major Debian and Ubuntu install under /usr/lib/postgresql (Linux), else Debian's 16 (so the error names it).
 */
export function localPgBin(env = process.env, { exists = fs.existsSync, list = listDir } = {}) {
  if (env.LOCAL_STACK_PG_BIN) return env.LOCAL_STACK_PG_BIN;
  if (exists('/opt/homebrew/bin/pg_ctl')) return '/opt/homebrew/bin';
  const debian = list('/usr/lib/postgresql')
    .filter((major) => /^\d+$/.test(major))
    .sort((a, b) => Number(b) - Number(a))
    .map((major) => `/usr/lib/postgresql/${major}/bin`)
    .find((bin) => exists(`${bin}/pg_ctl`));
  return debian ?? '/usr/lib/postgresql/16/bin';
}

/** As root (a cloud container's default user) the database runs as this OS user: initdb and postgres refuse root. */
export function localPgOsUser(env = process.env, uid = process.getuid?.()) {
  return uid === 0 ? env.LOCAL_STACK_PG_USER || 'postgres' : null;
}

// The state folder rule lives in local-test-facts.mjs, so the journeys read it without this script.
import { localStackState } from './local-test-facts.mjs';

export { localStackState };

/** The services the journey helpers require running (assertActiveLocalStack); a first `start --only` must name them. */
export const DEFAULT_SERVICES = ['edge', 'identity', 'trade', 'matching', 'ledger', 'customer'];

/**
 * The custody switch (OWNER 226, OWNER 288) the stack's running svc-ledger was started with: `on` or `off`. The stack
 * records `LEDGER_CUSTODY_LAYER` on each process it starts with one (run/processes.json, local-test-stack.mjs
 * startProc), so the TEST tools follow the ledger that is running, not the environment they happen to be called in.
 * A ledger record without one was started before the switch was recorded, when every TEST stack ran it on.
 * With it off INTAFACED's ledger holds no customer money: the TEST rig never posts to a person's account then
 * (docs/LOCAL-TEST-STACK.md, "Custody off"). Throws when the stack has no ledger record.
 */
export function stackCustodyLayer(stateDir = localStackState()) {
  let records;
  try {
    records = JSON.parse(fs.readFileSync(path.join(stateDir, 'run', 'processes.json'), 'utf8'));
  } catch {
    throw new Error(`refusing: no process records in ${stateDir}; start the stack first (pnpm local:stack)`);
  }
  if (!records?.ledger) throw new Error('refusing: the stack has no svc-ledger record; start the stack first (pnpm local:stack)');
  return custodyLayerOf(records);
}

/**
 * Whether the stack's running svc-ledger runs custody off. False when the stack has no process records yet: each tool's
 * own checks then refuse, naming what is missing, as before. A recorded value that is neither on nor off still throws.
 */
export function stackCustodyOff(stateDir = localStackState()) {
  if (!fs.existsSync(path.join(stateDir, 'run', 'processes.json'))) return false;
  let records;
  try {
    records = JSON.parse(fs.readFileSync(path.join(stateDir, 'run', 'processes.json'), 'utf8'));
  } catch {
    return false;
  }
  return custodyLayerOf(records) === 'off';
}

/**
 * The custody switch this stack starts its services with (OWNER 226, OWNER 288): `LOCAL_STACK_CUSTODY_LAYER` on a start,
 * `on` when unset, for the journeys marked Later: custody. Every service that carries `LEDGER_CUSTODY_LAYER` (svc-ledger,
 * svc-bank, svc-pay, svc-trade, svc-matching: local-stack-services/) takes this one value, so the stack never runs a
 * ledger and a book on different switches. `off` runs them as the launch build does (the beta, #11019).
 */
export function startCustodyLayer(env = process.env) {
  const value = env.LOCAL_STACK_CUSTODY_LAYER ?? '';
  if (value === '') return 'on';
  if (value !== 'on' && value !== 'off')
    throw new Error(`LOCAL_STACK_CUSTODY_LAYER is "${value}"; leave it unset (on), or set it to on or off.`);
  return value;
}

/** stackCustodyLayer's reading of the process records alone (pure): svc-ledger's recorded switch, `on` when unrecorded. */
export function custodyLayerOf(records) {
  const value = records?.ledger?.custodyLayer ?? 'on';
  if (value !== 'on' && value !== 'off') throw new Error(`refusing: svc-ledger's recorded custody switch is "${value}", not on or off`);
  return value;
}

/** The typed refusal the TEST tools give for a person's money on a custody-off stack (`local:fund`, the seed, the world). */
export const CUSTODY_OFF_CODE = 'local_test.custody_layer_off';
export function custodyOffRefusal(what) {
  return (
    `${CUSTODY_OFF_CODE}: ${what} refused. This stack runs LEDGER_CUSTODY_LAYER off, as the launch build will, so ` +
    "INTAFACED's ledger holds no customer money (OWNER 226, OWNER 288). A TEST person's money " +
    'is where launch keeps it: at the TEST partner (testPartner.fund) or on their own TEST venue account. ' +
    'Nothing was posted. Start the stack with LOCAL_STACK_CUSTODY_LAYER=on for the journeys marked Later: custody.'
  );
}

/**
 * The kernel's own birth mark for a process on Linux: field 22 of /proc/<pid>/stat, clock ticks since boot. It never
 * moves while the process lives. The 2-second allowance below compares ps's lstart (on Linux derived from a boot time
 * rounded to whole seconds, and moved by clock corrections) with a time written after spawn (late on a loaded runner);
 * on CI one or both put a live service outside it and the stack refused its own service's port (#7488: trade in main
 * run 42400147448; market in main run 42440617559). The mark comes from neither clock, so either cause is closed.
 * Elsewhere (macOS) it is null and the start time is checked as before. Read only; never the process environment.
 */
export function readKernelStart(pid, { platform = process.platform, read = fs.readFileSync } = {}) {
  if (platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = String(read(`/proc/${pid}/stat`, 'utf8'));
    // The command name (field 2) sits in parentheses and may hold spaces or ')'; the fields after the last ')' start at 3.
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[22 - 3];
    return /^\d+$/.test(ticks ?? '') ? ticks : null;
  } catch {
    return null;
  }
}

/**
 * ps exposes seconds; launch records are written immediately after spawn, in milliseconds. A record that carries the
 * kernel's birth mark (readKernelStart, taken at spawn) is held to that mark exactly wherever the kernel reports one,
 * which is stricter than the 2-second allowance and immune to clock drift.
 */
export function processStartMatches(startedAt, actual, kernelStart) {
  if (typeof kernelStart === 'string' && kernelStart && typeof actual?.kernelStart === 'string') return actual.kernelStart === kernelStart;
  const recorded = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt);
  return Number.isFinite(recorded) && Number.isFinite(actual?.startedAt) && Math.abs(actual.startedAt - recorded) <= 2000;
}

/** A stale PID, including one reused by an identical command, must not authorize a signal. */
export function processRecordMatches(record, actual) {
  return Boolean(
    Number.isSafeInteger(record?.pid) &&
    record.pid > 0 &&
    Array.isArray(record.argv) &&
    record.argv.length > 0 &&
    record.argv.every((arg) => typeof arg === 'string') &&
    actual?.command === record.argv.join(' ') &&
    processStartMatches(record.startedAt, actual, record.kernelStart),
  );
}

/** Read only command and birth time, never the process environment. */
export function readProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=,command='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (ps.status !== 0) return null;
  const match = ps.stdout?.trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/);
  return match ? { startedAt: Date.parse(match[1]), command: match[2], kernelStart: readKernelStart(pid) } : null;
}

/** Match the whole -D value, so a sibling directory with the same prefix cannot pass. */
export function postgresProcessMatches(pgdata, startedAt, actual) {
  return Boolean(
    actual?.command &&
    /^(?:\S*\/)?postgres\s/.test(actual.command) &&
    `${actual.command} `.includes(` -D ${pgdata} `) &&
    processStartMatches(startedAt, actual),
  );
}

const refuse = (reason) => {
  throw new Error(`refusing: selected local stack is not active (${reason})`);
};

/** Pure ownership check: stale files alone never authorize requests to fixed loopback ports. */
export function assertStackOwnership({ stateDir, marker, records, postgres, processes, listeners, services = DEFAULT_SERVICES }) {
  if (marker?.kind !== 'intafaced-local-test-stack' || !path.isAbsolute(marker.repo ?? '')) refuse('invalid marker or checkout');
  const pgdata = path.join(stateDir, 'data', 'postgres');
  const [pgPid, pgDirectory, pgStarted, pgPort] = postgres;
  if (pgDirectory !== pgdata || String(pgPort) !== String(marker.ports?.postgres)) refuse('database directory or port differs');
  const checks = [
    {
      name: 'postgres',
      pid: Number(pgPid),
      port: marker.ports.postgres,
      startedAt: Number(pgStarted) * 1000,
      matches: (actual) => postgresProcessMatches(pgdata, Number(pgStarted) * 1000, actual),
    },
  ];
  for (const name of services) {
    const record = records[name];
    const entry =
      name === 'customer'
        ? [path.join(marker.repo, 'tooling', 'scripts', 'local-test-stack.mjs'), '__serve-customer']
        : [path.join(marker.repo, 'services', `svc-${name}`, 'dist', 'index.js')];
    // A Node service may start with this checkout's code-reach preload first (service-reach.mjs), and nothing else.
    const preload = ['--import', pathToFileURL(path.join(marker.repo, 'tooling', 'scripts', 'service-reach.mjs')).href];
    const rest = record?.argv?.slice(1) ?? [];
    const args = name !== 'customer' && preload.every((value, i) => rest[i] === value) ? rest.slice(preload.length) : rest;
    // A Rust service (local-stack-services/<name>.mjs says `rust: true`) runs this checkout's own release binary, alone.
    const rustBinary = path.join(marker.repo, 'crates', `svc-${name}`, 'dist', `svc-${name}`);
    const ownBinary = record?.argv?.length === 1 && record.argv[0] === rustBinary;
    if (!ownBinary && (!record?.argv || args.length !== entry.length || !entry.every((value, i) => args[i] === value)))
      refuse(`${name} checkout differs`);
    checks.push({
      name,
      pid: record.pid,
      port: marker.ports[name],
      startedAt: Date.parse(record.startedAt),
      kernelStart: record.kernelStart,
      matches: (actual) => actual.command === record.argv.join(' '),
    });
  }
  for (const check of checks) {
    const actual = processes.get(check.pid);
    if (!Number.isSafeInteger(check.pid) || check.pid <= 0 || !actual || !check.matches(actual)) refuse(`${check.name} process differs`);
    // ps reports seconds, while the stack records milliseconds immediately after spawning.
    if (!processStartMatches(check.startedAt, actual, check.kernelStart)) refuse(`${check.name} process was replaced`);
    if (!listeners.get(check.pid)?.has(`127.0.0.1:${check.port}`)) refuse(`${check.name} does not own its loopback port`);
  }
  return { stateDir, marker };
}

/**
 * A tester compose stack's marker (docker-compose.tester.yml, written by local-test-compose-env.mjs): `runtime: compose`.
 * Its services run in containers, so no process ID or listener of theirs is visible to check. Its proof instead is the
 * stack id: compose-env draws it at random and writes it both into the marker and into the env file compose starts that
 * stack's Postgres with (`-c intafaced.tester_stack_id=<id>`), so only the database that compose up started answers it.
 */
export const COMPOSE_RUNTIME = 'compose';
const STACK_ID_RE = /^[0-9a-f]{32}$/;

/**
 * What answers on the compose marker's loopback ports, read by a child process so this check stays synchronous like the
 * process check: the stack id the database on the Postgres port was started with (as the compose role `svc_<x>`, whose
 * password is the compose default), and each named service's /health status. Never reads anything else.
 */
function readComposeStack(marker, services) {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const script = `
    const { createRequire } = require('node:module');
    const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
    (async () => {
      const out = { stackId: null, health: {} };
      try {
        const load = createRequire(input.pkg)('postgres');
        const sql = (load.default ?? load)(input.db, { max: 1, ssl: false, connect_timeout: 5, onnotice: () => {} });
        try { out.stackId = (await sql.unsafe("SELECT current_setting('intafaced.tester_stack_id', true) AS id"))[0]?.id ?? null; }
        finally { await sql.end({ timeout: 2 }); }
      } catch (err) { out.dbError = String(err?.code ?? err?.message ?? err); }
      for (const [name, port] of input.services) {
        try { out.health[name] = (await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(5000) })).status; }
        catch { out.health[name] = 0; }
      }
      process.stdout.write(JSON.stringify(out));
    })();`;
  const input = {
    pkg: path.join(repo, 'services', 'svc-p2p', 'package.json'),
    db: `postgres://svc_p2p:svc_p2p@127.0.0.1:${marker.ports.postgres}/${marker.database.name}`,
    services: services.map((name) => [name, marker.ports[name]]),
  };
  const res = spawnSync(process.execPath, ['-e', script], { input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000 });
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { stackId: null, health: {}, dbError: (res.stderr || res.error?.message || 'no answer').slice(0, 200) };
  }
}

/** Runs one read-only query on `db` in a child process (the image has no psql); its rows as text, null as ''. */
function runComposeSql(db, sql) {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const script = `
    const { createRequire } = require('node:module');
    const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
    (async () => {
      const load = createRequire(input.pkg)('postgres');
      const sql = (load.default ?? load)(input.db, { max: 1, ssl: false, connect_timeout: 5, onnotice: () => {} });
      try {
        const rows = await sql.unsafe(input.sql).values();
        process.stdout.write(JSON.stringify(rows.map((r) => r.map((v) => (v === null ? '' : String(v))))));
      } finally { await sql.end({ timeout: 2 }); }
    })().catch((err) => { process.stderr.write(String(err?.code ?? err?.message ?? err)); process.exit(1); });`;
  const input = { pkg: path.join(repo, 'services', 'svc-p2p', 'package.json'), db, sql };
  const res = spawnSync(process.execPath, ['-e', script], { input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000 });
  if (res.status !== 0) throw new Error(`compose database read failed: ${(res.stderr || res.error?.message || 'no answer').slice(0, 300)}`);
  return JSON.parse(res.stdout);
}

/**
 * One read on a compose marker's loopback Postgres as a service role, with compose's own LOCAL TEST password (the role's
 * name, tooling/infra/postgres-init): what the gates read with psql on a `pnpm local:stack` stack. Refuses anything but a
 * compose marker whose database is on loopback at its Postgres port, and any role but a service's own.
 */
export function composeSqlRead(marker, role, sql, { run = runComposeSql } = {}) {
  if (marker?.runtime !== COMPOSE_RUNTIME) refuse('not a compose marker');
  const db = marker.database ?? {};
  if (db.host !== '127.0.0.1' || String(db.port) !== String(marker.ports?.postgres) || !/^\d+$/.test(String(db.port)))
    refuse('compose database is not the marker loopback Postgres');
  if (!/^[A-Za-z0-9_]+$/.test(db.name ?? '')) refuse('compose database is not the marker loopback Postgres');
  if (!/^svc_[a-z0-9_]+$/.test(String(role))) refuse(`"${role}" is not a service role`);
  return run(`postgres://${role}:${role}@127.0.0.1:${db.port}/${db.name}`, sql);
}

/**
 * Pure ownership check of a compose marker: the database on its loopback Postgres port was started with its stack id, and
 * each named service on its loopback port answers its health check. Stale files alone never pass: a stack id is drawn per
 * state folder, so another stack on the same ports does not hold it.
 */
export function assertComposeOwnership({ marker, services, read = readComposeStack }) {
  if (marker?.kind !== 'intafaced-local-test-stack' || marker.runtime !== COMPOSE_RUNTIME) refuse('not a compose marker');
  if (!STACK_ID_RE.test(String(marker.stackId ?? ''))) refuse('compose marker has no stack id');
  const db = marker.database ?? {};
  if (
    db.host !== '127.0.0.1' ||
    !/^\d+$/.test(String(db.port)) ||
    String(db.port) !== String(marker.ports?.postgres) ||
    !/^[A-Za-z0-9_]+$/.test(db.name ?? '')
  )
    refuse('compose database is not the marker loopback Postgres');
  for (const name of services) if (!/^\d+$/.test(String(marker.ports?.[name] ?? ''))) refuse(`compose marker has no ${name} port`);
  const seen = read(marker, services);
  if (seen.stackId !== marker.stackId)
    refuse(`the database on 127.0.0.1:${db.port} is not this compose stack's${seen.dbError ? ` (${seen.dbError})` : ''}`);
  for (const name of services) if (seen.health?.[name] !== 200) refuse(`${name} does not answer on its loopback port`);
  return { marker };
}

/** Check selected Postgres and service PID/argv/start time/listeners without exposing their environment. */
export function assertActiveLocalStack({ stateDir = localStackState(), services = DEFAULT_SERVICES } = {}) {
  let marker, records, postgres;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(stateDir, 'LOCAL-TEST-STACK.json'), 'utf8'));
  } catch {
    refuse('missing ownership records');
  }
  if (marker?.runtime === COMPOSE_RUNTIME) {
    // A compose stack has no customer process of its own on a stack port; its other services are checked.
    const named = services.filter((name) => name !== 'customer');
    return { stateDir, ...assertComposeOwnership({ marker, services: named }) };
  }
  try {
    records = JSON.parse(fs.readFileSync(path.join(stateDir, 'run', 'processes.json'), 'utf8'));
    postgres = fs.readFileSync(path.join(stateDir, 'data', 'postgres', 'postmaster.pid'), 'utf8').split('\n');
  } catch {
    refuse('missing ownership records');
  }
  const pids = [Number(postgres[0]), ...services.map((name) => records[name]?.pid)];
  if (pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) refuse('missing process IDs');
  const ps = spawnSync('ps', ['-p', pids.join(','), '-o', 'pid=,lstart=,command='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  const processes = new Map();
  for (const line of (ps.stdout ?? '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/);
    if (match)
      processes.set(Number(match[1]), {
        startedAt: Date.parse(match[2]),
        command: match[3],
        kernelStart: readKernelStart(Number(match[1])),
      });
  }
  const sockets = spawnSync(
    fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof',
    ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-Fpn'],
    { encoding: 'utf8' },
  );
  if (sockets.error) refuse(`cannot list listening ports (lsof: ${sockets.error.message})`);
  const listeners = new Map();
  let pid;
  for (const line of (sockets.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      listeners.set(pid, new Set());
    } else if (line.startsWith('n') && listeners.has(pid)) listeners.get(pid).add(line.slice(1));
  }
  return assertStackOwnership({ stateDir, marker, records, postgres, processes, listeners, services });
}

/** Same file the local stack's identity process writes. */
export function localEmailOutboxPath(env = process.env, home = os.homedir()) {
  return path.join(localStackState(home, env), 'email-outbox.log');
}

/**
 * Newest LOCAL-TEST confirm link for this address, or null.
 * Line shape: `LOCAL-TEST purpose=email-confirm email=<email> expires=<iso> link=confirm-email?token=<encoded>` (the customer page; older lines used `confirmEmail`).
 */
export function readLatestEmailConfirmToken(text, email) {
  const want = String(email ?? '')
    .trim()
    .toLowerCase();
  let token = null;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.includes('LOCAL-TEST') || !line.includes('purpose=email-confirm')) continue;
    const emailMatch = /(?:^|\s)email=(\S+)/.exec(line);
    const linkMatch = /(?:^|\s)link=(\S+)/.exec(line);
    if (!emailMatch || !linkMatch) continue;
    if (emailMatch[1].toLowerCase() !== want) continue;
    const q = /[?&]token=([^&\s]+)/.exec(linkMatch[1]);
    if (!q?.[1]) continue;
    try {
      token = decodeURIComponent(q[1]);
    } catch {
      token = null;
    }
  }
  return token;
}
