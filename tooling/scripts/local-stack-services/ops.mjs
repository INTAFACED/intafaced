import { profileEnvFor } from '../owner-settings.mjs';

// LOCAL TEST only, the labelled values in tooling/profiles/test-owner-values/ops.json: Home's "Needs you" cap and order
// and the header search's help cap (home.config). Blank in production, where Home refuses each by code. Only these
// three: the file's restore values stay off this stack.
const HOME_VALUES = ['OPS_HOME_WORK_LIST_CAP', 'OPS_HOME_WORK_LIST_ORDER', 'OPS_HOME_SEARCH_RESULT_CAP'];
function homeTestValues() {
  const profile = profileEnvFor('ops', 'dev');
  const missing = HOME_VALUES.filter((name) => profile[name] === undefined);
  if (missing.length > 0) throw new Error(`${missing.join(', ')} missing from tooling/profiles/test-owner-values/ops.json.`);
  return Object.fromEntries(HOME_VALUES.map((name) => [name, profile[name]]));
}

export default ({ c, secrets, dbUrl, urlOf, PORTS, opsOutreachEnv }) => ({
  name: 'ops',
  env: () => ({
    ...c('svc-ops', PORTS.ops),
    DATABASE_URL: dbUrl('svc_ops', secrets),
    // svc-ops opens its CRM store only with an explicit pool size; blank leaves the intake refusing.
    OPS_DATABASE_POOL_MAX: '4',
    IDENTITY_URL: urlOf('identity'),
    ...homeTestValues(),
    ...opsOutreachEnv(),
  }),
});
