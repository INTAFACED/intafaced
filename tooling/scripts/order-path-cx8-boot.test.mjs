import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CX8_SMOKE_ENV, cx8RoleEnv } from './order-path-cx8-boot.mjs';

const SCRIPT = fileURLToPath(new URL('./order-path-cx8-boot.mjs', import.meta.url));
// What each stand-in process logs of the environment it was started with.
const KEYS = [
  'SERVICE_NAME',
  'DATABASE_POOL_MAX',
  'RECONCILE_CRON_MINUTES',
  'MATCHING_SNAPSHOT_EVERY',
  'MATCHING_OPERATOR_IDS',
  'LEDGER_CUSTODY_LAYER',
  'IDENTITY_FOUNDER_NITRO_USER_ID',
  'IDENTITY_FOUNDER_PHANTOM_USER_ID',
];
const FOUNDERS = [{ userId: 'smoke-founder-a' }, { userId: 'smoke-founder-b' }];

/**
 * One whole boot, as the CX-8 workflow runs it, in a folder of stand-ins: each service a process that logs its name and
 * environment and stays up until stopped, the Rust binaries and pnpm the same, the founder enrolment a stand-in that
 * logs and prints two smoke founders, health checks answered (fetch replaced), and CX8_AFTER set so the pay, bank and
 * tax phase boots too. Returns each start in the order it happened.
 */
let booted = null;
function boot() {
  if (booted) return booted;
  const box = mkdtempSync(join(tmpdir(), 'cx8-boot-'));
  const log = join(box, 'starts.ndjson');
  const put = (rel, text, mode) => {
    mkdirSync(dirname(join(box, rel)), { recursive: true });
    writeFileSync(join(box, rel), text);
    if (mode) chmodSync(join(box, rel), mode);
  };
  put(
    'stub.mjs',
    `import { appendFileSync } from 'node:fs';
const [what, ...args] = process.argv.slice(2);
const env = Object.fromEntries(${JSON.stringify(KEYS)}.filter((k) => k in process.env).map((k) => [k, process.env[k]]));
appendFileSync(process.env.CX8_TEST_LOG, JSON.stringify({ what, args, env }) + '\\n');
if (what === 'enrol') process.stdout.write('CX8_FOUNDERS_JSON=' + ${JSON.stringify(JSON.stringify(FOUNDERS))} + '\\n');
const once = what === 'pnpm' || what === 'enrol' || what === 'after' || args[0] === 'migrate';
if (!once) setInterval(() => {}, 1 << 30);
`,
  );
  const sh = (rel, what) => put(rel, `#!/bin/sh\nexec "${process.execPath}" "${join(box, 'stub.mjs')}" ${what} "$@"\n`, 0o755);
  sh('bin/pnpm', 'pnpm');
  sh('ledger-bin', 'ledger');
  sh('tax-bin', 'tax');
  for (const svc of ['identity', 'pay', 'bank', 'matching', 'trade'])
    put(`services/svc-${svc}/dist/index.js`, `await import(${JSON.stringify(pathToFileURL(join(box, 'stub.mjs')).href)});\n`);
  put('services/svc-trade/scripts/order-path-smoke.mjs', `await import(${JSON.stringify(pathToFileURL(join(box, 'stub.mjs')).href)});\n`);
  put('health.mjs', 'globalThis.fetch = async () => ({ ok: true, status: 200 });\n');
  // A service's index.js stand-in reads its role from SERVICE_NAME; the enrolment's, from its --enrol-founders flag.
  put(
    'stub-argv.mjs',
    `if (process.argv[1]?.endsWith('order-path-smoke.mjs')) process.argv.splice(2, 0, 'enrol');
else if (process.argv[1]?.endsWith('dist/index.js')) process.argv.splice(2, 0, process.env.SERVICE_NAME);\n`,
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !KEYS.includes(k) && !k.startsWith('CX8_')));
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(box, 'health.mjs')).href, SCRIPT], {
    cwd: box,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...env,
      PATH: `${join(box, 'bin')}:${process.env.PATH}`,
      NODE_OPTIONS: `--import ${pathToFileURL(join(box, 'stub-argv.mjs')).href}`,
      SVC_LEDGER_BIN: join(box, 'ledger-bin'),
      SVC_TAX_BIN: join(box, 'tax-bin'),
      CX8_AFTER: JSON.stringify([process.execPath, join(box, 'stub.mjs'), 'after']),
      CX8_TEST_LOG: log,
    },
  });
  const starts = existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
  booted = { status: r.status, output: `${r.stdout}${r.stderr}`, starts };
  return booted;
}
const started = (name) => boot().starts.filter((s) => s.what === name && s.args[0] !== 'migrate');

test('CX-8 smoke publishes the D-44 integers on the processes that refuse a blank', () => {
  assert.deepEqual(CX8_SMOKE_ENV, {
    DATABASE_POOL_MAX: '10',
    RECONCILE_CRON_MINUTES: '60',
    MATCHING_SNAPSHOT_EVERY: '500',
  });
  assert.deepEqual(cx8RoleEnv('matching'), { MATCHING_SNAPSHOT_EVERY: '500' });
  assert.deepEqual(cx8RoleEnv('ledger'), { DATABASE_POOL_MAX: '10', RECONCILE_CRON_MINUTES: '60' });
  assert.deepEqual(cx8RoleEnv('identity'), { DATABASE_POOL_MAX: '10' });
  assert.deepEqual(cx8RoleEnv('trade'), { DATABASE_POOL_MAX: '10' });
});

test('the whole boot runs to its end against the stand-ins', () => {
  const { status, output } = boot();
  assert.equal(status, 0, output);
  assert.match(output, /CX-8 boot \+ smoke complete/);
});

test('each booted process spreads that role env', () => {
  const role = { matching: 'svc-matching', ledger: 'ledger', identity: 'svc-identity', trade: 'svc-trade' };
  for (const [name, what] of Object.entries(role)) {
    const runs = started(what);
    assert.ok(runs.length >= 1, `${name} started\n${boot().output}`);
    for (const run of runs) for (const [k, v] of Object.entries(cx8RoleEnv(name))) assert.equal(run.env[k], v, `${name} gets ${k}=${v}`);
  }
});

test('matching boots after founder enrolment and is given exactly the two smoke founder ids (#4724)', () => {
  const { starts, output } = boot();
  const enrol = starts.findIndex((s) => s.what === 'enrol');
  const matching = starts.findIndex((s) => s.what === 'svc-matching');
  assert.ok(enrol >= 0 && matching > enrol, `matching must start after the founders are enrolled\n${output}`);
  assert.equal(started('svc-matching').length, 1, 'matching starts once');
  assert.equal(started('svc-matching')[0].env.MATCHING_OPERATOR_IDS, FOUNDERS.map((f) => f.userId).join(','));
  // ...and identity, booted again after the enrolment, pins exactly that pair.
  const pinned = started('svc-identity').at(-1).env;
  assert.deepEqual(
    [pinned.IDENTITY_FOUNDER_NITRO_USER_ID, pinned.IDENTITY_FOUNDER_PHANTOM_USER_ID],
    FOUNDERS.map((f) => f.userId),
  );
});

test('svc-bank is given the custody switch once, so an edit to it cannot be silently overridden (project-state#2520)', () => {
  // The value svc-bank boots with is the one this rig's svc-ledger runs: no later key or spread wins over it.
  const ledger = started('ledger');
  const bank = started('svc-bank');
  assert.equal(ledger.length, 1, boot().output);
  assert.equal(bank.length, 1, 'the bank starts once, in the CX8_AFTER phase');
  assert.equal(ledger[0].env.LEDGER_CUSTODY_LAYER, 'on');
  assert.equal(bank[0].env.LEDGER_CUSTODY_LAYER, ledger[0].env.LEDGER_CUSTODY_LAYER);
  for (const svc of ['svc-matching', 'svc-trade']) assert.equal(started(svc)[0].env.LEDGER_CUSTODY_LAYER, 'on', svc);
});
