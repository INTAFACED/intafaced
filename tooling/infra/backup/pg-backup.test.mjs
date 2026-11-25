/**
 * The hosted beta's backup is proven by restoring it, and its alert rules by promtool (#10211).
 *
 * In Docker, with the images docker-compose.yml runs (postgres:16-alpine for the `pg-backup` service, the pinned
 * prom/prometheus for promtool), so what passes here is what runs on the host:
 *  - a backup of a seeded server restores into a second, fresh server with every row, role and database intact;
 *  - restore refuses a backup whose checksums fail, an unfinished `.partial`, and a server that already holds the
 *    database; a backup with the database down fails and records the failure for `BackupFailed`;
 *  - only the newest KEEP backups are kept;
 *  - promtool loads prometheus.yaml with its rule file, the rules' own unit tests pass, and a planted fault in a rule
 *    makes them fail.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const INFRA = join(import.meta.dirname, '..');
const COMPOSE = readFileSync(join(INFRA, '..', '..', 'docker-compose.yml'), 'utf8');
const imageOf = (service) => {
  const m = new RegExp(`^  ${service}:\\n(?:    .*\\n)*?    image: (\\S+)`, 'm').exec(COMPOSE);
  assert.ok(m, `docker-compose.yml has no image for ${service}`);
  return m[1];
};
const PG_IMAGE = imageOf('pg-backup');
const PROM_IMAGE = imageOf('prometheus');
const tag = randomBytes(4).toString('hex');
const VOLUME = `pg-backup-test-${tag}`;
const containers = [];

const docker = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const run = (args) => spawnSync('docker', args, { encoding: 'utf8' });

function startPostgres(name, db) {
  const id = docker([
    'run',
    '-d',
    '--rm',
    '--name',
    `${name}-${tag}`,
    '-e',
    'POSTGRES_USER=intafaced',
    '-e',
    'POSTGRES_PASSWORD=intafaced',
    '-e',
    `POSTGRES_DB=${db}`,
    '-v',
    `${VOLUME}:/backups`,
    '-v',
    `${import.meta.dirname}:/backup-bin:ro`,
    PG_IMAGE,
  ]).trim();
  containers.push(id);
  return id;
}

function ready(id) {
  // The wait runs in the container, so the test holds no timer. TCP, not the socket: the image's init server listens
  // on the socket only, then restarts.
  const r = run([
    'exec',
    id,
    'sh',
    '-c',
    'for i in $(seq 120); do pg_isready -q -h 127.0.0.1 -U intafaced && exit 0; sleep 0.5; done; exit 1',
  ]);
  if (r.status !== 0) throw new Error(`postgres in ${id} never became ready`);
}

const ENV = ['-e', 'PGHOST=127.0.0.1', '-e', 'PGUSER=intafaced', '-e', 'PGPASSWORD=intafaced', '-e', 'BACKUP_DIR=/backups'];
const script = (id, args, env = []) => run(['exec', ...ENV, ...env, id, 'sh', '/backup-bin/pg-backup.sh', ...args]);
const psql = (id, db, sql) => docker(['exec', ...ENV, id, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql]).trim();
const backups = (id) => docker(['exec', id, 'sh', '-c', 'ls -1 /backups']).split('\n').filter(Boolean).sort();

/** What a restore must give back: every row (as text, so a numeric's scale counts), the roles and the databases. */
const snapshot = (id) => ({
  ledger: psql(id, 'intafaced', "SELECT md5(string_agg(t::text, ',' ORDER BY id)) || ':' || count(*) FROM svc_book.entries t"),
  sum: psql(id, 'intafaced', 'SELECT sum(amount)::text FROM svc_book.entries'),
  owner: psql(id, 'intafaced', "SELECT schema_owner FROM information_schema.schemata WHERE schema_name = 'svc_book'"),
  seq: psql(id, 'intafaced', 'SELECT last_value FROM svc_book.entries_id_seq'),
  test: psql(id, 'intafaced_test', 'SELECT note FROM marker'),
  login: psql(id, 'postgres', "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'svc_book'"),
  dbs: psql(id, 'postgres', "SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE NOT datistemplate"),
});

let source;
let fresh;

before(() => {
  docker(['volume', 'create', VOLUME]);
  source = startPostgres('pg-backup-source', 'intafaced');
  // A fresh server holds no database of ours: POSTGRES_DB would otherwise default to the user's name, `intafaced`.
  fresh = startPostgres('pg-backup-fresh', 'postgres');
  ready(source);
  ready(fresh);
  psql(
    source,
    'intafaced',
    `
    CREATE ROLE svc_book LOGIN PASSWORD 'svc_book';
    CREATE SCHEMA svc_book AUTHORIZATION svc_book;
    CREATE TABLE svc_book.entries (id bigserial PRIMARY KEY, account text NOT NULL, amount numeric(38,18) NOT NULL,
      meta jsonb NOT NULL, at timestamptz NOT NULL DEFAULT '2026-11-23T00:00:00Z');
    ALTER TABLE svc_book.entries OWNER TO svc_book;
    INSERT INTO svc_book.entries (account, amount, meta)
      SELECT 'acct-' || g, (g * 1.000000000000000001)::numeric(38,18), jsonb_build_object('g', g) FROM generate_series(1, 2000) g;`,
  );
  psql(source, 'intafaced', 'CREATE DATABASE intafaced_test OWNER intafaced');
  psql(source, 'intafaced_test', "CREATE TABLE marker (note text); INSERT INTO marker VALUES ('second database');");
});

after(() => {
  for (const id of containers) run(['rm', '-f', id]);
  run(['volume', 'rm', '-f', VOLUME]);
});

test('a backup restores into a fresh server with every row, role and database', () => {
  const made = script(source, ['backup'], ['-e', 'METRICS_DIR=/backups/metrics']);
  assert.equal(made.status, 0, made.stderr);
  const [stamp] = backups(source).filter((f) => /^\d{8}T\d{6}Z$/.test(f));
  assert.ok(stamp, `no complete backup in ${backups(source)}`);
  const metrics = docker(['exec', source, 'cat', '/backups/metrics/intafaced_backup.prom']);
  assert.match(metrics, /^intafaced_backup_last_attempt_success 1$/m);
  assert.match(metrics, /^intafaced_backup_last_success_timestamp_seconds \d+$/m);

  const want = snapshot(source);
  assert.equal(want.ledger.split(':')[1], '2000');
  const restored = script(fresh, ['restore', `/backups/${stamp}`]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.deepEqual(snapshot(fresh), want);
  // The restored role signs in with its own password, as the service would.
  const login = run([
    'exec',
    '-e',
    'PGPASSWORD=svc_book',
    fresh,
    'psql',
    '-XAtq',
    '-h',
    '127.0.0.1',
    '-U',
    'svc_book',
    '-d',
    'intafaced',
    '-c',
    'SELECT count(*) FROM svc_book.entries',
  ]);
  assert.equal(login.stdout.trim(), '2000', login.stderr);
});

test('restore refuses a server that already holds the database', () => {
  const [stamp] = backups(source).filter((f) => f.endsWith('Z'));
  const r = script(source, ['restore', `/backups/${stamp}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /database intafaced already exists: restore only into a fresh server/);
});

test('restore refuses a backup that fails its checksums, and an unfinished one', () => {
  const [stamp] = backups(source).filter((f) => f.endsWith('Z'));
  docker(['exec', source, 'sh', '-c', `cp -r /backups/${stamp} /backups/corrupt && printf x >> /backups/corrupt/db-intafaced.dump`]);
  const corrupt = script(source, ['restore', '/backups/corrupt']);
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /fails its checksums/);
  docker(['exec', source, 'sh', '-c', `rm -rf /backups/corrupt && cp -r /backups/${stamp} /backups/${stamp}.partial`]);
  const partial = script(source, ['restore', `/backups/${stamp}.partial`]);
  assert.notEqual(partial.status, 0);
  assert.match(partial.stderr, /unfinished backup/);
});

test('a backup that cannot reach the database fails, keeps no backup and records the failure', () => {
  const before = backups(source).filter((f) => f.endsWith('Z'));
  const r = script(source, ['backup'], ['-e', 'METRICS_DIR=/backups/metrics', '-e', 'PGPORT=1']);
  assert.notEqual(r.status, 0);
  assert.deepEqual(
    backups(source).filter((f) => f.endsWith('Z')),
    before,
  );
  const metrics = docker(['exec', source, 'cat', '/backups/metrics/intafaced_backup.prom']);
  assert.match(metrics, /^intafaced_backup_last_attempt_success 0$/m);
  // The last good backup's time stays, so `BackupStale` still counts from it.
  assert.match(metrics, /^intafaced_backup_last_success_timestamp_seconds \d+$/m);
});

test('only the newest KEEP backups are kept, and a leftover .partial is cleared', () => {
  // Two older backups, by their stamps, beside the ones already made and the .partial the test above left.
  const [stamp] = backups(source).filter((f) => f.endsWith('Z'));
  docker([
    'exec',
    source,
    'sh',
    '-c',
    `cp -r /backups/${stamp} /backups/20000101T000000Z && cp -r /backups/${stamp} /backups/20000102T000000Z`,
  ]);
  assert.ok(backups(source).some((f) => f.endsWith('.partial')));
  const r = script(source, ['backup'], ['-e', 'KEEP=2']);
  assert.equal(r.status, 0, r.stderr);
  const left = backups(source).filter((f) => f !== 'metrics');
  assert.equal(left.length, 2, `${left}`);
  assert.ok(!left.includes('20000101T000000Z') && !left.includes('20000102T000000Z'), `${left}`);
  assert.ok(
    left.every((f) => /^\d{8}T\d{6}Z$/.test(f)),
    `${left}`,
  );
});

const promtool = (dir, args) => run(['run', '--rm', '--entrypoint', 'promtool', '-v', `${dir}:/cfg:ro`, '-w', '/cfg', PROM_IMAGE, ...args]);

test('promtool loads prometheus.yaml with its alert rules, and the rules pass their unit tests', () => {
  const config = promtool(INFRA, ['check', 'config', 'prometheus.yaml']);
  assert.equal(config.status, 0, config.stdout + config.stderr);
  assert.match(config.stdout, /SUCCESS: 7 rules found/);
  const rules = promtool(INFRA, ['test', 'rules', 'prometheus-alerts.test.yaml']);
  assert.equal(rules.status, 0, rules.stdout + rules.stderr);
});

test('the rule tests fail on a planted fault: a down service waiting 10 minutes instead of 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alerts-planted-'));
  chmodSync(dir, 0o755); // promtool runs as `nobody` in its image
  try {
    copyFileSync(join(INFRA, 'prometheus-alerts.test.yaml'), join(dir, 'prometheus-alerts.test.yaml'));
    const rules = readFileSync(join(INFRA, 'prometheus-alerts.yaml'), 'utf8');
    const planted = rules.replace(
      /(expr: up\{job!~"prometheus\|app-health"\} == 0 or probe_success\{job="app-health"\} == 0\n\s+for: )2m/,
      '$110m',
    );
    assert.notEqual(planted, rules, 'the plant did not apply');
    writeFileSync(join(dir, 'prometheus-alerts.yaml'), planted);
    const r = promtool(dir, ['test', 'rules', 'prometheus-alerts.test.yaml']);
    assert.notEqual(r.status, 0, 'promtool passed a planted fault');
    assert.match(r.stdout + r.stderr, /alertname: ServiceDown/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
