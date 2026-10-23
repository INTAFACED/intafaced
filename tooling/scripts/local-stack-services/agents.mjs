export default ({ c, secrets, dbUrl, urlOf, PORTS, UNUSED }) => ({
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
    // Required, no default (owner-unpublished). Inert LOCAL TEST placeholders: metering is off,
    // so no usage fee is ever charged.
    AGENTS_FEE_ASSET_ID: 'USDT',
    AGENTS_USAGE_WINDOW_MINUTES: '60',
    AGENTS_METERING_ENABLED: 'false',
    // No model provider is connected: "upstream" pointed at a closed loopback port, so every
    // model call fails with a connection error instead of returning invented text. The service's
    // built-in "mock" provider is deliberately not used.
    AGENTS_PROVIDER: 'upstream',
    AGENTS_UPSTREAM_BASE_URL: UNUSED,
    AGENTS_UPSTREAM_API_KEY: 'not-connected-local-test',
  }),
});
