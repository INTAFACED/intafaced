#!/usr/bin/env node
/**
 * DOCTRINE GATES — one list, run by `pnpm verify` AND by CI.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `AGENTS.md` and its sibling agent entry file both tell every human and every
 * agent the same thing: run `pnpm verify` before you claim done. That promise
 * is only worth something if `verify` runs what CI runs. Until this file it did
 * not, and the two lists lived in two places that knew nothing about each other:
 *
 *   · the `verify` script in package.json, and
 *   · the eleven hand-written steps in the `gates` job of ci.yml.
 *
 * Two gates had already drifted out of the local list — `scan:dual-book-door-paths`
 * and `scan:test-db` — so an engineer could run `pnpm verify` green, push, and
 * land red on a gate they had no local way of running. That is the exact failure
 * this file removes: CI and verify now consume the SAME array, so a gate cannot
 * be in one and missing from the other.
 *
 * It also removes a duplication. Six of these scans used to run twice per CI
 * run — once in the `gates` job and again inside `dod-gate.mjs` in the `dod`
 * job. `dod-gate.mjs` is now what its name says: the per-service §14 Definition
 * of Done. The repo-wide scans live here.
 *
 * THE THIRD DRIFT, and the one that actually bit
 * ─────────────────────────────────────────────
 * `i18n-scan.mjs` sat in `tooling/ci/` for weeks wired into nothing at all —
 * not verify, not CI. Nobody deleted it and nobody ran it. So this runner
 * asserts that EVERY `.mjs` in `tooling/ci/` is either in `GATES` below or in
 * `NOT_GATES` with a written reason. A new scan cannot be added and quietly
 * never run: the manifest check fails until someone says which it is.
 *
 * Usage:
 *   node tooling/ci/gates.mjs          run every gate, report all failures
 *   node tooling/ci/gates.mjs --list   print the gate ids, one per line
 *   node tooling/ci/gates.mjs --changed
 *        a builder's local run: the tooling tests (about four minutes on the Mac) run only when the branch's diff
 *        against its merge-base with origin/main, plus uncommitted and untracked files, touches tooling/ or .github/
 *        (the tooling tests read the workflows too); every other gate runs as always. `--base <ref>` compares against
 *        another ref (a stacked branch). An unreadable diff runs everything. CI and main never pass the flag: they
 *        keep the full run (U4, project-state #1574).
 *   node tooling/ci/gates.mjs --before-push
 *        what .githooks/pre-push runs: every gate but LEFT_TO_CI_BEFORE_PUSH, all at once.
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const CI_DIR = join(ROOT, 'tooling', 'ci');

/**
 * The gates. Ordered cheapest-and-most-structural first, so the fastest
 * feedback is the feedback you get first.
 *
 * `advisory: true` means the scan runs and prints but cannot fail the build —
 * used only where the scan is a reporter by design. It is NOT a way to silence
 * a gate that fails; see i18n below for the one case and why.
 */
export const GATES = [
  {
    id: 'tooling-tests',
    script: 'tooling/scripts/tooling-tests.mjs',
    doctrine: 'merge condition (2026-10-13); every tooling test on every PR (owner decision 2026-10-31)',
    why:
      'the unit tests of the tools that decide what may merge and of the local test stack: every tooling/scripts/*.test.mjs, ' +
      'including gate-files (which files need the CI review), gate-gh (a 403 or 429 stops) and ' +
      'local-test-stack. Until 2026-10-31 only two of 28 ran here, so a stack change could land with its own tests red. ' +
      'Lives in tooling/scripts/, so the manifest check below does not cover it: this entry is the only thing running ' +
      'those tests, and deleting it has to be a visible act. About 40 seconds, no network.',
  },
  {
    id: 'truth-check',
    script: 'tooling/scripts/truth-check.mjs',
    doctrine: 'agent map honesty',
    why:
      'the agent entry files (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, README.md) must not teach a retired rule (self-merge, forced ' +
      'worktree removal, the Vue front end) and their links must resolve. It only ran in .githooks/pre-push, which a cloud push ' +
      'never runs, so a stale rule could reach main unchecked. It reads only those entry files, so it cannot block product work.',
  },
  {
    id: 'dead-code',
    script: 'tooling/ci/dead-code.mjs',
    doctrine: 'delete dead code an agent would copy (project-state#2848)',
    why:
      'knip lists every file no entry reaches and every export no other file imports, in every workspace; a change that ' +
      "adds one to tooling/ci/dead-code-baseline.json's list fails and is named. Replaced the reachability scan, which " +
      'matched import basenames over services/ and packages/ only, and the journey-helpers check, which covered one ' +
      'folder. Also holds the protected keep-list: a deleted keeper fails.',
  },
  {
    id: 'brand',
    script: 'tooling/ci/brand-scan.mjs',
    doctrine: '§0.7',
    why:
      'a partner or model-vendor name in user-facing copy. D26-P2-14: also walks discovered project roots ' +
      '(incl. `.vue`) and Java `src/main/resources`, so partner names cannot hide in a shell or resource catalogue.',
  },
  {
    id: 'custody',
    script: 'tooling/ci/custody-scan.mjs',
    doctrine: '§16.10',
    why: 'a Protocol Plane service importing a ledger write recipe or a contract with platform withdrawal power; also fails if the deleted vendor/ Java exchange and wallet tree returns',
  },
  {
    id: 's2s',
    script: 'tooling/ci/s2s-scan.mjs',
    doctrine: 'service-to-service auth',
    why:
      'every service signs its calls with the one shared internal secret, so any service can pose as any other. ' +
      'Services are moving to per-service keys; this holds hand-signed calls (serviceAuthHeaders*) and ctx.service ' +
      'name comparisons to a per-file baseline that may only shrink, so the move cannot be undone one file at a time.',
  },
  {
    id: 'secrets',
    script: 'tooling/ci/secret-scan.mjs',
    doctrine: '§16',
    why: 'a committed credential is invisible in review — it reads as a config line',
  },
  {
    id: 'test-db',
    script: 'tooling/ci/test-db-scan.mjs',
    doctrine: 'test isolation',
    why: 'a suite pointed at the shared database is how someone else’s main goes red',
  },
  {
    id: 'killswitch',
    script: 'tooling/ci/killswitch-reachability.mjs',
    doctrine: '§14.6',
    why: 'every route killable, enforced at the door, failing closed',
  },
  {
    id: 'screening-content',
    script: 'tooling/ci/screening-content-scan.mjs',
    doctrine: '§24 Lane A / Class X',
    why:
      'sanctions list CONTENT is counsel + Nitro human (Class X). The screening mechanism ships empty; a populated ' +
      'default in source, env examples, or compose would invent a legal control nobody signed. Unit tests already say ' +
      '"ships empty" — this gate re-derives it on every verify so list content cannot land as a helpful default.',
  },
  {
    id: 'migrations',
    script: 'tooling/ci/migration-check.mjs',
    doctrine: '§14',
    why: 'every migration reversible, destructive statements declared',
  },
  {
    id: 'cross-package-reads',
    script: 'tooling/ci/cross-package-reads.mjs',
    doctrine: 'CI redesign 2026-10-19 (MAINRED3)',
    why:
      'affected-test selection follows the workspace graph, and a test that reads another package’s files without ' +
      'declaring it is invisible to that graph: change the other package and the test is not selected. MAINRED3 was ' +
      'exactly that — a svc-trade change broke an apps/customer test that reads svc-trade. Every cross-package read must ' +
      'be declared in tooling/ci/test-read-edges.json. The same reads are hidden from turbo’s cache key, so it also fails when ' +
      'turbo.json’s generated <package>#typecheck / #build inputs miss one: a cached pass must never replay after a read package changed.',
  },
  {
    id: 'boundary',
    script: 'tooling/ci/boundary-scan.mjs',
    doctrine: 'architecture refactor W7 (2026-10-19)',
    why:
      'services never reach into each other and money moves only through the ledger. Fails on an @intafaced/svc-* dependency ' +
      'or a workspace dependency cycle, an import or disk read that climbs into another service, SQL against another ' +
      'service’s schema (any tag, string or .unsafe), a ledger entry, hand-built LedgerClient or /trpc/post outside ' +
      'ledger-client and svc-ledger, a balance-like column (also via ADD COLUMN or a drizzle schema), and a randomUUID, ' +
      'Date.now or Math.random idempotency key (also through a variable or on the next line), and a Vue-family dependency ' +
      '(vue, vuex, nuxt, @vue/*, @nuxt/*, vue-*) in any package.json, since the front end is React (AGENTS.md). Its old duplicate ratchet ' +
      '(local scales, result?.data unwraps, padEnd parsers, timeout-less fetch) is held by lint-ratchet below. Exceptions ' +
      'are named with a reason in tooling/ci/boundary-allow.json.',
  },
  {
    id: 'skip-honesty',
    script: 'tooling/ci/skip-honesty-scan.mjs',
    doctrine: '§14',
    why:
      'a test file that decides whether to run using a connection it opened itself can skip on CI ' +
      'without honouring REQUIRE_POSTGRES. Six money and identity suites had each copied such a probe, ' +
      'so a database hiccup skipped them silently and the build went green. All six money/identity ' +
      'private probes are gone; PRIVATE_PROBE is empty. Remaining unreported debt is svc-protocol ' +
      'UNJOURNALLED (held under the former Protocol Plane lock; journalling it is open agent work). The scan prints those and fails if an entry goes stale.',
  },
  {
    id: 'money-skip-honesty',
    script: 'tooling/ci/money-skip-honesty-scan.mjs',
    doctrine: '§14 / D26-P2-13',
    why:
      'skip-honesty forbids new private probes repo-wide; money still needed a sealed inventory so a new ' +
      'conditional skip (or hard it.skip) under ledger/trade/pay/bank/p2p/matching/token/market/ws cannot ' +
      'grow silently and look like coverage. tooling/ci/money-skip-inventory.mjs is the register — every ' +
      'money-path skip is listed with a kind, or deleted. The list ratchets both ways. No private-probe ' +
      'money rows remain; the pay EVM live rail is infra-journalled and still listed until CI runs a chain.',
  },
  {
    id: 'compose-secret-parity',
    script: 'tooling/ci/compose-secret-parity.mjs',
    doctrine: '§14',
    why:
      'every secret a service refuses to boot without must actually be passed to its container. ' +
      'This class has bitten twice: svc-ledger crash-looped on JWT_ACCESS_SECRET (#431) and svc-academy was ' +
      'never created at all (#442). It is silent in BOTH directions — a running container keeps the environment ' +
      'it started with, and a container nobody started writes no logs. Run against the commit before #431, this ' +
      'gate reproduces that bug and emits the exact fix that was applied.',
  },
  {
    id: 'service-tracing',
    script: 'tooling/ci/service-tracing.mjs',
    doctrine: '§14',
    why:
      'every service a compose file runs starts tracing: a Node entry calls startTelemetry and registerProcessHooks, ' +
      'the Java gateway loads the OpenTelemetry agent. svc-mining-pool ran with no tracer and svc-fix with none at all, ' +
      'and only a report-only script ever said so.',
  },
  {
    id: 'secret-rotation-readiness',
    script: 'tooling/ci/secret-rotation-readiness-scan.mjs',
    doctrine: '§16 / D26-P3-05',
    why:
      'rotation readiness is a runbook plus the gates that prove a disclosed or unwired secret is refused. ' +
      'A missing inventory prints as nothing-to-rotate. This gate holds docs/SECRET-ROTATION-READINESS.md, ' +
      'the OWNER-ACTIONS-WALLET-RPC-SECRETS.md citation (that file is not edited here), ' +
      'and compose-secret-parity / secrets remaining in GATES. It never reads secret values.',
  },
  {
    id: 'secret-scan-mutation',
    script: 'tooling/ci/secret-scan.mutation.mjs',
    doctrine: '§14',
    why:
      'the mutation proof for secret-scan, and it belongs beside it rather than in a doc nobody re-runs. ' +
      'A scanner that passes is indistinguishable from a scanner that is switched off — `process.exit(0)` on line 1 ' +
      'prints the same green tick. This is what tells the two apart: 13 planted credentials must be caught and ' +
      '15 credential-shaped-but-correct fixtures must NOT fire.',
  },
  {
    id: 'money-property-mutation',
    script: 'tooling/ci/money-property.mutation.mjs',
    doctrine: '§4.2',
    why:
      'the mutation proof for the money property suite, by the same argument as secret-scan-mutation one layer ' +
      'down. Property tests are unusually good at looking rigorous while asserting little: `floor <= half-up <= ceil` ' +
      'reads like a claim about rounding and is satisfied by an implementation that ignores its rounding argument. ' +
      'Measured, not assumed — the first version of money.property.test.ts caught 3 of these 6 mutants, and a ' +
      'mulBps that ignores the caller, a parseAmount that truncates over-precision, and a proRata that pays the ' +
      'SMALLEST remainders all survived eighteen green properties. 6 planted defects, all must die.',
  },
  {
    id: 'lint-ratchet',
    script: 'tooling/ci/lint-ratchet.mjs',
    doctrine: 'one linter, as a count that can only fall',
    why:
      "lints the files a change touches at the merge base and at the head with MAIN's .oxlintrc.json and garden plugin, " +
      "and fails when a rule's count rises, printing each finding's line and fix. No baseline file: main is the baseline, so " +
      'a moved function does not fail. The rules shown to fail honest code only print, each with its reason ' +
      '(tooling/lint/ratchet.json). A few seconds.',
  },
  {
    id: 'empty-denominator',
    script: 'tooling/ci/empty-denominator-gate.mjs',
    doctrine: '§14 / empty-denominator law',
    why:
      'a check that reports on nothing and gets read as evidence is this repo’s single most repeated defect, and until ' +
      'this entry NOTHING enforced the rule against it. Seven gates had each learned it separately and hand-rolled a ' +
      'guard — brand-scan’s `scanned === 0`, i18n-scan, i18n-bypass-scan ("walked zero un-allowlisted files and ' +
      'printed"), wallet-rpc-mainnet-scan’s "every denominator non-zero", event-wiring, shell-brand-scan, ' +
      'vendor-java-money-scan — which meant the EIGHTH gate anyone wrote would not have it, because nothing would ask. ' +
      'This asks: it runs every gate in this list against a tree where its denominator is genuinely zero and asserts ' +
      'what it actually did, rather than grepping for a guard’s source text — which would prove a string exists, not ' +
      'that a gate refuses. Measured on arrival: 22 gates refuse, 3 are exempt because their subject travels with them ' +
      'in fixtures, and 7 print CLEAN over nothing and are frozen as debt that may only shrink. The loudest of the ' +
      'seven was fabricated-money (retired 2026-10-13 with the Vue customer site), which printed "NOTHING WAS SCANNED … ' +
      'discovery is broken" and then exited 0 — while shell-brand-scan prints that same sentence and exits 1. Ordered last because it is the most expensive gate here ' +
      '(~5s, it spawns every other gate once) and because it depends on nothing above it. It classifies ITSELF, and ' +
      'since it cannot run inside its own fixture without recursing, a self-proof runs on every invocation instead: ' +
      'handed a substitute list of zero gates, or one unclassified gate, it must refuse. That is the worktree-gc ' +
      '--self-test and RULE_PROBES precedent, and it is not optional here — a meta-gate about empty denominators is the ' +
      'most obvious candidate in this repo to BE one.',
  },
];

/**
 * Scripts in `tooling/ci/` that are deliberately NOT gates. Each needs a
 * reason, because "it is not in the list" is exactly how i18n-scan went
 * unrun for weeks.
 */
export const NOT_GATES = {
  'gates.mjs': 'this runner — it is the list, so it cannot be an entry in itself.',
  'brief-cases.mjs':
    "not a gate: scores the CI review's and the proof reader's briefs on the real cases beside them, by hand, on the signed-in reviewer CLI (project-state#2847: nothing runs on every push). Its tests are brief-cases.test.mjs.",
  'architecture-map.mjs':
    "not a gate: writes docs/ARCHITECTURE.md's count block (`node tooling/ci/architecture-map.mjs`). Its gate repeated architecture-map.test.mjs, whose first case fails when the committed doc is stale or a table drifted, and tooling-tests runs that on every PR.",
  'custody-layer-check.mjs':
    'not a gate on its own: check 4 of custody-scan.mjs (the custody switch, OWNER 226), imported and run by it, so the `custody` gate runs it. A separate module so its plants can run in a sandbox copy without touching the tree.',
  'api-budget.mjs':
    "not a gate: the words for GitHub's spent hourly API budget (403 or 429 with no calls left, or gh's \"API rate limit exceeded\"), which the seal's scripts put in their error and annotation title, so why-red.mjs reads such a red as JUDGE DOWN rather than a red of the change's own (project-state #2065 row d25). It changes no pass or fail. Its tests are api-budget.test.mjs.",
  'main-first.mjs':
    "not a gate: real-app-journeys.yml's `Main's journeys first` job, which defers a Real-app journeys run off main while a main run's jobs wait for runners, without holding a runner: the deferred run selects no journeys and ends, and the `release` job re-runs it when main's planner finishes (a hand-dispatched full run is also deferred while 2 others hold runners; INTAFACED/project-state#1574 item 3). It reads GitHub's Actions API, so a laptop verify has no input; its tests are main-first.test.mjs.",
  'model-check.mjs':
    "the plan of model-check.yml: which TLA+ models a change is checked against (every model, when a modelled service, a path a COVERS.md names or the check itself changes), failing on a model nothing runs. Not a doctrine gate: it needs the pull request's changed files, and the models need Java and minutes, so the Model check workflow runs it; its tests are model-check.test.mjs.",
  'journey-verdict.mjs':
    "the Real-app journeys run's verdict against docs/runbooks/journey-baseline.json, run by the Real-app journeys job of real-app-journeys.yml on a finished run's merged report. Not a doctrine gate: it needs a run's report, its baseline's named run and the pass history since, so a laptop verify has no input. Its tests are journey-verdict.test.mjs, run in the `changes` job of ci.yml.",
  'ci-affected.mjs':
    'path classifier for named CI test shards and the merge-seal aggregator. Invoked from ci.yml `changes` / `merge-seal` jobs. Not a doctrine gate: a laptop verify has no GitHub event payload, and reddening verify over missing GITHUB_OUTPUT is how a classifier gets deleted. Its tests are ci-affected.test.mjs.',
  'bisect-main.mjs':
    'runs from main-bisect.yml, started by Main trust when a main run has failed twice: walks the commits since the last green and comments the first one where the failing test files fail. Needs a token, a red run and the test infrastructure, so a laptop verify has no input. bisect-main.test.mjs runs the search on fixtures.',
  'test-shards.mjs':
    'splits the test suite into the shards of the Tests job (SHARD_COUNT in ci-affected.mjs) on a run-everything change. Not a doctrine gate: it prints package lists for turbo and asserts nothing about the code. test-shards.test.mjs proves every package with a test script runs exactly once (whole in one shard, or as each of its SPLIT pieces once), fails on a dropped, repeated or lost piece.',
  'main-trust.mjs':
    'runs from main-trust.yml after a CI run on main finishes: re-runs a red run once, opens red / flaky issues, publishes the last-green branch. Needs a GitHub token and a finished run, so a laptop verify has no input. main-trust.test.mjs checks the decision table and parser.',
  'journeys-revert.mjs':
    'runs from main-trust.yml (trigger) and main-bisect.yml (find, open): when a journey step that passed on main fails outright (or a step new to main fails outright on its first run, in a journey file changed since the run before), it finds the one pull request that broke it (the commits whose files reach the failing journeys, proven by the probe) and opens its revert with squash auto-merge through the normal seal, never more than one per red and never a revert of a revert. Needs a token, a red run and the factory App key, so a laptop verify has no input. journeys-revert.test.mjs checks the break rule, the narrowing and the refusals.',
  'journeys-revert-probe.mjs':
    'runs from main-bisect.yml when commits can reach the failing journeys: with at most 16 candidates, each one is probed at once on its own runner and fresh local test stack (journeys-revert-probe.sh) and `decide` names the oldest commit of the failing run that ends at the red one; past 16, one runner runs the binary search. Needs the stack, so a laptop verify has no input. journeys-revert-probe.test.mjs checks the search and the report reading.',
  'journeys-revive.mjs':
    "runs from main-trust.yml's `revive` job, hourly and after each CI run on main (`main`: the main pass only, since GitHub's cron here fires late or never): a Real-app journeys run on main that finished with no report.json (it died before its tests ran) has its failed jobs re-run with growing waits (30 min to 4 h), five attempts at most, then one issue names it; then (and from the post-merge job after each main journeys run) an open pull request's journeys run red only because its verdict couldn't read main's inputs is re-run once main is back (no main re-run going, the baseline's named run has its report, a run the rows name has finished, and the API budget has room after a rate limit), twice per head at most. It changes no verdict: a verdict still fails closed on a report it can't read, and skips a finished main run that kept none (journey-verdict.mjs readHistory). Needs a GitHub token and main's runs, so a laptop verify has no input; its tests are journeys-revive.test.mjs.",
  'shard-download.mjs':
    "runs from real-app-journeys.yml's scoreboard job (\"Merge the shards\"): downloads the run's shard reports, waits for the reset of a spent API budget (at most twice, never past the job's time) instead of carrying on with none, fails the step by name on any refusal, and prints the token's core budget before and after. Needs the run's own artifacts and token, so a laptop verify has no input; its tests are shard-download.test.mjs.",
  'refusal.mjs':
    "not a gate: a helper that journeys-revive.mjs and main-trust.mjs call when GitHub refuses a request (403 or 429), to keep GitHub's own reason (its message, rate-limit headers, retry-after and request id) in the stop line and the issue; the refusal is still a stop, never retried. Its tests are refusal.test.mjs.",
  'post-merge-trust.mjs':
    'runs from main-trust.yml after Order-path CX-8, Customer Money browser checks, Real-app journeys or PR checks (the Dependency audit) finish on main: re-runs a whole-run check that broke after a green once, then opens one issue naming the commits since the last green; for journeys, opens one issue per journey whose step passed, then failed on two runs in a row, and prints newly passing and newly broken steps. It only writes issues. Needs a GitHub token and a finished run, so a laptop verify has no input. post-merge-trust.test.mjs checks the decision table and the report comparison.',
  'journey-baseline-guard.mjs':
    'PR-only guard: needs the PR’s docs/runbooks/journey-baseline.json against origin/main and the reports of the journeys runs on main from the base’s named run (to the newest when a step is added as unbuilt), so a laptop verify has no input. CI runs main’s copy from the `gates` job, so a PR cannot loosen the rules it is judged by. It refuses a step that passed on main added as unbuilt, a step taken off without a pass on main, and a rewrite from a run that is not a finished run on main (docs/runbooks/regression-issue-state.md). Its tests are tooling/scripts/journey-baseline-guard.test.mjs, which the tooling tests run.',
  'journey-list-guard.mjs':
    'PR-only guard: needs the PR’s docs/roadmap/journeys.json against that of the main its checkout was built on (its merge base with origin/main, so main moving on after GitHub made the merge is not read as a drop) and, when something is dropped, the PR body, so a laptop verify has no input. CI runs main’s copy from the `gates` job, so a PR cannot loosen the rules it is judged by. It refuses a journey or step on main dropped from journeys.json or its live count without a `Journey-retired: J-bank-13 #2 (OWNER <n>)` body line, and a step slice id not in docs/roadmap/slices.json (OWNER 1; intafaced #7438). Its tests are journey-list-guard.test.mjs.',
  'test-diff-guard.mjs':
    'PR-only guard: needs the PR diff against origin/main and the PR body, so a laptop verify has no input. CI runs main’s copy of it from the `gates` job, so a PR cannot loosen the rules it is judged by. A test deleted or loosened after it failed on an earlier head of the PR fails with no line that clears it. It covers unit tests, the browser harnesses and look sweeps (`*.pw.mjs`; a changed journey step file `J-*.pw.mjs` on a pull request the test judge runs for is the judge’s, `judged-paths.mjs` leftToJudge) and look baselines (`look-baselines/<room>/*.png`, which need a `Baseline-change: <room>` line and the independent review). test-diff-guard.test.mjs checks the matcher.',
  'look-drift.mjs':
    'PR-only guard, like test-diff-guard: judges only the lines a PR adds in apps/customer and packages/ui/src/lit, px allowed in the lit kit outside templates (raw colours, pixel sizes, left/right sides), so it needs the PR diff against origin/main and a laptop verify has no input. CI runs main’s copy from the `gates` job; its tests are look-drift.test.mjs; `--all` prints how many lines across the tree still carry raw values (report only).',
  'why-red.mjs':
    'not a check: a read-only helper that prints why a PR head is not green (failing checks, their error annotations, and whether the seal only waits for the independent review), so agents do not read whole job logs. It needs a GitHub token and a PR, so a laptop verify cannot run it; its tests are why-red.test.mjs.',
  'ci-review.mjs':
    "runs only inside ci-review.yml (the CI review job, AGENTS.md, 'Where a mistake costs more'): reads one PR head's diff through the API, asks the pinned reviewer CLI once, with read-only tools over the default branch's checkout (with the test part, test-judge.mjs, when a journey test or shared test code changed: the one AI judge a PR has), and turns its answer into the job's `Verdict` step and the test part's `Test verdict`; from a branch's third FAIL in a row, the Verdict step also prints the attack-the-premise instruction (advice, no verdict changes; `premise <pr> [head]` replays it through `gh api`). Needs the event payload, a GitHub token, the project-state read token and the review key, so a laptop verify has no input; `tooling/ci/ci-review.test.mjs` tests its answer reader and the seal's verdict reader.",
  'reviewer-error.mjs':
    "runs only inside ci-review.yml, when the reviewer CLI exits non-zero in the Review or Proof read step: prints that call's exit code and its answer's own error fields (U4, project-state#1574), so an outage names itself, and classes it `down` (no answer, a refused or used-up key, a limit, an overload, a network error: the judge is down, the job ends without a verdict and without a red) or `error` (red, as before), with the one action a down judge needs (OWNER 289 point 11). It needs a failed call's answer file, so a laptop verify has no input; `tooling/ci/reviewer-error.test.mjs` tests it.",
  'judge-down.mjs':
    'runs only inside ci-review.yml, in steps that can\'t fail their job: when the judge is down (reviewer-error.mjs `down`), the pending `judge` commit status with its one action and one project-state issue "Judge down: CI review"; when a reviewer call succeeds, the status cleared, the issue closed and the CI review re-run on the oldest 10 open PR heads with no verdict (OWNER 289 point 11). Nothing that seals reads its status. Needs the event, GitHub tokens and the App\'s issues token, so a laptop verify has no input; `tooling/ci/judge-down.test.mjs` tests it.',
  'step-pictures.mjs':
    "not a gate: runs only inside ci-review.yml's proof read, before the reader's call, and blocks nothing: it waits for the head's Real-app journeys runs, unpacks their shard artifacts and adds each step's end picture to the read's prompts (project-state #2693). Needs a GitHub token and a pull request's head, so a laptop verify has no input; `fetch` gets one run's pictures for a read made off CI. step-read.test.mjs tests it.",
  'step-read.mjs':
    "not a gate: runs only inside ci-review.yml, after the CI review's verdict steps, and blocks nothing (OWNER 257): it asks the proof reader's question (test-judge/READ.md, project-state READER.md step 3) of the steps a PR claims or whose own test it changes, on the readers' model, and publishes the answers as the proof v2 read artifact and the `proof v2 read` commit status, which no required check reads. Needs the event payload, a GitHub token, the project-state read token and the review key, so a laptop verify has no input; `local` replays a commit range from a clone.",
  'test-judge.mjs':
    "runs only inside ci-review.yml, as the `CI review` job's test part (one model call answers the review and this part): for a PR that changes a journey test or shared test code, reads the diff and the files as text and the affected steps' words from project-state, so the pinned reviewer CLI (read-only tools over the default branch's checkout) also answers whether each affected test still exercises and distinguishes its step, and turns that part of the answer into the job's `Test verdict` step. Needs the event payload, a GitHub token, the project-state read token and the review key, so a laptop verify has no input; `tooling/ci/test-judge.test.mjs` tests everything around the model call, and `local` replays a commit range from a clone.",
  'review-marker.mjs':
    "merge-seal step: for a gate-file or look-baseline change, needs the `CI review` job (ci-review.yml, a pull_request_target run of the default branch's copy) to have passed its `Verdict` step on the PR's exact head, read from the Actions API; a FAIL on that head stands, and no comment or status counts. Needs a GitHub token and a head sha, so a laptop verify cannot run it; review-marker.test.mjs and ci-review.test.mjs check the verdict reader and which changes need the review.",
  'ci-jobs-seal.mjs':
    'merge-seal step: CI’s jobs on the pull request’s exact head (ci.yml’s Affected tests, Doctrine gates, Format, Typecheck & build and every Tests shard), read through the Actions API, held to `sealNeeded` with the default branch classifying the changed files (`classify`). It runs in merge-seal.yml on pull_request_target, so the seal is the default branch’s whatever a pull request changes (R3 C3 piece 2). Needs a GitHub token and a head, so a laptop verify has no input; `ci-jobs-seal.test.mjs` holds its planted cases.',
  'open-flaky.mjs':
    'the one command an agent opens a flaky item with (`gh issue create --label`, so it never exists bare: RULING 7, project-state #2065). It writes a GitHub issue, so a laptop verify has no input; `open-flaky.test.mjs` holds its cases.',
  'journey-seal.mjs':
    "merge-seal step: a pull request whose title names journey steps (`J-bank-13 #1 #2`) needs each one passing in a finished Real-app journeys run on its exact head, read from the run's `real-app-journeys` report through the Actions API, or the step exempted on a strict body line `Left-or-replaced: J-bank-13 #1` at column 0 outside code; anything else that looks like an exemption fails closed (owner decision 2026-11-06). A pull request whose diff touches the journey stack's shared setup (SHARED_SETUP) also needs the newest finished full Real-app journeys run on its exact head with 0 steps outside the list or against its rules, the journeys verdict (journey-verdict.mjs judge) read with the default branch's baseline; a red step main's newest full run in the head's history has too stops only a pull request in its area (its journey, or a package changed since it last passed on main), and one that can't be bounded stops every pull request (owner decision 180). A pull request that changes a journey test file (`apps/customer/tests/real-app/J-*.pw.mjs`) names a step each changed file holds, in the title or on a `Left-or-replaced:` line, or the seal fails and prints the steps the files hold. `--recheck`, the last job of each seal input (START_JOB), starts or re-runs the seal once every input on the head has finished; `--clear-older` re-runs older red seals on a head after a green verdict. Needs a GitHub token and a pull request, so a laptop verify has no input; `tooling/ci/journey-seal.test.mjs` holds its planted cases and `--dry-run <pr>` reads any pull request without writing.",
  'journey-touch.mjs':
    'the journeys a pull request touches, read by journey-seal.mjs from its changed paths: shared setup, tooling/scripts, the journeys workflow and its checks, docs, build files and product code need the full run; journey test files only need those files run; other workflows, CI checks the journeys run does not use, unit tests, the git hooks under .githooks and the tooling/scripts files FACTORY_SCRIPTS lists (shown unreached by the journeys run, the stack and the app build) need none. A merge-seal input, not a gate of its own; `--base <ref>` prints what a branch must run, and `tooling/ci/journey-touch.test.mjs` holds its planted cases.',
  'journey-reach-map.mjs':
    "the touched-journeys map (R3 C4): `build` reads the `journey-reach` records of main's newest whole full Real-app journeys runs (gh run download) into tooling/ci/journey-reach-map.json, and refuses (a full map) with fewer than 3; journey-touch.mjs and the seal read it so product code runs only the journeys recorded reaching it, else the full suite (shared setup, scripts, admin-app paths, packages it can't map, event subscribers, a stale, missing or switched-off map; REACH_MAP_MODE = 'full' turns it off). A merge-seal input, not a gate of its own; `tooling/ci/journey-reach-map.test.mjs` holds its planted cases. Its `verify` (rebuild from main's runs up to the newest run the map names, compared byte for byte) runs in the Doctrine gates job of ci.yml when a pull request changes the map, with main's copy and the job's read-only token, NOT here: it needs NETWORK and a token. `.github/workflows/journey-reach-map.yml` builds the map in CI and keeps it as an artifact.",
  'journey-retries.mjs':
    "a step of the Real-app journeys workflow on a pull request: gives a full run's shards main's one retry only when a shard holds none of the journeys the pull request touches, so a retry never passes the change's own journey. Not a scan of its own; `tooling/ci/journey-retries.test.mjs` holds its cases.",
  'factory-switch.mjs':
    "merge-seal step and sweep: the factory switch, the one-line file FACTORY on the branch factory-switch, read through the contents API; only `run` passes, and anything else or an unreadable answer fails the seal closed (also read by journey-seal.mjs). `--sweep` runs from factory-sweep.yml on that branch and re-runs the open pull requests' seals on a flip. Needs a GitHub token, so a laptop verify cannot run it; `tooling/ci/factory-switch.test.mjs` checks the verdict, the read and the sweep.",
  'app-token.mjs':
    "not a gate: the factory App's installation tokens (its JWT, and a token narrowed to exactly the permissions asked for), imported by journeys-revert.mjs and journeys-revive.mjs; `tooling/ci/app-token.test.mjs` checks it.",
  'dod-gate.mjs':
    'run by hand with `pnpm gate` — it walks every service and is the §14 Definition of Done, not a repo-wide scan. Neither CI nor verify runs it; service-tracing.mjs is the gate for the one fault it found that CI did not catch.',

  'verify.mjs':
    'the verify runner itself — it CALLS this list. Listing it as a gate would make it invoke itself. It exists so the infrastructure verdict prints even when turbo halts early, which a `&&` chain cannot do.',
  'infra-verdict.mjs':
    'a reporter, not a gate: it prints which infrastructure-backed suites actually executed. It never fails a clean run — it exits 2 for "incomplete but permitted", which verify reports without failing. Run by verify.mjs after the test step.',
  'unreported-suites.mjs':
    'data, not a scan — the register of suites that still skip invisibly, each with the specific reason it was left and what lifts it. It exports two lists and runs nothing. Both skip-honesty-scan.mjs and infra-verdict.mjs import it; the scan warns if an entry goes stale, and the verdict cannot say COMPLETE while it stands.',
  'money-skip-inventory.mjs':
    'data, not a scan — D26-P2-13 register of every money-path test file that may skip, each with kind + why. money-skip-honesty-scan.mjs imports it, fails if the list grows and warns if it goes stale; a private-probe row must stay coupled to unreported-suites PRIVATE_PROBE (none remain).',
  'assert-test-db-env.mjs':
    'asserts the TEST_DATABASE_URL_* env the CI Tests job sets up. It is meaningless without that env, so it belongs to that job (residual #9) rather than to a laptop run.',
  'dependency-audit.mjs':
    'the supply-chain ratchet (`pnpm scan:deps`), wired as the Dependency audit job in .github/workflows/pr-checks.yml on every PR and every push to main, where Main trust turns a red into one issue. NOT a GATES entry for the same reason claim-check is not: it needs NETWORK — the advisory database is remote — and reddening a local `pnpm verify` on a train is how a security gate gets deleted. It is a ratchet, not a severity gate: 12 advisories were already in the tree when it landed (8 high, 2 on production paths — drizzle-orm direct and fast-uri under fastify), so `--audit-level=high` would have red-mained on day one, the trap the since-deleted shell-i18n-scan documented. NEW advisories fail; STALE frozen entries also fail, so the list can only shrink. A PR that changes no dependency file (`--base`, owner decision 2026-10-25) cannot change the tree, so for it both only warn; main and any PR that touches the lockfile get the full ratchet. `--self-test` runs before it in the same job. When it reaches zero, replace the baseline with a plain `pnpm audit --audit-level=high` and delete this entry.',
  'checkout-staleness.mjs':
    'reports how far behind origin/main a checkout is, so any board that prints numbers can declare its own staleness (#958). A library, not a check — it asserts nothing and cannot fail. Extracted from thrift-preflight when thrift was deleted 2026-08-07; the staleness half never had anything to do with spend.',
  'look-baselines.mjs':
    'a library, not a scan: the one definition of a look baseline (`look-baselines/<room>/…`) that test-diff-guard.mjs (the room must be named) and review-marker.mjs (the independent review is required) both import, so the two cannot disagree.',
  'exact-revert.mjs':
    "a library, not a scan: the one rule for an exact revert (a diff that undoes one commit and nothing else), with no imports, that ci-review.mjs (automaticRevert, what the reviewer is told) and test-diff-guard.mjs (autoRevert, checks 1-5 skip main-bisect's revert) both import, so the two cannot disagree. Its tests are exact-revert.test.mjs.",
  'judged-paths.mjs':
    'a library, not a scan: the one list of the paths the test judge rules on (`JUDGE_PATHS`, `judgedFile`), with no imports, that test-judge.mjs (which changes need its verdict) and test-diff-guard.mjs (which changes it leaves to the judge) both import, so the two cannot disagree; its `leftToJudge` is the one rule for which changes the guard leaves to the judge (the CI review’s test part).',
  'test-typecheck.mjs':
    'runs under the turbo `typecheck` task, not here. Every package script is now `tsc -p tsconfig.json --noEmit && node ../../tooling/ci/test-typecheck.mjs`, because type-checking a test file needs the workspace deps BUILT for their `.d.ts` — which `typecheck` already declares via `dependsOn: ["^build"]` and which a doctrine gate, by design, cannot: gates run first and take ~2s, before any build exists. Wiring it there would either make the fast pre-flight slow or make it wrong. So `pnpm typecheck`, `pnpm verify` and CI all run it, in parallel and turbo-cached (the script is a globalDependency, so editing the pinned list busts that cache). It is a ratchet in the same shape as the since-deleted fabricated-money-scan: 70 pre-existing test type errors frozen by exact text AND count, a new one is red, and a FIXED one is red too until its row is deleted — so the list can only shrink. Run it repo-wide by hand with `node tooling/ci/test-typecheck.mjs --all`.',
};

// ── Self-check: nothing in tooling/ci/ may be unaccounted for ───────────────
function manifestCheck() {
  const problems = [];
  const known = new Set(GATES.filter((g) => g.script.startsWith('tooling/ci/')).map((g) => basename(g.script)));

  for (const file of readdirSync(CI_DIR)) {
    if (!file.endsWith('.mjs')) continue;
    // A test file is accounted for by the tooling-tests gate, which runs every tooling/**/*.test.mjs.
    if (file.endsWith('.test.mjs') || known.has(file) || file in NOT_GATES) continue;
    problems.push(
      `tooling/ci/${file} is in the gate directory but is in neither GATES nor NOT_GATES.\n` +
        '      Add it to GATES so verify and CI both run it, or to NOT_GATES with the reason it is not a gate.\n' +
        '      A scan nobody runs is worse than no scan: it reads as coverage that does not exist.',
    );
  }

  for (const [file, reason] of Object.entries(NOT_GATES)) {
    if (!existsSync(join(CI_DIR, file))) problems.push(`NOT_GATES lists tooling/ci/${file}, which does not exist. Remove the entry.`);
    else if (!reason || reason.length < 20) problems.push(`NOT_GATES['${file}'] needs a real reason, not a placeholder.`);
  }

  for (const gate of GATES) {
    if (!existsSync(join(ROOT, gate.script))) problems.push(`gate "${gate.id}" points at ${gate.script}, which does not exist.`);
  }

  const ids = new Set(GATES.map((g) => g.id));
  for (const id of Object.keys(LEFT_TO_CI_BEFORE_PUSH)) {
    if (!ids.has(id)) problems.push(`LEFT_TO_CI_BEFORE_PUSH names "${id}", which is not a gate. Remove the entry.`);
  }

  // The other half of the drift: CI must consume THIS list, not its own copy.
  const workflow = join(ROOT, '.github', 'workflows', 'ci.yml');
  if (existsSync(workflow) && !/pnpm\s+gates\b/.test(readFileSync(workflow, 'utf8'))) {
    problems.push(
      '.github/workflows/ci.yml no longer runs `pnpm gates`.\n' +
        '      CI and verify are drifting apart again — that is how someone runs verify green and lands red.\n' +
        '      Put the `pnpm gates` step back, rather than re-listing individual scans as steps.',
    );
  }

  return problems;
}

// ── --changed: which gates a builder's local run needs ──────────────────────
/** Paths whose change can turn a tooling test red. Anything else cannot reach them, so `--changed` skips them. */
export const TOOLING_TEST_PATHS = ['tooling/', '.github/'];

/** The gates a run needs: all of them for a full run (`changed` null), else all but the tooling tests unless reached. */
export function gatesToRun(gates, changed) {
  if (changed === null) return gates;
  const reachesTooling = changed.some((p) => TOOLING_TEST_PATHS.some((prefix) => p.startsWith(prefix)));
  return reachesTooling ? gates : gates.filter((g) => g.id !== 'tooling-tests');
}

// ── --before-push: the gates .githooks/pre-push runs, all at once ───────────
/** The gates a push leaves to CI, each with why. Every other gate reads the pushed tree in seconds and runs before it. */
export const LEFT_TO_CI_BEFORE_PUSH = {
  'tooling-tests': 'about four minutes on the Mac; the hook runs the ones that read journey files itself',
  'truth-check': 'CI runs it on every pull request and on main',
  'lint-ratchet': "the hook runs it itself, on the pushed files with main's rules",
  'cross-package-reads': 'the hook runs it itself when a test or what it checks changed',
  'secret-scan-mutation': 'proves secret-scan on planted files (19 s on the Mac): only a change to the scanner reaches it',
  'money-property-mutation':
    'rewrites packages/ledger-client/src/money.ts in place and runs vitest per mutant (15 s): only a change to the money primitives reaches it',
  'empty-denominator': 'runs every gate against an empty tree (21 s on the Mac): only a change to a gate reaches it',
};

export function gatesBeforePush(gates) {
  return gates.filter((g) => !Object.hasOwn(LEFT_TO_CI_BEFORE_PUSH, g.id));
}

/**
 * Files changed since the merge-base with origin/main, committed or not, renames as both sides; null when git cannot
 * say (no origin/main, not a repo), so the caller runs everything rather than guessing a diff is product-only.
 */
export function changedSinceMain(cwd = ROOT, base = 'origin/main') {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const mergeBase = git('merge-base', 'HEAD', base).trim();
    const tracked = git('diff', '--name-only', '--no-renames', mergeBase);
    const untracked = git('ls-files', '--others', '--exclude-standard');
    return [...new Set((tracked + '\n' + untracked).split('\n').filter(Boolean))].sort();
  } catch {
    return null;
  }
}

// ── Run ────────────────────────────────────────────────────────────────────
/**
 * Guarded so this file can be IMPORTED as data without the import running 32
 * gates as a side effect.
 *
 * `empty-denominator-gate.mjs` has to read the REAL `GATES` array to classify
 * every entry in it and to assert its own classified count against
 * `GATES.length`. Its alternative was to parse this file's source text — and a
 * meta-gate whose census comes from a regex over source is the same species of
 * defect it exists to police: it would prove a string appears in a file, not
 * that a gate is in the list. So the array is the interface, and this guard is
 * what makes reading it free.
 *
 * Behaviour when run directly (`node tooling/ci/gates.mjs`, `pnpm gates`, the
 * `gates` job in ci.yml) is unchanged — `main()` is called immediately below.
 */
/** The most of one gate's output kept: the tooling tests' passing TAP alone is over 1 MB. */
export const GATE_OUTPUT_MAX = 64 * 1024 * 1024;

const RUN_AS_SCRIPT = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (RUN_AS_SCRIPT) await main();

/** One gate as its own process: whether it passed, what it printed and how long it took. */
export function runGate(gate) {
  const started = process.hrtime.bigint();
  return new Promise((done) => {
    // The default 1 MB cut the tooling tests' output before its `not ok` lines (CI run 43623577056, 14 Nov).
    execFile(
      process.execPath,
      [join(ROOT, gate.script), ...(gate.args ?? [])],
      { encoding: 'utf8', cwd: ROOT, maxBuffer: GATE_OUTPUT_MAX },
      (err, stdout, stderr) => {
        if (!err && stderr) process.stderr.write(stderr);
        done({
          ok: !err,
          output: err ? (stdout ?? '') + (stderr ?? '') : stdout,
          ms: Number((process.hrtime.bigint() - started) / 1000000n),
        });
      },
    );
  });
}

async function main() {
  const beforePush = process.argv.includes('--before-push');
  const changedOnly = process.argv.includes('--changed');
  // `--base <ref>` for a branch stacked on another (default origin/main).
  const baseAt = process.argv.indexOf('--base');
  const base = baseAt > 0 ? process.argv[baseAt + 1] : 'origin/main';
  const changed = changedOnly ? changedSinceMain(ROOT, base) : null;
  const gates = beforePush ? gatesBeforePush(GATES) : gatesToRun(GATES, changed);

  if (process.argv.includes('--list')) {
    for (const gate of gates) console.log(gate.id);
    process.exit(0);
  }

  const manifestProblems = manifestCheck();
  if (manifestProblems.length > 0) {
    console.error('\n✖ GATE MANIFEST BROKEN\n');
    for (const p of manifestProblems) console.error(`  · ${p}\n`);
    process.exit(1);
  }

  console.log(`\n══ DOCTRINE GATES (${gates.length}) ══\n`);
  if (changedOnly && changed === null) console.log(`  --changed: the diff against ${base} is unreadable, so every gate runs\n`);
  else if (beforePush) console.log(`  --before-push: all at once; left to CI: ${Object.keys(LEFT_TO_CI_BEFORE_PUSH).join(', ')}\n`);
  else if (gates.length < GATES.length)
    console.log('  --changed: nothing under tooling/ or .github/ changed, so the tooling tests are left to CI\n');

  const failed = [];
  const advisoryNoise = [];
  let totalMs = 0;
  const runStarted = process.hrtime.bigint();

  // CI runs one gate at a time; a push runs its gates at once and still reports them in the list's order.
  const results = [];
  if (beforePush) results.push(...(await Promise.all(gates.map(runGate))));
  else for (const gate of gates) results.push(await runGate(gate));

  for (const [i, gate] of gates.entries()) {
    const { ok, output, ms } = results[i];
    totalMs += ms;

    // Every gate is run. None is skipped because an earlier one failed — you
    // should see every broken gate in one run, not discover them one push apart.
    if (ok) {
      const summary = output.trim().split('\n').filter(Boolean).pop() ?? '(no output)';
      console.log(`  ✓ ${gate.id.padEnd(22)} ${String(ms).padStart(5)}ms  ${gate.doctrine}`);
      if (gate.advisory && output.includes('⚠')) {
        advisoryNoise.push({ gate, output });
        console.log(`      ⚠ advisory findings — printed below, not a failure`);
      } else {
        console.log(`      ${summary.trim()}`);
      }
      // A passing gate's own warnings (a stale entry to delete; a fix never fails, owner decision 2026-10-27) must
      // still reach the run's annotations, so they are passed through rather than folded into the summary line.
      for (const line of output.split('\n')) if (line.startsWith('::warning')) console.log(line);
    } else if (gate.advisory) {
      advisoryNoise.push({ gate, output });
      console.log(`  ⚠ ${gate.id.padEnd(22)} ${String(ms).padStart(5)}ms  ${gate.doctrine} (advisory)`);
    } else {
      failed.push({ gate, output });
      console.log(`  ✖ ${gate.id.padEnd(22)} ${String(ms).padStart(5)}ms  ${gate.doctrine}`);
    }
  }

  for (const { gate, output } of advisoryNoise) {
    console.log(`\n── ${gate.id} (advisory — does not fail the build) ──`);
    console.log(output.trimEnd());
  }

  if (failed.length > 0) {
    console.error(`\n✖ ${failed.length} of ${gates.length} DOCTRINE GATE(S) FAILED\n`);
    for (const { gate, output } of failed) {
      console.error(`── ${gate.id} — ${gate.doctrine} ──`);
      console.error(`   why this gate exists: ${gate.why}`);
      console.error(output.trimEnd() + '\n');
    }
    console.error('  A red gate is not a discussion (AGENT_PROTOCOL §3).\n');
    process.exit(1);
  }

  const wallMs = Number((process.hrtime.bigint() - runStarted) / 1000000n);
  console.log(`\n✓ all ${gates.length} doctrine gates passed — ${totalMs}ms total${beforePush ? `, ${wallMs}ms at once` : ''}\n`);
}
