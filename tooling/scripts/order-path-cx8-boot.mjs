#!/usr/bin/env node
/**
 * CX-8 CI boot helper — start ledger + matching + trade + identity against
 * CI postgres/nats, migrate, then run order-path-smoke STRICT.
 *
 * Env (set by workflow):
 *   DATABASE_URL_ROOT or per-service URLs
 *   NATS_URL, INTERNAL_SERVICE_SECRET, EDGE_PRINCIPAL_SECRET, JWT_ACCESS_SECRET
 *   CX8_SKIP_IDENTITY=1 — L1 only (not default)
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * D-44 smoke-rig integers. Product schemas refuse a blank value. Zod's
 * number coerce turns that missing value into NaN and the boot error is
 * "received nan". These are this harness's published values, not compose
 * defaults and not a product fallback.
 */
export const CX8_SMOKE_ENV = {
  DATABASE_POOL_MAX: '10',
  RECONCILE_CRON_MINUTES: '60',
  MATCHING_SNAPSHOT_EVERY: '500',
};

export function cx8RoleEnv(role) {
  if (role === 'matching') return { MATCHING_SNAPSHOT_EVERY: CX8_SMOKE_ENV.MATCHING_SNAPSHOT_EVERY };
  if (role === 'ledger') {
    return {
      DATABASE_POOL_MAX: CX8_SMOKE_ENV.DATABASE_POOL_MAX,
      RECONCILE_CRON_MINUTES: CX8_SMOKE_ENV.RECONCILE_CRON_MINUTES,
    };
  }
  if (role === 'identity' || role === 'trade') return { DATABASE_POOL_MAX: CX8_SMOKE_ENV.DATABASE_POOL_MAX };
  throw new Error(`no CX-8 smoke env for ${role}`);
}

const ROOT = process.cwd();
const SECRET = process.env.INTERNAL_SERVICE_SECRET ?? 'dev-only-cx8-internal-service-secret-xx';
const EDGE = process.env.EDGE_PRINCIPAL_SECRET ?? 'dev-only-cx8-edge-principal-secret-xxxx';
const JWT = process.env.JWT_ACCESS_SECRET ?? 'dev-only-cx8-jwt-access-secret-xxxxxxxx';
const NATS = process.env.NATS_URL ?? 'nats://127.0.0.1:4222';
const PG = process.env.CX8_POSTGRES ?? 'postgres://intafaced:intafaced@127.0.0.1:5432/intafaced_test';

// Owner-operation admission key shared by exactly two services: svc-trade reads it as
// IDENTITY_ADMISSION_SECRET and svc-identity as IDENTITY_TRADE_ADMISSION_SECRET. Identity
// refuses a key shorter than 32 chars or equal to any other secret it holds, so it is
// generated on its own. 36 random bytes = 48 chars. Fresh every run, never stored or logged.
// SMOKE RIG ONLY — not a production value; Nitro 2026-10-14
const ADMISSION_SECRET = randomBytes(36).toString('base64url');

// Key that seals TOTP secrets at rest; blank refuses enrolment. Generated fresh each run, never stored.
// It is held here, not inline, because identity boots twice (see enrolFoundersAndRestartIdentity) and the
// second boot must open the secrets the first boot sealed. SMOKE RIG ONLY — generated fresh each run
const TOTP_SECRET_KEY = randomBytes(32).toString('hex');

// Founder invites for the two smoke operators. Opening a market (`matching.open`) is a founder-only action
// at identity: proposer and approver must both be live founders (action-approval-audience.ts). The only
// way identity makes a founder is its own: enrol the account with a single-use invite
// (`auth.registerFounder`), give it a second factor, then pin the founder pair by user id at boot
// (IDENTITY_FOUNDER_NITRO_USER_ID / IDENTITY_FOUNDER_PHANTOM_USER_ID). Identity configures only the invites'
// sha256 hashes; the codes stay in this process. Same shape as founder-enrolment.ts (160 random bits as
// 32 base32 characters, hash over the canonical form). These two smoke accounts are NOT the real
// founders; the names Nitro and Phantom are identity's slot names for the pair.
// SMOKE RIG ONLY — generated fresh each run, never stored or logged
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function founderInviteCode() {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of randomBytes(20)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}
const FOUNDER_INVITE_CODES = [founderInviteCode(), founderInviteCode()];
const FOUNDER_INVITE_HASHES = FOUNDER_INVITE_CODES.map((c) => createHash('sha256').update(c, 'utf8').digest('hex'));
const FOUNDER_INVITE_EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString(); // SMOKE RIG ONLY — one hour

const children = [];

function log(msg) {
  console.log(`[cx8-boot] ${msg}`);
}

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} → ${code}`))));
  });
}

function start(name, cmd, args, env = {}) {
  log(`start ${name}`);
  const p = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  children.push({ name, p });
  p.on('exit', (code, signal) => {
    log(`${name} exited code=${code} signal=${signal}`);
  });
  return p;
}

async function waitHealth(url, label, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok || res.status < 500) {
        log(`healthy ${label}`);
        return;
      }
    } catch {
      /* retry */
    }
    await sleep(1000);
  }
  throw new Error(`timeout waiting for ${label} at ${url}`);
}

function killAll() {
  for (const { name, p } of children) {
    try {
      p.kill('SIGTERM');
    } catch {
      log(`kill ${name} failed`);
    }
  }
}

process.on('exit', killAll);
process.on('SIGINT', () => {
  killAll();
  process.exit(130);
});

const common = {
  APP_ENV: 'test',
  LOG_LEVEL: 'warn',
  NATS_URL: NATS,
  NATS_STREAM_PREFIX: 'CX8',
  INTERNAL_SERVICE_SECRET: SECRET,
  EDGE_PRINCIPAL_SECRET: EDGE,
  JWT_ACCESS_SECRET: JWT,
  JWT_ISSUER: 'intafaced-cx8',
  JWT_AUDIENCE: 'intafaced',
  INTERNAL_SERVICE_BODY_BIND: 'accept-both',
};

const ledgerUrl = process.env.TEST_DATABASE_URL ?? process.env.LEDGER_DATABASE_URL ?? PG;
const tradeUrl = process.env.TEST_DATABASE_URL_TRADE ?? process.env.TRADE_DATABASE_URL ?? PG;
const identityUrl = process.env.TEST_DATABASE_URL_IDENTITY ?? process.env.IDENTITY_DATABASE_URL ?? PG;
const payUrl = process.env.TEST_DATABASE_URL_PAY ?? process.env.PAY_DATABASE_URL ?? PG;

/**
 * Identity, as the rig boots it. `founderPair` is null on the first boot (no founders exist yet, enrolment
 * is open) and the two enrolled user ids on the second (pair pinned, enrolment closed).
 */
function startIdentity(founderPair = null) {
  start('identity', 'node', ['services/svc-identity/dist/index.js'], {
    ...common,
    ...cx8RoleEnv('identity'),
    SERVICE_NAME: 'svc-identity',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: '4002',
    DATABASE_URL: identityUrl,
    // Action approval (opening a market takes a proposer and a different, MFA-verified approver).
    // Blank lifetime refuses every propose (action_approval.ttl_unset).
    IDENTITY_TRADE_ADMISSION_SECRET: ADMISSION_SECRET,
    IDENTITY_ACTION_APPROVAL_TTL_SECONDS: '600', // SMOKE RIG ONLY — not a production value; Nitro 2026-10-14
    IDENTITY_TOTP_SECRET_KEY: TOTP_SECRET_KEY,
    ...(founderPair
      ? {
          IDENTITY_FOUNDER_NITRO_USER_ID: founderPair[0], // SMOKE RIG ONLY — a throwaway smoke account, not a real founder
          IDENTITY_FOUNDER_PHANTOM_USER_ID: founderPair[1], // SMOKE RIG ONLY — a throwaway smoke account, not a real founder
        }
      : {
          IDENTITY_FOUNDER_INVITE_HASHES: FOUNDER_INVITE_HASHES.join(','),
          IDENTITY_FOUNDER_INVITE_EXPIRES_AT: FOUNDER_INVITE_EXPIRES_AT,
        }),
    // Operator desk scope for the two smoke founders' MFA sessions, so the customer journeys can review a KYC request
    // through identity's own two-person path. SMOKE RIG ONLY — a throwaway founder pair, fresh each run
    IDENTITY_FOUNDER_SESSION_SCOPES: 'admin:compliance',
    REGISTRATION_OPEN: 'true',
    WEBAUTHN_ENABLED: 'false',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_RP_NAME: 'cx8',
    WEBAUTHN_ORIGIN: 'http://localhost',
  });
}

/**
 * Enrol the two smoke founders, then boot identity again with the pair pinned. The smoke script does the
 * enrolment (it owns the identity client and TOTP code); it prints one result line, which is read here and
 * never echoed. The result holds the throwaway accounts' passwords and TOTP secrets, so it travels only in
 * this process and in the smoke's environment.
 */
async function enrolFoundersAndRestartIdentity() {
  const out = await new Promise((resolve, reject) => {
    const p = spawn('node', ['services/svc-trade/scripts/order-path-smoke.mjs', '--enrol-founders'], {
      cwd: ROOT,
      env: {
        ...process.env,
        IDENTITY_HTTP_URL: 'http://127.0.0.1:4002',
        EDGE_PRINCIPAL_SECRET: EDGE,
        JWT_ACCESS_SECRET: JWT,
        JWT_ISSUER: common.JWT_ISSUER,
        JWT_AUDIENCE: common.JWT_AUDIENCE,
        TRADE_SMOKE_REGION: process.env.TRADE_SMOKE_REGION ?? 'DE',
        CX8_FOUNDER_INVITES: FOUNDER_INVITE_CODES.join(','),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.on('exit', (code) => (code === 0 ? resolve(buf) : reject(new Error(`founder enrolment exited ${code}`))));
  });
  const line = out.split('\n').find((l) => l.startsWith('CX8_FOUNDERS_JSON='));
  if (!line) throw new Error('founder enrolment printed no result');
  const founders = JSON.parse(line.slice('CX8_FOUNDERS_JSON='.length));

  const identity = children.find((c) => c.name === 'identity');
  await new Promise((resolve) => {
    if (identity.p.exitCode !== null || identity.p.signalCode !== null) return resolve();
    identity.p.once('exit', resolve);
    identity.p.kill('SIGTERM');
  });
  children.splice(children.indexOf(identity), 1);
  startIdentity(founders.map((f) => f.userId));
  await waitHealth('http://127.0.0.1:4002', 'identity (founder pair pinned)');
  return founders;
}

async function main() {
  log(`PG=${PG} NATS=${NATS}`);

  await run('pnpm', ['--filter', '@intafaced/svc-ledger', 'db:migrate'], {
    DATABASE_URL: ledgerUrl,
    ...common,
  });
  await run('pnpm', ['--filter', '@intafaced/svc-trade', 'db:migrate'], {
    DATABASE_URL: tradeUrl,
    ...common,
  });
  await run('pnpm', ['--filter', '@intafaced/svc-identity', 'db:migrate'], {
    DATABASE_URL: identityUrl,
    ...common,
  });

  await run('pnpm', ['--filter', '@intafaced/svc-pay', 'db:migrate'], {
    DATABASE_URL: payUrl,
    ...common,
  });

  // Resolve `nats` from workspace package deps (not hoisted to monorepo root).
  await run('pnpm', ['--filter', '@intafaced/events', 'run', 'cx8-streams'], { ...common, NATS_URL: NATS });

  mkdirSync(join(ROOT, '.data/matching'), { recursive: true });

  writeFileSync(join(ROOT, '.data/matching/engine_journal.ndjson'), '');

  start('ledger', 'node', ['services/svc-ledger/dist/index.js'], {
    ...common,
    ...cx8RoleEnv('ledger'),
    SERVICE_NAME: 'svc-ledger',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: '4001',
    DATABASE_URL: ledgerUrl,
    LEDGER_POSTING_ENABLED: 'true',
  });

  startIdentity();

  // Payments core, for the customer withdrawal journeys. No payout rail is configured: no chain RPC, no hot wallet,
  // no sandbox rails, so a withdrawal must refuse with a named reason before anything is held.
  start('pay', 'node', ['services/svc-pay/dist/index.js'], {
    ...common,
    SERVICE_NAME: 'svc-pay',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: '4006',
    DATABASE_URL: payUrl,
    LEDGER_URL: 'http://127.0.0.1:4001',
    IDENTITY_URL: 'http://127.0.0.1:4002',
    DATABASE_POOL_MAX: '5',
    // SMOKE RIG ONLY — throwaway secrets and owner integers, fresh each run; not production values
    PAY_CRYPTO_WEBHOOK_SECRET: randomBytes(24).toString('base64url'),
    PAY_CARD_SANDBOX_WEBHOOK_SECRET: randomBytes(24).toString('base64url'),
    PAY_MIN_CONFIRMATIONS: '6',
    PAY_WEBHOOK_TOLERANCE_SECONDS: '300',
    PAY_CHECKOUT_SESSION_TTL_SECONDS: '900',
    PAY_CHECKOUT_MAX_OPEN_SESSIONS: '10',
    PAY_LINK_DEFAULT_TTL_DAYS: '7',
    PAY_LINK_MAX_TTL_DAYS: '30',
    PAY_OPERATOR_CREDIT_RAILS: 'crypto-native',
    PAY_CRYPTO_WATCHER_ENABLED: 'false',
  });

  await waitHealth('http://127.0.0.1:4001', 'ledger');
  await waitHealth('http://127.0.0.1:4002', 'identity');
  await waitHealth('http://127.0.0.1:4006', 'pay');

  // Opening a market is founder-only at identity: make the two smoke operators founders first.
  const founders = await enrolFoundersAndRestartIdentity();

  // Matching boots only now, after the founders exist: it refuses to boot without at least two distinct
  // operator ids (MATCHING_OPERATOR_IDS, #4724), and the only ids this rig has are the two smoke founders
  // enrolled above. Nothing before this point talks to matching (the enrolment is identity-only), and the
  // journal is empty, so there is nothing to restart. The smoke opens the market with operatorId = the
  // requester and confirmOperatorId = the approver, both in this list.
  start('matching', 'node', ['services/svc-matching/dist/index.js'], {
    ...common,
    ...cx8RoleEnv('matching'),
    SERVICE_NAME: 'svc-matching',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: '4005',
    MATCHING_JOURNAL_PATH: join(ROOT, '.data/matching/engine_journal.ndjson'),
    // SMOKE RIG ONLY — the two throwaway smoke founders' user ids, fresh each run; not real operators
    MATCHING_OPERATOR_IDS: founders.map((f) => f.userId).join(','),
    // Matching consumes the two-person approval that opens a market at identity.
    IDENTITY_URL: 'http://127.0.0.1:4002',
  });
  await waitHealth('http://127.0.0.1:4005', 'matching');

  start('trade', 'node', ['services/svc-trade/dist/index.js'], {
    ...common,
    ...cx8RoleEnv('trade'),
    SERVICE_NAME: 'svc-trade',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: '4004',
    DATABASE_URL: tradeUrl,
    LEDGER_URL: 'http://127.0.0.1:4001',
    MATCHING_URL: 'http://127.0.0.1:4005',
    IDENTITY_URL: 'http://127.0.0.1:4002',
    IDENTITY_ADMISSION_SECRET: ADMISSION_SECRET,
    TRADE_SPOT_ENABLED: 'true',
    // The smoke supplies no sanctions screening list (INTAFACED_SANCTIONS_REGIONS
    // is counsel's to publish; this rig must not invent one). With the switch
    // unset, POST /api/v1/orders is refused 403 denied.screening_unconfigured.
    // 'off' is the explicit local-test stand-in that every service's vitest
    // config uses; it is honoured only while APP_ENV is dev/test, which `common`
    // sets. Outside dev/test svc-trade refuses to BOOT with this fixture
    // (assertNoLocalTestFixtures, services/svc-trade/src/index.ts), and the
    // screening reader ignores 'off' there, so screening stays fail-closed.
    INTAFACED_SCREENING_FAIL_CLOSED: 'off', // SMOKE RIG ONLY — local-test fixture value, same as every service's vitest config; refused outside dev/test
    // SMOKE RIG owner integers. Compose ships empty; blank refuses convert quote
    // and market-buy hold. These are the fixture's published values, not product
    // defaults — never restore compose invented spread/cap.
    TRADE_CONVERT_SPREAD_BPS: '25',
    TRADE_MARKET_SLIPPAGE_CAP_BPS: '150',
    // Fee schedule (PTX-M21). Place and fill refuse while it is unpublished, and
    // blank is not zero. This is a published schedule whose maker and taker fees
    // are both 0 bps, in the exact JSON shape parseFeeScheduleJson reads
    // (services/svc-trade/src/spot/fee-schedule.ts; bps are decimal STRINGS, the
    // same shape the #3699 tests use). The smoke checks the order path, not fee
    // revenue, so it posts no fee.
    TRADE_FEE_SCHEDULE: JSON.stringify({ published: true, version: 'cx8-smoke-zero-fee', makerBps: '0', takerBps: '0' }), // SMOKE RIG ONLY — not a production value; Nitro 2026-10-13
    // Pre-trade limits (services/svc-trade/src/futures/pretrade-limits.ts). Each is an
    // owner integer: a plain base-10 integer string, parsed by parseOwnerIntegerEnv
    // (owner-int-env.ts); blank or non-integer refuses every place with
    // trade.max_{order,position,loss}_unset. They are ENFORCED, not just checked to be
    // set: the unit is whole units of the market's quote asset (USDT here). MAX_ORDER
    // caps one order's notional (price x qty), spot and futures; MAX_POSITION and
    // MAX_LOSS gate futures opens only. At 1,000,000 this smoke's 10 USDT orders sit
    // far below every cap, so no limit refusal is expected; a refusal here means a
    // real regression.
    TRADE_MAX_ORDER: '1000000', // SMOKE RIG ONLY — not a production value; Nitro 2026-10-13
    TRADE_MAX_POSITION: '1000000', // SMOKE RIG ONLY — not a production value; Nitro 2026-10-13
    TRADE_MAX_LOSS: '1000000', // SMOKE RIG ONLY — not a production value; Nitro 2026-10-13
    // NOT a boot requirement any more. svc-trade boots with this blank and logs
    // "FUTURES IS DISABLED" (optionalProfitSourceFromConfig in
    // services/svc-trade/src/index.ts): futures opens are refused until an account
    // is named. The spot smoke never touches futures. It is kept so the rig's
    // futures path stays enabled as it was; recipes.futuresRealizeProfit draws
    // from this one account, so profitSourceFromConfig refuses any other value.
    TRADE_FUTURES_PROFIT_SOURCE: 'house:fees:trade:available', // pre-existing smoke value (#883)
  });

  await waitHealth('http://127.0.0.1:4004', 'trade');

  await run('pnpm', ['--filter', '@intafaced/svc-trade', 'run', 'order-path-smoke'], {
    TRADE_HTTP_URL: 'http://127.0.0.1:4004',
    MATCHING_HTTP_URL: 'http://127.0.0.1:4005',
    LEDGER_HTTP_URL: 'http://127.0.0.1:4001',
    // The smoke opens the market through identity and matching, and reads the
    // founders' MFA sessions as the edge would, so it needs identity's URL and the
    // token settings.
    IDENTITY_HTTP_URL: 'http://127.0.0.1:4002',
    JWT_ACCESS_SECRET: JWT,
    JWT_ISSUER: common.JWT_ISSUER,
    JWT_AUDIENCE: common.JWT_AUDIENCE,
    ORDER_PATH_SMOKE_STRICT: '1',
    // The two enrolled smoke founders (ids, passwords, TOTP secrets). SMOKE RIG ONLY — throwaway accounts, fresh each run
    CX8_FOUNDERS_JSON: JSON.stringify(founders),
    EDGE_PRINCIPAL_SECRET: EDGE,
    INTERNAL_SERVICE_SECRET: SECRET,
    TRADE_SMOKE_SEED_SQL: '1',
    TRADE_DATABASE_URL: tradeUrl,
    TRADE_SMOKE_SYMBOL: 'BTC/USDT',
    TRADE_SMOKE_QTY: '0.1',
    TRADE_SMOKE_PRICE: '100',
    TRADE_SMOKE_REGION: 'DE',
    TRADE_SMOKE_L3: '1',
    TRADE_SMOKE_STRESS_N: '3',
    // Settle + ledger post lag under JetStream; STRICT fails closed if still empty.
    TRADE_SMOKE_FILL_WAIT_MS: '25000',
  });

  // Optional second phase on the same stack: CX8_AFTER is a JSON array, the command to run once the smoke has passed
  // (`pnpm journeys:trade` sets it to the customer journeys). The stack is still up, the market is open, and the
  // service addresses and secrets are passed in the same names the smoke reads.
  if (process.env.CX8_AFTER) {
    const [cmd, ...args] = JSON.parse(process.env.CX8_AFTER);
    await run(cmd, args, {
      TRADE_HTTP_URL: 'http://127.0.0.1:4004',
      MATCHING_HTTP_URL: 'http://127.0.0.1:4005',
      LEDGER_HTTP_URL: 'http://127.0.0.1:4001',
      IDENTITY_HTTP_URL: 'http://127.0.0.1:4002',
      PAY_HTTP_URL: 'http://127.0.0.1:4006',
      CX8_FOUNDERS_JSON: JSON.stringify(founders),
      EDGE_PRINCIPAL_SECRET: EDGE,
      INTERNAL_SERVICE_SECRET: SECRET,
      TRADE_SMOKE_SYMBOL: 'BTC/USDT',
      TRADE_SMOKE_REGION: process.env.TRADE_SMOKE_REGION ?? 'DE',
    });
  }

  log('CX-8 boot + smoke complete');
  killAll();
  process.exit(0);
}

function isDirectRun() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error('[cx8-boot] fatal', err);
    killAll();
    process.exit(1);
  });
}
