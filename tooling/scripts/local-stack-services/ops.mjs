export default ({ c, secrets, dbUrl, urlOf, PORTS, opsOutreachEnv }) => ({
  name: 'ops',
  env: () => ({
    ...c('svc-ops', PORTS.ops),
    DATABASE_URL: dbUrl('svc_ops', secrets),
    // svc-ops opens its CRM store only with an explicit pool size; blank leaves the intake refusing.
    OPS_DATABASE_POOL_MAX: '4',
    IDENTITY_URL: urlOf('identity'),
    ...opsOutreachEnv(),
  }),
});
