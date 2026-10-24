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
    // LOCAL TEST only, the labelled values in tooling/profiles/test-owner-values/ops.json: Home's "Needs you" cap and
    // order and the header search's help cap (home.config). Blank in production, where Home refuses each by code.
    OPS_HOME_WORK_LIST_CAP: testValue('OPS_HOME_WORK_LIST_CAP'),
    OPS_HOME_WORK_LIST_ORDER: testValue('OPS_HOME_WORK_LIST_ORDER'),
    OPS_HOME_SEARCH_RESULT_CAP: testValue('OPS_HOME_SEARCH_RESULT_CAP'),
    ...opsOutreachEnv(),
  }),
});
