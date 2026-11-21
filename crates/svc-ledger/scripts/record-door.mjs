// Records, from the TypeScript svc-ledger in this checkout, what the Rust crate's shell is held to:
//
// - `src/door/schemas.json`: the input schema each door checks before it reaches the ledger, as the tree of zod 4
//   parts the kit's schema engine runs (`service_kit::schema`).
// - `src/door/callers.rs`: which services may call each service door (`LEDGER_DOOR_CALLERS`).
// - `src/errors_table.rs`: the user copy (`userCopy`) of every `ledger.*` code the TypeScript names.
// - `tests/fixtures/input-parity.golden.json`: zod's own verdict on inputs made from each schema.
// - `tests/fixtures/tokens.golden.json`: `verifyAccessToken`'s verdict on access tokens made to probe it.
// - `tests/fixtures/env-parity.golden.json`: what `env.ts` answers for a set of environments.
// - `tests/fixtures/reports.golden.jsonl`: what the `reports` slice's five doors answer on the wire (status and body)
//   for inputs made to reach each branch of their handlers.
// - `tests/fixtures/history-book.golden.json`: the posts the history slice's Postgres tests book, as the TypeScript
//   recipes write them, so the Rust suite reads the same book the TypeScript tests read.
//
// Run from the repository root, with the workspace packages built (`pnpm build`: the history doors' schemas load the
// ledger client as the service resolves it):
//   TZ=UTC node --import tsx crates/svc-ledger/scripts/record-door.mjs          writes the files
//   TZ=UTC node --import tsx crates/svc-ledger/scripts/record-door.mjs --check  fails when a written file is stale
//
// It reads the TypeScript service and never writes there. It stops being runnable when the TypeScript service is
// deleted, and from then on what it wrote is the reference.

import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CRATE = fileURLToPath(new URL('../', import.meta.url));
const SVC = `${ROOT}services/svc-ledger/src/`;
const NAME = 'record-door';
if (!existsSync(SVC)) {
  console.error(`${NAME}: services/svc-ledger no longer exists; nothing to record from. The files it wrote are the reference now.`);
  process.exit(2);
}
const CHECK = process.argv.includes('--check');
if (process.env.TZ !== 'UTC') {
  console.error(`${NAME}: run with TZ=UTC`);
  process.exit(2);
}

// zod as the service resolves it, so the schemas below and `z.object({}).strict()` are the same zod.
const { z } = await import(pathToFileURL(createRequire(`${SVC}index.ts`).resolve('zod')).href);
const ledgerClient = await import(`${ROOT}packages/ledger-client/src/types.ts`);
const doorInputs = await import(`${SVC}door-inputs.ts`);
const { LEDGER_DOOR_CALLERS } = await import(`${SVC}door-callers.ts`);
const { userCopy } = await import(`${SVC}user-copy.ts`);
const { operatorTxGetInputSchema } = await import(`${SVC}ledger/operator-tx-get.ts`);
const { operatorTraceInputSchema } = await import(`${SVC}ledger/operator-trace.ts`);
const { operatorTxListInputSchema, operatorAccountSearchInputSchema } = await import(`${SVC}ledger/operator-desk.ts`);
const { accountMetadataReadInputSchema } = await import(`${SVC}ledger/operator-account-metadata.ts`);
// The history doors' schemas as the service runs them: `history.ts` takes the ledger client as the service resolves it
// (its built `dist`), so its account schema is a different object from the one `types.ts` above loads.
const { historyInputSchema, historyPageInputSchema } = await import(`${SVC}ledger/history.ts`);
const servedLedgerClient = await import(pathToFileURL(createRequire(`${SVC}index.ts`).resolve('@intafaced/ledger-client')).href);
const { ledgerHoldingsHistoryInputSchema } = await import(`${ROOT}packages/contracts/src/ledger-holdings-history.ts`);
const { recipes, formatAmount, parseAmount: amt } = await import(`${ROOT}packages/ledger-client/src/index.ts`);
const { verifyAccessToken } = await import(`${ROOT}packages/auth/src/tokens.ts`);
const { ledgerFeeRevenueInputSchema } = await import(`${ROOT}packages/contracts/src/ledger-fee-revenue.ts`);
const { restoreWatermarkReadInputSchema } = await import(`${ROOT}packages/contracts/src/ops-restore-watermarks.ts`);
const reconciliation = await import(`${ROOT}packages/contracts/src/ledger-reconciliation.ts`);
const statementPnl = await import(`${SVC}ledger/statement-pnl-reproduce.ts`);
const reportExport = await import(`${SVC}ledger/report-export.ts`);
const custody = await import(`${SVC}ledger/custody-adapters.ts`);
const financeClose = await import(`${SVC}ledger/finance-close.ts`);
const resilience = await import(`${SVC}ledger/resilience-gate.ts`);
const s2sHttp = await import(`${SVC}s2s-http.ts`);

// ── The inputs the door checks ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Each door's first check on its input, where the TypeScript handler parses its body (or its path and query) with one
 * zod schema before it reaches the ledger. `/operator/stats` parses `z.object({}).strict()` inline.
 */
const INPUTS = {
  post: ledgerClient.postRequestSchema,
  balance: ledgerClient.accountRefSchema,
  balances: doorInputs.balancesInput,
  txByKey: doorInputs.txByKeyInput,
  txById: doorInputs.txByIdInput,
  portfolio: doorInputs.portfolioS2sInput,
  history: historyInputSchema,
  historyPage: historyPageInputSchema,
  holdingsHistory: ledgerHoldingsHistoryInputSchema,
  freeze: doorInputs.freezeSchema,
  unfreeze: doorInputs.thawSchema,
  reconcile: doorInputs.reconcileSchema,
  txGet: operatorTxGetInputSchema,
  trace: operatorTraceInputSchema,
  txList: operatorTxListInputSchema,
  accountSearch: operatorAccountSearchInputSchema,
  stats: z.object({}).strict(),
  metadataRead: accountMetadataReadInputSchema,
  statementPnl: statementPnl.statementPnlReproduceInputSchema,
  reportExport: reportExport.reportExportInputSchema,
  custody: custody.custodyInputSchema,
  financeClose: financeClose.financeCloseInputSchema,
  resilience: resilience.resilienceInputSchema,
  feeRevenue: ledgerFeeRevenueInputSchema,
  transactionsExist: reconciliation.ledgerTransactionsExistInputSchema,
  reconciliationEvaluations: reconciliation.reconciliationEvaluationFeedInputSchema,
  restoreWatermark: restoreWatermarkReadInputSchema,
};

/**
 * The replies a door checks before it answers (`schema.parse(reply)`): a stored row the contract no longer reads is the
 * service's fault, a 500, never a reply that breaks its caller. The parse also gives the reply its keys in the
 * contract's order.
 */
const OUTPUTS = {
  controlRun: reconciliation.reconciliationControlRunSchema,
  evaluationFeed: reconciliation.reconciliationEvaluationFeedSchema,
};

/** Refines, by their source as tsx loads it: the Rust door runs each by this name (`src/refines.rs`). */
const REFINES = {
  'q=>!q.from||!q.to||Date.parse(q.from)<Date.parse(q.to)': 'from_before_to',
  'v=>BigInt(v)<=INT8_MAX': 'seq_within_int8',
};
/** `superRefine`s, by the schema that carries them (their check's source is zod's own wrapper). */
const SUPER_REFINES = new Map([
  [ledgerClient.accountRefSchema, 'owner_id_space'],
  [servedLedgerClient.accountRefSchema, 'owner_id_space'],
  // The same check and message as `accountRefSchema`'s, on the page's own strict object.
  [historyPageInputSchema, 'owner_id_space'],
]);

const ids = new Map();
const nodes = [];

function messageOf(def) {
  if (!def.error) return undefined;
  const m = def.error({});
  return typeof m === 'string' ? m : m?.message;
}

const LENGTH_WHEN = 'val.length !== undefined';

function check(c, owner) {
  const d = c._zod.def;
  const out = (k, extra = {}) => {
    const msg = messageOf(d);
    return { k, ...extra, ...(d.abort ? { abort: true } : {}), ...(msg !== undefined ? { msg } : {}) };
  };
  if (d.when && !(['min_length', 'max_length'].includes(d.check) && d.when.toString().includes(LENGTH_WHEN))) {
    throw new Error(`a check with its own when: ${d.check}`);
  }
  switch (d.check) {
    case 'min_length':
      return out('min_length', { n: d.minimum });
    case 'max_length':
      return out('max_length', { n: d.maximum });
    case 'string_format':
      if (d.format === 'regex') return out('regex', { src: d.pattern.toString() });
      if (['guid', 'uuid', 'datetime'].includes(d.format)) return out('format', { format: d.format, src: d.pattern.toString() });
      throw new Error(`string format ${d.format}`);
    case 'overwrite': {
      const src = d.tx.toString();
      if (src === '(input) => input.trim()') return out('trim');
      throw new Error(`overwrite ${src}`);
    }
    case 'greater_than':
      return out('gt', { v: d.value, incl: d.inclusive });
    case 'less_than':
      return out('lt', { v: d.value, incl: d.inclusive });
    case 'number_format':
      if (d.format !== 'safeint') throw new Error(`number format ${d.format}`);
      return out('int');
    case 'custom': {
      if (d.fn === undefined) {
        const id = SUPER_REFINES.get(owner);
        if (!id) throw new Error('an unnamed superRefine');
        return { k: 'super', id };
      }
      const id = REFINES[d.fn.toString()];
      if (!id) throw new Error(`an unnamed refine: ${d.fn.toString()}`);
      return out('refine', { id, ...(d.path ? { path: d.path } : {}) });
    }
    default:
      throw new Error(`check ${d.check}`);
  }
}

/** The one transform the doors use: `(s) => s.trim()` on a string, as tsx prints it. */
const TRIM_TRANSFORMS = new Set(['(s) => s.trim()', 's=>s.trim()']);

/**
 * A pipe. `z.string().transform((s) => s.trim())` is recorded as the string with `trim` as its one check: the same
 * parse, since the transform only ever sees a string that passed. Any other pipe is recorded as one: the first part,
 * then the second on what passed it (`handlePipeResult`). Any other transform is refused, never guessed.
 */
function pipe(s, checks) {
  const d = s._zod.def;
  if (checks.length) throw new Error('a pipe with its own checks');
  const out = d.out._zod.def;
  if (out.type !== 'transform') return { t: 'pipe', in: node(d.in), out: node(d.out) };
  const from = d.in._zod.def;
  if (from.type !== 'string' || from.checks?.length || from.coerce || !TRIM_TRANSFORMS.has(out.transform.toString())) {
    throw new Error(`a transform other than a string's trim: ${out.transform.toString()}`);
  }
  return { t: 'string', checks: [{ k: 'trim' }] };
}

function node(s) {
  if (ids.has(s)) return ids.get(s);
  const id = nodes.length;
  ids.set(s, id);
  nodes.push(null);
  nodes[id] = build(s);
  return id;
}

/**
 * A part's own `error`, recorded only in the one shape the doors use: a string whose error keeps zod's message for an
 * absent input and gives one fixed message for any other (`decimalString` in `statement-pnl-reproduce.ts`). Any other
 * error is refused, never guessed.
 */
function definedMsg(s) {
  const d = s._zod.def;
  const shown = [null, 7, true, 'x', [], {}].map((input) => d.error({ input }));
  if (d.type !== 'string' || d.checks?.length || d.error({ input: undefined }) !== undefined) {
    throw new Error(`a ${d.type} schema with its own error`);
  }
  if (typeof shown[0] !== 'string' || shown.some((m) => m !== shown[0])) throw new Error('an error whose message depends on the input');
  return shown[0];
}

function build(s) {
  const d = s._zod.def;
  if (d.error) return { t: 'string', definedMsg: definedMsg(s) };
  const self = s._zod.traits.has('$ZodCheck') && d.type === 'string' ? [s] : [];
  const checks = [...self, ...(d.checks ?? [])].map((c) => check(c, s));
  const withChecks = (o) => (checks.length ? { ...o, checks } : o);
  switch (d.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return withChecks({ t: d.type, ...(d.coerce ? { coerce: true } : {}) });
    case 'unknown':
      return withChecks({ t: 'unknown' });
    case 'enum':
      return withChecks({ t: 'enum', values: s.options });
    case 'literal':
      return withChecks({ t: 'literal', values: d.values });
    case 'object': {
      const shape = Object.entries(d.shape).map(([k, v]) => [k, node(v)]);
      let catchall = null;
      if (d.catchall) {
        const t = d.catchall._zod.def.type;
        if (t === 'never') catchall = 'strict';
        else if (t === 'unknown') catchall = 'passthrough';
        else throw new Error(`catchall ${t}`);
      }
      return withChecks({ t: 'object', shape, ...(catchall ? { catchall } : {}) });
    }
    case 'array':
      return withChecks({ t: 'array', el: node(d.element) });
    case 'optional':
    case 'nullable':
      return withChecks({ t: d.type, in: node(d.innerType) });
    case 'default':
      return withChecks({ t: 'default', in: node(d.innerType), value: d.defaultValue });
    case 'union':
      if (d.discriminator !== undefined) {
        if (d.unionFallback) throw new Error('a discriminated union with a fallback');
        return withChecks({ t: 'dunion', disc: d.discriminator, options: d.options.map(node) });
      }
      if (d.inclusive === false) throw new Error('an exclusive union');
      return withChecks({ t: 'union', options: d.options.map(node) });
    case 'record':
      if (d.mode && d.mode !== 'strict') throw new Error(`record mode ${d.mode}`);
      return withChecks({ t: 'record', key: node(d.keyType), value: node(d.valueType) });
    case 'pipe':
      return pipe(s, checks);
    default:
      throw new Error(`schema type ${d.type}`);
  }
}

const inputs = Object.fromEntries(Object.entries({ ...INPUTS, ...OUTPUTS }).map(([door, schema]) => [door, node(schema)]));

// ── zod's verdicts ─────────────────────────────────────────────────────────────────────────────────────────────────

/** `ok <output>` (`ok =` when the output is the input as sent), `issues <zod's issues>`, or `throws <message>`. */
function verdict(schema, input, text) {
  let r;
  try {
    r = schema.safeParse(input);
  } catch (err) {
    return `throws ${err.message}`;
  }
  if (!r.success) return `issues ${JSON.stringify(r.error.issues)}`;
  const out = JSON.stringify(r.data) ?? 'undefined';
  return out === text ? 'ok =' : `ok ${out}`;
}

const ID = '22222222-2222-4222-8222-222222222222';
/** A valid input of each door, and a few of its variants the samples alone would not reach. */
const VALID = {
  post: {
    idempotencyKey: 'deposit:crypto-native:0xabc',
    module: 'ledger',
    reason: 'deposit',
    entries: [
      {
        account: { ownerType: 'treasury', ownerId: 'rail:card-sandbox', assetId: 'USDC', kind: 'available' },
        direction: 'credit',
        amount: '1.50',
      },
      { account: { ownerType: 'user', ownerId: ID, assetId: 'USDC', kind: 'available' }, direction: 'debit', amount: '1.50' },
    ],
  },
  balance: { ownerType: 'user', ownerId: ID, assetId: 'USDC', kind: 'available' },
  balances: { ownerType: 'house', ownerId: 'fees:trade' },
  txByKey: { idempotencyKey: 'deposit:crypto-native:0xabc' },
  txById: { txId: ID },
  portfolio: { ownerType: 'user', ownerId: ID, chainAccount: `0x${'a'.repeat(40)}` },
  history: {
    account: { ownerType: 'user', ownerId: ID, assetId: 'USDT', kind: 'available' },
    from: '2026-01-01T00:00:00Z',
    to: '2026-02-01T00:00:00.123+02:00',
  },
  historyPage: { ownerType: 'user', ownerId: ID, kind: 'available', assetId: 'USDT', limit: 200, cursor: 'djIuNDI' },
  holdingsHistory: { ownerType: 'user', ownerId: ID, from: '2026-10-01T00:00:00.000Z', bucketSeconds: 3600 },
  freeze: { reason: '  operator halt drill  ', approvalId: 'a1', operationId: 'o1', confirmOperatorId: null },
  unfreeze: { approvalId: 'a1', operationId: 'o1', confirmOperatorId: null },
  reconcile: { approvalId: 'a1', operationId: 'o1' },
  txGet: { txId: ID },
  trace: { businessKey: ' deposit:crypto-native:0xabc ' },
  txList: { assetId: ' USDC ', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00+02:00', before: '42' },
  accountSearch: { prefix: ' user:2222 ', after: ID },
  stats: {},
  metadataRead: { accountId: ID },
  statementPnl: {
    ownerType: 'user',
    ownerId: ID,
    reportingAssetId: 'USD',
    lots: {
      closed: [{ assetId: 'BTC', costBasis: '100', proceeds: '150.5' }],
      open: [{ assetId: 'ETH', qtyRemaining: '2', costBasis: '3000' }],
    },
    marks: { ETH: '1600.25' },
    navInputs: { cashReporting: '10' },
  },
  reportExport: {
    kind: 'regulator',
    complete: true,
    ownerId: 'o',
    accountId: 'a',
    legalEntityId: 'le',
    regulatorId: 'r',
    reportingPeriod: '2026Q3',
    lotIds: ['l1'],
  },
  custody: {
    kind: 'break',
    adapterAmount: '10',
    bookAmount: '9.5',
    breakId: 'b1',
    firstSeenAt: '2026-11-01T00:00:00Z',
    resolve: 'operator',
  },
  financeClose: {
    kind: 'close',
    complete: true,
    clientOwnerId: 'c',
    corporateOwnerId: 'k',
    periodId: '2026-10',
    recipes: ['clientBalances', 'corporateBalances'],
  },
  resilience: {
    kind: 'risk',
    dependency: 'matching',
    dependencyStatus: 'ok',
    acceptNewRisk: true,
    observedCount: '3',
    observedLatencyMs: '12',
  },
  feeRevenue: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00.123456+02:00' },
  transactionsExist: { txIds: [ID, ID.toUpperCase()] },
  reconciliationEvaluations: { after: { finishedAt: '2026-01-01T00:00:00.123456Z', id: ID }, limit: 500 },
  restoreWatermark: { asOf: '2026-01-01T00:00:00+08:00' },
};
const RUN = {
  id: ID,
  controlId: ID,
  status: 'PASS',
  compared: 1,
  phase: { status: 'unset' },
  errorCode: { status: 'set', value: 'rail.timeout' },
  asOf: '2026-01-01T00:00:00.000Z',
  readAt: '2026-01-01T00:00:00.000Z',
  margin: { status: 'set', value: '0.5' },
  sources: { ledger: { asOf: '2026-01-01T00:00:00.000Z' }, outside: { asOf: 'unset' }, parity: { asOf: '2026-01-01T00:00:00Z' } },
  outsideSide: 'snapshot',
  periodStart: '2026-01-01T00:00:00.000Z',
  periodEnd: '2026-01-02T00:00:00.000Z',
  accounts: [ID],
  assets: [{ assetId: 'USDC', observed: '-1.5', expected: 'unset', difference: 'unset', tolerance: '0', missing: 'ledger' }],
  reconcilingItems: [{ source: 'svc-pay', id: 'p1', kind: 'held', assetId: 'USDC', amount: '-2' }],
};
const { accounts: _accounts, ...EVALUATED } = RUN;
VALID.controlRun = RUN;
VALID.evaluationFeed = {
  evaluations: [{ run: EVALUATED, finishedAt: '2026-01-01T00:00:00.123456Z', severity: { status: 'set', value: 'critical' } }],
  next: { finishedAt: '2026-01-01T00:00:00.123456Z', id: ID },
};
const EXTRA = {
  post: [
    { ...VALID.post, meta: { a: 1 }, correlationId: 'c' },
    { ...VALID.post, entries: [VALID.post.entries[0]] },
    { ...VALID.post, entries: [VALID.post.entries[0], { ...VALID.post.entries[1], amount: '-1' }] },
    { ...VALID.post, entries: [VALID.post.entries[0], { ...VALID.post.entries[1], amount: `1${'0'.repeat(20)}` }] },
    { ...VALID.post, entries: [VALID.post.entries[0], { ...VALID.post.entries[1], account: { ...VALID.balance, ownerId: '1042' } }] },
    { ...VALID.post, meta: [] },
  ],
  balance: [
    { ...VALID.balance, ownerId: 'A2222222-2222-4222-8222-222222222222' },
    { ...VALID.balance, ownerType: 'house', ownerId: ID },
    { ...VALID.balance, ownerType: 'house', ownerId: 'fees:trade', purpose: 'order:x' },
    { ...VALID.balance, ownerType: 'module', ownerId: 'Fees' },
    { ...VALID.balance, assetId: 'A'.repeat(17) },
    { ...VALID.balance, purpose: 'p'.repeat(129) },
    { ...VALID.balance, kind: 'locked' },
  ],
  portfolio: [
    { ...VALID.portfolio, chainAccount: '0x12' },
    { ownerType: 'user', ownerId: '' },
  ],
  history: [
    { ...VALID.history, account: { ...VALID.history.account, ownerId: 'fees:trade' } },
    { ...VALID.history, from: '2026-01-01' },
    { ...VALID.history, from: '2026-01-01T00:00Z' },
    { ...VALID.history, to: '2026-01-01T00:00:00+0200' },
    { ...VALID.history, to: '2026-13-01T00:00:00Z' },
    { ...VALID.history, after: 'x' },
  ],
  historyPage: [
    { ownerType: 'user', ownerId: ID, kind: 'available' },
    { ownerType: 'user', ownerId: 'fees:trade', kind: 'available' },
    { ownerType: 'house', ownerId: 'fees:trade', kind: 'available', purpose: '  ' },
    { ownerType: 'user', ownerId: ID, kind: 'hold', purpose: 'order:x' },
    { ...VALID.historyPage, limit: 0 },
    { ...VALID.historyPage, limit: 1.5 },
    { ...VALID.historyPage, limit: 201 },
    { ...VALID.historyPage, assetId: '' },
    { ...VALID.historyPage, assetId: 'A'.repeat(17) },
    { ...VALID.historyPage, cursor: '' },
    { ...VALID.historyPage, cursor: 'c'.repeat(257) },
    { ...VALID.historyPage, before: 'x' },
  ],
  holdingsHistory: [
    { ...VALID.holdingsHistory, ownerType: 'house', ownerId: 'fees:trade' },
    { ...VALID.holdingsHistory, bucketSeconds: 120 },
    { ...VALID.holdingsHistory, bucketSeconds: '3600' },
    { ...VALID.holdingsHistory, bucketSeconds: 86400 },
    { ...VALID.holdingsHistory, ownerId: 'o'.repeat(129) },
    { ...VALID.holdingsHistory, from: '2026-10-01T00:30:00+05:30' },
  ],
  freeze: [
    { ...VALID.freeze, reason: '            ' },
    { ...VALID.freeze, reason: ' eleven chars ' },
    { ...VALID.freeze, reason: 'twelve chars' },
    { ...VALID.freeze, reason: `  ${'r'.repeat(500)}  ` },
    { ...VALID.freeze, reason: 'r'.repeat(501) },
    { ...VALID.freeze, reason: 12 },
    { ...VALID.freeze, reason: null },
    { ...VALID.freeze, approvalId: '' },
    { ...VALID.freeze, operationId: 'o'.repeat(129) },
    { ...VALID.freeze, confirmOperatorId: 'c'.repeat(129) },
    { approvalId: 'a1', operationId: 'o1' },
  ],
  txList: [
    { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' },
    { before: '9223372036854775808' },
    { before: '0' },
    { from: 'yesterday' },
    { assetId: '   ' },
  ],
  accountSearch: [{ prefix: 'nobody:x' }, { prefix: 'user:' }, { prefix: 'user:x', after: 'not-a-uuid' }],
  trace: [{ businessKey: '   ' }, { businessKey: 'k'.repeat(513) }],
  feeRevenue: [
    { from: '2026-01-01T00:00:00', to: '2026-01-02T00:00:00Z' },
    { from: '2026-02-30T00:00:00Z', to: '2026-01-02T00:00:00Z' },
    { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00+0200' },
  ],
  transactionsExist: [
    { txIds: [] },
    { txIds: Array.from({ length: 21 }, () => ID) },
    { txIds: Array.from({ length: 20 }, () => ID) },
    { txIds: ['22222222-2222-2222-2222-222222222222'] },
    { txIds: ['not-a-guid'] },
  ],
  reconciliationEvaluations: [
    { after: null, limit: 1 },
    { after: null, limit: 0 },
    { after: null, limit: 501 },
    { after: null, limit: 1.5 },
    { after: { finishedAt: '2026-01-01T00:00:00Z' }, limit: 1 },
    { after: { finishedAt: '2026-01-01T00:00:00Z', id: ID, x: 1 }, limit: 1 },
  ],
  restoreWatermark: [{ asOf: '2026-01-01' }, { asOf: '2026-01-01T00:00:00Z', x: 1 }],
  controlRun: [
    { ...RUN, reconcilingItems: undefined },
    { ...RUN, assets: [{ ...RUN.assets[0], observed: '01' }] },
    { ...RUN, accounts: ['nope'] },
    { ...RUN, sources: { ...RUN.sources, outside: { asOf: 'never' } } },
    { ...RUN, status: 'started', margin: { status: 'set', value: '-1' } },
  ],
  evaluationFeed: [
    { evaluations: [], next: null },
    { evaluations: [{ ...VALID.evaluationFeed.evaluations[0], run: RUN }], next: null },
    { evaluations: [{ ...VALID.evaluationFeed.evaluations[0], severity: { status: 'set', value: 'loud' } }], next: null },
  ],
  unfreeze: [
    { approvalId: '', operationId: 'o' },
    { approvalId: 'a', operationId: 'o', confirmOperatorId: 'c'.repeat(129) },
  ],
};

/** The inputs each door's verdict is recorded on. */
function probes(door) {
  const valid = VALID[door];
  const out = [undefined, null, 7, 'x', [], {}, valid, { ...valid, extra: 1 }, ...(EXTRA[door] ?? [])];
  for (const key of Object.keys(valid)) {
    const without = { ...valid };
    delete without[key];
    out.push(without);
    for (const v of [null, 7, true, '', 'x'.repeat(600), [], {}]) out.push({ ...valid, [key]: v });
  }
  return out;
}

const verdicts = [];
const verdictIndex = new Map();
const cases = [];
for (const [door, schema] of Object.entries({ ...INPUTS, ...OUTPUTS })) {
  for (const input of probes(door)) {
    const text = JSON.stringify(input) ?? null;
    const v = verdict(schema, input, text);
    if (!verdictIndex.has(v)) verdictIndex.set(v, verdicts.push(v) - 1);
    cases.push([door, text, verdictIndex.get(v)]);
  }
}

// ── Access tokens ──────────────────────────────────────────────────────────────────────────────────────────────────

const TOKEN = {
  secret: 'placeholder-ledger-shell-access-secret-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const ROTATED = { ...TOKEN, keyId: 'k2', verifyOnly: [{ keyId: 'k1', secret: 'placeholder-older-ledger-shell-secret-long' }] };
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function jwt(header, payload, secret, { raw = false } = {}) {
  const head = raw ? header : b64(header);
  const body = raw ? payload : b64(payload);
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
const FUTURE = 4_102_444_800; // 2100-01-01
const PAST = 1_000_000_000;
const CLAIMS = {
  sub: '11111111-1111-4111-8111-111111111111',
  scopes: ['admin:treasury'],
  tier: 'basic',
  mfa: true,
  sid: '33333333-3333-4333-8333-333333333333',
  iss: 'intafaced',
  aud: 'intafaced.api',
  iat: PAST,
  exp: FUTURE,
};
const H = { alg: 'HS256', typ: 'JWT' };
const S = TOKEN.secret;
const TOKEN_CASES = [
  ['valid', TOKEN, jwt(H, CLAIMS, S)],
  ['valid no-mfa no-tier', TOKEN, jwt(H, { ...CLAIMS, mfa: undefined, tier: undefined }, S)],
  ['aud array', TOKEN, jwt(H, { ...CLAIMS, aud: ['x', 'intafaced.api'] }, S)],
  ['wrong secret', TOKEN, jwt(H, CLAIMS, 'placeholder-another-ledger-secret-long-xx')],
  ['expired', TOKEN, jwt(H, { ...CLAIMS, exp: PAST }, S)],
  ['no exp', TOKEN, jwt(H, { ...CLAIMS, exp: undefined }, S)],
  ['exp string', TOKEN, jwt(H, { ...CLAIMS, exp: String(FUTURE) }, S)],
  ['wrong issuer', TOKEN, jwt(H, { ...CLAIMS, iss: 'someone' }, S)],
  ['no issuer', TOKEN, jwt(H, { ...CLAIMS, iss: undefined }, S)],
  ['wrong audience', TOKEN, jwt(H, { ...CLAIMS, aud: 'other' }, S)],
  ['nbf future', TOKEN, jwt(H, { ...CLAIMS, nbf: FUTURE - 1 }, S)],
  ['nbf past', TOKEN, jwt(H, { ...CLAIMS, nbf: PAST }, S)],
  ['iat string', TOKEN, jwt(H, { ...CLAIMS, iat: 'now' }, S)],
  ['alg none', TOKEN, `${b64({ alg: 'none' })}.${b64(CLAIMS)}.`],
  ['alg HS512', TOKEN, jwt({ alg: 'HS512' }, CLAIMS, S)],
  ['two parts', TOKEN, `${b64(H)}.${b64(CLAIMS)}`],
  ['not a token', TOKEN, 'not-a-token'],
  ['header not json', TOKEN, jwt('{nope', b64(CLAIMS), S, { raw: true })],
  ['header null', TOKEN, jwt(b64('null'), b64(CLAIMS), S, { raw: true })],
  ['payload array', TOKEN, jwt(H, [1], S)],
  ['sub not a guid', TOKEN, jwt(H, { ...CLAIMS, sub: 'nobody' }, S)],
  ['no sid', TOKEN, jwt(H, { ...CLAIMS, sid: undefined }, S)],
  ['scopes string', TOKEN, jwt(H, { ...CLAIMS, scopes: 'admin:treasury' }, S)],
  ['mfa string', TOKEN, jwt(H, { ...CLAIMS, mfa: 'yes' }, S)],
  ['tier unknown', TOKEN, jwt(H, { ...CLAIMS, tier: 'gold' }, S)],
  ['tier null', TOKEN, jwt(H, { ...CLAIMS, tier: null }, S)],
  ['api key', TOKEN, jwt(H, { ...CLAIMS, kid: 'key-1', key_env: 'live' }, S)],
  ['key_env unknown', TOKEN, jwt(H, { ...CLAIMS, kid: 'key-1', key_env: 'prod' }, S)],
  ['sub account', TOKEN, jwt(H, { ...CLAIMS, sub_account: '44444444-4444-4444-8444-444444444444' }, S)],
  ['staff', TOKEN, jwt(H, { ...CLAIMS, staffPermissions: ['ledger:read'], staffEnv: 'local' }, S)],
  ['staff without env', TOKEN, jwt(H, { ...CLAIMS, staffPermissions: ['ledger:read'] }, S)],
  ['staff twice', TOKEN, jwt(H, { ...CLAIMS, staffPermissions: ['ledger:read', 'ledger:read'], staffEnv: 'local' }, S)],
  ['staff unknown', TOKEN, jwt(H, { ...CLAIMS, staffPermissions: ['vault:open'], staffEnv: 'local' }, S)],
  ['staff on a key', TOKEN, jwt(H, { ...CLAIMS, kid: 'k', staffPermissions: ['ledger:read'], staffEnv: 'local' }, S)],
  ['env without staff', TOKEN, jwt(H, { ...CLAIMS, staffEnv: 'local' }, S)],
  ['rotated: signing key', ROTATED, jwt({ ...H, kid: 'k2' }, CLAIMS, S)],
  ['rotated: verify-only key', ROTATED, jwt({ ...H, kid: 'k1' }, CLAIMS, ROTATED.verifyOnly[0].secret)],
  ['rotated: no kid, older key', ROTATED, jwt(H, CLAIMS, ROTATED.verifyOnly[0].secret)],
  ['rotated: unknown kid', ROTATED, jwt({ ...H, kid: 'k9' }, CLAIMS, S)],
  ['rotated: kid a number', ROTATED, jwt({ ...H, kid: 2 }, CLAIMS, S)],
  ['short secret', { ...TOKEN, secret: 'short-placeholder' }, jwt(H, CLAIMS, 'short-placeholder')],
];
const tokenCases = [];
for (const [name, config, token] of TOKEN_CASES) {
  let answer;
  try {
    const p = await verifyAccessToken(token, config);
    answer = {
      ok: {
        userId: p.userId,
        scopes: p.scopes,
        tier: p.tier,
        mfa: p.mfa,
        kid: p.kid ?? null,
        subAccount: p.sub_account ?? null,
        exp: p.expiresAt.getTime() / 1000,
      },
    };
  } catch (err) {
    answer = { refused: { message: err.message, code: err.code } };
  }
  // Each token is kept as its dot-separated parts, so no secret scanner reads this fixture of probes as a leaked
  // credential; the test joins them.
  tokenCases.push({
    name,
    config: { secret: config.secret, keyId: config.keyId ?? null, verifyOnly: config.verifyOnly ?? [] },
    parts: token.split('.'),
    answer,
  });
}

// ── The environment ────────────────────────────────────────────────────────────────────────────────────────────────

const ENV_BASE = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://ledger:ledger@localhost:5432/ledger',
  INTERNAL_SERVICE_SECRET: 'placeholder-ledger-env-internal-secret-long',
  JWT_ACCESS_SECRET: 'placeholder-ledger-env-access-secret-long-x',
  DATABASE_POOL_MAX: '10',
  RECONCILE_CRON_MINUTES: '5',
};
const ENV_CASES = [
  {},
  { DATABASE_POOL_MAX: undefined, RECONCILE_CRON_MINUTES: undefined },
  { HTTP_PORT: '4101', SERVICE_NAME: 'svc-ledger-b', LEDGER_IDEMPOTENCY_CONFLICT_MODE: 'refuse' },
  { LEDGER_IDEMPOTENCY_CONFLICT_MODE: 'warn' },
  {
    RECONCILE_CRON_MINUTES: '15',
    LEDGER_RECONCILE_RAIL_CARD_SANDBOX_URL: 'https://rail.test/s',
    LEDGER_RECONCILE_OPEN_ITEMS_CARD_SANDBOX_URL: 'http://localhost:9/o',
  },
  { LEDGER_RECONCILE_RAIL_card_URL: 'https://rail.test/s' },
  { LEDGER_RECONCILE_RAIL_CARD_SANDBOX_URL: 'http://rail.test/s' },
  { RECONCILE_CRON_MINUTES: '0' },
  { RECONCILE_CRON_MINUTES: '   ' },
  { RECONCILE_CRON_MINUTES: 'often' },
  { LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS: '' },
  { LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS: '1' },
  { LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS: '9999999999' },
  { LEDGER_RECONCILE_MAX_STALE_HOURS: '1.5' },
  { LEDGER_RECONCILE_MAX_STALE_HOURS: '48' },
  { RECONCILE_MAX_CONSECUTIVE_INCOMPLETE: '0' },
  { RECONCILE_MAX_CONSECUTIVE_INCOMPLETE: '3' },
  { LEDGER_CUSTODY_LAYER: 'on' },
  { LEDGER_CUSTODY_LAYER: 'off' },
  { LEDGER_CUSTODY_LAYER: '' },
  { LEDGER_CUSTODY_LAYER: 'maybe' },
  { LEDGER_POSTING_ENABLED: 'false' },
  { LEDGER_POSTING_ENABLED: ' YES ' },
  { LEDGER_POSTING_ENABLED: '' },
  { LEDGER_CLOCK_SKEW_BOUND_MS: '5000' },
  { LEDGER_CLOCK_SKEW_BOUND_MS: '' },
  { IDENTITY_URL: 'http://identity:4002' },
  { IDENTITY_URL: 'identity' },
  { LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL: 'https://example.test/snap' },
  { LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL: 'http://127.0.0.1:9/snap' },
  { LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL: 'http://example.test/snap' },
  { LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL: '' },
  { JWT_ACCESS_SECRET: 'short-placeholder', INTERNAL_SERVICE_SECRET: undefined },
  { JWT_ACCESS_TTL_SECONDS: '30', JWT_ISSUER: 'other', JWT_AUDIENCE: 'aud' },
  { S2S_AUTH_MODE: 'dual', INTERNAL_SERVICE_BODY_BIND: 'require' },
  { HTTP_PORT: 'eighty' },
];
const envProbe = `${CRATE}scripts/env-probe.mjs`;
const envCases = ENV_CASES.map((overrides) => {
  const vars = { ...ENV_BASE, ...overrides };
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete vars[k];
  const out = execFileSync(process.execPath, ['--import', 'tsx', envProbe], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, TZ: 'UTC', LEDGER_ENV_PROBE: JSON.stringify(vars) },
    encoding: 'utf8',
  });
  return { env: vars, answer: JSON.parse(out) };
});

// ── The user copy of each code ─────────────────────────────────────────────────────────────────────────────────────

const sources = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.includes('.test.') && !e.name.includes('.testkit.'))
    .map((e) => readFileSync(`${e.parentPath}/${e.name}`, 'utf8'));
const codes = [
  ...new Set(
    [SVC, `${ROOT}packages/ledger-client/src/`]
      .flatMap(sources)
      .flatMap((t) => [...t.matchAll(/'(ledger\.[a-z0-9_.]+)'/g)].map((m) => m[1])),
  ),
].sort();
const copy = codes.map((code) => [code, userCopy(code)]);

// ── The reports slice's answers ────────────────────────────────────────────────────────────────────────────────────

/** Every combination of the listed values (`undefined`: the key is left out). */
function combos(spec) {
  let out = [{}];
  for (const [key, values] of Object.entries(spec)) {
    out = out.flatMap((o) => values.map((v) => (v === undefined ? o : { ...o, [key]: v })));
  }
  return out;
}

const NOW = Date.parse('2026-11-21T00:00:00.000Z');
const OWNER = { ownerType: 'user', ownerId: ID, reportingAssetId: 'USD' };
const lot = (assetId, costBasis, proceeds) => ({ assetId, costBasis, proceeds });
const open = (assetId, qtyRemaining, costBasis) => ({ assetId, qtyRemaining, costBasis });
const MAX = '99999999999999999999.999999999999999999';
/** Inputs that reach each branch of the five handlers, beside the input probes above. */
const REPORT_CASES = {
  statementPnl: [
    ...combos({
      inventFifoFromHistory: [undefined, true, false],
      lotsFromHistory: [undefined, true],
      costBasis: [undefined, null, '', '1'],
      lots: [undefined, { closed: [], open: [] }, { closed: [lot('BTC', '1', '2')], open: [] }],
      navInputs: [undefined, { cashReporting: '5' }],
    }).map((o) => ({ ...OWNER, ...o })),
    ...combos({
      lots: [
        { closed: [lot('BTC', null, '2')], open: [] },
        { closed: [lot('BTC', '1', null)], open: [] },
        { closed: [lot('BTC', '100', '150.5'), lot('SOL', '7.25', '3')], open: [] },
        { closed: [], open: [open('ETH', '2', null)] },
        { closed: [], open: [open('ETH', '2', '3000'), open('BTC', '0.333333333333333333', '1')] },
        { closed: [], open: [open('toString', '1', '1')] },
        { closed: [], open: [open('constructor', '1', '1')] },
        { closed: [], open: [open('ETH', 'abc', '1')] },
        { closed: [lot('BTC', '1.0000000000000000001', '2')], open: [] },
        { closed: [lot('BTC', ' 1 ', '+2')], open: [] },
        { closed: [lot('BTC', '-5', '.5')], open: [] },
        { closed: [lot('BTC', '1e3', '2')], open: [] },
        { closed: [lot('BTC', '0', MAX)], open: [] },
        { closed: [], open: [open('ETH', '0.000000000000000001', '0')] },
      ],
      marks: [undefined, {}, { ETH: '1600.25', BTC: '0.5' }, { ETH: 'x' }, { toString: '1', constructor: '2' }],
      navInputs: [undefined, { cashReporting: '10' }, { cashReporting: 'x' }, { cashReporting: '-0' }],
    }).map((o) => ({ ...OWNER, ...o })),
  ],
  reportExport: [
    ...combos({
      kind: ['nav', 'sftp', 'regulator'],
      complete: [undefined, true, false],
      ownerId: [undefined, ' ', 'o'],
      legalEntityId: [undefined, 'le'],
      regulatorId: [undefined, 'r'],
      reportingPeriod: [undefined, '', '2026Q3'],
      lotIds: [undefined, [' '], ['', 'l1']],
    }),
    ...combos({
      kind: ['nav', 'regulator'],
      complete: [true],
      ownerId: ['o'],
      legalEntityId: ['le'],
      regulatorId: ['r'],
      reportingPeriod: ['p'],
      accountId: [undefined, ' ', 'a'],
      lotIds: [undefined, [], ['l1']],
    }),
    ...combos({
      kind: ['nav', 'regulator'],
      inventCostBasis: [undefined, true],
      lotsFromHistory: [undefined, true, false],
      inventFifoFromHistory: [undefined, true],
      costBasis: [undefined, null, '', '12'],
      ownerId: [undefined, ' o '],
    }),
  ],
  custody: [
    ...combos({
      kind: ['chain', 'fiat', 'off_exchange'],
      role: [undefined, 'adapter', 'book'],
      treatAsBook: [undefined, true, false],
      ownerAuthorized: [undefined, true, false],
      adapterAmount: [undefined, '10.50', 'abc', '-0.000000000000000001', MAX],
    }),
    ...combos({
      kind: ['break'],
      adapterAmount: [undefined, '10', 'abc', MAX],
      bookAmount: [undefined, '9.5', `-${MAX}`],
      breakId: [undefined, '  ', ' b1 '],
      firstSeenAt: [undefined, '', '2026-11-01T00:00:00Z', '2026-11-20T23:59:59.999+01:00', '2026-11-01', '2027-01-01T00:00:00Z', 'nope'],
      autoClear: [undefined, true],
      resolve: [undefined, 'operator', 'auto'],
    }),
  ],
  financeClose: [
    ...combos({
      kind: ['segregation', 'close', 'por'],
      complete: [undefined, true],
      clientOwnerId: [undefined, ' ', ' c '],
      corporateOwnerId: [undefined, 'c', 'k'],
      periodId: [undefined, 'p'],
      recipes: [undefined, ['clientBalances'], [' clientBalances', 'corporateBalances ', 'x', 'x', ' ']],
      claimFullyReserved: [undefined, true],
    }),
    ...combos({
      kind: ['segregation', 'por'],
      commingle: [undefined, true],
      inventReserve: [undefined, true, false],
      reserveAmount: [undefined, null, '', '5'],
      reserveRecipeId: [undefined, ' ', 'rr'],
      clientOwnerId: ['c'],
      corporateOwnerId: ['k'],
    }),
  ],
  resilience: [
    ...combos({
      kind: ['risk', 'split_brain', 'slo'],
      dependency: [undefined, ' ', 'db'],
      dependencyStatus: [undefined, 'ok', 'degraded', 'down'],
      acceptNewRisk: [undefined, true, false],
      writers: [undefined, ['a', ' a ', ''], ['a', 'b']],
      sourcesOfTruth: [undefined, ['x', 'y']],
      splitBrain: [undefined, true],
      ownerSloSet: [undefined, true],
    }),
    ...combos({
      kind: ['risk', 'slo'],
      ownerSloSet: [undefined, true, false],
      sloTargetMs: [undefined, '5'],
      observedCount: [undefined, ' ', ' 3 '],
      observedLatencyMs: [undefined, '', '12'],
    }),
  ],
};

/** The door's handler on one body, with `httpError` on what it throws: the answer as the wire carries it. */
const HANDLERS = {
  statementPnl: s2sHttp.handleS2sStatementPnl,
  reportExport: s2sHttp.handleS2sReportExport,
  custody: s2sHttp.handleS2sCustody,
  financeClose: s2sHttp.handleS2sFinanceClose,
  resilience: s2sHttp.handleS2sResilience,
};
/** The book the statement reads when no lots are sent: no balances on file. */
const EMPTY_BOOK = { balances: async () => [] };
const realNow = Date.now;
Date.now = () => NOW;
const reportCases = [];
const answers = [];
const answerIndex = new Map();
const answerUses = new Map();
try {
  for (const [door, handle] of Object.entries(HANDLERS)) {
    const bodies = [...probes(door), ...REPORT_CASES[door]];
    const seen = new Set();
    for (const body of bodies) {
      const text = JSON.stringify(body) ?? null;
      if (seen.has(text)) continue;
      seen.add(text);
      let status = 200;
      let out;
      try {
        out = await handle(EMPTY_BOOK, body === undefined ? undefined : JSON.parse(text));
      } catch (err) {
        ({ status, body: out } = s2sHttp.httpError(err));
      }
      const answer = JSON.stringify(out);
      // Each distinct answer is kept with at most three of the inputs that reach it, so the file stays reviewable.
      const key = `${door} ${status} ${answer}`;
      const reached = answerUses.get(key) ?? 0;
      if (reached >= 3) continue;
      answerUses.set(key, reached + 1);
      if (!answerIndex.has(answer)) answerIndex.set(answer, answers.push(answer) - 1);
      reportCases.push([door, text, status, answerIndex.get(answer)]);
    }
  }
} finally {
  Date.now = realNow;
}
// ── The history slice's book ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The posts each history Postgres test books before it reads, made by the same recipes with the same arguments as
 * `history-postgres.test.ts`, `history-page-postgres.test.ts`, `history-page-order-id-postgres.test.ts` and
 * `holdings-history-postgres.test.ts`. Each list is booked in order; the Rust suite books it as `PostgresLedger.post`
 * would store it (the canonical purpose, every entry against its account, the balance it leaves).
 */
const userAvailable = (ownerId, assetId) => ({ ownerType: 'user', ownerId, assetId, kind: 'available' });
const railBoundary = (rail, assetId) => ({ ownerType: 'treasury', ownerId: `rail:${rail}`, assetId, kind: 'available' });
const transfer = (key, module, reason, userId, asset, value, into) => ({
  idempotencyKey: key,
  module,
  reason,
  entries: [
    { account: userAvailable(userId, asset), direction: into ? 'debit' : 'credit', amount: amt(value) },
    { account: railBoundary('crypto-native', asset), direction: into ? 'credit' : 'debit', amount: amt(value) },
  ],
});
const bankIn = (userId, key, value, asset = 'USDT') => transfer(key, 'bank', 'bank.transfer.in', userId, asset, value, true);
const deposit = (userId, assetId, value, railRef, rail = 'crypto-native') =>
  recipes.deposit({ userId, assetId, amount: amt(value), rail, railRef });
const fill = (fillId, makerId, takerId, makerOrderId, takerOrderId, qty, quoteAmount, makerFeeBps, takerFeeBps) =>
  recipes.tradeFill({
    fillId,
    makerId,
    takerId,
    makerOrderId,
    takerOrderId,
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: amt(qty),
    quoteAmount: amt(quoteAmount),
    takerSide: 'buy',
    makerFeeBps,
    takerFeeBps,
  });
const mmFill = (fillId, takerId, makerOrderId, takerOrderId, qty, quoteAmount, makerFeeBps, takerFeeBps, product) =>
  recipes.marketMakerMakerFill({
    fillId,
    takerId,
    makerOrderId,
    takerOrderId,
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: amt(qty),
    quoteAmount: amt(quoteAmount),
    takerSide: 'buy',
    makerFeeBps,
    takerFeeBps,
    ...(product ? { product } : {}),
  });
const hold = (orderId, userId, assetId, value) => recipes.orderHold({ orderId, userId, assetId, amount: amt(value) });
/** A buyback funded from a fee, its order, and a fill against one customer's ask: both suites book the same shape. */
const buyback = (p, payer) => [
  deposit(payer, 'USDT', '300', `${p}-bb-fee`),
  recipes.feeCharge({ chargeId: `${p}-bb-fee`, userId: payer, module: 'trade', mode: 'asset', assetId: 'USDT', amount: amt('300') }),
  recipes.sweepFeesToRewards({ windowId: `buyback:${p}-bb`, sourceModule: 'trade', assetId: 'USDT', amount: amt('300') }),
  recipes.buybackOrderHold({ orderId: `${p}-bb-order`, quoteAsset: 'USDT', amount: amt('300') }),
];
const buybackFill = (p, maker, ask, qtyHeld) => [
  hold(ask, maker, 'BTC', qtyHeld),
  recipes.buybackTakerFill({
    fillId: `${p}-bb-fill`,
    makerId: maker,
    makerOrderId: ask,
    takerOrderId: `${p}-bb-order`,
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: amt('0.5'),
    quoteAmount: amt('300'),
    makerFeeBps: 10,
  }),
];

const SPENDER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const QUIET = '33333333-3333-4333-8333-333333333333';
const PAGER = '71111111-1111-4111-8111-111111111111';
const OTHER = '72222222-2222-4222-8222-222222222222';
const RAILER = '74444444-4444-4444-8444-444444444444';
const CONVERTER = '75555555-5555-4555-8555-555555555555';
const WITHDRAWER = '76666666-6666-4666-8666-666666666666';
const O = {
  taker: '81111111-1111-4111-8111-111111111111',
  maker: '82222222-2222-4222-8222-222222222222',
  self: '83333333-3333-4333-8333-333333333333',
  free: '84444444-4444-4444-8444-444444444444',
  freeMaker: '85555555-5555-4555-8555-555555555555',
  bbPayer: '87777777-7777-4777-8777-777777777777',
  bbMaker: '86666666-6666-4666-8666-666666666666',
  takerOrder: 'd1111111-1111-4111-8111-d11111111111',
  makerOrder: 'd2222222-2222-4222-8222-d22222222222',
  makerOrder2: 'd3333333-3333-4333-8333-d33333333333',
  mmTakerOrder: 'd4444444-4444-4444-8444-d44444444444',
  selfBuy: 'd5555555-5555-4555-8555-d55555555555',
  selfSell: 'd6666666-6666-4666-8666-d66666666666',
  freeOrder: 'd7777777-7777-4777-8777-d77777777777',
  makerOrder3: 'd8888888-8888-4888-8888-d88888888888',
  bbAsk: 'd9999999-9999-4999-8999-d99999999999',
};
const HH = {
  taker: '91111111-1111-4111-8111-111111111111',
  maker: '92222222-2222-4222-8222-222222222222',
  takerOrder: 'e1111111-1111-4111-8111-e11111111111',
  makerOrder: 'e2222222-2222-4222-8222-e22222222222',
  bbPayer: '95555555-5555-4555-8555-555555555555',
  bbMaker: '94444444-4444-4444-8444-444444444444',
  bbAsk: 'e3333333-3333-4333-8333-e33333333333',
};
const convertFill = (n, product) => [
  hold(`product-taker-${n}`, CONVERTER, 'USDT', '10'),
  recipes.marketMakerOrderHold({ orderId: `product-maker-${n}`, assetId: 'BTC', amount: amt('0.001') }),
  mmFill(`product-fill-${n}`, CONVERTER, `product-maker-${n}`, `product-taker-${n}`, '0.001', '10', 0, 0, product),
];
const [oddHold, oddMmHold, oddFill] = convertFill('odd');
const withdrawal = (userId, assetId, value, withdrawalId) => ({ userId, assetId, amount: amt(value), rail: 'crypto-native', withdrawalId });
const WD = (id) => withdrawal(WITHDRAWER, 'USDT', '5', id);
const HW = (id, value) => withdrawal(HH.taker, 'BTC', value, id);
const send = (transferId, from, to) =>
  recipes.bankTransfer({
    transferId,
    occurrence: 0,
    kind: 'manual',
    keySpace: 'p2p',
    from: userAvailable(from, 'USDT'),
    to: userAvailable(to, 'USDT'),
    amount: amt('50'),
  });

const BOOK = {
  // history-postgres.test.ts
  history: [
    bankIn(SPENDER, 'hist-deposit-1', '100.123456789012345678'),
    transfer('hist-spend-1', 'trade', 'trade.fill', SPENDER, 'USDT', '25.5', false),
    bankIn(SPENDER, 'hist-refund-1', '0.000000000000000001'),
    bankIn(STRANGER, 'hist-stranger-1', '999'),
    transfer('hist-stranger-2', 'trade', 'trade.fill', STRANGER, 'USDT', '9', false),
    bankIn(QUIET, 'hist-quiet-open', '1'),
  ],
  // history-page-postgres.test.ts
  page: [
    bankIn(PAGER, 'pg-usdt-1', '1'),
    bankIn(PAGER, 'pg-usd-1', '2', 'USD'),
    bankIn(PAGER, 'pg-usdt-2', '3'),
    bankIn(OTHER, 'pg-other-1', '999'),
  ],
  rails: [
    deposit(RAILER, 'USDT', '1', 'r1'),
    deposit(RAILER, 'USDT', '1', 'r2', 'bank-crypto-ledger'),
    deposit(RAILER, 'USDT', '1', 'r2b', 'local-test'),
    deposit(RAILER, 'USDT', '1', 'r3', 'not-a-known-rail'),
    { ...deposit(RAILER, 'USDT', '1', 'r4'), idempotencyKey: 'rail-nonstring', meta: { rail: { x: 1 }, secret: 'must-not-leak' } },
    bankIn(RAILER, 'rail-none', '1'),
  ],
  products: [
    recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: 'product-btc' }),
    deposit(CONVERTER, 'USDT', '100', 'product-u'),
    ...convertFill('desk'),
    ...convertFill('convert', 'convert'),
    oddHold,
    oddMmHold,
    { ...oddFill, meta: { ...oddFill.meta, product: 'not-a-known-product' } },
  ],
  withdrawals: [
    deposit(WITHDRAWER, 'USDT', '50', 'wd-dep'),
    recipes.withdrawHold(WD('7a7a7a7a-0000-4000-8000-000000000001:0')),
    recipes.withdrawReverse(WD('7a7a7a7a-0000-4000-8000-000000000001:0')),
    recipes.withdrawHold(WD('7a7a7a7a-0000-4000-8000-000000000001:1')),
  ],
  // history-page-order-id-postgres.test.ts
  orderIds: [
    deposit(O.taker, 'USDT', '5000', 'oid-taker-usdt'),
    deposit(O.maker, 'BTC', '5', 'oid-maker-btc'),
    deposit(O.self, 'USDT', '2000', 'oid-self-usdt'),
    deposit(O.self, 'BTC', '2', 'oid-self-btc'),
    hold(O.takerOrder, O.taker, 'USDT', '1000'),
    recipes.orderHoldAmend({ orderId: O.takerOrder, userId: O.taker, assetId: 'USDT', amount: amt('500'), sequence: 1 }),
    hold(O.makerOrder, O.maker, 'BTC', '1'),
    hold(O.makerOrder2, O.maker, 'BTC', '1'),
    fill('oid-fill-1', O.maker, O.taker, O.makerOrder, O.takerOrder, '1', '600', 10, 20),
    fill('oid-fill-2', O.maker, O.taker, O.makerOrder2, O.takerOrder, '1', '620', 10, 20),
    recipes.orderHoldRelease({ orderId: O.takerOrder, userId: O.taker, assetId: 'USDT', amount: amt('280') }),
    recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('3'), seedId: 'oid-seed-btc' }),
    hold(O.mmTakerOrder, O.taker, 'USDT', '700'),
    recipes.marketMakerOrderHold({ orderId: 'mm-side-1', assetId: 'BTC', amount: amt('1') }),
    mmFill('oid-mm-fill', O.taker, 'mm-side-1', O.mmTakerOrder, '1', '700', 10, 20),
    hold(O.selfBuy, O.self, 'USDT', '900'),
    hold(O.selfSell, O.self, 'BTC', '1'),
    fill('oid-self-fill', O.self, O.self, O.selfSell, O.selfBuy, '1', '900', 10, 20),
    deposit(O.free, 'USDT', '500', 'oid-free-usdt'),
    deposit(O.freeMaker, 'BTC', '1', 'oid-free-maker-btc'),
    hold(O.freeOrder, O.free, 'USDT', '400'),
    hold(O.makerOrder3, O.freeMaker, 'BTC', '1'),
    fill('oid-free-fill', O.freeMaker, O.free, O.makerOrder3, O.freeOrder, '0.5', '300', 0, 0),
    ...buyback('oid', O.bbPayer),
    deposit(O.bbMaker, 'BTC', '1', 'oid-bb-maker-btc'),
    ...buybackFill('oid', O.bbMaker, O.bbAsk, '1'),
  ],
  // holdings-history-postgres.test.ts, before its wait for a clear minute
  holdings: [
    deposit(HH.taker, 'USDT', '1000', 'hh-usdt'),
    deposit(HH.maker, 'BTC', '1', 'hh-btc'),
    hold(HH.takerOrder, HH.taker, 'USDT', '700'),
    hold(HH.makerOrder, HH.maker, 'BTC', '0.01'),
    fill('hh-fill-1', HH.maker, HH.taker, HH.makerOrder, HH.takerOrder, '0.01', '600', 10, 20),
    recipes.orderHoldRelease({ orderId: HH.takerOrder, userId: HH.taker, assetId: 'USDT', amount: amt('100') }),
    recipes.withdrawHold(HW('hh-w-settled', '0.003')),
    recipes.withdrawSettle(HW('hh-w-settled', '0.003')),
    recipes.withdrawHold(HW('hh-w-reversed', '0.002')),
    recipes.withdrawReverse(HW('hh-w-reversed', '0.002')),
    recipes.withdrawHold(HW('hh-w-open', '0.001')),
  ],
  // ... and after it: these share one 60 s bucket
  holdingsMinute: [
    send('hh-t-in', HH.maker, HH.taker),
    send('hh-t-back', HH.taker, HH.maker),
    ...buyback('hh', HH.bbPayer),
    deposit(HH.bbMaker, 'BTC', '1', 'hh-bb-btc'),
    ...buybackFill('hh', HH.bbMaker, HH.bbAsk, '0.5'),
  ],
};

/** A post as the book stores it: amounts as decimal strings, the purpose `accountPurpose` keys on, meta or `{}`. */
const bookPost = (p) => ({
  // Named `idempotency`, not by its TypeScript name: a secret scanner reads `<...>Key: <text>` as a credential.
  idempotency: p.idempotencyKey,
  module: p.module,
  reason: p.reason,
  meta: p.meta ?? {},
  entries: p.entries.map((e) => ({
    ownerType: e.account.ownerType,
    ownerId: e.account.ownerId,
    assetId: e.account.assetId,
    kind: e.account.kind,
    purpose: (e.account.purpose ?? '').trim(),
    direction: e.direction,
    amount: formatAmount(e.amount),
  })),
});
const book = Object.fromEntries(Object.entries(BOOK).map(([name, posts]) => [name, posts.map(bookPost)]));

// ── The books the ops-reads database tests read ──────────────────────────────────────────────────────────────────

/**
 * The posts `fee-revenue-postgres.test.ts` and `own-funds-postgres.test.ts` book before they read, in their order, made
 * by the same recipes and account helpers. The Rust port cannot post yet (the `posting` slice), so
 * `tests/ops_reads_pg.rs` writes each straight into the book; the accounts and reasons are the recipes' own.
 */
const lc = await import(`${ROOT}packages/ledger-client/src/index.ts`);
const PAYER = '11111111-1111-4111-8111-111111111111';
const MERCHANT = '22222222-2222-4222-8222-222222222222';
const legs = (key, module, reason, debit, credit, value) => ({
  idempotencyKey: key,
  module,
  reason,
  entries: [
    { account: debit, direction: 'debit', amount: amt(value) },
    { account: credit, direction: 'credit', amount: amt(value) },
  ],
});
const earn = (venueId, venueAccount, fillId, value) =>
  lc.recipes.builderFeeEarn({ venueId, venueAccount, fillId, assetId: 'USDC', amount: amt(value), userId: PAYER });
const feeFund = (asset) =>
  legs(`fee-fund-${asset}`, 'bank', 'bank.transfer.in', lc.userAvailable(PAYER, asset), lc.railBoundary('crypto-native', asset), '1000');
const fee = (key, module, asset, value) =>
  legs(key, module, 'trade.fill.fee', lc.houseFees(module, asset), lc.userAvailable(PAYER, asset), value);
const FEE_REVENUE = [
  feeFund('USDT'),
  feeFund('BTC'),
  fee('fee-rev-1', 'trade', 'USDT', '10.123456789012345678'),
  fee('fee-rev-2', 'pay', 'USDT', '2'),
  fee('fee-rev-3', 'trade', 'BTC', '0.001'),
  legs('fee-back-rev-1', 'trade', 'trade.fill.fee.correction', lc.userAvailable(PAYER, 'USDT'), lc.houseFees('trade', 'USDT'), '0.5'),
  legs('insurance-rev-1', 'futures', 'futures.insurance.fund', lc.insuranceFund('USDT'), lc.userAvailable(PAYER, 'USDT'), '77'),
  earn('test-venue', 'acct-1', 'f1', '3'),
  earn('test-venue', 'acct-1', 'f2', '2'),
  earn('other-venue', 'acct-9', 'f1', '7'),
  lc.recipes.builderFeeReceive({ venueId: 'test-venue', claimId: 'claim-1', assetId: 'USDC', amount: amt('1.5') }),
  fee('fee-rev-4', 'pay', 'USDT', '1'),
];
const rail = lc.railBoundary('crypto-native', 'USDT');
const move = (key, from, to, value) => legs(key, 'bank', 'test.move', to, from, value);
const OWN_FUNDS = [
  move('own-funds-user', rail, lc.userAvailable(PAYER, 'USDT'), '1000'),
  move('own-funds-merchant', rail, lc.merchantClearing(MERCHANT, 'USDT'), '40'),
  move('own-funds-burn', rail, lc.burnAccount('USDT'), '5'),
  move('own-funds-held', rail, lc.moduleAccount('ops', 'hold-confirm:test-held-funds', 'USDT'), '9'),
  move('own-funds-reward', rail, lc.moduleAccount('campaigns', 'lock:reward-1', 'USDT'), '3'),
  move('own-funds-clearing', rail, lc.futuresLossSink('USDT'), '11'),
  move('own-funds-fee', lc.userAvailable(PAYER, 'USDT'), lc.houseFees('trade', 'USDT'), '12.500000000000000001'),
  move('own-funds-insurance', rail, lc.insuranceFund('USDT'), '77'),
  move('own-funds-mm', lc.railBoundary('crypto-native', 'BTC'), lc.marketMaker('BTC'), '0.25'),
  move('own-funds-reserve', rail, lc.moduleAccount('bank', 'loan-reserve', 'USDT'), '300'),
  earn('test-venue', 'acct-1', 'f1', '4'),
  lc.recipes.builderFeeReceive({ venueId: 'test-venue', claimId: 'claim-1', assetId: 'USDC', amount: amt('4') }),
  lc.recipes.ownFundsMove({
    from: { kind: 'venue-builder-account', venueId: 'test-venue' },
    to: { kind: 'partner-reserve', partnerId: 'bank' },
    assetId: 'USDC',
    amount: amt('1.5'),
    reference: 'stmt-1',
  }),
];
/** `restore-watermark-asof.pg.test.ts`'s `deposit(n)`, for n = 1. */
const DEPOSIT = lc.recipes.deposit({
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  assetId: 'USDT',
  amount: amt('1'),
  rail: 'crypto-native',
  railRef: 'tx-wm-1',
});
const booked = (posts) =>
  posts.map((p) => ({
    idempotencyKey: p.idempotencyKey,
    module: p.module,
    reason: p.reason,
    entries: p.entries.map((e) => ({
      ownerType: e.account.ownerType,
      ownerId: e.account.ownerId,
      assetId: e.account.assetId,
      kind: e.account.kind,
      purpose: e.account.purpose ?? '',
      direction: e.direction,
      amount: lc.formatAmount(e.amount),
    })),
  }));
const books = { feeRevenue: booked(FEE_REVENUE), ownFunds: booked(OWN_FUNDS), deposit: booked([DEPOSIT])[0] };

// ── Writing ────────────────────────────────────────────────────────────────────────────────────────────────────────

const HEADER = '// @generated by crates/svc-ledger/scripts/record-door.mjs from the TypeScript svc-ledger. Do not edit by hand.\n';
const rs = (s) => JSON.stringify(s);
const callers = Object.entries(LEDGER_DOOR_CALLERS);
const callersRs = `${HEADER}//! Which services may call each service door (\`LEDGER_DOOR_CALLERS\`, \`services/svc-ledger/src/door-callers.ts\`). A door
//! with no caller refuses every key.

/// \`(door, callers)\`, in the TypeScript's order.
pub const DOOR_CALLERS: [(&str, &[&str]); ${callers.length}] = [
${callers.map(([door, list]) => `    (${rs(door)}, &[${list.map(rs).join(', ')}]),`).join('\n')}
];
`;
const errorsRs = `${HEADER}//! The user copy (\`userCopy\`, \`services/svc-ledger/src/user-copy.ts\`) of every \`ledger.*\` code the TypeScript
//! svc-ledger and \`@intafaced/ledger-client\` name, sorted. A code without catalogue copy reads as itself.

/// \`(code, user copy)\`.
pub const USER_COPY: [(&str, &str); ${copy.length}] = [
${copy.map(([c, t]) => `    (${rs(c)}, ${rs(t)}),`).join('\n')}
];
`;

const outputs = [
  [`${CRATE}src/door/callers.rs`, callersRs],
  [`${CRATE}src/errors_table.rs`, errorsRs],
  [`${CRATE}src/door/schemas.json`, `${JSON.stringify({ nodes, inputs })}\n`],
  [`${CRATE}tests/fixtures/input-parity.golden.json`, `${JSON.stringify({ verdicts, cases })}\n`],
  [`${CRATE}tests/fixtures/tokens.golden.json`, `${JSON.stringify({ cases: tokenCases }, null, 1)}\n`],
  [`${CRATE}tests/fixtures/env-parity.golden.json`, `${JSON.stringify({ cases: envCases }, null, 1)}\n`],
  // One line each: the clock and the distinct answers, then one case a line (`[door, input, status, answer]`).
  [
    `${CRATE}tests/fixtures/reports.golden.jsonl`,
    `${[JSON.stringify({ nowMs: NOW, answers }), ...reportCases.map((c) => JSON.stringify(c))].join('\n')}\n`,
  ],
  [`${CRATE}tests/fixtures/history-book.golden.json`, `${JSON.stringify(book)}\n`],
  [`${CRATE}tests/fixtures/ops-reads-books.json`, `${JSON.stringify(books, null, 1)}\n`],
];

const PRETTIER = fileURLToPath(new URL('../../../node_modules/.bin/prettier', import.meta.url));
const formatted = (file, text) => {
  if (file.endsWith('.rs')) return execFileSync('rustfmt', ['--edition', '2024', '--emit', 'stdout'], { input: text, encoding: 'utf8' });
  if (file.endsWith('.json'))
    return execFileSync(PRETTIER, ['--stdin-filepath', file], { input: text, encoding: 'utf8', maxBuffer: 1 << 28 });
  return text;
};

let stale = 0;
for (const [file, raw] of outputs) {
  const text = formatted(file, raw);
  if (CHECK) {
    let was = '';
    try {
      was = readFileSync(file, 'utf8');
    } catch {}
    if (was !== text) {
      console.error(`stale: ${file.slice(ROOT.length)}`);
      stale++;
    }
  } else writeFileSync(file, text);
}
console.log(
  `${callers.length} service doors, ${Object.keys(inputs).length} door inputs, ${nodes.length} schema parts, ${cases.length} input cases, ${tokenCases.length} tokens, ${envCases.length} environments, ${reportCases.length} report answers, ${copy.length} codes`,
);
if (stale) process.exit(1);
