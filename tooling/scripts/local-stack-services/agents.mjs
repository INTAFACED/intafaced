/** LOCAL TEST rates per million tokens, in TEST USDT, for every task the default table routes. Not product prices. */
const TEST_ROUTING_TABLE = {
  routes: [
    { task: 'navigator.plan', maxOutputTokens: 4096, price: { inputPerMillion: '3', outputPerMillion: '15' } },
    { task: 'navigator.tool_select', maxOutputTokens: 1024, price: { inputPerMillion: '1', outputPerMillion: '5' } },
    { task: 'support.reply', maxOutputTokens: 2048, price: { inputPerMillion: '1', outputPerMillion: '5' } },
    { task: 'support.classify', maxOutputTokens: 256, price: { inputPerMillion: '0.25', outputPerMillion: '1.25' } },
    { task: 'scanner.rank', maxOutputTokens: 2048, price: { inputPerMillion: '1', outputPerMillion: '5' } },
    { task: 'merchant.watch', maxOutputTokens: 1024, price: { inputPerMillion: '1', outputPerMillion: '5' } },
    { task: 'copy_intel.stats', maxOutputTokens: 2048, price: { inputPerMillion: '1', outputPerMillion: '5' } },
    { task: 'index.embed', maxOutputTokens: 1, capability: 'embed', price: { inputPerMillion: '0.1', outputPerMillion: '0' } },
  ].map((route) => ({ providerId: 'primary', model: 'test-engine', ...route })),
};

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
    // Required, no default (owner-unpublished). LOCAL TEST values.
    AGENTS_FEE_ASSET_ID: 'USDT',
    AGENTS_USAGE_WINDOW_MINUTES: '60',
    // Metered with labelled TEST rates (OWNER 107: prices stay blank in production; test stacks use labelled TEST
    // rates). Usage settles as a TEST fee charge through the ledger, from the account's TEST USDT.
    AGENTS_METERING_ENABLED: 'true',
    AGENTS_ROUTING_TABLE: JSON.stringify(TEST_ROUTING_TABLE),
    // The service's deterministic stand-in engine, which /ready and every route report as "sandbox": no model
    // provider is connected on a test stack and no real inference runs.
    AGENTS_PROVIDER: 'mock',
  }),
});
