import { loadProfile } from '../owner-settings.mjs';

/** One labelled TEST value from this service's profile file; a missing one names the file instead of a bare TypeError. */
function testValue(name) {
  const entry = loadProfile().values[name];
  if (!entry) throw new Error(`${name} is missing from tooling/profiles/test-owner-values/ops.json.`);
  return entry.value;
}

/**
 * The joint restore desk (J-ops-console-08 #5-#7): the ops profile's TEST archive URL and storage target, and the bank and
 * pay watermark doors it reads beside the ledger and identity. `LOCAL_STACK_OPS_RESTORE=off` on a start or restart leaves
 * all of it blank, so the "no archive configured" refusal (#4) can be seen too.
 */
const restoreDesk = (urlOf) =>
  process.env.LOCAL_STACK_OPS_RESTORE === 'off'
    ? {}
    : {
        OPS_RESTORE_ARCHIVE_URL: testValue('OPS_RESTORE_ARCHIVE_URL'),
        OPS_RESTORE_TARGET: testValue('OPS_RESTORE_TARGET'),
        BANK_URL: urlOf('bank'),
        PAY_URL: urlOf('pay'),
      };

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
    // Home's announcement strip count (J-home-ia-06), TEST in the same profile. `LOCAL_STACK_OPS_HOME_NOTICE_STRIP_LIMIT=off`
    // on a start or restart leaves it blank, so the strip's refusal (home.notice_strip_limit_unset) can be seen.
    ...(process.env.LOCAL_STACK_OPS_HOME_NOTICE_STRIP_LIMIT === 'off'
      ? {}
      : { OPS_HOME_NOTICE_STRIP_LIMIT: testValue('OPS_HOME_NOTICE_STRIP_LIMIT') }),
    // Reconciliation alerts (OPS-reconciliation-03, J-ops-console-07 #8): the TEST repeat interval for in-console notices.
    // Unset, a repeat failure still counts and its notice reads ops.alert_repeat_unset. The ledger feed uses LEDGER_URL above.
    OPS_RECON_ALERT_REPEAT_SECONDS: testValue('OPS_RECON_ALERT_REPEAT_SECONDS'),
    ...restoreDesk(urlOf),
    ...opsOutreachEnv(),
  }),
});
