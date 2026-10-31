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
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { profileEnvFor } from './owner-settings.mjs';

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
const SIGNIN_CHALLENGE_KEY = randomBytes(32).toString('hex');

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

// New custodial orders need a proved email (RC-identity-01, #5878). Identity writes its LOCAL-TEST confirm links to this
// file, and the smoke and the journeys prove their traders' addresses the way a person does: ask, then open the link.
// SMOKE RIG ONLY — a throwaway file per run; local-outbox is refused at boot unless APP_ENV is dev or test.
const MAIL_OUTBOX = join(tmpdir(), `cx8-email-outbox-${process.pid}.log`);

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
// The payments core boots only for the customer journeys (the CX8_AFTER phase), which need it for withdrawals. The plain
// CX-8 smoke does not use it, so the CX-8 workflow need not build it.
const WITH_PAY = Boolean(process.env.CX8_AFTER);
const payUrl = process.env.TEST_DATABASE_URL_PAY ?? process.env.PAY_DATABASE_URL ?? PG;
// The bank boots with the pay core, for the same journeys phase: the wallet view reads its balance breakdown.
const bankUrl = process.env.TEST_DATABASE_URL_BANK ?? process.env.BANK_DATABASE_URL ?? PG;

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
    // Email confirmation for the traders (see MAIL_OUTBOX). SMOKE RIG ONLY — not owner decisions: a link lives 10
    // minutes, five asks an hour.
    IDENTITY_MAIL_TRANSPORT: 'local-outbox',
    IDENTITY_LOCAL_MAIL_OUTBOX: MAIL_OUTBOX,
    IDENTITY_EMAIL_CONFIRM_TTL_SECONDS: '600',
    IDENTITY_EMAIL_CONFIRM_RATE_MAX: '5',
    IDENTITY_EMAIL_CONFIRM_RATE_WINDOW_SECONDS: '3600',
    REGISTRATION_OPEN: 'true',
    // Sign-in challenge (I-signin-sessions-30). SMOKE RIG ONLY — not owner decisions: a high failure count so the smoke's
    // own sign-ins never need one, a light difficulty, a two-minute token and a key fresh each run.
    IDENTITY_SIGNIN_CHALLENGE_AFTER_FAILURES: '500',
    IDENTITY_SIGNIN_CHALLENGE_BITS: '12',
    IDENTITY_SIGNIN_CHALLENGE_TTL_SECONDS: '120',
    IDENTITY_SIGNIN_CHALLENGE_KEY: SIGNIN_CHALLENGE_KEY,
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
        CX8_MAIL_OUTBOX: MAIL_OUTBOX,
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

  if (WITH_PAY) {
    await run('pnpm', ['--filter', '@intafaced/svc-pay', 'db:migrate'], {
      DATABASE_URL: payUrl,
      ...common,
    });
    await run('pnpm', ['--filter', '@intafaced/svc-bank', 'db:migrate'], {
      DATABASE_URL: bankUrl,
      ...common,
    });
  }

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
  // no payout sandbox, so a withdrawal must refuse with a named reason before anything is held.
  if (WITH_PAY)
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
      // The TEST bank the profile's PAY_CHECKOUT_RAILS names registers only with its webhook secret; without it svc-pay refuses boot.
      PAY_BANK_TRANSFER_SANDBOX_WEBHOOK_SECRET: randomBytes(24).toString('base64url'),
      // Owner integers and rails: the labelled TEST profile (tooling/profiles/test-owner-values/<service>.json)
      ...profileEnvFor('pay', common.APP_ENV),
      PAY_CRYPTO_WATCHER_ENABLED: 'false',
      // The same local-test stand-in the trade service gets below (Nino, 2026-10-19: yes to the sanctions switch for svc-pay). Counsel's list is not ours
      // to invent. Honoured only while APP_ENV is dev/test; svc-pay refuses to BOOT with this fixture elsewhere (assertNoLocalTestFixtures).
      INTAFACED_SCREENING_FAIL_CLOSED: 'off', // SMOKE RIG ONLY — local-test fixture value; refused outside dev/test
    });

  // Bank, for the wallet-view journeys: balances read from the ledger, no rail, no card programme, no price feed. Every owner-set
  // figure below is a throwaway for this rig, not a product value.
  if (WITH_PAY)
    start('bank', 'node', ['services/svc-bank/dist/index.js'], {
      ...common,
      SERVICE_NAME: 'svc-bank',
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: '4009',
      DATABASE_URL: bankUrl,
      LEDGER_URL: 'http://127.0.0.1:4001',
      IDENTITY_URL: 'http://127.0.0.1:4002',
      TRADE_URL: 'http://127.0.0.1:4004',
      DATABASE_POOL_MAX: '5',
      // SMOKE RIG ONLY — owner integers and ids that boot refuses without; not production values
      ...profileEnvFor('bank', common.APP_ENV),
      INTAFACED_SCREENING_FAIL_CLOSED: 'off', // SMOKE RIG ONLY — local-test fixture value; refused outside dev/test
    });

  // Tax, for the profit and loss journey: it reads the caller's fills from the ledger (no database of its own). The jurisdiction map,
  // history window and data lake stay unset; the lot book needs none of them.
  if (WITH_PAY)
    start('tax', 'node', ['services/svc-tax/dist/index.js'], {
      ...common,
      SERVICE_NAME: 'svc-tax',
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: '4020',
      LEDGER_URL: 'http://127.0.0.1:4001',
      INTAFACED_SCREENING_FAIL_CLOSED: 'off', // SMOKE RIG ONLY — local-test fixture value; refused outside dev/test
    });

  await waitHealth('http://127.0.0.1:4001', 'ledger');
  await waitHealth('http://127.0.0.1:4002', 'identity');
  if (WITH_PAY) await waitHealth('http://127.0.0.1:4006', 'pay');
  if (WITH_PAY) await waitHealth('http://127.0.0.1:4009', 'bank');
  if (WITH_PAY) await waitHealth('http://127.0.0.1:4020', 'tax');

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
    // Owner values (convert spread, slippage cap, dead-man timeouts, fee schedule, pre-trade caps): the labelled TEST profile,
    // tooling/profiles/test-owner-values/<service>.json, listed by `node tooling/scripts/owner-settings.mjs`. Blank in compose; never a product default.
    ...profileEnvFor('trade', common.APP_ENV),
    // NOT a boot requirement any more. svc-trade boots with this blank and logs
    // "FUTURES IS DISABLED" (optionalProfitSourceFromConfig in
    // services/svc-trade/src/index.ts): futures opens are refused until an account
    // is named. The spot smoke never touches futures. It is kept so the rig's
    // futures path stays enabled as it was; recipes.futuresRealizeProfit draws
    // from this one account, so profitSourceFromConfig refuses any other value.
    TRADE_FUTURES_PROFIT_SOURCE: 'house:futures-loss:available', // clearing pot (docs/adr/2026-10-20-futures-matched-traders.md)
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
    CX8_MAIL_OUTBOX: MAIL_OUTBOX,
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
      CX8_MAIL_OUTBOX: MAIL_OUTBOX,
      ...(WITH_PAY
        ? { PAY_HTTP_URL: 'http://127.0.0.1:4006', BANK_HTTP_URL: 'http://127.0.0.1:4009', TAX_HTTP_URL: 'http://127.0.0.1:4020' }
        : {}),
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
