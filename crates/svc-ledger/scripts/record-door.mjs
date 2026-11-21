// Records, from the TypeScript svc-ledger in this checkout, what the Rust crate's shell is held to:
//
// - `src/door/schemas.json`: the input schema each door checks before it reaches the ledger, as the tree of zod 4
//   parts the kit's schema engine runs (`service_kit::schema`).
// - `src/door/callers.rs`: which services may call each service door (`LEDGER_DOOR_CALLERS`).
// - `src/errors_table.rs`: the user copy (`userCopy`) of every `ledger.*` code the TypeScript names.
// - `tests/fixtures/input-parity.golden.json`: zod's own verdict on inputs made from each schema.
// - `tests/fixtures/tokens.golden.json`: `verifyAccessToken`'s verdict on access tokens made to probe it.
// - `tests/fixtures/env-parity.golden.json`: what `env.ts` answers for a set of environments.
//
// Run from the repository root:
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
const assetRegistry = await import(`${ROOT}packages/contracts/src/asset-registry.ts`);
const { verifyAccessToken } = await import(`${ROOT}packages/auth/src/tokens.ts`);

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
  freeze: doorInputs.freezeSchema,
  unfreeze: doorInputs.thawSchema,
  reconcile: doorInputs.reconcileSchema,
  txGet: operatorTxGetInputSchema,
  trace: operatorTraceInputSchema,
  txList: operatorTxListInputSchema,
  accountSearch: operatorAccountSearchInputSchema,
  stats: z.object({}).strict(),
  metadataRead: accountMetadataReadInputSchema,
  // The asset registry (`ledger/supported-assets.ts`): each read's filter, the edit a founder applies, the precision
  // `parseAssetEdit` checks first, and the row every read answers (`registryAssetSchema.parse`).
  assetsList: assetRegistry.assetsListInputSchema,
  assetsGet: assetRegistry.assetsGetInputSchema,
  assetApplyEdit: assetRegistry.assetApplyEditInputSchema,
  assetEdit: assetRegistry.assetEditInputSchema,
  assetPrecision: assetRegistry.assetPrecisionSchema,
  registryAsset: assetRegistry.registryAssetSchema,
};

/** Refines, by their source as tsx loads it: the Rust door runs each by this name (`src/refines.rs`). */
const REFINES = {
  'q=>!q.from||!q.to||Date.parse(q.from)<Date.parse(q.to)': 'from_before_to',
  'v=>BigInt(v)<=INT8_MAX': 'seq_within_int8',
};
/** `superRefine`s, by the schema that carries them (their check's source is zod's own wrapper). */
const SUPER_REFINES = new Map([
  [ledgerClient.accountRefSchema, 'owner_id_space'],
  [assetRegistry.registryAssetSchema, 'asset_body'],
  [assetRegistry.assetEditInputSchema, 'asset_body'],
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
    case 'record':
      if (d.mode && d.mode !== 'strict') throw new Error(`record mode ${d.mode}`);
      return withChecks({ t: 'record', key: node(d.keyType), value: node(d.valueType) });
    case 'pipe':
      return pipe(s, checks);
    default:
      throw new Error(`schema type ${d.type}`);
  }
}

const inputs = Object.fromEntries(Object.entries(INPUTS).map(([door, schema]) => [door, node(schema)]));

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
  freeze: { reason: '  operator halt drill  ', approvalId: 'a1', operationId: 'o1', confirmOperatorId: null },
  unfreeze: { approvalId: 'a1', operationId: 'o1', confirmOperatorId: null },
  reconcile: { approvalId: 'a1', operationId: 'o1' },
  txGet: { txId: ID },
  trace: { businessKey: ' deposit:crypto-native:0xabc ' },
  txList: { assetId: ' USDC ', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00+02:00', before: '42' },
  accountSearch: { prefix: ' user:2222 ', after: ID },
  stats: {},
  metadataRead: { accountId: ID },
  assetsList: { state: 'active', action: 'withdraw' },
  assetsGet: { assetId: 'USDT' },
  assetEdit: {
    id: 'USDT',
    kind: 'crypto',
    precision: 6,
    networks: [
      { networkId: 'tron', label: 'Tron (TRC-20)' },
      {
        networkId: 'ethereum',
        label: 'Ethereum (ERC-20)',
        contract: ' 0xdac17f958d2ee523a2206206994597c13d831ec7 ',
        links: [{ label: 'Explorer', url: 'https://etherscan.io/token/0xdac1' }],
      },
    ],
    defaultNetworkId: 'ethereum',
    allowedActions: ['deposit', 'withdraw', 'trade', 'transfer'],
    state: 'active',
    reason: '  TEST: publish USDT  ',
  },
  assetPrecision: 6,
};
VALID.assetApplyEdit = { approvalId: 'ap-1', operationId: 'asset-edit:USDT:1', edit: VALID.assetEdit };
VALID.registryAsset = (() => {
  const { reason: _reason, ...body } = VALID.assetEdit;
  return { ...body, revision: 1, updatedAt: '2026-11-21T01:02:03.456Z' };
})();
const edit = VALID.assetEdit;
const [tron, eth] = edit.networks;
const ASSET_BODY_EXTRA = [
  { ...edit, networks: [tron, tron] },
  { ...edit, defaultNetworkId: 'solana' },
  { ...edit, networks: [], defaultNetworkId: null },
  { ...edit, networks: [], defaultNetworkId: 'solana', allowedActions: ['trade', 'trade'] },
  { ...edit, allowedActions: ['trade', 'trade'] },
  { ...edit, allowedActions: ['deposit', 'withdraw', 'trade', 'transfer', 'trade'] },
  { ...edit, allowedActions: ['mint'] },
  { ...edit, precision: 19 },
  { ...edit, precision: -1 },
  { ...edit, precision: 1.5 },
  { ...edit, precision: '6' },
  { ...edit, precision: 18 },
  { ...edit, precision: 0 },
  { ...edit, id: 'usdt' },
  { ...edit, id: 'A'.repeat(17) },
  { ...edit, kind: 'stock' },
  { ...edit, state: 'frozen' },
  { ...edit, state: 'retired' },
  { ...edit, networks: [{ ...tron, networkId: 'Tron' }], defaultNetworkId: null },
  { ...edit, networks: [{ ...tron, networkId: '-tron' }], defaultNetworkId: null },
  { ...edit, networks: [{ ...tron, networkId: 'a'.repeat(33) }], defaultNetworkId: null },
  { ...edit, networks: [{ ...tron, label: '' }, eth] },
  { ...edit, networks: [{ ...tron, extra: 1 }, eth] },
  { ...edit, networks: [tron, { ...eth, contract: '   ' }] },
  { ...edit, networks: [tron, { ...eth, contract: 'c'.repeat(129) }] },
  { ...edit, networks: [tron, { ...eth, links: [] }] },
  { ...edit, networks: [tron, { ...eth, links: [{ label: 'x', url: 'http://etherscan.io' }] }] },
  { ...edit, networks: [tron, { ...eth, links: [{ label: 'x', url: 'https://localhost' }] }] },
  { ...edit, networks: [tron, { ...eth, links: [{ label: 'x', url: 'https://a.b c' }] }] },
  { ...edit, networks: [tron, { ...eth, links: [{ label: 'x', url: 'https://a.b/c?d#e' }] }] },
  { ...edit, networks: [tron, { ...eth, links: Array(9).fill({ label: 'x', url: 'https://a.b' }) }] },
  { ...edit, networks: [tron, { ...eth, links: [{ label: 'x', url: 'https://a.b', extra: 1 }] }] },
  { ...edit, networks: Array.from({ length: 65 }, (_, i) => ({ networkId: `n${i}`, label: 'n' })), defaultNetworkId: null },
  { ...edit, networks: [tron, 7] },
  { ...edit, networks: [tron, null], defaultNetworkId: 'tron' },
];
const EXTRA = {
  assetsList: [
    { state: 'halted' },
    { action: 'trade' },
    { state: 'frozen' },
    { action: 'mint' },
    { state: 'active', action: 'withdraw', extra: 1 },
  ],
  assetsGet: [{ assetId: 'usdt' }, { assetId: 'A'.repeat(17) }, { assetId: '' }, { assetId: 'US DT' }],
  assetEdit: [
    ...ASSET_BODY_EXTRA,
    { ...edit, reason: '   ' },
    { ...edit, reason: 'r'.repeat(501) },
    { ...edit, reason: `  ${'r'.repeat(500)}  ` },
  ],
  assetApplyEdit: [
    ...ASSET_BODY_EXTRA.map((e) => ({ ...VALID.assetApplyEdit, edit: e })),
    { ...VALID.assetApplyEdit, approvalId: 'a'.repeat(129) },
    { ...VALID.assetApplyEdit, operationId: '' },
    { approvalId: 'ap-1', operationId: 'op-1', edit: { ...edit, precision: undefined } },
  ],
  assetPrecision: [0, 18, 19, -1, 1.5, '6', 1e21, Number.MAX_SAFE_INTEGER + 2],
  registryAsset: [
    ...ASSET_BODY_EXTRA.map(({ reason: _r, ...b }) => ({ ...b, revision: 1, updatedAt: VALID.registryAsset.updatedAt })),
    { ...VALID.registryAsset, revision: -1 },
    { ...VALID.registryAsset, revision: 1.5 },
    { ...VALID.registryAsset, revision: Number.MAX_SAFE_INTEGER + 2 },
    { ...VALID.registryAsset, updatedAt: '2026-11-21T01:02:03.456+00:00' },
    { ...VALID.registryAsset, updatedAt: '2026-11-21' },
    { ...VALID.registryAsset, precision: null },
    { ...VALID.registryAsset, reason: 'x' },
  ],
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
for (const [door, schema] of Object.entries(INPUTS)) {
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
  `${callers.length} service doors, ${Object.keys(inputs).length} door inputs, ${nodes.length} schema parts, ${cases.length} input cases, ${tokenCases.length} tokens, ${envCases.length} environments, ${copy.length} codes`,
);
if (stale) process.exit(1);
