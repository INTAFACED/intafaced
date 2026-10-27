export default ({ c, secrets, dbUrl, urlOf, PORTS, opsOutreachEnv }) => ({
  name: 'ops',
  env: () => ({
    ...c('svc-ops', PORTS.ops),
    DATABASE_URL: dbUrl('svc_ops', secrets),
    // svc-ops opens its CRM store only with an explicit pool size; blank leaves the intake refusing.
    OPS_DATABASE_POOL_MAX: '4',
    IDENTITY_URL: urlOf('identity'),
    // Staff holds on funds (J-ops-console-04 #2-#5) post through the ledger. LOCAL TEST values, not owner decisions: the
    // TEST account a confirmed hold moves to, and the longest expiry a hold may be given. Unset, confirm refuses
    // owner.decision and an expiry refuses ops.hold_expiry_unset.
    LEDGER_URL: urlOf('ledger'),
    OPS_STAFF_HOLD_CONFIRM_ACCOUNT: 'test-held-funds',
    OPS_STAFF_HOLD_EXPIRY_MAX_HOURS: '24',
    ...opsOutreachEnv(),
  }),
});
