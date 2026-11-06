import path from 'node:path';
import { loadProfile } from '../owner-settings.mjs';

/** One labelled TEST value from this service's profile file; a missing one names the file instead of a bare TypeError. */
function testValue(name) {
  const entry = loadProfile().values[name];
  if (!entry) throw new Error(`${name} is missing from tooling/profiles/test-owner-values/agents.json.`);
  return entry.value;
}

/**
 * The TEST routing table, with the TEST Coach route appended (RC-agents-02). `LOCAL_STACK_AGENTS_COACH_ROUTE=off` on a
 * start or restart leaves the Coach with no model, so its "engine unavailable" refusal can be seen.
 * `LOCAL_STACK_AGENTS_RATES=off` leaves the table blank instead.
 */
/** The routing table as the service's env entry, or nothing when the stack's TEST rates are off. */
const withRoutingTable = (table) => (table === undefined ? {} : { AGENTS_ROUTING_TABLE: table });

function routingTable() {
  // `LOCAL_STACK_AGENTS_RATES=off` publishes no routing table, as production runs until the owner sets the rates: the
  // service serves its default routes priced at nothing, and every run refuses agents.price_unset (J-agents-02 #7).
  if (process.env.LOCAL_STACK_AGENTS_RATES === 'off') return undefined;
  const table = JSON.parse(testValue('AGENTS_ROUTING_TABLE'));
  if (process.env.LOCAL_STACK_AGENTS_COACH_ROUTE === 'off') return JSON.stringify(table);
  return JSON.stringify({ ...table, routes: [...table.routes, JSON.parse(testValue('AGENTS_COACH_ROUTE'))] });
}

/**
 * The engine live runs use. By default the service's deterministic stand-in engine, which /ready and every route report
 * as "sandbox": no model provider is connected on a test stack and no real inference runs.
 * `LOCAL_STACK_AGENTS_SANDBOX_ENGINE=off` on a start or restart makes the stack a live-engine deployment instead (J-agents-04
 * #1): the HTTP model adapter, which every route reports as "live", pointed at a TEST address nothing answers at, with a
 * TEST key. No model vendor is reached and nothing is spent: every live run fails at the engine, so a test run that
 * still answers proves it never asked the live engine.
 */
function engine(STATE) {
  if (process.env.LOCAL_STACK_AGENTS_SANDBOX_ENGINE === 'off') {
    return {
      AGENTS_PROVIDER: 'upstream',
      AGENTS_UPSTREAM_BASE_URL: 'http://127.0.0.1:9',
      AGENTS_UPSTREAM_API_KEY: 'TEST',
      AGENTS_UPSTREAM_TIMEOUT_MS: '1000',
    };
  }
  return {
    AGENTS_PROVIDER: 'mock',
    // While this file exists the stand-in engine parks each completion before it answers, so a journey can read the
    // service's own record of a run the engine has not answered yet (J-agents-01 #5). Absent, it answers at once.
    AGENTS_MOCK_HOLD_FILE: path.join(STATE, 'agents-engine.hold'),
  };
}

function approvalTtl() {
  const choice = process.env.LOCAL_STACK_AGENTS_APPROVAL_TTL;
  if (choice === 'off') return {};
  return {
    AGENTS_APPROVAL_TTL_SECONDS: testValue(choice === 'short' ? 'AGENTS_APPROVAL_TTL_SECONDS_SHORT' : 'AGENTS_APPROVAL_TTL_SECONDS'),
  };
}

export default ({ c, secrets, dbUrl, urlOf, PORTS, STATE }) => ({
  name: 'agents',
  env: () => ({
    ...c('svc-agents', PORTS.agents),
    DATABASE_URL: dbUrl('svc_agents', secrets),
    LEDGER_URL: urlOf('ledger'),
    IDENTITY_URL: urlOf('identity'),
    ACADEMY_URL: urlOf('academy'),
    SUPPORT_URL: urlOf('support'),
    TRADE_URL: urlOf('trade'),
    PAY_URL: urlOf('pay'),
    BANK_URL: urlOf('bank'),
    // LOCAL TEST only, the labelled values in tooling/profiles/test-owner-values/agents.json. Metered at TEST rates, so
    // a run charges TEST USDT through the ledger (OWNER 107). Production leaves the rates blank, and every run refuses
    // agents.price_unset before the engine.
    AGENTS_FEE_ASSET_ID: testValue('AGENTS_FEE_ASSET_ID'),
    AGENTS_USAGE_WINDOW_MINUTES: testValue('AGENTS_USAGE_WINDOW_MINUTES'),
    AGENTS_METERING_ENABLED: testValue('AGENTS_METERING_ENABLED'),
    ...withRoutingTable(routingTable()),
    // LOCAL TEST tier law of the scanner, navigator and support doors (owner decision); production leaves it blank and each
    // door refuses tier_law_blank. The tier itself is always the signed principal's.
    AGENTS_TIER_LAWS: testValue('AGENTS_TIER_LAWS'),
    // LOCAL TEST operator log values (J-agents-15). `LOCAL_STACK_AGENTS_LOG_READ_REASONS=off` or
    // `LOCAL_STACK_AGENTS_TRANSCRIPT_RETENTION=off` on a start or restart leaves that value blank, so a journey proves
    // its refusal (agents.log_read_reason_unset, agents.transcript_retention_unset) and its restore.
    // `LOCAL_STACK_AGENTS_TEMPLATES=off` offers only "Start blank" (J-agents-03 #1); otherwise every built-in template.
    ...(process.env.LOCAL_STACK_AGENTS_TEMPLATES === 'off' ? { AGENTS_OWN_TEMPLATES: 'blank' } : {}),
    ...(process.env.LOCAL_STACK_AGENTS_LOG_READ_REASONS === 'off' ? {} : { AGENTS_LOG_READ_REASONS: testValue('AGENTS_LOG_READ_REASONS') }),
    AGENTS_OPS_ACTIONS_LIMIT: testValue('AGENTS_OPS_ACTIONS_LIMIT'),
    // LOCAL TEST managed baseline for own agents' tools (J-agents-05 #1). `LOCAL_STACK_AGENTS_POLICY_BASELINE=off` leaves
    // it blank, so every own-agent tool call refuses agents.baseline_value_unset.
    ...(process.env.LOCAL_STACK_AGENTS_POLICY_BASELINE === 'off' ? {} : { AGENTS_POLICY_BASELINE: testValue('AGENTS_POLICY_BASELINE') }),
    ...(process.env.LOCAL_STACK_AGENTS_TRANSCRIPT_RETENTION === 'off'
      ? {}
      : { AGENTS_TRANSCRIPT_RETENTION_DAYS: testValue('AGENTS_TRANSCRIPT_RETENTION_DAYS') }),
    // LOCAL TEST own-agent token lifetime (J-agents-03 #5) and drafting assistant on the TEST engine (J-agents-03 #6).
    // `LOCAL_STACK_AGENTS_TOKEN_LIFETIME=off` or `LOCAL_STACK_AGENTS_ASSISTANT_MODEL=off` on a start or restart leaves that
    // value blank, so a journey sees agents.identity.lifetime_unset or the owner.decision notice, and its restore.
    ...(process.env.LOCAL_STACK_AGENTS_TOKEN_LIFETIME === 'off'
      ? {}
      : { AGENTS_OWN_TOKEN_LIFETIME_MINUTES: testValue('AGENTS_OWN_TOKEN_LIFETIME_MINUTES') }),
    ...(process.env.LOCAL_STACK_AGENTS_ASSISTANT_MODEL === 'off'
      ? {}
      : { AGENTS_OWN_ASSISTANT_MODEL: testValue('AGENTS_OWN_ASSISTANT_MODEL') }),
    // LOCAL TEST automatic reviewer on the TEST engine (J-agents-05 #7). `LOCAL_STACK_AGENTS_REVIEWER_MODEL=off` on a
    // restart leaves it blank, so a journey sees the owner.decision notice and every call going to the person.
    ...(process.env.LOCAL_STACK_AGENTS_REVIEWER_MODEL === 'off' ? {} : { AGENTS_REVIEWER_MODEL: testValue('AGENTS_REVIEWER_MODEL') }),
    // LOCAL TEST wait of a held own-agent call (J-agents-05 #5 #6). `LOCAL_STACK_AGENTS_APPROVAL_TTL=off` on a start or
    // restart leaves it blank (holding refuses agents.approval.ttl_unset); `=short` uses the short TEST wait, so a journey
    // can watch a request expire.
    ...approvalTtl(),
    ...engine(STATE),
    // `LOCAL_STACK_AGENTS_IDENTITY=off` on a restart points this service's identity reads at a TEST address nothing
    // answers at, so identity is unavailable to it and a decision that needs the owner's account fails closed
    // (J-agents-05 #6). Sign-in and every other service keep the real identity service.
    ...(process.env.LOCAL_STACK_AGENTS_IDENTITY === 'off' ? { IDENTITY_URL: 'http://127.0.0.1:9' } : {}),
  }),
});
