import path from 'node:path';

export default ({ c, urlOf, PORTS, P, localOperatorIds, PLACEHOLDER_OPERATOR_IDS }) => ({
  name: 'matching',
  env: () => ({
    ...c('svc-matching', PORTS.matching),
    MATCHING_ENGINE_ENABLED: 'true',
    MATCHING_SNAPSHOT_EVERY: '0', // required, owner-unpublished; 0 = snapshotting off (no magnitude invented)
    MATCHING_JOURNAL_PATH: path.join(P.data, 'matching', 'engine_journal.ndjson'),
    // Opening a market needs a two-person approval that matching consumes from identity
    // (services/svc-matching/src/action-approval-consume.ts). Without this it refuses by name.
    IDENTITY_URL: urlOf('identity'),
    // Matching reads order:<id> holds read-only from the ledger at boot; without it a journal with resting orders boots closed (matching.hold_check_unwired).
    LEDGER_URL: urlOf('ledger'),
    // Opening a market also requires BOTH the proposer and the approver to be on this list (security fix #4742;
    // unset, nobody can open a market). LOCAL TEST: the two labelled operators of local-test-gates.mjs, read
    // from operators.json. They exist only after `local-test-gates.mjs operators`, so the first time restart
    // matching afterwards (pnpm local:stack:restart matching). Harmless before #4742 merges.
    // svc-matching refuses to boot with fewer than two operator ids, so a fresh state boots on two placeholder
    // ids that match no account; `local-test-gates.mjs operators` then restart matching swaps in the real two.
    MATCHING_OPERATOR_IDS: localOperatorIds() || PLACEHOLDER_OPERATOR_IDS,
  }),
});
