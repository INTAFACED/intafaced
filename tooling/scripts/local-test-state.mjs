import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/** The Postgres client and server binaries the local test stack uses: LOCAL_STACK_PG_BIN, else Homebrew, else Debian's 16. */
export function localPgBin(env = process.env) {
  if (env.LOCAL_STACK_PG_BIN) return env.LOCAL_STACK_PG_BIN;
  return fs.existsSync('/opt/homebrew/bin/pg_ctl') ? '/opt/homebrew/bin' : '/usr/lib/postgresql/16/bin';
}

/** As root (a cloud container's default user) the database runs as this OS user: initdb and postgres refuse root. */
export function localPgOsUser(env = process.env, uid = process.getuid?.()) {
  return uid === 0 ? env.LOCAL_STACK_PG_USER || 'postgres' : null;
}

// The state folder rule lives in local-test-facts.mjs, so the journeys read it without this script.
import { localStackState } from './local-test-facts.mjs';

export { localStackState };

const DEFAULT_SERVICES = ['edge', 'identity', 'trade', 'matching', 'ledger', 'customer'];

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
    "INTAFACED's ledger holds no customer money (docs/adr/2026-11-10-launch-money-model.md). A TEST person's money " +
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
    if (!record?.argv || record.argv.length !== entry.length + 1 || !entry.every((value, i) => record.argv[i + 1] === value))
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

/** Check selected Postgres and service PID/argv/start time/listeners without exposing their environment. */
export function assertActiveLocalStack({ stateDir = localStackState(), services = DEFAULT_SERVICES } = {}) {
  let marker, records, postgres;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(stateDir, 'LOCAL-TEST-STACK.json'), 'utf8'));
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
