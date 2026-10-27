/**
 * Tests for services-map.mjs: helper-built env fields must not be listed as required.
 * No network. Run: node --test tooling/scripts/services-map.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fieldsOf, helpersOf, render } from './services-map.mjs';

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
  'svc-agents': ['AGENTS_METERING_ENABLED'],
  'svc-bank': ['LOAN_QUOTE_ASSET_ID', 'LOAN_SWEEP_BATCH_SIZE', 'TRANSFER_BATCH_SIZE'],
};

function envCell(table, service) {
  const row = table.split('\n').find((l) => l.startsWith(`| \`${service}\` |`));
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
