// Records, from the TypeScript svc-matching in this checkout, what the Rust crate's shell is held to:
//
// - `src/door/schemas.json`: the input schema each door parses its body with before it reaches the engine
//   (`door-inputs.ts`, and the submit record's `MATCHING_SUBMIT_ORDER.input`), as the tree of zod 4 parts the kit's
//   schema engine runs (`service_kit::schema`).
// - `src/errors_table.rs`: the user copy (`userCopy`) of every `matching.*` code the TypeScript names, and the two
//   catalogue codes the doors answer with.
// - `tests/fixtures/requests.json`: every request the TypeScript wire replay sends (`wire-replay-matrix.ts`): its
//   method, URL, input name and body, so the Rust replay sends the same bytes.
// - `tests/fixtures/input-parity.golden.json`: zod's own verdict on inputs made from each schema.
// - `tests/fixtures/env-parity.golden.json`: what `env.ts` answers for a set of environments.
//
// Run from the repository root:
//   TZ=UTC node --import tsx crates/svc-matching/scripts/record-door.mjs          writes the files
//   TZ=UTC node --import tsx crates/svc-matching/scripts/record-door.mjs --check  fails when a written file is stale
//
// It reads the TypeScript service and never writes there. It stops being runnable when the TypeScript service is
// deleted, and from then on what it wrote is the reference.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CRATE = fileURLToPath(new URL('../', import.meta.url));
const SVC = `${ROOT}services/svc-matching/src/`;
const NAME = 'record-door';
if (!existsSync(SVC)) {
  console.error(`${NAME}: services/svc-matching no longer exists; nothing to record from. The files it wrote are the reference now.`);
  process.exit(2);
}
const CHECK = process.argv.includes('--check');
if (process.env.TZ !== 'UTC') {
  console.error(`${NAME}: run with TZ=UTC`);
  process.exit(2);
}

const doorInputs = await import(`${SVC}door-inputs.ts`);
// The exchange contract as the service resolves it, so its schemas are the very objects `door-inputs.ts` holds.
const exchange = await import(pathToFileURL(createRequire(`${SVC}index.ts`).resolve('@intafaced/exchange-contract')).href);
const { MATCHING_SUBMIT_ORDER, marketStateSnapshotSchema, marketLifecycleAdmissionProofSchema } = exchange;
const { userCopy } = await import(`${SVC}user-copy.ts`);
const matrix = await import(`${SVC}wire-replay-matrix.ts`);

// ── The inputs the door checks ─────────────────────────────────────────────────────────────────────────────────────

/** Each door's input schema, by the name the Rust door's route table uses. `snapshot` is the lifecycle proof's
 *  snapshot alone, which the proof's `superRefine` parses again before it hashes it. */
const INPUTS = {
  submit: MATCHING_SUBMIT_ORDER.input,
  closePosition: doorInputs.closePositionBodySchema,
  amend: doorInputs.amendBodySchema,
  mark: doorInputs.markBodySchema,
  massCancel: doorInputs.massCancelBodySchema,
  massQuote: doorInputs.massQuoteBodySchema,
  venueKill: doorInputs.venueKillBodySchema,
  sessionDead: doorInputs.sessionDeadBodySchema,
  reconcile: doorInputs.reconcileBodySchema,
  spreadList: doorInputs.spreadListBodySchema,
  spreadOrder: doorInputs.spreadOrderBodySchema,
  founder: doorInputs.founderBody,
  rulebookDraft: doorInputs.rulebookDraftBody,
  rulebookPublish: doorInputs.rulebookPublishBody,
  snapshot: marketStateSnapshotSchema,
};

/** Refines, by their source as tsx loads it (two spellings of one function, as its two copies load): the Rust door runs
 *  each by this name (`src/refines.rs`). */
const REFINES = {
  'value=>value.trim()===value&&!CONTROL_CHARACTER.test(value)': 'spine_id',
  '(value) => value.trim() === value && !CONTROL_CHARACTER.test(value)': 'spine_id',
};
/** `superRefine`s, by the schema that carries them (their check's source is zod's own wrapper). */
const SUPER_REFINES = new Map([
  [doorInputs.amendBodySchema, 'amend_changes_something'],
  [marketStateSnapshotSchema, 'snapshot_actions'],
  [marketLifecycleAdmissionProofSchema, 'lifecycle_proof'],
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
      const src = d.fn.toString();
      const id = REFINES[src];
      if (!id) throw new Error(`an unnamed refine: ${src}`);
      return out('refine', { id, ...(d.path ? { path: d.path } : {}) });
    }
    default:
      throw new Error(`check ${d.check}`);
  }
}

function node(s) {
  if (ids.has(s)) return ids.get(s);
  const id = nodes.length;
  ids.set(s, id);
  nodes.push(null);
  nodes[id] = build(s);
  return id;
}

function build(s) {
  const d = s._zod.def;
  if (d.error) throw new Error(`a ${d.type} schema with its own error`);
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
      if (d.discriminator !== undefined) throw new Error('a discriminated union');
      if (d.inclusive === false) throw new Error('an exclusive union');
      return withChecks({ t: 'union', options: d.options.map(node) });
    case 'record':
      if (d.mode && d.mode !== 'strict') throw new Error(`record mode ${d.mode}`);
      return withChecks({ t: 'record', key: node(d.keyType), value: node(d.valueType) });
    default:
      throw new Error(`schema type ${d.type}`);
  }
}

const inputs = Object.fromEntries(Object.entries(INPUTS).map(([door, schema]) => [door, node(schema)]));

// ── The replay's requests ──────────────────────────────────────────────────────────────────────────────────────────

const requests = matrix.DOORS.flatMap((door) =>
  matrix.inputs(door).map(([input, url, body]) => ({
    file: door.file,
    method: door.method,
    url,
    input,
    body: body === undefined ? null : JSON.stringify(body),
  })),
);

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

const proof = (action = 'PLACE', marketId = matrix.MARKET) => matrix.proof(marketId, action);
const place = proof();
/** A valid input of each door, and a few of its variants the samples alone would not reach. */
const VALID = {
  submit: requestBody('orders-submit', 'valid'),
  closePosition: requestBody('positions-close', 'valid'),
  amend: requestBody('orders-amend', 'valid'),
  mark: requestBody('mark', 'valid'),
  massCancel: { accountId: 'mm', side: 'sell', sessionId: null },
  massQuote: requestBody('mass-quote', 'valid'),
  venueKill: requestBody('halt', 'valid'),
  sessionDead: requestBody('session-dead', 'valid'),
  reconcile: requestBody('reconcile', 'valid'),
  spreadList: requestBody('spread-list', 'valid'),
  spreadOrder: requestBody('spread-orders', 'valid'),
  founder: requestBody('operator-halt', 'valid'),
  rulebookDraft: requestBody('operator-rulebook-check', 'valid'),
  rulebookPublish: requestBody('operator-rulebook-publish', 'valid'),
  snapshot: place.snapshot,
};
function requestBody(file, input) {
  const r = requests.find((x) => x.file === file && x.input === input);
  if (!r) throw new Error(`no request ${file} ${input}`);
  return JSON.parse(r.body);
}
const snap = place.snapshot;
const EXTRA = {
  submit: [
    { ...VALID.submit, lifecycleProof: { ...place, snapshotId: `trade.lifecycle.snapshot:${'0'.repeat(64)}` } },
    { ...VALID.submit, lifecycleProof: { ...place, action: 'QUOTE' } },
    { ...VALID.submit, lifecycleProof: { ...place, checkedAt: '2026-11-19T00:00:01.000Z' } },
    { ...VALID.submit, lifecycleProof: { ...place, transitionId: 'other' } },
    { ...VALID.submit, lifecycleProof: { ...place, evidenceRefs: ['other'] } },
    { ...VALID.submit, lifecycleProof: { ...place, snapshot: { ...snap, marketId: ' BTC-USDT' } } },
    { ...VALID.submit, lifecycleProof: { ...place, snapshot: { ...snap, state: 'HALTED' } } },
    { ...VALID.submit, lifecycleProof: { ...place, snapshot: { ...snap, allowedActions: ['PLACE', 'PLACE'] } } },
    { ...VALID.submit, lifecycleProof: { ...place, snapshot: { ...snap, extra: 1 } } },
    { ...VALID.submit, lifecycleProof: { ...place, decision: 'INELIGIBLE' } },
    { ...VALID.submit, lifecycleProof: { ...place, checkedAt: 'yesterday' } },
    { ...VALID.submit, type: 'stop', stopPrice: '29000' },
    { ...VALID.submit, type: 'market', price: null, tif: 'IOC' },
    { ...VALID.submit, qty: '1.0000000000000000001' },
    { ...VALID.submit, qty: 1.5 },
    { ...VALID.submit, accountId: 'a'.repeat(129) },
    { ...VALID.submit, postOnly: true, tif: 'IOC' },
  ],
  amend: [
    { expectedVersion: 1, lifecycleProof: proof('AMEND') },
    { expectedVersion: 0, qty: '1', lifecycleProof: proof('AMEND') },
    { expectedVersion: 1.5, qty: '1', lifecycleProof: proof('AMEND') },
    { expectedVersion: 1, tif: 'IOC', lifecycleProof: proof('AMEND') },
  ],
  massQuote: [
    { ...VALID.massQuote, mmpMaxQuote: '' },
    { ...VALID.massQuote, mmpMaxQuote: 5 },
    { ...VALID.massQuote, bid: null },
  ],
  massCancel: [{ accountId: '' }, { accountId: 'mm', side: 'up' }, { accountId: 'mm', sessionId: 's'.repeat(129) }],
  venueKill: [{ operatorId: '' }, { operatorId: 'o', confirmOperatorId: 'c'.repeat(129) }],
  reconcile: [
    { orders: [{ orderId: 'x', marketId: 'm', state: 'gone', remaining: '1', funded: true }] },
    { orders: [{ orderId: 'x', marketId: 'm', state: 'open', remaining: '-1', funded: true, detail: 'd'.repeat(257) }] },
  ],
  spreadList: [{ ...VALID.spreadList, legs: Array.from({ length: 9 }, () => ({ symbol: 'x', side: 'buy', ratio: '1' })) }],
  spreadOrder: [
    { ...VALID.spreadOrder, price: '-5' },
    { ...VALID.spreadOrder, clientOrderId: '' },
  ],
  founder: [
    { approvalId: 'a', operationId: 'o', idempotencyKey: 7 },
    { ...VALID.founder, marketId: '' },
  ],
  rulebookDraft: [{ sections: { fees: 'f'.repeat(20_001) } }, { sections: [] }, { sections: { fees: 7 } }],
  snapshot: [
    { ...snap, state: 'PRELAUNCH', allowedActions: ['CANCEL', 'PLACE'] },
    { ...snap, state: 'POST_ONLY', allowedActions: ['PLACE'] },
    { ...snap, state: 'CANCEL_ONLY', allowedActions: ['CANCEL'] },
    { ...snap, lastGoodState: null },
    { ...snap, evidenceRefs: [] },
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
for (const [door, schema] of Object.entries(INPUTS)) {
  for (const input of probes(door)) {
    const text = JSON.stringify(input) ?? null;
    const v = verdict(schema, input, text);
    if (!verdictIndex.has(v)) verdictIndex.set(v, verdicts.push(v) - 1);
    cases.push([door, text, verdictIndex.get(v)]);
  }
}

// ── The environment ────────────────────────────────────────────────────────────────────────────────────────────────

const A = '11111111-1111-4111-8111-111111111111';
const B = '44444444-4444-4444-8444-444444444444';
const ENV_BASE = {
  NODE_ENV: 'test',
  INTERNAL_SERVICE_SECRET: 'placeholder-matching-env-internal-secret-long',
  MATCHING_SNAPSHOT_EVERY: '0',
  MATCHING_OPERATOR_IDS: `${A},${B}`,
};
const ENV_CASES = [
  {},
  { HTTP_PORT: '4105', SERVICE_NAME: 'svc-matching-b', MATCHING_JOURNAL_PATH: '/data/journal.ndjson' },
  { HTTP_PORT: 'eighty' },
  { MATCHING_JOURNAL_PATH: '' },
  { MATCHING_SNAPSHOT_EVERY: undefined },
  { MATCHING_SNAPSHOT_EVERY: '   ' },
  { MATCHING_SNAPSHOT_EVERY: '500' },
  { MATCHING_SNAPSHOT_EVERY: '-1' },
  { MATCHING_SNAPSHOT_EVERY: '1.5' },
  { MATCHING_SNAPSHOT_EVERY: 'often' },
  { MATCHING_ENGINE_ENABLED: 'true' },
  { MATCHING_ENGINE_ENABLED: 'true', LEDGER_CUSTODY_LAYER: 'on' },
  { MATCHING_ENGINE_ENABLED: ' OFF ', LEDGER_CUSTODY_LAYER: 'on' },
  { MATCHING_ENGINE_ENABLED: '' },
  { MATCHING_ENGINE_ENABLED: 'maybe', LEDGER_CUSTODY_LAYER: 'on' },
  { LEDGER_CUSTODY_LAYER: 'on' },
  { LEDGER_CUSTODY_LAYER: ' ON ' },
  { LEDGER_CUSTODY_LAYER: '' },
  { LEDGER_CUSTODY_LAYER: 'maybe' },
  { LEDGER_CUSTODY_LAYER: 'maybe', HTTP_PORT: 'x' },
  { MATCHING_ENGINE_ENABLED: 'yes', HTTP_PORT: 'x' },
  { IDENTITY_URL: 'http://identity:4002' },
  { IDENTITY_URL: 'identity' },
  { IDENTITY_URL: '' },
  { LEDGER_URL: ' http://ledger:4001 ' },
  { LEDGER_URL: '   ' },
  { LEDGER_URL: 'ledger' },
  { EDGE_PRINCIPAL_SECRET: ' placeholder-matching-edge-secret-long-enough ' },
  { EDGE_PRINCIPAL_SECRET: 'short-placeholder' },
  { EDGE_PRINCIPAL_SECRET: '  ' },
  { EDGE_PRINCIPAL_PUBLIC_KEY: 'A'.repeat(43), EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: '60', EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: '5' },
  { EDGE_PRINCIPAL_PUBLIC_KEY: 'short', EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: '0' },
  { MATCHING_OPERATOR_IDS: undefined },
  { MATCHING_OPERATOR_IDS: '' },
  { MATCHING_OPERATOR_IDS: A },
  { MATCHING_OPERATOR_IDS: `${A}, ${A.toUpperCase()}` },
  { MATCHING_OPERATOR_IDS: ` ${A} ,, ${B} ` },
  { INTERNAL_SERVICE_SECRET: undefined },
  { INTERNAL_SERVICE_SECRET: 'short-placeholder', INTERNAL_SERVICE_BODY_BIND: 'require' },
  { S2S_AUTH_MODE: 'dual', INTERNAL_SERVICE_BODY_BIND: 'sometimes' },
  { NODE_ENV: 'staging', LOG_LEVEL: 'loud' },
  { REDIS_URL: 'redis', NATS_URL: ' ', OTEL_EXPORTER_OTLP_ENDPOINT: 'otel', OTEL_ENABLED: 'false' },
  { DATABASE_URL: 'postgres://matching:matching@localhost:5432/matching' },
];
const envProbe = `${CRATE}scripts/env-probe.mjs`;
const envCases = ENV_CASES.map((overrides) => {
  const vars = { ...ENV_BASE, ...overrides };
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete vars[k];
  const out = execFileSync(process.execPath, ['--import', 'tsx', envProbe], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, TZ: 'UTC', MATCHING_ENV_PROBE: JSON.stringify(vars) },
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
  ...new Set([
    'error.forbidden',
    'error.unauthorized',
    ...sources(SVC).flatMap((t) => [...t.matchAll(/'(matching\.[a-z0-9_.]+)'/g)].map((m) => m[1])),
  ]),
].sort();
const copy = codes.map((code) => [code, userCopy(code)]);

// ── Writing ────────────────────────────────────────────────────────────────────────────────────────────────────────

const HEADER = '// @generated by crates/svc-matching/scripts/record-door.mjs from the TypeScript svc-matching. Do not edit by hand.\n';
const rs = (s) => JSON.stringify(s);
const errorsRs = `${HEADER}//! The user copy (\`userCopy\`, \`services/svc-matching/src/user-copy.ts\`) of every \`matching.*\` code the TypeScript
//! svc-matching names, and the catalogue codes its doors answer with, sorted. A code without catalogue copy reads as
//! itself.

/// \`(code, user copy)\`.
pub const USER_COPY: [(&str, &str); ${copy.length}] = [
${copy.map(([c, t]) => `    (${rs(c)}, ${rs(t)}),`).join('\n')}
];
`;

const outputs = [
  [`${CRATE}src/errors_table.rs`, errorsRs],
  [`${CRATE}src/door/schemas.json`, `${JSON.stringify({ nodes, inputs })}\n`],
  [`${CRATE}tests/fixtures/requests.json`, `${JSON.stringify({ requests }, null, 1)}\n`],
  [`${CRATE}tests/fixtures/input-parity.golden.json`, `${JSON.stringify({ verdicts, cases })}\n`],
  [`${CRATE}tests/fixtures/env-parity.golden.json`, `${JSON.stringify({ cases: envCases }, null, 1)}\n`],
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
  `${Object.keys(inputs).length} door inputs, ${nodes.length} schema parts, ${requests.length} requests, ${cases.length} input cases, ${envCases.length} environments, ${copy.length} codes`,
);
if (stale) process.exit(1);
