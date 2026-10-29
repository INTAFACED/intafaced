/**
 * The outside-balance snapshot svc-ledger reads (LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL, an owner value). Unset by default, so an
 * outside-balance control shows its outside side unset (J-ops-console-07 #3). `LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT=unreachable`
 * on a start or restart points it at a closed local port, so a run shows ERROR when its outside source cannot be read
 * (J-ops-console-07 #5). LOCAL TEST only, not an owner decision.
 */
function outsideSnapshot() {
  const asked = process.env.LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT;
  if (asked === undefined || asked === '') return {};
  if (asked === 'unreachable') return { LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL: 'http://127.0.0.1:9/local-test-outside-snapshot' };
  throw new Error(`LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT is "${asked}"; leave it unset for no snapshot, or set it to unreachable.`);
}

import { STATEMENT_RAILS, railStatementEnv } from '../local-test-rail-statements.mjs';

export default ({ c, secrets, dbUrl, urlOf, PORTS }) => ({
  name: 'ledger',
  env: () => ({
    ...c('svc-ledger', PORTS.ledger),
    DATABASE_URL: dbUrl('svc_ledger', secrets),
    LEDGER_POSTING_ENABLED: 'true',
    // Required, no default. LOCAL TEST value chosen for this stack only, not an owner decision.
    RECONCILE_CRON_MINUTES: '60',
    // Asset registry edits consume a founder approval from identity; without it they refuse identity_unwired.
    IDENTITY_URL: urlOf('identity'),
    ...outsideSnapshot(),
    // LOCAL TEST: each rail whose stand-in keeps its own records answers for its boundary from those records
    // (local-test-rail-statements.mjs), so a per-rail outside control compares rail:<rail> with the rail's own word.
    // Rail local-test is the TEST mint and has none.
    ...Object.fromEntries(STATEMENT_RAILS.map((rail) => [railStatementEnv(rail), `${urlOf('rail-statements')}/statement`])),
  }),
});
