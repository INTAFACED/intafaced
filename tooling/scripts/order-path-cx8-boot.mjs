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
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

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

const children = [];

// Handover for the market-open operators (credentials + the approver's per-run TOTP secret): a mode-700
// directory holding a mode-600 file, removed at exit. Never logged, never kept beyond the run.
let operatorsDir = null;
function removeOperatorsFile() {
  if (operatorsDir) rmSync(operatorsDir, { recursive: true, force: true });
  operatorsDir = null;
}

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
  removeOperatorsFile();
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
process.on('SIGTERM', () => {
  killAll();
  process.exit(143);
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

async function main() {
  log(`PG=${PG} NATS=${NATS}`);

  const ledgerUrl = process.env.TEST_DATABASE_URL ?? process.env.LEDGER_DATABASE_URL ?? PG;
  const tradeUrl = process.env.TEST_DATABASE_URL_TRADE ?? process.env.TRADE_DATABASE_URL ?? PG;
  const identityUrl = process.env.TEST_DATABASE_URL_IDENTITY ?? process.env.IDENTITY_DATABASE_URL ?? PG;

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

  // Resolve `nats` from workspace package deps (not hoisted to monorepo root).
  await run('pnpm', ['--filter', '@intafaced/events', 'run', 'cx8-streams'], { ...common, NATS_URL: NATS });

  mkdirSync(join(ROOT, '.data/matching'), { recursive: true });

  writeFileSync(join(ROOT, '.data/matching/engine_journal.ndjson'), '');

  start('ledger', 'node', ['services/svc-ledger/dist/index.js'], {
    ...common,
    SERVICE_NAME: 'svc-ledger',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: '4001',
    DATABASE_URL: ledgerUrl,
    LEDGER_POSTING_ENABLED: 'true',
    // Owner-published integers with no default: blank refuses boot (schemas in
    // packages/config/src/env.ts and services/svc-ledger/src/env.ts).
    DATABASE_POOL_MAX: '10', // SMOKE RIG ONLY — not a production value; Nitro 2026-10-13
    RECONCILE_CRON_MINUTES: '60', // SMOKE RIG ONLY — not a production value; Nitro 2026-10-13
  });

  start('identity', 'node', ['services/svc-identity/dist/index.js'], {
    ...common,
    SERVICE_NAME: 'svc-identity',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: '4002',
    DATABASE_URL: identityUrl,
    DATABASE_POOL_MAX: '10', // SMOKE RIG ONLY — not a production value; Nitro 2026-10-13
    // Action approval (opening a market takes a proposer and a different, MFA-verified approver).
    // Blank lifetime refuses every propose (action_approval.ttl_unset).
    IDENTITY_TRADE_ADMISSION_SECRET: ADMISSION_SECRET,
    IDENTITY_ACTION_APPROVAL_TTL_SECONDS: '600', // SMOKE RIG ONLY — not a production value; Nitro 2026-10-14
    // Key that seals TOTP secrets at rest; blank refuses enrolment. Generated fresh each run, never stored.
    IDENTITY_TOTP_SECRET_KEY: randomBytes(32).toString('hex'), // SMOKE RIG ONLY — generated fresh each run, never stored
    REGISTRATION_OPEN: 'true',
    WEBAUTHN_ENABLED: 'false',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_RP_NAME: 'cx8',
    WEBAUTHN_ORIGIN: 'http://localhost',
  });

  await waitHealth('http://127.0.0.1:4001', 'ledger');
  await waitHealth('http://127.0.0.1:4002', 'identity');

  // Matching starts only now: it reads its operator list once at boot, so the two market-open
  // operators must already exist at identity. The smoke registers them (and enrols the approver's
  // TOTP) in its prepare mode and writes them to a mode-600 file, which this boot deletes at exit.
  operatorsDir = mkdtempSync(join(tmpdir(), 'cx8-operators-'));
  const operatorsFile = join(operatorsDir, 'operators.json');
  await run('pnpm', ['--filter', '@intafaced/svc-trade', 'run', 'order-path-smoke'], {
    CX8_PREPARE_OPERATORS_FILE: operatorsFile,
    IDENTITY_HTTP_URL: 'http://127.0.0.1:4002',
    EDGE_PRINCIPAL_SECRET: EDGE,
    JWT_ACCESS_SECRET: JWT,
    JWT_ISSUER: common.JWT_ISSUER,
    JWT_AUDIENCE: common.JWT_AUDIENCE,
  });
  const operators = JSON.parse(readFileSync(operatorsFile, 'utf8'));
  const operatorIds = [operators.requester?.userId, operators.approver?.userId];
  if (operatorIds.some((id) => typeof id !== 'string' || id.trim() === '' || id.includes(','))) {
    throw new Error('operator preparation did not yield two usable identity user ids');
  }
  log('market-open operators registered at identity');

  // Matching (no DB)
  start('matching', 'node', ['services/svc-matching/dist/index.js'], {
    ...common,
    SERVICE_NAME: 'svc-matching',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: '4005',
    MATCHING_JOURNAL_PATH: join(ROOT, '.data/matching/engine_journal.ndjson'),
    // Matching consumes the two-person approval that opens a market at identity.
    IDENTITY_URL: 'http://127.0.0.1:4002',
    // Owner-published, no default: blank refuses boot (services/svc-matching/src/env.ts).
    MATCHING_SNAPSHOT_EVERY: '500', // SMOKE RIG ONLY — not a production value; Nitro 2026-10-13
    // SMOKE RIG ONLY — #4742: matching refuses every venue door unless the approval's requester and
    // approver are named here (comma-separated identity userIds, read once at boot). These are the
    // two throwaway localtest_cx8 operators registered above; not a production value. Before #4742
    // matching ignores this variable.
    MATCHING_OPERATOR_IDS: operatorIds.join(','),
  });

  await waitHealth('http://127.0.0.1:4005', 'matching');

  start('trade', 'node', ['services/svc-trade/dist/index.js'], {
    ...common,
    SERVICE_NAME: 'svc-trade',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: '4004',
    DATABASE_URL: tradeUrl,
    DATABASE_POOL_MAX: '10', // SMOKE RIG ONLY — not a production value; Nitro 2026-10-13
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
    // Pre-trade credit caps (services/svc-trade/src/futures/pretrade-credit.ts).
    // Each is an owner integer: a plain base-10 integer string, parsed by
    // parseOwnerIntegerEnv (owner-int-env.ts); blank or non-integer refuses every
    // place with trade.max_{order,position,loss}_unset. The code only checks that
    // each is published and does not compare an order against it, so the unit is
    // not enforced here.
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
    // approver's MFA session as the edge would, so it needs identity's URL and the
    // token settings.
    IDENTITY_HTTP_URL: 'http://127.0.0.1:4002',
    JWT_ACCESS_SECRET: JWT,
    JWT_ISSUER: common.JWT_ISSUER,
    JWT_AUDIENCE: common.JWT_AUDIENCE,
    ORDER_PATH_SMOKE_STRICT: '1',
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
    // The operators registered before matching started (credentials stay in the file, not in env).
    CX8_OPERATORS_FILE: operatorsFile,
  });

  log('CX-8 boot + smoke complete');
  killAll();
  process.exit(0);
}

main().catch((err) => {
  console.error('[cx8-boot] fatal', err);
  killAll();
  process.exit(1);
});
