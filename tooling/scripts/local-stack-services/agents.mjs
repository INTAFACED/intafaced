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
 */
function routingTable() {
  const table = JSON.parse(testValue('AGENTS_ROUTING_TABLE'));
  if (process.env.LOCAL_STACK_AGENTS_COACH_ROUTE === 'off') return JSON.stringify(table);
  return JSON.stringify({ ...table, routes: [...table.routes, JSON.parse(testValue('AGENTS_COACH_ROUTE'))] });
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
    AGENTS_ROUTING_TABLE: routingTable(),
    // The service's deterministic stand-in engine, which /ready and every route report as "sandbox": no model
    // provider is connected on a test stack and no real inference runs.
    AGENTS_PROVIDER: 'mock',
    // While this file exists the stand-in engine parks each completion before it answers, so a journey can read the
    // service's own record of a run the engine has not answered yet (J-agents-01 #5). Absent, it answers at once.
    AGENTS_MOCK_HOLD_FILE: path.join(STATE, 'agents-engine.hold'),
  }),
});
