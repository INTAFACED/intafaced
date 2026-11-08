/**
 * The paths the test judge rules on (tooling/ci/test-judge.mjs, the seal's `Test judge` verdict), in a module with no
 * imports, so test-diff-guard.mjs can read them from main's copy beside it (ci.yml copies the guard's imports from main).
 * A change to a judged path is ruled on by the judge, so the guard's weakening checks leave those files to it (R3 C6).
 */
/** The journey tests and the shared code they run on: a pull request that changes any of these is judged. */
export const JUDGE_PATHS = [
  [/^apps\/customer\/tests\/real-app\//, 'the journey tests and their harness'],
  [/^tooling\/scripts\/local-stack-services\//, "the local stack's per-service settings"],
  [/^tooling\/scripts\/local-stack-fixtures\//, "the local stack's fixtures"],
  [/^tooling\/scripts\/local-test-[^/]+$/, 'the local test world and stack tools'],
  [/^tooling\/scripts\/local-(founder-seed|video-store)\.mjs$/, 'the local stack tools the journeys call'],
  [/^tooling\/scripts\/journey-(world|fund|fail-fast|freeze-guard)\.mjs$/, 'the journey harness tools'],
  [/^tooling\/scripts\/seed-[^/]*test[^/]*\.mjs$/, 'the TEST seeds the journeys call'],
  [/^tooling\/scripts\/owner-settings\.mjs$/, 'the owner settings the journeys read'],
  [/^tooling\/profiles\/test-owner-values\//, 'the TEST owner values'],
  // Product files the journey tests and look sweeps import: what they answer or match decides what a test observes.
  [/^apps\/customer\/src\/screens\/[^/]+\/[^/]+\.fixtures\.mjs$/, 'the screen fixtures the look sweeps answer from'],
  [/^apps\/customer\/src\/app\/(feature-registry|path-match)\.ts$/, 'the feature registry and path matcher the journeys import'],
  [/^apps\/customer\/deployment\/(host-dispatch|render-security-headers)\.mjs$/, 'the host dispatch and headers the journeys import'],
  [/^services\/svc-fix\/scripts\/ensure-toolchain\.mjs$/, 'the FIX toolchain the journeys start'],
  // Everything proof v2's reach reads covered (project-state tooling/proof-v2/request.mjs, reachKind), so the judge can
  // stand in for them: any tests/real-app/ folder, and every tool script under tooling/scripts/ (its unit tests aside).
  [/(^|\/)tests\/real-app\//, 'a real-app test folder'],
  [/^tooling\/scripts\/[^/]+\.mjs$/, 'the tool scripts'],
];
const UNIT_TEST = /\.test\.(mjs|ts|js)$/;
/** Whether a file is shared test code or a journey test the judge rules on. */
// A unit test is skipped only where proof v2's reachKind skips one: directly under tooling/scripts/. Anywhere else
// (any tests/real-app/ folder, the TEST config folders) a file named like a unit test is still judged.
const SKIPPED_UNIT_TEST = /^tooling\/scripts\/[^/]+$/;
export const judgedFile = (f) => !(UNIT_TEST.test(f) && SKIPPED_UNIT_TEST.test(f)) && JUDGE_PATHS.some(([re]) => re.test(f));
