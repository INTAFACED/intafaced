import { OUTSIDE_SOURCE_PORT, OUTSIDE_SOURCE_RAILS } from '../local-test-outside-source.mjs';

/**
 * The outside-balance snapshot svc-ledger reads (LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL, an owner value). Unset by default, so an
 * outside-balance control shows its outside side unset (J-ops-console-07 #3). `LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT=unreachable`
 * on a start or restart points it at a closed local port, so a run shows ERROR when its outside source cannot be read
 * (J-ops-console-07 #5). `=rails` points it, and each recording rail's statement URL, at the stack's LOCAL TEST outside
 * source (local-test-outside-source.mjs), which totals the rails' own records, so a run reads what the rails say
 * (J-ops-console-27 #8). LOCAL TEST only, not an owner decision.
 */
function outsideSnapshot() {
  const asked = process.env.LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT;
  if (asked === undefined || asked === '') return {};
  if (asked === 'unreachable') return { LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL: 'http://127.0.0.1:9/local-test-outside-snapshot' };
  if (asked === 'rails') {
    const base = `http://127.0.0.1:${OUTSIDE_SOURCE_PORT}`;
    const statements = OUTSIDE_SOURCE_RAILS.map((rail) => [
      `LEDGER_RECONCILE_RAIL_${rail.toUpperCase().replaceAll('-', '_')}_URL`,
      `${base}/statement`,
    ]);
    return { LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL: `${base}/snapshot`, ...Object.fromEntries(statements) };
  }
  throw new Error(`LOCAL_STACK_LEDGER_OUTSIDE_SNAPSHOT is "${asked}"; leave it unset for no snapshot, or set it to unreachable or rails.`);
}

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
  }),
});
