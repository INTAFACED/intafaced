/**
 * The Rust binary for the conformance runs: a fresh database migrated by the binary's own `migrate`, and the binary
 * serving it over HTTP three times: with no service keys (shared-secret callers only), with a keyring every ledger
 * caller signs with (`S2S_AUTH_MODE=dual`), and in detect mode. All three serve one book, as replicas would.
 */
import { generateKeyPairSync } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { serviceCallSigner } from '../../../../packages/contracts/src/service-auth-http.ts';
import { createServiceSigner, parseKeyring } from '../../../../packages/contracts/src/service-keys.ts';
import { LEDGER_CALLER_SERVICES } from '../../../../services/svc-ledger/src/caller-allowlist.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const BINARY = `${ROOT}target/debug/svc-ledger`;
export const SECRET = 'placeholder-conformance-internal-secret-long';

function env(k: string): string {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} is required (see posting.conformance.ts)`);
  return v;
}

// One key per ledger caller, made for this run; never written anywhere.
const pairs = new Map(
  LEDGER_CALLER_SERVICES.map((svc) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return [
      svc as string,
      {
        kid: `${svc}.conf`,
        privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
        x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
      },
    ];
  }),
);
const KEYRING = JSON.stringify({ keys: [...pairs].map(([svc, p]) => ({ kid: p.kid, svc, use: 's2s', x: p.x })) });

/** Headers for a post from `service`: signed with its key, or under the shared secret claiming its name. */
export function signerFor(service: string, keyed: boolean) {
  const pair = keyed ? pairs.get(service) : undefined;
  if (keyed && !pair) throw new Error(`no conformance key for ${service}`);
  return serviceCallSigner({
    service: service as never,
    audience: 'svc-ledger',
    legacySecret: SECRET,
    ...(pair
      ? {
          s2s: {
            mode: 'dual',
            signer: createServiceSigner({
              service: service as never,
              kid: pair.kid,
              privateKey: pair.privateKey,
              keyring: parseKeyring(KEYRING),
            }),
          },
        }
      : {}),
  } as never);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      s.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

let started = 0;

type Serving = { keyed?: boolean; detect?: boolean };

/** The binary serving `url`; `keyed` adds the keyring, `detect` answers a reused key in detect mode. */
async function serve(url: string, { keyed = false, detect = false }: Serving) {
  const port = await freePort();
  const child: ChildProcess = spawn(BINARY, [], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      DATABASE_URL: url,
      DATABASE_POOL_MAX: '10',
      NATS_URL: env('NATS_URL'),
      // One prefix for every door of the run: they are replicas of one service, and a second set of streams over the
      // same subjects is refused by the bus.
      NATS_STREAM_PREFIX: 'conformance',
      INTERNAL_SERVICE_SECRET: SECRET,
      JWT_ACCESS_SECRET: 'placeholder-conformance-access-secret-long-x',
      SERVICE_NAME: 'svc-ledger',
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: String(port),
      LEDGER_CUSTODY_LAYER: 'on',
      LEDGER_IDEMPOTENCY_CONFLICT_MODE: detect ? 'detect' : 'refuse',
      RECONCILE_CRON_MINUTES: '5',
      // Its log is read below: the ready line, and the detect door's mismatch reports.
      LOG_LEVEL: 'info',
      ...(keyed ? { S2S_AUTH_MODE: 'dual', S2S_KEYRING: KEYRING } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // A test file that dies before its teardown must not leave a binary serving.
  const orphaned = () => child.kill('SIGKILL');
  process.once('exit', orphaned);
  child.once('exit', () => process.off('exit', orphaned));
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr += String(d)));
  // The log is one JSON object a line on stdout: the server's ready line, and the detect door's mismatch reports.
  const mismatches: Array<Record<string, unknown>> = [];
  let partial = '';
  let ready: () => void = () => undefined;
  const up = new Promise<void>((resolve, reject) => {
    ready = resolve;
    child.once('exit', (code) => reject(new Error(`svc-ledger exited ${code}: ${stderr}`)));
  });
  child.stdout?.on('data', (d) => {
    const lines = (partial + String(d)).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        if (o.event === 'ledger.idempotency_mismatch') mismatches.push(o);
        if (o.msg === 'svc-ledger ready') ready();
      } catch {}
    }
  });
  const base = `http://127.0.0.1:${port}`;
  // Logged once the server is listening.
  await up;
  if (!(await fetch(`${base}/health`)).ok) throw new Error(`svc-ledger is up but not healthy: ${stderr}`);
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((res) => (child.exitCode !== null ? res(null) : child.once('exit', res)));
  };
  return { base, stop, mismatches };
}

export interface RustBook {
  readonly url: string;
  /** The book, read and written as the TypeScript does (`search_path` `ledger,public`). */
  readonly sql: postgres.Sql;
  /** Shared-secret callers only: no keys configured. */
  readonly plain: string;
  /** Every ledger caller's key in its keyring. */
  readonly keyed: string;
  /** No keys, and a reused key answered in detect mode. */
  readonly detect: string;
  /** The detect door's `ledger.idempotency_mismatch` reports so far, as it logged them. */
  readonly mismatches: ReadonlyArray<Record<string, unknown>>;
  teardown(): Promise<void>;
}

/** A fresh database the binary migrated, served by the binary twice (`plain`, `keyed`). */
export async function openRustBook(admin = env('TEST_DATABASE_URL')): Promise<RustBook> {
  const name = `itf_conf_ledger_${process.pid}_${++started}_test`;
  const root = postgres(admin, { max: 1, onnotice: () => undefined });
  await root.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  await root.unsafe(`CREATE DATABASE "${name}"`);
  const u = new URL(admin);
  u.pathname = `/${name}`;
  const url = u.toString();
  const boot = postgres(url, { max: 1, onnotice: () => undefined });
  await boot.unsafe(
    'CREATE EXTENSION IF NOT EXISTS "pgcrypto"; CREATE EXTENSION IF NOT EXISTS "citext"; CREATE SCHEMA IF NOT EXISTS "ledger"',
  );
  await boot.end();
  const migrated = spawnSync(BINARY, ['migrate'], { env: { PATH: process.env.PATH, DATABASE_URL: url }, encoding: 'utf8' });
  if (migrated.status !== 0) throw new Error(`svc-ledger migrate failed: ${migrated.stderr}${migrated.stdout}`);
  const [plain, keyed, detect] = [await serve(url, {}), await serve(url, { keyed: true }), await serve(url, { detect: true })];
  const sql = postgres(url, { max: 4, connection: { search_path: 'ledger,public' }, onnotice: () => undefined });
  return {
    url,
    sql,
    plain: plain.base,
    keyed: keyed.base,
    detect: detect.base,
    mismatches: detect.mismatches,
    async teardown() {
      await Promise.all([plain.stop(), keyed.stop(), detect.stop()]);
      await sql.end({ timeout: 5 });
      await root.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await root.end({ timeout: 5 });
    },
  };
}
