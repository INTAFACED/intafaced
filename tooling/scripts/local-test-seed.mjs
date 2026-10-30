#!/usr/bin/env node
/**
 * LOCAL TEST CONTENT — labelled rows so Earn, Loans, Convert and P2P show data.
 *
 *   LOCAL_TEST=1 node tooling/scripts/local-test-seed.mjs apply  [--state <dir>]
 *   LOCAL_TEST=1 node tooling/scripts/local-test-seed.mjs home   [--notice-minutes <n>] [--state <dir>]
 *   LOCAL_TEST=1 node tooling/scripts/local-test-seed.mjs status [--state <dir>]
 *   LOCAL_TEST=1 node tooling/scripts/local-test-seed.mjs unseed [--state <dir>]
 *   LOCAL_TEST=1 node tooling/scripts/local-test-seed.mjs age-loan <loanId> <days> [--state <dir>]
 *   LOCAL_TEST=1 node tooling/scripts/local-test-seed.mjs fund-earn-pool <poolId> <amount> <ref> [--state <dir>]
 *
 * Default state dir: LOCAL_STACK_STATE, else ~/.intafaced/local-test-stack (local-test-state.mjs)
 * Nitro's preview stack: ~/.intafaced/s3-trade-20261015
 *
 * Refuses (exit 2, no file write, no database) unless LOCAL_TEST=1, NODE_ENV is
 * not production, APP_ENV (if set) is dev or test, the marker is a local test
 * stack, and every database URL is built only from that directory's secrets.json
 * and marker (loopback, marker postgres port). Ledger posts go to 127.0.0.1 on
 * the marker's ledger port. DATABASE_URL and LEDGER_URL in the environment are
 * not read.
 *
 * Money moves only through packages/ledger-client recipes into that local ledger.
 * Earn and loan reserves are a labelled TEST deposit on rail `local-test` into
 * `LOCAL_TEST_FUNDER_ID`, then a move from that funder's available balance.
 * Values below are illustrative TEST numbers. They are not production defaults.
 * Docs: docs/LOCAL-TEST-STACK.md (section "Local test content").
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { HOME_NOTICE_DAYS, applyHome, homeStatus } from './local-test-home.mjs';
import { localStackState } from './local-test-state.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), '..', '..');

export const MARKER_FILE = 'LOCAL-TEST-STACK.json';
export const MARKER_KIND = 'intafaced-local-test-stack';
export const FUNDS_LABEL = 'LOCAL TEST FUNDS — not real money';
/** Labelled local TEST funder. A fixed id written in this file, not a person. */
export const LOCAL_TEST_FUNDER_ID = '00000000-0000-4000-8000-00000000c0de';
export const NAME_PREFIX = 'TEST · ';
export const NAME_SUFFIX = '(local test, not a real rate)';
export const LOAN_RESERVE_FUNDING_ID = 'local-test-seed-loan-reserve-USDT';
export const LOAN_RESERVE_AMOUNT = '1000000';
export const P2P_METHOD_ID = 'local_test_bank';
export const P2P_COUNTRY = '*';
export const P2P_LABEL = 'TEST bank transfer (local test, not a real rail)';
export const LIST_LIMIT = 200;
/** `age-loan` moves a TEST loan back at most this many days: enough for a month of interest rows, far below the accrual backlog guard. */
export const MAX_AGE_DAYS = 31;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `fund-earn-pool` puts at most this much TEST reserve into one pool at a time: the seeded pools' own reserve. */
export const MAX_POOL_FUNDING = '1000000';
/** A pool the stack may fund by hand: one whose name says it is TEST (the seeded pools and the journeys' own). */
const TEST_POOL_NAME = /^TEST[ ·]/;

const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Illustrative TEST earn rates. Names are built by `earnPoolName`.
 * Reserve amounts are exact decimal strings. Each one is deposited to
 * `LOCAL_TEST_FUNDER_ID` on rail `local-test`, then moved with `recipes.earnPoolFund`.
 */
export const TEST_EARN = [
  { slug: 'usdt-flexible', assetId: 'USDT', kind: 'flexible', aprBps: 400, termDays: null, reserve: '1000000' },
  { slug: 'usdt-fixed-30d', assetId: 'USDT', kind: 'fixed', aprBps: 600, termDays: 30, reserve: '1000000' },
  { slug: 'usdc-flexible', assetId: 'USDC', kind: 'flexible', aprBps: 350, termDays: null, reserve: '1000000' },
  { slug: 'btc-flexible', assetId: 'BTC', kind: 'flexible', aprBps: 100, termDays: null, reserve: '10' },
];

/**
 * Policy numbers are copied from a passing loan fixture, not invented here:
 * `DEFAULT_LIQUIDATION_POLICY` in services/svc-bank/src/loans/risk.ts and
 * `aprBps` / `maxLtvBps` in services/svc-bank/src/loans/originate-public-door.test.ts
 * (`seedProduct`). The service's own policy check is the judge.
 */
export const TEST_LOAN_POLICY = {
  marginCallLtvBps: 7500,
  liquidationLtvBps: 8500,
  insolvencyLtvBps: 9500,
  targetLtvBps: 6500,
  penaltyBps: 200,
  maxTrancheBps: 2500,
  graceSeconds: 3600,
};

export const TEST_LOANS = [
  {
    name: 'TEST · BTC collateral against USDT debt (local test, not a real rate)',
    debtAssetId: 'USDT',
    collateralAssetId: 'BTC',
    quoteAssetId: 'USDT',
    aprBps: 1000,
    maxLtvBps: 5000,
  },
  {
    name: 'TEST · ETH collateral against USDT debt (local test, not a real rate)',
    debtAssetId: 'USDT',
    collateralAssetId: 'ETH',
    quoteAssetId: 'USDT',
    aprBps: 1000,
    maxLtvBps: 5000,
  },
];

/**
 * Convert quotes a spot book (`services/svc-trade/src/convert/quote.ts`, source
 * kind `book`) and settles `baseAsset` against `quoteAsset` from this pot.
 * The stack's default markets (`DEFAULT_SYMBOLS` in local-test-market.mjs) are
 * BTC/USDT, BTC/USDC, ETH/USDT, ETH/USDC, IFC/USDT and the TEST ETH/BTC. Both sides are here.
 * Amounts are exact decimal strings. Rail is `local-test`.
 */
export const TEST_HOUSE_INVENTORY = [
  { assetId: 'BTC', amount: '100' },
  { assetId: 'ETH', amount: '1000' },
  { assetId: 'USDT', amount: '5000000' },
  { assetId: 'USDC', amount: '5000000' },
  { assetId: 'IFC', amount: '1000000' },
];

/** Two plain text fields. `parseFieldSpecs` defaults `required` to true. No pattern. */
export const TEST_P2P_FIELDS = [
  { key: 'holder', label: 'TEST holder name' },
  { key: 'reference', label: 'TEST reference' },
];

export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardError';
  }
}

/** The stack's own state rule (LOCAL_STACK_STATE, else per user), as the gates read it, so the compose seed finds its folder. */
export function defaultStateDir(env = process.env) {
  return localStackState(os.homedir(), env);
}

export function earnPoolName(row) {
  const kind = row.kind === 'fixed' ? `fixed ${row.termDays} days` : 'flexible';
  return `${NAME_PREFIX}${row.assetId} ${kind} ${row.aprBps} bps ${NAME_SUFFIX}`;
}

export function earnFundingId(row) {
  return `local-test-seed-${row.slug}`;
}

export function houseSeedId(assetId) {
  return `LOCAL-TEST-seed-house-${assetId}-v1`;
}

function assertDecimal(label, value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new GuardError(`refusing: ${label} must be an exact decimal string (got ${JSON.stringify(value)})`);
  }
}

function assertLabelledName(name) {
  if (!name.startsWith(NAME_PREFIX) || !name.endsWith(NAME_SUFFIX)) {
    throw new GuardError(`refusing: TEST name is missing its label: ${name}`);
  }
}

/** Fail closed if a table edit drops the label or turns money into a number. */
export function assertTestTables() {
  const slugs = new Set();
  for (const row of TEST_EARN) {
    if (slugs.has(row.slug)) throw new GuardError(`refusing: duplicate earn slug ${row.slug}`);
    slugs.add(row.slug);
    assertLabelledName(earnPoolName(row));
    assertDecimal(`earn reserve ${row.slug}`, row.reserve);
    if (row.kind === 'fixed' && !(Number.isInteger(row.termDays) && row.termDays > 0)) {
      throw new GuardError(`refusing: fixed earn pool ${row.slug} needs a term in days`);
    }
    if (row.kind === 'flexible' && row.termDays != null) {
      throw new GuardError(`refusing: flexible earn pool ${row.slug} must not set a term`);
    }
  }
  for (const row of TEST_LOANS) {
    assertLabelledName(row.name);
    if (row.quoteAssetId !== 'USDT' || row.debtAssetId !== 'USDT') {
      throw new GuardError(`refusing: loan product ${row.name} must quote and borrow USDT`);
    }
  }
  assertDecimal('loan reserve', LOAN_RESERVE_AMOUNT);
  const assets = new Set();
  for (const row of TEST_HOUSE_INVENTORY) {
    if (assets.has(row.assetId)) throw new GuardError(`refusing: duplicate house asset ${row.assetId}`);
    assets.add(row.assetId);
    assertDecimal(`house ${row.assetId}`, row.amount);
  }
}

function codeOf(err) {
  return err && typeof err === 'object' && 'code' in err ? err.code : undefined;
}

function absentBalance(amount) {
  if (amount == null || amount === '') return true;
  return /^0+(?:\.0+)?$/.test(String(amount));
}

// ── Guards ──────────────────────────────────────────────────────────────────

const defaultIo = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
};

function readJson(io, file, label) {
  let text;
  try {
    text = io.readFileSync(file, 'utf8');
  } catch (err) {
    throw new GuardError(`refusing: cannot read ${label} (${err.message})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GuardError(`refusing: ${label} is not valid JSON`);
  }
}

function databaseUrl(role, secrets, marker) {
  const host = marker?.database?.host;
  const markerPort = marker?.ports?.postgres;
  const dbPort = marker?.database?.port;
  const name = marker?.database?.name;
  if (typeof host !== 'string' || host.length === 0) throw new GuardError('refusing: marker has no database host');
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new GuardError(`refusing: database host "${host}" is not loopback (127.0.0.1 or localhost)`);
  }
  if (markerPort == null || String(markerPort).length === 0) throw new GuardError('refusing: marker has no postgres port');
  if (String(dbPort) !== String(markerPort)) {
    throw new GuardError(`refusing: database port ${dbPort} is not the marker postgres port ${markerPort}`);
  }
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]+$/.test(name)) throw new GuardError('refusing: marker database name is missing');
  const password = secrets?.pgService;
  if (typeof password !== 'string' || password.length === 0) {
    throw new GuardError('refusing: secrets.json has no pgService password');
  }
  // Host, port and name come from the marker. The password comes from secrets.
  // secrets.databaseUrl, if someone put one there, is not read.
  return `postgres://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${host}:${markerPort}/${name}`;
}

function ledgerUrlOf(marker) {
  const port = marker?.ports?.ledger;
  if (port == null || !/^\d+$/.test(String(port))) throw new GuardError('refusing: marker has no ledger port');
  return `http://127.0.0.1:${port}`;
}

/**
 * Pure guard. Reads the marker and secrets. Does not write, and does not open
 * a database or a ledger. A database URL or ledger URL in the environment is
 * not read. Optional `io` is how tests spy on writes and reads.
 */
export function guardSeed(env, stateDir, io = defaultIo) {
  if (env.LOCAL_TEST === undefined) {
    throw new GuardError('refusing: set LOCAL_TEST=1 to confirm this is the local test stack on this machine.');
  }
  if (env.LOCAL_TEST !== '1') {
    throw new GuardError(`refusing: LOCAL_TEST must be exactly "1" (got ${JSON.stringify(env.LOCAL_TEST)}).`);
  }
  if (env.NODE_ENV === 'production') throw new GuardError('refusing: NODE_ENV is "production". This script is local-only.');
  if (env.APP_ENV !== undefined && env.APP_ENV !== 'dev' && env.APP_ENV !== 'test') {
    const shown = env.APP_ENV === '' ? 'blank' : `"${env.APP_ENV}"`;
    throw new GuardError(`refusing: APP_ENV is ${shown}; if set, it must be exactly "dev" or "test".`);
  }
  if (!stateDir || typeof stateDir !== 'string') throw new GuardError('refusing: state directory is missing');

  const markerPath = path.join(stateDir, MARKER_FILE);
  if (!io.existsSync(markerPath)) {
    throw new GuardError(`refusing: marker ${markerPath} not found. Start the stack first (pnpm local:stack).`);
  }
  const marker = readJson(io, markerPath, 'marker');
  if (!marker || marker.kind !== MARKER_KIND) {
    throw new GuardError('refusing: marker file is not a local test stack marker');
  }

  const secretsPath = path.join(stateDir, 'secrets.json');
  if (!io.existsSync(secretsPath)) throw new GuardError(`refusing: secrets ${secretsPath} not found.`);
  const secrets = readJson(io, secretsPath, 'secrets.json');

  const bankUrl = databaseUrl('svc_bank', secrets, marker);
  const p2pUrl = databaseUrl('svc_p2p', secrets, marker);
  const ledgerUrl = ledgerUrlOf(marker);
  for (const url of [bankUrl, p2pUrl]) {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      throw new GuardError(`refusing: database host "${parsed.hostname}" is not loopback (127.0.0.1 or localhost)`);
    }
    if (parsed.port !== String(marker.ports.postgres)) {
      throw new GuardError(`refusing: database port ${parsed.port} is not the marker postgres port ${marker.ports.postgres}`);
    }
  }
  const ledger = new URL(ledgerUrl);
  if (ledger.hostname !== '127.0.0.1' || ledger.port !== String(marker.ports.ledger)) {
    throw new GuardError('refusing: ledger URL is not 127.0.0.1 on the marker ledger port');
  }
  return { stateDir, marker, bankUrl, p2pUrl, ledgerUrl, internal: secrets.internal };
}

// ── Ledger wire (same shape as local-test-stack cmdFund) ───────────────────

export function toWire(request, formatAmount) {
  return {
    idempotencyKey: request.idempotencyKey,
    module: request.module,
    reason: request.reason,
    meta: { ...request.meta, label: FUNDS_LABEL },
    entries: request.entries.map((entry) => ({
      account: entry.account,
      direction: entry.direction,
      amount: formatAmount(entry.amount),
    })),
  };
}

async function postRecipe(deps, request) {
  const wire = toWire(request, deps.formatAmount);
  const posted = await deps.ledger.post(wire);
  return { wire, posted };
}

async function openNamed(list, emptyCode) {
  try {
    return await list();
  } catch (err) {
    if (codeOf(err) === emptyCode) return [];
    throw err;
  }
}

// ── Apply ───────────────────────────────────────────────────────────────────

/**
 * Deposit on rail `local-test` into the TEST funder, then move that balance.
 * A crash between the two posts leaves the value on the funder. The retry's
 * deposit is a ledger no-op and its funding post completes, so nothing is
 * double-posted.
 */
async function fundFromLocalTestDeposit(deps, { slug, assetId, amount, recipe }) {
  await postRecipe(
    deps,
    deps.recipes.deposit({
      userId: LOCAL_TEST_FUNDER_ID,
      assetId,
      amount,
      rail: 'local-test',
      railRef: `LOCAL-TEST-seed-funder-${slug}-v1`,
    }),
  );
  await postRecipe(deps, recipe(deps.userAvailable(LOCAL_TEST_FUNDER_ID, assetId)));
}

export async function applyEarn(deps, rows = TEST_EARN) {
  assertTestTables();
  const open = await openNamed(() => deps.earn.listPools(undefined, LIST_LIMIT), 'bank.earn_rate_unset');
  const openNames = new Set(open.filter((pool) => pool.status === undefined || pool.status === 'open').map((pool) => pool.name));
  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    const name = earnPoolName(row);
    assertLabelledName(name);
    assertDecimal(name, row.reserve);
    const existing = open.find((pool) => pool.name === name);
    const pool =
      existing ??
      (await deps.earn.createPool({
        assetId: row.assetId,
        kind: row.kind,
        name,
        aprBps: row.aprBps,
        termDays: row.kind === 'fixed' ? row.termDays : null,
        minDeposit: deps.parseAmount('0'),
      }));
    if (existing && openNames.has(name)) skipped += 1;
    else {
      created += 1;
      open.push(pool);
      openNames.add(name);
    }
    const amount = deps.parseAmount(row.reserve);
    await fundFromLocalTestDeposit(deps, {
      slug: row.slug,
      assetId: row.assetId,
      amount,
      recipe: (from) =>
        deps.recipes.earnPoolFund({
          poolId: pool.id,
          fundingId: earnFundingId(row),
          assetId: row.assetId,
          amount,
          from,
        }),
    });
  }
  return { created, skipped };
}

export async function applyLoans(deps, rows = TEST_LOANS) {
  assertTestTables();
  const open = await openNamed(() => deps.loans.listProducts(undefined, LIST_LIMIT), 'bank.loan_products_unset');
  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    assertLabelledName(row.name);
    const existing = open.find((product) => product.name === row.name);
    if (existing) {
      skipped += 1;
      continue;
    }
    const product = await deps.loans.createProduct({
      name: row.name,
      debtAssetId: row.debtAssetId,
      collateralAssetId: row.collateralAssetId,
      quoteAssetId: row.quoteAssetId,
      aprBps: row.aprBps,
      maxLtvBps: row.maxLtvBps,
      policy: { ...TEST_LOAN_POLICY },
      minPrincipal: deps.parseAmount('0'),
    });
    open.push(product);
    created += 1;
  }
  const amount = deps.parseAmount(LOAN_RESERVE_AMOUNT);
  await fundFromLocalTestDeposit(deps, {
    slug: 'loan-reserve-USDT',
    assetId: 'USDT',
    amount,
    recipe: (from) =>
      deps.recipes.loanReserveFund({
        fundingId: LOAN_RESERVE_FUNDING_ID,
        debtAssetId: 'USDT',
        amount,
        from,
      }),
  });
  return { created, skipped };
}

export async function applyHouse(deps, rows = TEST_HOUSE_INVENTORY) {
  assertTestTables();
  let posted = 0;
  for (const row of rows) {
    assertDecimal(row.assetId, row.amount);
    const amount = deps.parseAmount(row.amount);
    await postRecipe(
      deps,
      deps.recipes.marketMakerSeedFund({
        assetId: row.assetId,
        amount,
        seedId: houseSeedId(row.assetId),
        rail: 'local-test',
      }),
    );
    posted += 1;
  }
  return { posted };
}

export async function applyP2p(deps) {
  const schema = await deps.instruments.registerMethodSchema({
    methodId: P2P_METHOD_ID,
    country: P2P_COUNTRY,
    label: P2P_LABEL,
    fields: TEST_P2P_FIELDS.map((field) => ({ ...field })),
    enabled: true,
  });
  return { methodId: schema.methodId ?? P2P_METHOD_ID, label: schema.label ?? P2P_LABEL };
}

export async function applyAll(deps) {
  const earn = await applyEarn(deps);
  const loans = await applyLoans(deps);
  const house = await applyHouse(deps);
  const p2p = await applyP2p(deps);
  const lines = [
    `earn pools: created ${earn.created}, skipped ${earn.skipped}`,
    `loan products: created ${loans.created}, skipped ${loans.skipped}`,
    `house inventory: ${house.posted} assets posted on rail local-test`,
    `p2p method: ${p2p.methodId}`,
    FUNDS_LABEL,
  ];
  return { earn, loans, house, p2p, lines };
}

/**
 * The founder's Home (J-home-ia-11): a TEST deposit, a TEST notice and an inbox row, only when the tester profile asks
 * (`home`). Not part of `apply`: the notice is on the public board for 30 days, and every stack that loads the TEST
 * content without the tester entry (each Real-app journeys shard, Try it) keeps an empty board, which J-home-ia-06 needs.
 */
export async function applyHomeContent(deps, { noticeMinutes } = {}) {
  // The deposit, notice and inbox row need the founder pair; the tester entry asked for Home, so without it this fails.
  const wired = deps.home ? await deps.home() : null;
  if (!wired) throw new Error('home: no enrolled founder pair on this stack, so Home cannot be seeded (run local-founder-seed.mjs enrol)');
  const lines = await applyHome(wired, noticeMinutes === undefined ? {} : { noticeMs: noticeMinutes * 60_000 });
  return { lines: [...lines, FUNDS_LABEL] };
}

// ── Unseed (close / disable, never delete, never reverse a ledger credit) ──

export async function unseedAll(deps) {
  const poolNames = TEST_EARN.map((row) => earnPoolName(row));
  const productNames = TEST_LOANS.map((row) => row.name);
  const pools = await deps.closePools(poolNames);
  const products = await deps.closeProducts(productNames);
  let method = 'absent';
  try {
    // svc-p2p will not switch a method off without one of its retirement reasons; a TEST rail taken down is the
    // closest of them to "no longer offered".
    const row = await deps.instruments.setMethodSchemaEnabled(P2P_METHOD_ID, P2P_COUNTRY, false, 'low_demand');
    method = row?.enabled === false ? 'disabled' : 'updated';
  } catch (err) {
    if (codeOf(err) !== 'p2p.instrument_method_unknown') throw err;
  }
  return {
    pools,
    products,
    method,
    lines: [
      `earn pools closed: ${pools} (rows kept)`,
      `loan products closed: ${products} (rows kept)`,
      `p2p method ${P2P_METHOD_ID}: ${method}`,
      'ledger credits are not reversed',
    ],
  };
}

// ── Age a TEST loan (a stack has no past, and loan interest is charged by the day) ──

/**
 * Moves one TEST loan's start back `days` UTC days, so the bank's own accrual job has past days to charge (J-bank-11
 * #2: a repayment pays interest first). Only the loan's dates move: when it was opened and drawn, and when its opening
 * pledge settled. Nothing is posted and no figure is written; the interest is the bank's, charged later by its job door.
 * Refused unless the loan is on a TEST product, active, drawn, and has nothing after its opening yet (no interest row,
 * repayment, liquidation, margin call or later collateral move), so no recorded event is ever left before the loan's start.
 */
export async function ageLoan(deps, loanId, days) {
  if (typeof loanId !== 'string' || !UUID.test(loanId)) throw new GuardError('refusing: age-loan needs a loan id (a UUID)');
  if (!/^\d+$/.test(String(days)) || Number(days) < 1 || Number(days) > MAX_AGE_DAYS) {
    throw new GuardError(`refusing: age-loan needs whole days from 1 to ${MAX_AGE_DAYS}`);
  }
  const testProducts = TEST_LOANS.map((row) => row.name);
  const aged = await deps.ageLoanRows(loanId, Number(days), testProducts);
  if (aged.refused) throw new GuardError(`refusing: loan ${loanId} ${aged.refused}`);
  return {
    ...aged,
    lines: [`loan ${loanId}: opened ${aged.openedAt}, drawn ${aged.drawnAt} (moved back ${days} days)`, FUNDS_LABEL],
  };
}

/**
 * Funds one TEST earn pool's reserve, so the bank's own accrual job can pay the pool's interest on this stack (J-bank-08
 * #3: a journey opens its own pool through the treasury door, and ops.fundPool only draws on bank revenue a fresh stack
 * does not have). The same two moves `apply` makes for a seeded pool: a labelled TEST deposit to the TEST funder, then
 * `earnPoolFund` from the funder's available balance. `ref` makes both business keys, so a retry funds once. Refused
 * unless the pool exists, is named TEST and is open, and the amount is a decimal above zero and at most the cap.
 */
export async function fundEarnPool(deps, poolId, amount, ref) {
  assertTestTables();
  if (typeof poolId !== 'string' || !UUID.test(poolId)) throw new GuardError('refusing: fund-earn-pool needs a pool id (a UUID)');
  if (typeof ref !== 'string' || !/^[A-Za-z0-9-]{4,64}$/.test(ref)) {
    throw new GuardError('refusing: fund-earn-pool needs a ref of 4 to 64 letters, digits or dashes');
  }
  assertDecimal('pool funding', amount);
  const units = deps.parseAmount(amount);
  if (units <= 0n || units > deps.parseAmount(MAX_POOL_FUNDING)) {
    throw new GuardError(`refusing: fund-earn-pool funds above 0 and at most ${MAX_POOL_FUNDING}`);
  }
  const pool = await deps.readPoolById(poolId);
  if (!pool) throw new GuardError(`refusing: pool ${poolId} is not on this stack`);
  if (!TEST_POOL_NAME.test(pool.name)) throw new GuardError(`refusing: pool ${poolId} is not a TEST pool`);
  if (pool.status !== 'open') throw new GuardError(`refusing: pool ${poolId} is ${pool.status}`);
  await fundFromLocalTestDeposit(deps, {
    slug: `pool-${poolId}-${ref}`,
    assetId: pool.assetId,
    amount: units,
    recipe: (from) => deps.recipes.earnPoolFund({ poolId, fundingId: `local-test-${ref}`, assetId: pool.assetId, amount: units, from }),
  });
  return { lines: [`pool ${poolId}: reserve funded ${amount} ${pool.assetId} (ref ${ref})`, FUNDS_LABEL] };
}

// ── Status (read-only) ──────────────────────────────────────────────────────

export async function statusReport(deps, now = new Date()) {
  const asOf = now.toISOString();
  const pools = await deps.readPools(TEST_EARN.map((row) => earnPoolName(row)));
  const products = await deps.readProducts(TEST_LOANS.map((row) => row.name));
  const method = await deps.instruments.findMethod(P2P_METHOD_ID, P2P_COUNTRY);
  const house = [];
  for (const row of TEST_HOUSE_INVENTORY) {
    const bal = await deps.ledger.balance({
      ownerType: 'house',
      ownerId: 'market-maker',
      assetId: row.assetId,
      kind: 'available',
    });
    if (!absentBalance(bal?.amount)) house.push({ assetId: row.assetId, amount: String(bal.amount) });
  }
  const lines = [];
  const any = pools.length > 0 || products.length > 0 || method || house.length > 0;
  lines.push(any ? 'LOCAL TEST content' : 'LOCAL TEST content — nothing seeded');
  lines.push(`as of ${asOf}`);
  lines.push(FUNDS_LABEL);
  if (!any) return lines;
  if (pools.length > 0) {
    lines.push('pools:');
    for (const pool of pools) lines.push(`  ${pool.name}  ${pool.status}  ${pool.assetId}`);
  }
  if (products.length > 0) {
    lines.push('products:');
    for (const product of products) lines.push(`  ${product.name}  ${product.status}`);
  }
  if (house.length > 0) {
    lines.push('house:');
    for (const row of house) lines.push(`  ${row.assetId}  ${row.amount}`);
  }
  if (method) {
    lines.push('method:');
    lines.push(`  ${method.methodId}  ${method.enabled ? 'enabled' : 'disabled'}  ${method.label}`);
  }
  const wired = deps.home ? await deps.home() : null;
  lines.push(...(wired ? await homeStatus(wired) : ['home: no enrolled founder pair on this stack']));
  return lines;
}

// ── Real stack (only after guardSeed; tests inject deps instead) ───────────

async function importFromRepo(rel) {
  return import(pathToFileURL(path.join(REPO, rel)).href);
}

async function signedCall(plan, contracts, route, body) {
  if (typeof plan.internal !== 'string' || plan.internal.length === 0) {
    throw new GuardError('refusing: secrets.json has no internal service secret');
  }
  const raw = JSON.stringify(body);
  const headers = {
    'content-type': 'application/json',
    ...contracts.serviceAuthHeadersForBody('local-test-seed', plan.internal, raw),
  };
  const res = await fetch(`${plan.ledgerUrl}/trpc/${route}`, { redirect: 'error', method: 'POST', headers, body: raw });
  const text = await res.text();
  if (!res.ok) throw new Error(`ledger ${route} refused (${res.status}): ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

/**
 * Load `postgres` from svc-bank, the package that declares it.
 * A script under `tooling/scripts/` cannot resolve that dependency itself.
 */
export function resolvePostgres(repo) {
  const pkg = path.join(repo, 'services', 'svc-bank', 'package.json');
  try {
    const loaded = createRequire(pkg)('postgres');
    return loaded?.default ?? loaded;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot load postgres from ${pkg}: ${message}`);
  }
}

/**
 * Home's live wiring on this stack, or null when its founder pair is not enrolled: founder a's and b's sessions through
 * Edge (local-test-gates.mjs), and the stack's own `chain-deposit` tool for the TEST transfer. The gates refuse a state
 * folder other than the one this seed was given, so the two always name the same stack.
 */
function homeDeps(plan) {
  const vault = path.join(plan.stateDir, 'founders.json');
  if (!fs.existsSync(vault)) return null;
  let wired;
  return () =>
    (wired ??= (async () => {
      const [gates, founders, notice, stack] = await Promise.all([
        import('./local-test-gates.mjs'),
        import('./local-test-founders.mjs'),
        import('./local-test-notice.mjs'),
        import('./local-test-stack.mjs'),
      ]);
      // A draft vault (the stack wrote it, enrolment has not run or failed) is no founder pair: Home is not seeded.
      if (!founders.enrolledFounderPair(JSON.parse(fs.readFileSync(vault, 'utf8')))) return null;
      const ctx = await gates.makeContext({ log: () => {} });
      if (path.resolve(ctx.paths.stateDir) !== path.resolve(plan.stateDir)) {
        throw new GuardError(`refusing: the gates read ${ctx.paths.stateDir}, not ${plan.stateDir}; set LOCAL_STACK_STATE to it`);
      }
      const pair = await gates.approverSessions(ctx);
      if (!founders.isLocalTestFounderHandle(pair.a.op.handle)) throw new GuardError('refusing: Home is seeded for the founder pair only');
      return {
        edge: ctx.edge,
        founder: { handle: pair.a.op.handle, token: pair.a.token },
        async draftNotice(input, key) {
          const res = await ctx.edge.mutate(
            'notify',
            'notify.draftNotice',
            { ...input, clientRequestId: key },
            await pair.a.tradeOpsToken(),
          );
          const row = res.json?.result?.data;
          if (!row) throw new Error(`notify.draftNotice refused (${res.status}): ${res.text.slice(0, 300)}`);
          return row;
        },
        publishNotice: (row, publishKey) =>
          notice.publishWithApproval({ edge: ctx.edge, pair, policyVersion: gates.MARKERS.policyVersion }, row, publishKey),
        chainDeposit(address, asset, amount, confirmations, label) {
          execFileSync(
            process.execPath,
            [
              path.join(REPO, 'tooling/scripts/local-test-stack.mjs'),
              'chain-deposit',
              address,
              asset,
              amount,
              String(confirmations),
              '--tx',
              label,
            ],
            { cwd: REPO, env: { ...process.env, LOCAL_STACK_STATE: plan.stateDir }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
          );
        },
        txHash: stack.chainTxHash,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      };
    })());
}

export async function openLocal(plan) {
  const postgres = resolvePostgres(REPO);
  let ledgerClient;
  let contracts;
  let EarnService;
  let LoanService;
  let InstrumentService;
  try {
    [ledgerClient, contracts] = await Promise.all([
      importFromRepo('packages/ledger-client/dist/index.js'),
      importFromRepo('packages/contracts/dist/index.js'),
    ]);
    EarnService = (await importFromRepo('services/svc-bank/dist/earn/earn-service.js')).EarnService;
    LoanService = (await importFromRepo('services/svc-bank/dist/loans/loan-service.js')).LoanService;
    InstrumentService = (await importFromRepo('services/svc-p2p/dist/instrument-service.js')).InstrumentService;
  } catch (err) {
    throw new Error(`packages are not built (${err.message}). Run: pnpm local:stack --rebuild`);
  }
  const sqlOpts = (schema) => ({
    max: 1,
    ssl: false,
    onnotice: () => undefined,
    connection: { search_path: `${schema},public`, application_name: 'local-test-seed' },
  });
  const bankSql = postgres(plan.bankUrl, sqlOpts('bank'));
  const p2pSql = postgres(plan.p2pUrl, sqlOpts('p2p'));
  const unusedLedger = {};
  const earn = new EarnService(bankSql, unusedLedger);
  const loans = new LoanService(bankSql, unusedLedger, {
    priceSource: {
      async price() {
        throw new Error('local-test-seed does not invent price marks');
      },
    },
  });
  const instruments = new InstrumentService(p2pSql);
  const namesIn = (sql, names) => sql(names);

  return {
    home: homeDeps(plan),
    earn,
    loans,
    instruments: {
      registerMethodSchema: (input) => instruments.registerMethodSchema(input),
      setMethodSchemaEnabled: (methodId, country, enabled, reason) =>
        instruments.setMethodSchemaEnabled(methodId, country, enabled, reason),
      enabledMethodKeys: () => instruments.enabledMethodKeys(),
      async findMethod(methodId, country) {
        const rows = await p2pSql`
          SELECT method_id, country, label, enabled
            FROM p2p.payment_method_schemas
           WHERE method_id = ${methodId} AND country = ${country}
        `;
        const row = rows[0];
        if (!row) return null;
        return { methodId: row.method_id, country: row.country, label: row.label, enabled: row.enabled };
      },
    },
    recipes: ledgerClient.recipes,
    userAvailable: ledgerClient.userAvailable,
    parseAmount: ledgerClient.parseAmount,
    formatAmount: ledgerClient.formatAmount,
    ledger: {
      post: (wire) => signedCall(plan, contracts, 'post', wire),
      balance: (query) => signedCall(plan, contracts, 'balance', query),
    },
    async readPools(names) {
      if (names.length === 0) return [];
      const rows = await bankSql`
        SELECT id, name, status, asset_id
          FROM bank.earn_pools
         WHERE name IN ${namesIn(bankSql, names)}
         ORDER BY name ASC
      `;
      return rows.map((row) => ({ id: row.id, name: row.name, status: row.status, assetId: row.asset_id }));
    },
    async readPoolById(poolId) {
      const rows = await bankSql`SELECT id, name, status, asset_id FROM bank.earn_pools WHERE id = ${poolId}`;
      const row = rows[0];
      return row ? { id: row.id, name: row.name, status: row.status, assetId: row.asset_id } : null;
    },
    async readProducts(names) {
      if (names.length === 0) return [];
      const rows = await bankSql`
        SELECT id, name, status
          FROM bank.loan_products
         WHERE name IN ${namesIn(bankSql, names)}
         ORDER BY name ASC
      `;
      return rows.map((row) => ({ id: row.id, name: row.name, status: row.status }));
    },
    async closePools(names) {
      if (names.length === 0) return 0;
      const rows = await bankSql`
        UPDATE bank.earn_pools
           SET status = 'closed', updated_at = now()
         WHERE name IN ${namesIn(bankSql, names)}
           AND status <> 'closed'
        RETURNING id
      `;
      return rows.length;
    },
    async closeProducts(names) {
      if (names.length === 0) return 0;
      const rows = await bankSql`
        UPDATE bank.loan_products
           SET status = 'closed', updated_at = now()
         WHERE name IN ${namesIn(bankSql, names)}
           AND status <> 'closed'
        RETURNING id
      `;
      return rows.length;
    },
    async ageLoanRows(loanId, days, testProducts) {
      return bankSql.begin(async (tx) => {
        const rows = await tx`
          SELECT l.status, l.drawn_at, p.name AS product
            FROM bank.loans l JOIN bank.loan_products p ON p.id = l.product_id
           WHERE l.id = ${loanId}
             FOR UPDATE OF l
        `;
        const loan = rows[0];
        if (!loan) return { refused: 'is not on this stack' };
        // Held to the end of this transaction: no event row can be written for any loan while the count and the move run.
        await tx`
          LOCK TABLE bank.loan_interest_accruals, bank.loan_repayments, bank.loan_liquidations,
                     bank.loan_collateral_events, bank.loan_margin_calls IN SHARE MODE
        `;
        if (!testProducts.includes(loan.product)) return { refused: 'is not on a TEST loan product' };
        if (loan.status !== 'active' || loan.drawn_at === null) return { refused: `is ${loan.status}, not an active drawn loan` };
        const [later] = await tx`
          SELECT (SELECT count(*) FROM bank.loan_interest_accruals WHERE loan_id = ${loanId})
               + (SELECT count(*) FROM bank.loan_repayments WHERE loan_id = ${loanId})
               + (SELECT count(*) FROM bank.loan_liquidations WHERE loan_id = ${loanId})
               + (SELECT count(*) FROM bank.loan_margin_calls WHERE loan_id = ${loanId})
               + (SELECT count(*) FROM bank.loan_collateral_events WHERE loan_id = ${loanId} AND sequence <> 0) AS n
        `;
        if (Number(later.n) > 0) return { refused: 'already has events after its opening' };
        const shift = tx`make_interval(days => ${days})`;
        const [moved] = await tx`
          UPDATE bank.loans SET opened_at = opened_at - ${shift}, drawn_at = drawn_at - ${shift}
           WHERE id = ${loanId}
          RETURNING opened_at, drawn_at
        `;
        await tx`
          UPDATE bank.loan_collateral_events
             SET created_at = created_at - ${shift}, settled_at = settled_at - ${shift}
           WHERE loan_id = ${loanId} AND sequence = 0
        `;
        return { openedAt: moved.opened_at.toISOString(), drawnAt: moved.drawn_at.toISOString() };
      });
    },
    async close() {
      await bankSql.end({ timeout: 5 });
      await p2pSql.end({ timeout: 5 });
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = 'Use: apply | home [--notice-minutes <n>] | status | unseed | age-loan | fund-earn-pool';
const MAX_NOTICE_MINUTES = HOME_NOTICE_DAYS * 24 * 60;

export function parseArgs(argv) {
  const args = [...argv];
  let stateDir;
  let noticeMinutes;
  const at = args.indexOf('--state');
  if (at !== -1) {
    stateDir = args[at + 1];
    if (!stateDir || stateDir.startsWith('--')) throw new GuardError('refusing: --state needs a directory');
    args.splice(at, 2);
  }
  const minutesAt = args.indexOf('--notice-minutes');
  if (minutesAt !== -1) {
    const raw = args[minutesAt + 1];
    if (args[0] !== 'home') throw new GuardError('refusing: --notice-minutes is for home only');
    if (!/^[1-9][0-9]*$/.test(raw ?? '') || Number(raw) > MAX_NOTICE_MINUTES) {
      throw new GuardError(`refusing: --notice-minutes needs a whole number from 1 to ${MAX_NOTICE_MINUTES}`);
    }
    noticeMinutes = Number(raw);
    args.splice(minutesAt, 2);
  }
  const [command, ...rest] = args;
  if (!command) throw new GuardError(`refusing: command required. ${USAGE}`);
  const operands = command === 'age-loan' ? 2 : command === 'fund-earn-pool' ? 3 : 0;
  if (rest.length > operands) throw new GuardError(`refusing: unknown argument "${rest[operands]}"`);
  if (rest.length < operands) {
    throw new GuardError(
      command === 'age-loan' ? 'refusing: age-loan needs <loanId> <days>' : 'refusing: fund-earn-pool needs <poolId> <amount> <ref>',
    );
  }
  return {
    command,
    operands: rest,
    ...(noticeMinutes === undefined ? {} : { noticeMinutes }),
    stateDir: path.resolve(stateDir ?? defaultStateDir()),
  };
}

async function dispatch(command, deps, hooks, operands = [], options = {}) {
  const out = hooks.out ?? ((line) => process.stdout.write(`${line}\n`));
  if (command === 'apply') {
    const report = await applyAll(deps);
    for (const line of report.lines) out(line);
    return 0;
  }
  if (command === 'home') {
    const report = await applyHomeContent(deps, { noticeMinutes: options.noticeMinutes });
    for (const line of report.lines) out(line);
    return 0;
  }
  if (command === 'unseed') {
    const report = await unseedAll(deps);
    for (const line of report.lines) out(line);
    return 0;
  }
  if (command === 'status') {
    const lines = await statusReport(deps, hooks.now ?? new Date());
    for (const line of lines) out(line);
    return 0;
  }
  if (command === 'age-loan') {
    const report = await ageLoan(deps, operands[0], operands[1]);
    for (const line of report.lines) out(line);
    return 0;
  }
  if (command === 'fund-earn-pool') {
    const report = await fundEarnPool(deps, operands[0], operands[1], operands[2]);
    for (const line of report.lines) out(line);
    return 0;
  }
  throw new GuardError(`refusing: unknown command "${command}". ${USAGE}`);
}

/**
 * `hooks.load` replaces `openLocal` in tests. `hooks.io` is the guard spy.
 * A refused guard returns 2 and does not call `load`.
 */
export async function main(argv, env = process.env, hooks = {}) {
  const log = hooks.log ?? ((line) => process.stderr.write(`${line}\n`));
  const io = hooks.io ?? defaultIo;
  try {
    const parsed = parseArgs(argv);
    const plan = guardSeed(env, parsed.stateDir, io);
    const load = hooks.load ?? openLocal;
    const deps = hooks.deps ?? (await load(plan));
    try {
      return await dispatch(parsed.command, deps, hooks, parsed.operands, { noticeMinutes: parsed.noticeMinutes });
    } finally {
      if (!hooks.deps && deps?.close) await deps.close();
    }
  } catch (err) {
    log(err?.message ?? String(err));
    return err instanceof GuardError ? 2 : 1;
  }
}

const invoked = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invoked) {
  const code = await main(process.argv.slice(2), process.env);
  process.exit(code);
}
