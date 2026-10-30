/**
 * SUITES THAT STILL SKIP WITHOUT SAYING SO — the register of what is NOT fixed.
 *
 * WHY THIS FILE EXISTS RATHER THAN AN `// eslint-disable`-SHAPED EXEMPTION
 *
 * The change that added `postgresAvailable` journalling and
 * `tooling/ci/skip-honesty-scan.mjs` could not reach every offender. Each entry
 * below carries the specific reason it was left and what would lift it.
 *
 * PRIVATE_PROBE is empty. The last money private probe
 * (`svc-pay/src/rails/evm-chain.live.test.ts`) now journals via `recordInfraProbe`.
 * Lifting it from this list is the debt being paid, not a silent exemption:
 * skip-honesty will fail a new private probe on that path the same as anywhere else.
 *
 * svc-protocol's UNJOURNALLED lock below is NOT a phantom. `/services/svc-protocol/`
 * is a real CODEOWNERS line, so that hold names its scope, sits where merges pass,
 * and states who lifts it.
 *
 * So the register is loud in both directions:
 *
 *   · `skip-honesty-scan.mjs` does not fail on these, but the list CANNOT GROW —
 *     a new private probe anywhere else is still red.
 *   · It is not left to go stale quietly. If an entry stops violating, the scan
 *     warns and names the entry to delete; it does not fail, since a fix never
 *     fails the build (owner decision 2026-10-27). Until it is deleted, the
 *     verdict below still cannot say COMPLETE.
 *   · `infra-verdict.mjs` refuses to say COMPLETE while any entry stands. The
 *     strongest sentence it can print becomes "complete except for the suites
 *     below, which cannot report either way" — which is the true one.
 *
 * Every entry is a debt with a named owner, not a decision.
 */

/**
 * Test files that decide whether to run using a connection they opened
 * themselves. `catch { return false }` — so `CI=true` and `REQUIRE_POSTGRES=1`
 * do nothing to them, and they skip on CI counted as passes.
 *
 * @type {{file: string, dependency: string, owner: string, why: string}[]}
 */
export const PRIVATE_PROBE = [
  // payment-service.test.ts lifted 2026-08-09 — #346; postgresAvailable.
  // evm-chain.live.test.ts lifted 2026-09-04 — journals recordInfraProbe; still
  // on money-skip-inventory as infra-journalled until CI runs a chain for pay.
];

/**
 * Files whose skip guard DOES call a shared probe — so `skip-honesty-scan` is
 * satisfied — but whose probe does not write to the infra journal. They cannot
 * skip dishonestly, yet the verdict still cannot count them, so "COMPLETE" would
 * be a claim about suites nobody measured.
 *
 * @type {{file: string, probeSource: string, dependency: string, owner: string, why: string}[]}
 */
export const UNJOURNALLED = [
  'services/svc-protocol/src/accounts/create2-onchain.test.ts',
  'services/svc-protocol/src/amm/mint-swap-onchain.test.ts',
  'services/svc-protocol/src/amm/pool-factory-onchain.test.ts',
  'services/svc-protocol/src/chain/refusal-without-chain.test.ts',
  'services/svc-protocol/src/launch/router-launch-live.test.ts',
  'services/svc-protocol/src/launch/token-factory-onchain.test.ts',
  'services/svc-protocol/src/router.live-chain.test.ts',
].map((file) => ({
  file,
  probeSource: 'services/svc-protocol/scripts/dev-chain.ts',
  dependency: 'evm-chain',
  owner: 'svc-protocol CODEOWNERS (M1–M7 human lock)',
  /**
   * Enumerated rather than described as "svc-protocol's chain suites". The first
   * draft of this register named two of them — the two that skip the whole file —
   * and missed the five that skip a describe block, which is the same silence in
   * a shape that reads as smaller. Undercounting the register is the identical
   * error to undercounting the suites; both produce a number a reader trusts.
   */
  why:
    "skips on `devChainReachable`, which is honest but silent: svc-protocol's copy does not call " +
    "recordInfraProbe, so the verdict cannot count this suite either way. svc-indexer's copy of the " +
    "same helper is journalled in this change; svc-protocol's is byte-identical work, left alone only " +
    'because the service is under the human lock.',
}));

/** Flat view for anything that just needs the file names. */
export const ALL_UNREPORTED = [...PRIVATE_PROBE, ...UNJOURNALLED];
