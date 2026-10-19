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
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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
    id: 'gate-tools-tests',
    script: 'tooling/scripts/gate-tools.test.mjs',
    doctrine: 'merge condition (2026-10-13)',
    why:
      'the unit tests of the tools that decide what may merge: gate-file-guard.mjs (a gate change must say so in the PR title), gate-gh.mjs ' +
      '(a 403 or 429 stops, every call has a timeout) and, once it lands, main-auto-revert.mjs. Fixture JSON and log ' +
      'excerpts for gh, no network, about two seconds. Lives in tooling/scripts/, so the manifest check below does not ' +
      'cover it: this entry is the only thing running the tests, and deleting it has to be a visible act.',
  },
  {
    id: 'tracker',
    script: 'tooling/scripts/tracker.mjs',
    args: ['--check'],
    doctrine: 'tracker honesty',
    why: 'a tracker that drifts from the code is worse than no tracker',
  },
  {
    id: 'services-map',
    script: 'tooling/scripts/services-map.mjs',
    args: ['--check'],
    doctrine: 'agent map honesty',
    why:
      'docs/SERVICES.md is the one table of services, ports and required env that agents read instead of opening 25 ' +
      'compose blocks and env files. Hand-kept service counts had already drifted in three docs (eleven, twenty-one, 25). ' +
      'Generated from the code, so a stale copy fails here, the same way the tracker does.',
  },
  {
    id: 'coverage',
    script: 'tooling/ci/coverage-check.mjs',
    doctrine: '§25:740',
    why:
      'the law names this gate by path. It answers, on every push, the question the 2026-08-03 audit had to ' +
      'answer by hand: is anything in the law absent from the board without someone having said so — and its ' +
      'mirror, is anything on the board claiming a law that does not say it. Ordered after tracker because it ' +
      'imports features.mjs, and a broken tracker should report as a broken tracker rather than as coverage drift. ' +
      'It was a hand-written step in ci.yml on this branch; it is an entry here instead, because a step that CI ' +
      'runs and `pnpm verify` does not is the exact drift gates.mjs exists to make impossible.',
  },
  {
    id: 'reachability',
    script: 'tooling/ci/reachability-scan.mjs',
    doctrine: 'L3 slice factory law, Reachability law',
    why:
      'a module that imports nothing and is imported by nothing is not shipped work. Between #905 and #946 the ' +
      'slice factory produced 151 such modules - each re-declaring a constant that already existed and testing ' +
      'the copy against a literal - and every one passed this gate list, format, typecheck, tests and CI. The ' +
      'stamp-mill gate led with docsOnly (#884) so it never looked. This is the gate that would have caught it ' +
      'on the first wave instead of the two hundredth. Modules built but not yet wired are PARKED by name with a ' +
      'reason, and that list may only shrink.',
  },
  {
    id: 'notice-pin',
    script: 'tooling/ci/notice-pin.mjs',
    doctrine: 'D26-P3-04 / NOTICE freshness',
    why:
      'root NOTICE was compiled 2026-07-29 against 4311cff and can silently diverge from the vendor Apache pin, ' +
      'compose image tags, jar count, and the Path A charting working tree. This gate fails on that silent drift; ' +
      'named divergences must be written in NOTICE §11. It does not purchase licences and is not legal advice.',
  },
  {
    id: 'brand',
    script: 'tooling/ci/brand-scan.mjs',
    doctrine: '§0.7',
    why:
      'a partner or model-vendor name in user-facing copy. D26-P2-14: also walks discovered vendor Vue shell ' +
      'project roots (incl. `.vue`) and Java `src/main/resources` — bulk `vendor/` stays skipped so load-bearing ' +
      'package/groupId lines do not drown the gate; partner names cannot hide in the product shell or Java resource catalogues.',
  },
  {
    id: 'shell-brand',
    script: 'tooling/ci/shell-brand-scan.mjs',
    doctrine: '§0.7',
    why:
      'relaxed-boundary ratchet over the vendored Java CORS surface (same FORBIDDEN list parsed from brand-scan.mjs): ' +
      'CorsConfig / CorsAllowlist / CORS ApplicationConfig, where `\\b` cannot see a name welded into an identifier. ' +
      'NARROWED 2026-10-13, DELETED 2026-10-19: the legacy Vue customer site (vendor 05_Web_Front, replaced by ' +
      'apps/customer) is gone from the tree, so only the Java CORS surface is walked. Baseline is empty — any new hit fails until fixed; never re-freeze.',
  },
  {
    id: 'custody',
    script: 'tooling/ci/custody-scan.mjs',
    doctrine: '§16.10',
    why:
      'a Protocol Plane service importing a ledger write recipe, plus D26-P2-08: Java money/custody surface is in ' +
      'the scan object via vendor-java-money-scan successor (fail closed if unscanned). Dual-book rules stay in that ' +
      'file — custody-scan composes it, it does not fork a third scanner. See the header of custody-scan.mjs',
  },
  {
    id: 'secrets',
    script: 'tooling/ci/secret-scan.mjs',
    doctrine: '§16',
    why: 'a committed credential is invisible in review — it reads as a config line',
  },
  {
    id: 'wallet-rpc-auth',
    script: 'tooling/ci/wallet-rpc-auth-scan.mjs',
    doctrine: '§16 / A1.4',
    why: 'a wallet RPC module must authenticate /rpc/** — the guard on one module is not the guard on every classpath that can boot',
  },
  {
    id: 'wallet-rpc-mainnet',
    script: 'tooling/ci/wallet-rpc-mainnet-scan.mjs',
    doctrine: '§16 / ADR 2026-07-28',
    why:
      'the wallet RPC tree is barred from live value until the security review the vendored-exchange ADR makes a ' +
      'precondition of adoption has happened — and until this gate that bar existed only in prose. What stopped ' +
      'mainnet was incidental: no Dockerfile, no compose service, no CI job, and env placeholders that decide whether ' +
      'a service STARTS, not which chain it talks to. Supply the environment and every other gate here still printed ' +
      'clean. Ordered next to wallet-rpc-auth because they fence the same tree and answer different questions: auth ' +
      'asks whether a bootable module authenticates, this asks whether anything can boot one at all, and whether a ' +
      'new mainnet constant appeared. 38 existing constants are frozen by exact text AND by how many times each ' +
      'appears, so the baseline can only shrink — text alone left the gate blind to an unused mainnet import becoming ' +
      'a live selector, and to a deleted broadcast being pasted back. Rules that match nothing in the tree (the ' +
      'wss:// scheme, ChainId.NONE, RawTransactionManager, an EVM address under a non-address key) have no baseline ' +
      'to prove them alive, so 47 fixtures run through the real matchers on every invocation instead. Two of those ' +
      'rules exist because a value that LOOKS undecided is not: `${VAR}` is the environment’s decision and is ' +
      'skipped, `${VAR:0xdac17…}` resolves without an environment and is the pin it defaults to.',
  },
  {
    id: 'wallet-rpc-mainnet-mutation',
    script: 'tooling/ci/wallet-rpc-mainnet-scan.mutation.mjs',
    doctrine: '§16 / §14',
    why:
      'the mutation proof for the gate above, and it mutates the CHECKER rather than the subject — RULE_PROBES ' +
      'already answers "does the rule still fire" on every invocation. This answers the question that harness could ' +
      'not ask about itself. Deleting the probe loop used to exit 0 while still printing "0 rule probe(s) executed … ' +
      '(24 must fire, -24 must not)", and deleting the occurrence comparison used to exit 0 still printing "none ' +
      'gained a copy" over a tree that had just gained one: both numbers were read off source text, so removing the ' +
      'work left the claim standing. Every summary clause is now minted by the check that establishes it and ' +
      'reconciled before printing; deletions must each be detected, and a mutant whose anchor has moved fails ' +
      'rather than skips.',
  },
  {
    id: 'wallet-rpc-perimeter-refuse',
    script: 'tooling/ci/wallet-rpc-perimeter-refuse.mjs',
    doctrine: '§16 / D26-P2-09',
    why:
      'continuous perimeter regression for 01_wallet_rpc — mainnet / sign / width refuse classes must each keep ' +
      'firing + silent probe halves, and chain-id / RPC / key-width / disclosed-secret-width axes must fail closed ' +
      'independently. Deleting the class or axis register, counters, claim mint, a class rule binding, or a named ' +
      'axis must go red. Complements wallet-rpc-mainnet (subject + probes) and its checker-mutation suite.',
  },
  {
    id: 'vendor-shell',
    script: 'tooling/ci/vendor-shell-scan.mjs',
    doctrine: 'vendor residue',
    why: 'mass-credit endpoints and CORS * inherited from the vendored shell',
  },
  {
    id: 'invitation-outreach-golden',
    script: 'tooling/ci/invitation-outreach-golden-scan.mjs',
    doctrine: '§14 / desk honesty',
    why:
      'apps/invitation bundles six outreach modules (outreach-intake, outreach-review, outreach-public-info, ' +
      'outreach-draft-storage, outreach-countries, config/intafaced.js), vendored in apps/invitation/src/vendored since ' +
      'D-140. The goldens next to them (intake, review, draft-storage) only prove anything if CI runs them. Narrowed from the retired ' +
      'shell-golden gate; refuses when it finds no outreach goldens.',
  },
  {
    id: 'vendor-java-money',
    script: 'tooling/ci/vendor-java-money-scan.mjs',
    doctrine: 'dual-book Option B',
    why: 'a Java money mutator is a second book, and there is only one book',
  },
  {
    id: 'vendor-java-jar-truth',
    script: 'tooling/ci/vendor-java-jar-truth.mjs',
    doctrine: 'D-S-17 / D26-P2-07 jar truth',
    why:
      'Grade D ungated mints must stay deleted, a green source scan must not be read as runtime safety, and the ' +
      'compose-jar rebuild path (tooling/scripts/vendor-java-rebuild.mjs + vendor-compile package job) must stay real.',
  },
  {
    id: 'dual-book-door',
    script: 'tooling/ci/dual-book-door-scan.mjs',
    doctrine: 'Architect A1',
    why: 'the door-kill interceptor must be registered on every vendored app',
  },
  {
    id: 'dual-book-door-paths',
    script: 'tooling/ci/dual-book-door-path-unit.mjs',
    doctrine: 'Architect A1',
    why: 'proves the door-kill path fragments actually block what they claim, without a JVM',
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
    id: 'marketing-language',
    script: 'tooling/ci/marketing-language-scan.mjs',
    doctrine: 'DIRECTION §8.9 / D26-P0-16',
    why:
      'product copy may not describe anything as audited, insured, or guaranteed without OWNER-SEAL(§8.9). Agents invent ' +
      'those words as marketing; the gate re-derives the ban over locale catalogues and refuses empty denominators. Law ' +
      'helpers live in packages/config/src/marketing-language.ts — Vue FE craft stays out of scope (nitro-frontend-all).',
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
      'be declared in tooling/ci/test-read-edges.json.',
  },
  {
    id: 'workspace',
    script: 'tooling/ci/workspace-sync.mjs',
    doctrine: 'fleet sync',
    why: 'a service that builds but never reaches the image or the fleet',
  },
  {
    id: 'event-wiring',
    script: 'tooling/ci/event-wiring.mjs',
    doctrine: '§10',
    why:
      'the same shape as workspace-sync, one layer in: a declared subject with no publisher, or no subscriber. ' +
      'The bus could not report silence — a subject nobody publishes and a subject nobody reads both looked ' +
      'exactly like a working one. Every unwired end is now an entry in WIRING_SOCKETS with a written reason, or red.',
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
      'UNJOURNALLED (CODEOWNERS lock). The scan prints those and fails if an entry goes stale.',
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
    id: 'secret-rotation-readiness',
    script: 'tooling/ci/secret-rotation-readiness-scan.mjs',
    doctrine: '§16 / D26-P3-05',
    why:
      'rotation readiness is a runbook plus the gates that prove a disclosed or unwired secret is refused. ' +
      'A missing inventory prints as nothing-to-rotate. This gate holds docs/SECRET-ROTATION-READINESS.md, ' +
      'the OWNER-ACTIONS-WALLET-RPC-SECRETS.md citation (that file is not edited here), EctWithdrawSecretConfig, ' +
      'and compose-secret-parity / wallet-rpc-auth / secrets remaining in GATES. It never reads secret values.',
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
  'ci-affected.mjs':
    'path classifier for named CI test shards and the merge-seal aggregator. Invoked from ci.yml `changes` / `merge-seal` jobs and via `--self-test`. Not a doctrine gate: a laptop verify has no GitHub event payload, and reddening verify over missing GITHUB_OUTPUT is how a classifier gets deleted. Local pre-flight: `node tooling/ci/ci-affected.mjs --self-test`.',
  'main-trust.mjs':
    'runs from main-trust.yml after a CI run on main finishes: re-runs a red run once, opens red / flaky issues, publishes the last-green branch. Needs a GitHub token and a finished run, so a laptop verify has no input. `node tooling/ci/main-trust.mjs --self-test` checks the decision table and parser.',
  'test-diff-guard.mjs':
    'PR-only guard: needs the PR diff against origin/main and the PR body, so a laptop verify has no input. CI runs main’s copy of it from the `gates` job, so a PR cannot loosen the rules it is judged by. `node tooling/ci/test-diff-guard.mjs --self-test` checks the matcher.',
  'review-marker.mjs':
    'merge-seal step: needs a `Independent review: PASS <head sha>` comment on the PR. Needs a GitHub token and PR number, so a laptop verify cannot run it; `node tooling/ci/review-marker.mjs --self-test` checks the matcher.',
  'gates.mjs': 'this runner — it is the list, so it cannot be an entry in itself.',
  'dod-gate.mjs':
    'run by `pnpm gate`, separately and last — it walks every service and is the §14 Definition of Done, not a repo-wide scan. verify runs it after build/typecheck/test. CI runs it as a reported, non-blocking step at the end of the `gates` job.',

  'verify.mjs':
    'the verify runner itself — it CALLS this list. Listing it as a gate would make it invoke itself. It exists so the infrastructure verdict prints even when turbo halts early, which a `&&` chain cannot do.',
  'infra-verdict.mjs':
    'a reporter, not a gate: it prints which infrastructure-backed suites actually executed. It never fails a clean run — it exits 2 for "incomplete but permitted", which verify reports without failing. Run by verify.mjs after the test step.',
  'unreported-suites.mjs':
    'data, not a scan — the register of suites that still skip invisibly, each with the specific reason it was left and what lifts it. It exports two lists and runs nothing. Both skip-honesty-scan.mjs and infra-verdict.mjs import it; the scan fails if an entry goes stale, so it cannot rot into blanket cover.',
  'money-skip-inventory.mjs':
    'data, not a scan — D26-P2-13 register of every money-path test file that may skip, each with kind + why. money-skip-honesty-scan.mjs imports it and fails if the list grows or goes stale; a private-probe row must stay coupled to unreported-suites PRIVATE_PROBE (none remain).',
  'assert-test-db-env.mjs':
    'asserts the TEST_DATABASE_URL_* env the CI Tests job sets up. It is meaningless without that env, so it belongs to that job (residual #9) rather than to a laptop run.',
  'dependency-audit.mjs':
    'the supply-chain ratchet (`pnpm scan:deps`), wired as its own workflow (the Dependency audit job in .github/workflows/pr-checks.yml) on dependency-surface PRs plus a weekly cron. NOT a GATES entry for the same reason claim-check is not: it needs NETWORK — the advisory database is remote — and reddening a local `pnpm verify` on a train is how a security gate gets deleted. It is a ratchet, not a severity gate: 12 advisories were already in the tree when it landed (8 high, 2 on production paths — drizzle-orm direct and fast-uri under fastify), so `--audit-level=high` would have red-mained on day one, the trap the since-deleted shell-i18n-scan documented. NEW advisories fail; STALE frozen entries also fail, so the list can only shrink. When it reaches zero, replace the baseline with a plain `pnpm audit --audit-level=high` and delete this entry.',
  'value-gate.mjs':
    'stamp-mill detector for near-duplicate commits — the docs-only rule (Board-Delta trailer) AND, since 2026-08-06, the code rule (near-duplicate subject SERIES whose new symbols nothing outside them calls; Serial-Work trailer). Wired as an explicit STRICT step in BOTH workflows and in neither gate list: docs-format.yml, because ci.yml excludes docs/** and **/*.md so coordinator docs PRs never hit GATES; and the `gates` job of ci.yml, because docs-format only fires on markdown, so a code PR without a slice doc never met the gate at all — half of how #832–#876 landed. (ci.yml writes that exclusion as negated `paths:` rather than `paths-ignore`, because INTAFACED_DEFINITIVE_BUILD.md is law and coverage-check has to see it; the set of excluded docs is unchanged.) Still NOT a GATES entry: it needs a current `origin/main` plus >=11 ancestors, which a laptop `pnpm verify` cannot promise, and reddening a local verify over a stale fetch is how a gate gets deleted. Both checkouts now pin fetch-depth: 0 — under the actions/checkout default of 1 it compared an empty ancestor list against an empty ancestor list and printed OK. Local pre-flight: `pnpm value-gate:self-test` (20 fixtures).',
  'checkout-staleness.mjs':
    'reports how far behind origin/main a checkout is, so any board that prints numbers can declare its own staleness (#958). A library, not a check — it asserts nothing and cannot fail. Extracted from thrift-preflight when thrift was deleted 2026-08-07; the staleness half never had anything to do with spend.',
  'test-typecheck.mjs':
    'runs under the turbo `typecheck` task, not here. Every package script is now `tsc -p tsconfig.json --noEmit && node ../../tooling/ci/test-typecheck.mjs`, because type-checking a test file needs the workspace deps BUILT for their `.d.ts` — which `typecheck` already declares via `dependsOn: ["^build"]` and which a doctrine gate, by design, cannot: gates run first and take ~2s, before any build exists. Wiring it there would either make the fast pre-flight slow or make it wrong. So `pnpm typecheck`, `pnpm verify` and CI all run it, in parallel and turbo-cached (the script is a globalDependency, so editing the pinned list busts that cache). It is a ratchet in the same shape as the since-deleted fabricated-money-scan: 70 pre-existing test type errors frozen by exact text AND count, a new one is red, and a FIXED one is red too until its row is deleted — so the list can only shrink. Run it repo-wide by hand with `node tooling/ci/test-typecheck.mjs --all`.',
};

// ── Self-check: nothing in tooling/ci/ may be unaccounted for ───────────────
function manifestCheck() {
  const problems = [];
  const known = new Set(GATES.filter((g) => g.script.startsWith('tooling/ci/')).map((g) => basename(g.script)));

  for (const file of readdirSync(CI_DIR)) {
    if (!file.endsWith('.mjs')) continue;
    if (known.has(file) || file in NOT_GATES) continue;
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
const RUN_AS_SCRIPT = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (RUN_AS_SCRIPT) main();

function main() {
  if (process.argv.includes('--list')) {
    for (const gate of GATES) console.log(gate.id);
    process.exit(0);
  }

  const manifestProblems = manifestCheck();
  if (manifestProblems.length > 0) {
    console.error('\n✖ GATE MANIFEST BROKEN\n');
    for (const p of manifestProblems) console.error(`  · ${p}\n`);
    process.exit(1);
  }

  console.log(`\n══ DOCTRINE GATES (${GATES.length}) ══\n`);

  const failed = [];
  const advisoryNoise = [];
  let totalMs = 0;

  for (const gate of GATES) {
    const started = process.hrtime.bigint();
    let ok = true;
    let output = '';

    try {
      output = execFileSync(process.execPath, [join(ROOT, gate.script), ...(gate.args ?? [])], {
        encoding: 'utf8',
        cwd: ROOT,
      });
    } catch (err) {
      ok = false;
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }

    const ms = Number((process.hrtime.bigint() - started) / 1000000n);
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
    console.error(`\n✖ ${failed.length} of ${GATES.length} DOCTRINE GATE(S) FAILED\n`);
    for (const { gate, output } of failed) {
      console.error(`── ${gate.id} — ${gate.doctrine} ──`);
      console.error(`   why this gate exists: ${gate.why}`);
      console.error(output.trimEnd() + '\n');
    }
    console.error('  A red gate is not a discussion (AGENT_PROTOCOL §3).\n');
    process.exit(1);
  }

  console.log(`\n✓ all ${GATES.length} doctrine gates passed — ${totalMs}ms total\n`);
}
