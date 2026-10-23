export default ({ c, secrets, dbUrl, PORTS, UNUSED }) => ({
  name: 'blueprint',
  env: () => ({
    ...c('svc-blueprint', PORTS.blueprint),
    DATABASE_URL: dbUrl('svc_blueprint', secrets),
    // The neural engine is an outside provider. "http" at a closed loopback port means the engine
    // is unreachable and requests fail; the stub engine ("mock") is deliberately not used.
    BLUEPRINT_ENGINE_MODE: 'http',
    BLUEPRINT_ENGINE_URL: UNUSED,
  }),
});
