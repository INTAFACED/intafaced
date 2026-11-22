/**
 * Tests for services-map.mjs: helper-built env fields must not be listed as required.
 * No network. Run: node --test tooling/scripts/services-map.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fieldsOf, helpersOf, render, rustPurpose, rustRequiredEnv } from './services-map.mjs';

const requiredNames = (src) => {
  const helpers = helpersOf(src);
  const body = /z\.object\(\{([\s\S]*)\}\)/.exec(src)[1];
  return fieldsOf(body, helpers)
    .filter((f) => f.required)
    .map((f) => f.name);
};

test('a field built by a helper with a default or optional is not required', () => {
  const src = `
const ownerInt = z.union([z.string(), z.number()]).optional().transform((r) => r);
const bool = (on: boolean) => blankAsAbsent(z.union([z.boolean(), z.string()]).default(on));
const blankAsAbsent = <T extends z.ZodTypeAny>(inner: T) => z.preprocess((v) => v, inner);
const addr = z.preprocess((v) => v, z.string().default('0x0'));
const strict = z.string().min(1);
const schema = base.merge(z.object({
  A_FEE: ownerInt,
  B_FLAG: bool(true),
  C_ADDR: addr,
  D_STRICT: strict,
  E_PLAIN: z.string().min(1),
  F_WRAPPED: blankAsAbsent(z.string().min(1)),
  G_OPT: z.string().optional(),
}));`;
  assert.deepEqual(requiredNames(src), ['D_STRICT', 'E_PLAIN', 'F_WRAPPED']);
});

test("the service kit's blankAsUnset makes a field optional", () => {
  const src = `
const schema = base.merge(z.object({
  A_ROWS: blankAsUnset(z.coerce.number().int().min(1)),
  B_PLAIN: z.string().min(1),
}));`;
  assert.deepEqual(requiredNames(src), ['B_PLAIN']);
});

test('a helper that is not a schema builder does not make a field optional', () => {
  const src = `
function parseThing(raw: string) { return raw.default(); }
const schema = base.merge(z.object({
  A_THING: z.string().transform(parseThing),
}));`;
  assert.deepEqual(requiredNames(src), ['A_THING']);
});

// The seven rows an independent run of each service's real schema, with an empty environment, showed
// were over-reported before helpers were resolved. None of these names refuses boot when blank.
const NOT_REQUIRED = {
  'svc-agents': ['AGENTS_UPSTREAM_HEADERS', 'AGENTS_UPSTREAM_MODELS'],
  'svc-blueprint': [
    'BLUEPRINT_CARD_RENDERER_URL',
    'BLUEPRINT_CREW_CAPACITY',
    'BLUEPRINT_ENGINE_URL',
    'BLUEPRINT_MENTOR_SHORTLIST_SIZE',
    'BLUEPRINT_SEASON',
  ],
  'svc-identity': ['IDENTITY_FOUNDER_INVITE_EXPIRES_AT', 'IDENTITY_FOUNDER_INVITE_HASHES', 'REGISTRATION_OPEN', 'WEBAUTHN_ENABLED'],
  'svc-market': ['MARKET_HOUSE_COMMISSION_BPS'],
  'svc-notify': ['NOTIFY_FANOUT_ENABLED', 'NOTIFY_INCIDENT_ALL_CLEAR', 'NOTIFY_INCIDENT_SILENCE', 'NOTIFY_OUT_OF_APP_ENABLED'],
  'svc-p2p': [
    'P2P_DISPUTE_ESCALATION_RECHECK_SECONDS',
    'P2P_DISPUTE_SLA_SECONDS',
    'P2P_ESCROW_DEADLINE_SECONDS',
    'P2P_FEE_BPS',
    'P2P_INSTRUMENT_RETENTION_DAYS',
    'P2P_PAYMENT_DEADLINE_SECONDS',
    'P2P_RELEASE_DEADLINE_SECONDS',
    'P2P_SWEEP_INTERVAL_SECONDS',
  ],
  'svc-protocol': [
    'PROTOCOL_AMM_FACTORY_ADDRESS',
    'PROTOCOL_FACTORY_ADDRESS',
    'PROTOCOL_IMPLEMENTATION_ADDRESS',
    'PROTOCOL_TOKEN_FACTORY_ADDRESS',
  ],
};

// Fields that do refuse boot when blank must stay listed.
const STILL_REQUIRED = {
  'svc-edge': ['EDGE_BODY_LIMIT_BYTES', 'EDGE_RATE_LIMIT_MAX', 'EDGE_RATE_LIMIT_WINDOW_MS'],
  'svc-ledger': ['RECONCILE_CRON_MINUTES'],
  'svc-matching': ['MATCHING_SNAPSHOT_EVERY'],
  'svc-agents': ['AGENTS_FEE_ASSET_ID', 'AGENTS_METERING_ENABLED', 'AGENTS_USAGE_WINDOW_MINUTES', 'LEDGER_URL'],
  'svc-bank': ['LOAN_QUOTE_ASSET_ID', 'LOAN_SWEEP_BATCH_SIZE', 'TRANSFER_BATCH_SIZE'],
};

function envCell(table, service) {
  // A Rust service's row names its crate after the service: `| `svc-x` (Rust, `crates/svc-x`) |`.
  const row = table.split('\n').find((l) => l.startsWith(`| \`${service}\` |`) || l.startsWith(`| \`${service}\` (Rust, `));
  assert.ok(row, `${service} has a row`);
  return row.split(' | ').pop();
}

test('SERVICES.md leaves out the fields that have a default or are optional', () => {
  const table = render();
  for (const [service, names] of Object.entries(NOT_REQUIRED)) {
    const cell = envCell(table, service);
    for (const name of names) assert.ok(!cell.includes(`\`${name}\``), `${service} must not list ${name}`);
  }
});

test('SERVICES.md still lists the fields that refuse boot when blank', () => {
  const table = render();
  for (const [service, names] of Object.entries(STILL_REQUIRED)) {
    const cell = envCell(table, service);
    for (const name of names) assert.ok(cell.includes(`\`${name}\``), `${service} must list ${name}`);
  }
});

test('the committed docs/SERVICES.md is the rendered one', () => {
  const committed = readFileSync(new URL('../../docs/SERVICES.md', import.meta.url), 'utf8');
  assert.equal(committed, render());
});

test("a Rust service's required env is each field env.rs refuses when unset, and its purpose is lib.rs's first sentence", () => {
  const env = `
    let a = field("A_SECRET", get("A_SECRET").map_or(Err(REQUIRED_STRING.to_owned()), |v| min_len(v, 32)));
    let b = field("B_PORT", get("B_PORT").map_or(Ok(4020), |v| coerce_int(v)));
    let c = get("C_NAME").unwrap_or("x");`;
  assert.deepEqual(rustRequiredEnv(env), ['A_SECRET']);
  // A blank read as NaN, and a blank integer with no default, refuse when unset; one with a default does not.
  const ints = `
    let v = coerce_int(f.blank("D_POOL").unwrap_or("NaN"), Some((1, false)), Some(200));
    o.blank_int("E_MINUTES", None, 1, None);
    o.blank_int("F_MINUTES", Some(5), 1, None);`;
  assert.deepEqual(rustRequiredEnv(ints), ['D_POOL', 'E_MINUTES']);
  // An unset field read as empty text is required only when the same source refuses it by name.
  const listed = `
    let ids = o.f.get("G_IDS").unwrap_or("").to_owned();
    if parse(&ids).len() < 2 { o.issue("G_IDS", MESSAGE); }
    let note = o.f.get("H_NOTE").unwrap_or("").to_owned();`;
  assert.deepEqual(rustRequiredEnv(listed), ['G_IDS']);
  const kit = `
pub fn edge(f: &mut Fields<'_>) -> EdgeEnv {
    let v = f.get("K_SECRET").map_or(Err(REQUIRED_STRING.to_owned()), |v| min_len(v, 32));
}
pub fn s2s(f: &mut Fields<'_>) -> S2sEnv {
    let v = f.get("S_SECRET").map_or(Err(REQUIRED_STRING.to_owned()), |v| min_len(v, 32));
}`;
  // A kit slice's refusals count only when the service calls that slice by path.
  assert.deepEqual(rustRequiredEnv(`${env}\n    let e = service_kit::env::edge(&mut f);`, kit), ['A_SECRET', 'K_SECRET']);
  assert.equal(
    rustPurpose('//! svc-x: the lot export over ledger reads. It posts nothing.\n//! More.\nuse a;'),
    'The lot export over ledger reads.',
  );
  const real = render();
  assert.match(
    real,
    /\| `svc-tax` \(Rust, `crates\/svc-tax`\) \| .+ \| 4020 \| compose network only \| `EDGE_PRINCIPAL_SECRET`, `INTERNAL_SERVICE_SECRET` \|/,
  );
});
