import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/** The Postgres client and server binaries the local test stack uses: LOCAL_STACK_PG_BIN, else Homebrew, else Debian's 16. */
export function localPgBin(env = process.env) {
  if (env.LOCAL_STACK_PG_BIN) return env.LOCAL_STACK_PG_BIN;
  return fs.existsSync('/opt/homebrew/bin/pg_ctl') ? '/opt/homebrew/bin' : '/usr/lib/postgresql/16/bin';
}

/** One state root for the stack and every helper. Never silently fall back after a typo. */
export function localStackState(home = os.homedir(), env = process.env) {
  if (env.LOCAL_STACK_STATE === undefined) return path.join(home, '.intafaced', 'local-test-stack');
  const state = env.LOCAL_STACK_STATE;
  if (!state.trim() || !path.isAbsolute(state)) throw new Error('LOCAL_STACK_STATE must be an absolute folder path');
  return path.resolve(state);
}

const DEFAULT_SERVICES = ['edge', 'identity', 'trade', 'matching', 'ledger', 'customer'];

/** ps exposes seconds; launch records are written immediately after spawn, in milliseconds. */
export function processStartMatches(startedAt, actual) {
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
    processStartMatches(record.startedAt, actual),
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
  return match ? { startedAt: Date.parse(match[1]), command: match[2] } : null;
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
      matches: (actual) => actual.command === record.argv.join(' '),
    });
  }
  for (const check of checks) {
    const actual = processes.get(check.pid);
    if (!Number.isSafeInteger(check.pid) || check.pid <= 0 || !actual || !check.matches(actual)) refuse(`${check.name} process differs`);
    // ps reports seconds, while the stack records milliseconds immediately after spawning.
    if (!processStartMatches(check.startedAt, actual)) refuse(`${check.name} process was replaced`);
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
    if (match) processes.set(Number(match[1]), { startedAt: Date.parse(match[2]), command: match[3] });
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
