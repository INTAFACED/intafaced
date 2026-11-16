#!/usr/bin/env node
/**
 * Before a push: the unit tests related to the pushed files, under CI's conditions, within a hard time limit.
 *
 * A unit test that the change itself breaks was first seen on GitHub, about six minutes after the push (15 of the last
 * 100 first pushes went red on the Tests job first, #8670). Measured on those heads, one at a time on the shared Mac:
 * each package's own changed test files, then `vitest related` on its changed files, caught 8 of the 12 that the
 * change caused, with a median of 15 s. They are caught only under CI's conditions, so this step brings them:
 *  - CI's Node major (`.node-version`). Under another Node some tests fail only here (Node 26's own `localStorage`
 *    hides happy-dom's, so customer render tests fail on every push).
 *  - TZ=UTC, as on GitHub's runners.
 *  - A throwaway Postgres cluster, made by initdb in a temp folder on its own port, in UTC, and set up by the same
 *    tooling/infra/postgres-init scripts CI's test-infra runs. Six of the 8 catches were a head's own Postgres test.
 *    It is removed when the step ends. It is not the local test stack.
 * Without one of these the step skips with one line and never refuses: a refusal for a reason outside the change is
 * what took tests out of this hook before (#8277, #8284).
 *
 * The limit (default 90 s, PRE_PUSH_TESTS_SECONDS) covers the whole step. At the limit it stops its tests, the push
 * goes on, and it says so; CI's Tests job runs them as before. It refuses only when vitest names a failing test, and
 * names it. A step that breaks in any other way lets the push go and says why.
 *
 * Usage (from the repo root, as .githooks/pre-push runs it): node tooling/scripts/related-tests-before-push.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME = 'related tests';
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const TEST = /\.test\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
// vitest's colour codes (ESC [ … m), built from the code point so the pattern holds no control character.
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripColour = (s) => s.replace(COLOUR, '');
const KIND_ORDER = ['packages', 'services', 'apps'];
const PG_ROLES = [
  ['PAY', 'svc_pay'],
  ['IDENTITY', 'svc_identity'],
  ['TOKEN', 'svc_token'],
  ['TRADE', 'svc_trade'],
  ['P2P', 'svc_p2p'],
  ['BANK', 'svc_bank'],
  ['BLUEPRINT', 'svc_blueprint'],
  ['AGENTS', 'svc_agents'],
  ['NOTIFY', 'svc_notify'],
  ['SUPPORT', 'svc_support'],
];

/** The changed code files, grouped by workspace package, packages first, then services, then apps. */
export function groupByPackage(files) {
  const groups = new Map();
  for (const f of files) {
    const m = /^((packages|services|apps)\/[^/]+)\/(.+)$/.exec(f);
    if (!m || !CODE.test(m[3])) continue;
    if (!groups.has(m[1])) groups.set(m[1], { dir: m[1], kind: m[2], files: [], tests: [] });
    const g = groups.get(m[1]);
    g.files.push(m[3]);
    if (TEST.test(m[3])) g.tests.push(m[3]);
  }
  return [...groups.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.dir.localeCompare(b.dir));
}

/** The failing tests vitest names in its output: `FAIL  <file> > <test>`, or `FAIL  <file> [ <file> ]` for a suite. */
export function failingTests(output) {
  const found = new Set();
  for (const line of stripColour(output).split('\n')) {
    const m = /(?:^|\s)FAIL\s+(\S+\.test\.\S+.*)$/.exec(line);
    if (m) found.add(m[1].replace(/\s+\[ .* \]$/, '').trim());
  }
  return [...found];
}

/** A node binary of `major`: this one, else a version manager's or Homebrew's. */
export function findNode(major, { current = process.versions.node, execPath = process.execPath, home = homedir() } = {}) {
  if (current.split('.')[0] === String(major)) return execPath;
  const fixed = [`/opt/homebrew/opt/node@${major}/bin/node`, `/usr/local/opt/node@${major}/bin/node`];
  for (const p of fixed) if (existsSync(p)) return p;
  const managed = [
    [join(home, '.nvm', 'versions', 'node'), (v) => join(v, 'bin', 'node')],
    [join(home, '.local', 'share', 'fnm', 'node-versions'), (v) => join(v, 'installation', 'bin', 'node')],
    [join(home, '.volta', 'tools', 'image', 'node'), (v) => join(v, 'bin', 'node')],
  ];
  for (const [dir, bin] of managed) {
    if (!existsSync(dir)) continue;
    const versions = readdirSync(dir)
      .filter((v) => v.replace(/^v/, '').split('.')[0] === String(major))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) if (existsSync(bin(join(dir, v)))) return bin(join(dir, v));
  }
  return null;
}

/** A folder holding initdb, pg_ctl and psql. */
export function findPgBin(env = process.env) {
  const has = (d) => d && ['initdb', 'pg_ctl', 'psql'].every((b) => existsSync(join(d, b)));
  if (env.PRE_PUSH_PG_BIN) return has(env.PRE_PUSH_PG_BIN) ? env.PRE_PUSH_PG_BIN : null;
  const cfg = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  if (cfg.status === 0 && has(cfg.stdout.trim())) return cfg.stdout.trim();
  for (const v of [16, 17, 18]) {
    for (const d of [`/opt/homebrew/opt/postgresql@${v}/bin`, `/usr/local/opt/postgresql@${v}/bin`, `/usr/lib/postgresql/${v}/bin`]) {
      if (has(d)) return d;
    }
  }
  return null;
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** Runs a command in its own process group until `deadline`; at the deadline the whole group is killed. */
function run(cmd, args, { cwd, env, deadline, input }) {
  return new Promise((resolve) => {
    const left = deadline - Date.now();
    if (left <= 0) return resolve({ code: null, out: '', timedOut: true });
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    if (input !== undefined) child.stdin.end(input);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, left);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, out: String(e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    });
  });
}

class Skip extends Error {}
class Limit extends Error {}

async function startPostgres({ root, pgBin, deadline, env }) {
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-pg-'));
  const data = join(dir, 'data');
  const pw = join(dir, 'pw');
  writeFileSync(pw, 'intafaced\n');
  const stop = () => {
    if (existsSync(join(data, 'postmaster.pid'))) {
      spawnSync(join(pgBin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', '-t', '20', 'stop'], { stdio: 'ignore' });
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const step = async (what, cmd, args, extra = {}) => {
      const r = await run(cmd, args, { cwd: root, env: extra.env ?? env, deadline });
      if (r.timedOut) throw new Limit(`starting Postgres (${what})`);
      if (r.code !== 0) throw new Skip(`Postgres did not start (${what}): ${r.out.trim().split('\n').slice(-2).join(' ')}`);
    };
    await step('initdb', join(pgBin, 'initdb'), [
      '-D',
      data,
      '-U',
      'intafaced',
      `--pwfile=${pw}`,
      '-A',
      'scram-sha-256',
      '-N',
      '-E',
      'UTF8',
      '--locale=C',
    ]);
    const port = await freePort();
    const opts = `-p ${port} -k '' -c listen_addresses=127.0.0.1 -c fsync=off -c timezone=UTC -c max_connections=300`;
    await step('pg_ctl start', join(pgBin, 'pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-t', '30', '-o', opts, 'start']);
    const pgEnv = { ...env, PGHOST: '127.0.0.1', PGPORT: String(port), PGPASSWORD: 'intafaced', PATH: `${pgBin}:${env.PATH}` };
    const psql = (db, ...a) =>
      step(`psql ${db}`, join(pgBin, 'psql'), ['-q', '-v', 'ON_ERROR_STOP=1', '-U', 'intafaced', '-d', db, ...a], { env: pgEnv });
    // The same setup as CI's test-infra (.github/actions/test-infra): the service schemas and roles, then the isolated
    // test database by the init script the local docker fleet runs too.
    await psql('postgres', '-c', 'CREATE DATABASE intafaced');
    await psql('intafaced', '-f', 'tooling/infra/postgres-init/01-service-schemas.sql');
    await psql('intafaced', '-c', 'GRANT CREATE ON DATABASE intafaced TO intafaced_ops; ALTER ROLE intafaced_ops WITH CREATEDB;');
    await step('02-intafaced-test-db.sh', 'bash', ['tooling/infra/postgres-init/02-intafaced-test-db.sh'], {
      env: { ...pgEnv, POSTGRES_USER: 'intafaced', POSTGRES_DB: 'intafaced' },
    });
    const url = (user, db = 'intafaced_test') => `postgres://${user}:${user}@127.0.0.1:${port}/${db}`;
    const dbEnv = { TEST_DATABASE_URL: url('intafaced'), TEST_DATABASE_URL_SUPPORT_ADMIN: url('intafaced', 'postgres') };
    for (const [k, role] of PG_ROLES) dbEnv[`TEST_DATABASE_URL_${k}`] = url(role);
    return { dbEnv, stop };
  } catch (e) {
    stop();
    throw e;
  }
}

function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export async function main({ root = process.cwd(), env = process.env, log = console.log, err = console.error } = {}) {
  const started = Date.now();
  const limitS = Number(env.PRE_PUSH_TESTS_SECONDS ?? 90);
  const deadline = started + limitS * 1000;
  const took = () => `${Math.round((Date.now() - started) / 1000)} s`;
  const skip = (why) => {
    log(`${NAME} — ${why}; skipped, CI's Tests job runs them`);
    return 0;
  };

  const base = git(root, 'merge-base', 'HEAD', 'origin/main');
  if (!base) return skip('no merge-base with origin/main');
  const changed = (git(root, 'diff', '--name-only', '--diff-filter=ACMR', base, 'HEAD') ?? '').split('\n').filter(Boolean);
  const groups = groupByPackage(changed).filter((g) => {
    const pj = join(root, g.dir, 'package.json');
    if (!existsSync(pj) || !existsSync(join(root, g.dir, 'node_modules', '.bin', 'vitest'))) return false;
    return /\bvitest\b/.test(JSON.parse(readFileSync(pj, 'utf8')).scripts?.test ?? '');
  });
  if (groups.length === 0) {
    log(`${NAME} — no package code with vitest tests in this push (or no install); skip`);
    return 0;
  }

  const major = existsSync(join(root, '.node-version')) ? readFileSync(join(root, '.node-version'), 'utf8').trim().split('.')[0] : null;
  const node = major ? findNode(major) : process.execPath;
  if (!node) return skip(`no Node ${major} here (CI's .node-version); under another Node some tests fail only on this machine`);
  const pgBin = findPgBin(env);
  if (!pgBin)
    return skip('no Postgres binaries here (initdb, pg_ctl, psql); without a database the Postgres suites fail only on this machine');

  const testEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([k]) => !k.startsWith('GIT_') && !['CI', 'NODE_TEST_CONTEXT', 'REQUIRE_POSTGRES'].includes(k) && !k.startsWith('TEST_DATABASE_URL'),
    ),
  );
  Object.assign(testEnv, {
    TZ: 'UTC',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TURBO_TELEMETRY_DISABLED: '1',
    PATH: `${dirname(node)}:${env.PATH}`,
  });

  const names = groups.map((g) => g.dir.split('/')[1]).join(', ');
  log(`${NAME} — ${names}: own changed tests first, then the tests importing the changed files (limit ${limitS} s)`);
  let pg = null;
  const onSignal = () => {
    pg?.stop();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    pg = await startPostgres({ root, pgBin, deadline, env: testEnv });
    Object.assign(testEnv, pg.dbEnv);

    // Each tested package's own build and its dependencies' (a test may import a dependency's dist), from the
    // turbo cache that every worktree on this machine shares. Apps are not built: their tests run from source.
    const turbo = join(root, 'node_modules', '.bin', 'turbo');
    if (existsSync(turbo)) {
      const filters = groups.map((g) => {
        const name = JSON.parse(readFileSync(join(root, g.dir, 'package.json'), 'utf8')).name;
        return `--filter=${name}${g.kind === 'apps' ? '^' : ''}...`;
      });
      const b = await run(turbo, ['run', 'build', ...filters, '--filter=!./apps/*', '--output-logs=errors-only'], {
        cwd: root,
        env: testEnv,
        deadline,
      });
      if (b.timedOut) throw new Limit('building');
      if (b.code !== 0)
        return skip(
          `the build of ${names} failed here (CI's Typecheck & build job reports it): ${b.out.trim().split('\n').slice(-3).join(' ')}`,
        );
    }

    const phases = [
      (g) => (g.tests.length ? ['run', '--bail=1', '--passWithNoTests', ...g.tests] : null),
      (g) =>
        g.files.length > g.tests.length
          ? ['related', '--run', '--bail=1', '--passWithNoTests', ...g.files, ...g.tests.flatMap((t) => ['--exclude', t])]
          : null,
    ];
    for (const phase of phases) {
      for (const g of groups) {
        const args = phase(g);
        if (!args) continue;
        const vitest = join(root, g.dir, 'node_modules', '.bin', 'vitest');
        const r = await run(vitest, args, { cwd: join(root, g.dir), env: testEnv, deadline });
        if (r.timedOut) throw new Limit(`${g.dir} (vitest ${args[0]})`);
        if (r.code === 0) continue;
        const failed = failingTests(r.out);
        if (failed.length === 0) {
          log(`${NAME} — vitest in ${g.dir} ended with code ${r.code} and named no failing test; not refused. Its last lines:`);
          log(r.out.trim().split('\n').slice(-15).join('\n'));
          continue;
        }
        const clean = stripColour(r.out);
        const firstFail = clean.indexOf('FAIL ');
        err(clean.slice(Math.max(0, firstFail), firstFail + 4000).trimEnd());
        err(`
  ✖ a unit test failed — push refused (${took()}, ${g.dir}):
${failed.map((t) => `      ${t}`).join('\n')}

    CI's Tests job runs the same test and would fail the same way. Its output is above. To run this step again
    (CI's Node, UTC and a throwaway Postgres): node tooling/scripts/related-tests-before-push.mjs
`);
        return 1;
      }
    }
    log(`${NAME} — passed in ${took()}`);
    return 0;
  } catch (e) {
    if (e instanceof Limit) {
      log(
        `${NAME} — time limit of ${limitS} s reached while ${e.message}; stopped, the push goes on: CI's Tests job runs what did not run here`,
      );
      return 0;
    }
    if (e instanceof Skip) return skip(e.message);
    return skip(`the step itself failed (${e?.message ?? e})`);
  } finally {
    pg?.stop();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}

export const SCRIPT = fileURLToPath(import.meta.url);
