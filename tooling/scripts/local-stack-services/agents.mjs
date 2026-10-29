import { loadProfile } from '../owner-settings.mjs';

/** One labelled TEST value from this service's profile file; a missing one names the file instead of a bare TypeError. */
function testValue(name) {
  const entry = loadProfile().values[name];
  if (!entry) throw new Error(`${name} is missing from tooling/profiles/test-owner-values/agents.json.`);
  return entry.value;
}

export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
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
    // LOCAL TEST only, the labelled values in tooling/profiles/test-owner-values/agents.json. Metered at TEST rates, so
    // a run charges TEST USDT through the ledger (OWNER 107). Production leaves the rates blank, and every run refuses
    // agents.price_unset before the engine.
    AGENTS_FEE_ASSET_ID: testValue('AGENTS_FEE_ASSET_ID'),
    AGENTS_USAGE_WINDOW_MINUTES: testValue('AGENTS_USAGE_WINDOW_MINUTES'),
    AGENTS_METERING_ENABLED: testValue('AGENTS_METERING_ENABLED'),
    AGENTS_ROUTING_TABLE: testValue('AGENTS_ROUTING_TABLE'),
    // The service's deterministic stand-in engine, which /ready and every route report as "sandbox": no model
    // provider is connected on a test stack and no real inference runs.
    AGENTS_PROVIDER: 'mock',
  }),
});
