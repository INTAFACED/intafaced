import { loadProfile } from '../owner-settings.mjs';

/** One labelled TEST value from this service's profile file; a missing one names the file instead of a bare TypeError. */
function testValue(name) {
  const entry = loadProfile().values[name];
  if (!entry) throw new Error(`${name} is missing from tooling/profiles/test-owner-values/ops.json.`);
  return entry.value;
}

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
    // Home's owner values (home.config: J-home-ia-01 #4, J-home-ia-02 #5), labelled TEST in the ops profile. Unset, Home's
    // work list refuses home.work_list_cap_unset and the header search's Help group says no limit is set.
    OPS_HOME_WORK_LIST_CAP: testValue('OPS_HOME_WORK_LIST_CAP'),
    OPS_HOME_WORK_LIST_ORDER: testValue('OPS_HOME_WORK_LIST_ORDER'),
    OPS_HOME_SEARCH_RESULT_CAP: testValue('OPS_HOME_SEARCH_RESULT_CAP'),
    // Reconciliation alerts (OPS-reconciliation-03, J-ops-console-07 #8): the TEST repeat interval for in-console notices.
    // Unset, a repeat failure still counts and its notice reads ops.alert_repeat_unset. The ledger feed uses LEDGER_URL above.
    OPS_RECON_ALERT_REPEAT_SECONDS: testValue('OPS_RECON_ALERT_REPEAT_SECONDS'),
    ...opsOutreachEnv(),
  }),
});
