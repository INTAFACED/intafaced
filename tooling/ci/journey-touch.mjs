#!/usr/bin/env node
/**
 * Which journeys a pull request touches, from its changed paths: the yardstick the merge seal (journey-seal.mjs) holds
 * a pull request's own Real-app journeys runs to, so a pull request runs the journeys it can break and no more.
 * (Failure it prevents: on 7 Nov 2026 a pull request that changed product code, #7415, merged on its own named steps
 * and broke another journey's step, J-copy-bots-otc-01 #1, on main; builders then dispatched the full suite, 36
 * shards, on nearly every branch to be safe, and runners became the factory's binding constraint.)
 *
 * Each changed path is one of three kinds, and the most demanding kind among a pull request's paths decides:
 *   - full: the change can reach any journey (a pull request runs pullPick's bounded set for it). The journey stack's shared setup (SHARED_SETUP in
 *     journey-seal.mjs), every script under tooling/scripts (the stack, the TEST market maker, the seed, world-restore,
 *     the shard planner and the scripts journeys import), the journeys workflow and its actions, the seal and this file,
 *     the journeys verdict and the baseline, build and environment files, every doc the journeys run can read (DOCS_READ:
 *     docs/roadmap, docs/runbooks and the docs code names), and every product path (apps/, services/, packages/) other than a unit test, unless the next
 *     kind takes it. A static guess at which journeys reach which code would miss journeys (a journey runs through the
 *     customer app, svc-edge and whatever services they call and the events those raise), so only evidence narrows it;
 *   - reach (the touched-journeys map, journey-reach-map.mjs, with --reach): a product path runs only the journeys main's
 *     own full runs recorded reaching it, when no full path above is in the change and the map can speak for every
 *     product path in it (shared setup, scripts, admin-app paths, packages it can't map, a switched-off, missing or
 *     stale map: full). Its journeys join the `files` list, and `reach` says why;
 *   - named (theo-01 part 1, project-state#2065, OWNER 296): a pull request whose title or branch names a journey
 *     (`J-<area>-<n>`, namedJourneyIds) that has a journey file at its head runs the journeys it names and every journey
 *     test file it changes, and its product paths also go to the map, as an unnamed one's do: the journeys the map
 *     records reaching them join the run, and a path the map can't narrow makes the change full. (Until 17 Nov 2026 a
 *     named pull request's product paths went to neither the full run nor the map, and main's full run was the only
 *     check on other journeys. Four named pull requests that ran their own journey alone each broke another one on
 *     main and were reverted: #8113 J-campaigns-01, #8153 J-cex-spot-17, #8542 J-copy-bots-otc-03, #8139
 *     J-identity-04; the map makes each of them full, journey-touch.test.mjs "replay, 4 real pull requests".) The map's
 *     `full` journeys, which no recorded run speaks for, run with a named pull request too, as with any other: no record
 *     says they miss what it changed. (Until 18 Nov 2026 they were left out of a named run to save shards, and
 *     #8802 ran 327 files without J-wallet-01, on that list, and turned main red, #8812; #8495 broke J-agents-12, also on
 *     it; intafaced #8851, journey-touch.test.mjs "replay, 5 named pull requests". Of the last 20 named pull requests
 *     before this change, 15 ran full anyway, 3 nearly-full picks become full, and one of 1 file becomes 35 files in 10
 *     shards.) A map that is switched off, stale or unreadable makes the change full; only with no map
 *     input at all (`reach` null: a call without --reach, or a seal io that reads no main runs or journey files) do the
 *     named journeys alone run, as before. Every other full path above still makes it full. Main runs every journey after every merge and is the
 *     backstop (OWNER 249 (3): "a PR runs only the journeys it touches, the full suite runs on main after a merge, a red
 *     main is reverted"). A product pull request that names no journey keeps the rules above;
 *   - stack (theo-01 part 2, OWNER 296: "A change to one service's own test-stack file runs the journeys that use that
 *     file"): a named pull request's change to a service's own stack file (STACK_FILE: `local-stack-services/<service>.mjs`,
 *     `test-owner-values/<service>.json`), or to a root deploy file the stack never reads (ROOT_DEPLOY_FILE), also
 *     runs the journeys whose tests use it (stackImporters), when nothing else makes it full. So do two more kinds
 *     (project-state rows d64, d68: on 14 Nov 2026 4 of the 7 newest journey pull requests ran all 32 shards, about 35
 *     minutes more a push, for one of these paths): a journey helper beside the journey files (HELPER, not on
 *     STACK_HELPERS) runs the journey files that import it, and the stack itself (STACK_CANARY,
 *     tooling/scripts/local-test-stack.mjs, which every shard boots) runs the named journeys plus the CANARY journeys
 *     (the lead's call). Without a name, or when the journey files can't be read, each stays full, and the rest of
 *     SHARED_SETUP always is;
 *   - files: a journey test file (`apps/customer/tests/real-app/J-<id>[-part].pw.mjs`, JOURNEY_TEST) touches the
 *     journeys in that file only. (Another run file there, a look sweep, holds no journey steps, so no report lists it:
 *     it is full.) Journey files are independent: each makes its own accounts and keeps its own run
 *     file (real-app-journeys.yml splits shards by file on that basis), and a helper they share is shared setup, so
 *     full. A file the head removed runs nothing and needs nothing.
 *   - none: a path no journeys run executes or reads: another workflow under .github (not real-app-journeys.yml, not
 *     .github/actions), a CI check under tooling/ci that the journeys run does not use (JOURNEY_CI lists the ones it
 *     does; journey-touch.test.mjs fails when an import or a reference from the journeys run reaches one not listed),
 *     a unit test (`*.test.*`, `*.spec.*`), a git hook under .githooks (git runs it on a commit or a push, which no
 *     journeys run makes), and a factory script under tooling/scripts that nothing the journeys run, the stack or the
 *     app's build executes, imports or names (FACTORY_SCRIPTS; journey-touch.test.mjs fails when anything there reaches
 *     one, so a script the run starts using comes off the list or turns its pull request red).
 * A path that matches none of the rules is full.
 *
 * Full names what the change can reach, never what a pull request runs: no pull request runs the full suite. A full
 * change, or a pick past PR_MAX_FILES, runs the bounded set (pullPick: its changed and named journeys, the map's
 * always-run list and the CANARY), in at most 30 shards (journey-shards.mjs PR_MAX_SHARDS); main's full run after the
 * merge judges the rest, as OWNER 249 (3) says. The seal holds the pull request to the same set.
 *
 *   node tooling/ci/journey-touch.mjs --base origin/main     (this checkout's branch against a base; prints what to run)
 *   node tooling/ci/journey-touch.mjs --files a b c          (named paths)
 *   node tooling/ci/journey-touch.mjs --json --files-from f  (one path a line; JSON { mode, full, files }; real-app-journeys.yml's plan)
 *   … --reach                                                 (product paths by the touched-journeys map; its age read with gh)
 *   node tooling/ci/journey-touch.mjs --reuse               (env TARGET, HEAD_SHA: the target less what runs by hand, or
 *                                                              this pull request's earlier run, on that head already run;
 *                                                              real-app-journeys.yml's reuse step)
 *   node tooling/ci/journey-touch.mjs --fallback            (the CANARY's files: a pull request's run whose paths can't
 *                                                              be judged; real-app-journeys.yml's pick step)
 *   node tooling/ci/journey-touch.mjs --dispatch            (env JOURNEYS_TARGET: a run by hand's input with every file of
 *                                                              each journey it names; real-app-journeys.yml's pick step)
 *   … --title <t> --branch <b>                                (the journeys the pull request names; with --reach, the
 *                                                              env's TITLE and GITHUB_HEAD_REF when not given, which is
 *                                                              how real-app-journeys.yml's touch step passes them)
 */
import { runJobsSync } from './run-jobs.mjs';
import { execFileSync } from 'node:child_process';
import { githubFetch, githubToken } from './github-fetch.mjs';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JOURNEY_TEST, isSharedSetup } from './journey-seal.mjs';
import { TOUCH_JOB } from './main-first.mjs';
import {
  REACH_MAP_MODE,
  alwaysRun,
  builtMap,
  headWanted,
  loadMap,
  mapProblem,
  newerMap,
  pathReach,
  reachSelect,
  readHead,
  runsBehind,
  subscribesVia,
} from './journey-reach-map.mjs';
import { countCall } from './api-count.mjs';
import { reachesLook } from './look-paths.mjs';

/** A journey test file the Real-app journeys run runs by name: directly in the real-app folder, ending `.pw.mjs`. */
export const RUN_FILE = /^apps\/customer\/tests\/real-app\/([A-Za-z0-9._-]+\.pw\.mjs)$/;

/** A changed path as printed in a log line: a pull request names its own paths, so a control character (a newline that
 *  would start a workflow command) is shown as `?`, never written. */
export const printable = (p) => String(p).replace(/[\u0000-\u001f\u007f]/g, '?');

/** The CI checks under tooling/ci that the journeys run executes or imports (real-app-journeys.yml, the seal, Main
 *  trust's post-merge job). A change to one of them changes how a journeys run is judged, so it needs the full run. */
export const JOURNEY_CI = [
  'tooling/ci/journey-seal.mjs',
  'tooling/ci/journey-touch.mjs',
  'tooling/ci/journey-verdict.mjs',
  'tooling/ci/journey-verdict.test.mjs',
  // The scoreboard's shard download ("Merge the shards").
  'tooling/ci/shard-download.mjs',
  // The touched-journeys map and what reads it: they decide which journeys a product change runs.
  'tooling/ci/journey-reach-map.mjs',
  'tooling/ci/journey-reach-map.json',
  // What finds the journeys run's reach among tooling no rule places (quietTooling).
  'tooling/ci/tooling-reach.mjs',
  'tooling/ci/post-merge-trust.mjs',
  'tooling/ci/review-marker.mjs',
  // The paths that draw a Customer room or kit part, read by the seal's review rule and the journeys pick.
  'tooling/ci/look-paths.mjs',
  'tooling/ci/workflow-concurrency.test.mjs',
  'tooling/ci/factory-switch.mjs',
  // The seal's scripts word a spent API budget with it (judge down).
  'tooling/ci/api-budget.mjs',
  'tooling/ci/api-count.mjs',
  // The seal's scripts and main-first.mjs call GitHub through it.
  'tooling/ci/github-fetch.mjs',
  // Every reader of a run's jobs reads them through it, in pages GitHub answers after a re-run.
  'tooling/ci/run-jobs.mjs',
  // real-app-journeys.yml's `Main's journeys first` job runs it.
  'tooling/ci/main-first.mjs',
  // Main trust's post-merge job runs it after each journeys run on main, and main-bisect.yml's journeys revert jobs.
  'tooling/ci/journeys-revert.mjs',
  'tooling/ci/journeys-revert-probe.mjs',
  'tooling/ci/journeys-revert-probe.sh',
  // journeys-revert.mjs mints its App token with it.
  'tooling/ci/app-token.mjs',
  // journeys-revert.mjs reads its test and job lists (the revert on main for CI reds).
  'tooling/ci/bisect-main.mjs',
  // journeys-revert.mjs refresh tells main-bisect's revert by its branch and author.
  'tooling/ci/exact-revert.mjs',
  // Reached through the seal's imports (review-marker.mjs) and the test-infra action; journey-touch.test.mjs finds them.
  'tooling/ci/assert-test-db-env.mjs',
  'tooling/ci/look-baselines.mjs',
  'tooling/ci/test-judge.mjs',
  'tooling/ci/judged-paths.mjs',
  'tooling/ci/test-judge/JUDGE.md',
];

/**
 * The docs a journeys run can read: the journeys index and the baseline (docs/roadmap, docs/runbooks), and every doc a
 * product source, a journey file or a script the journeys run executes names by path. A file ends without `/`, a folder
 * with it. Every other path under docs/ runs no journeys (the 9 Nov 09:41 UTC item on project-state#1574: a docs-only
 * pull request paid for the whole suite). journey-touch.test.mjs fails when that code names a doc this list misses.
 */
export const DOCS_READ = [
  'docs/roadmap/',
  'docs/runbooks/',
  'docs/audits/',
  'docs/agents/',
  'docs/adr/2026-11-10-launch-money-model.md',
  'docs/decisions/s2s-body-bind.md',
  'docs/pay/MERCHANT-PUBLIC-API-QUICKSTART.md',
  'docs/CODEOWNERS',
  'docs/LOCAL-TEST-STACK.md',
  'docs/OWNER-OPS-CHECKLIST-2026-07-31.md',
  'docs/OWNER-SETTINGS.md',
  'docs/RUNNING.md',
  'docs/THREAT-MODEL-BLUEPRINT-ATTESTATIONS.md',
];

/**
 * The scripts under tooling/scripts that no journeys run executes or reads: builders' and agents' tools on the Mac (the
 * pre-push checks, the review before a push, worktrees, GitHub setup) and unit tests of scripts. Every other file under
 * tooling/scripts stays full, a new one included, until it is shown unreached and listed here. journey-touch.test.mjs
 * proves each entry from the repository: no relative import, script name, `pnpm` script or path in the journeys
 * workflow, its actions, the journey files and their helpers, the CI files JOURNEY_CI lists, the stack's shared setup,
 * the stack's environment (tooling/profiles, tooling/infra) or any app, service or package file (the app's build
 * included) reaches it, through any chain of scripts. Type declarations (`.d.mts`, read by the app's type check),
 * code generators of app sources and test fixtures stay off the list. (Failure it prevents: intafaced #8284, a change
 * to the pre-push hook and its checks, paid a full journeys run of about 39 minutes per push on 14 Nov 2026, and factory
 * pull requests paid 6,011 job-minutes of journey runs since 13 Nov, project-state#2332.)
 */
export const FACTORY_SCRIPTS = [
  'tooling/scripts/agent-models.test.mjs',
  'tooling/scripts/agent-pr.mjs',
  'tooling/scripts/ci-checks.mjs',
  'tooling/scripts/ci-checks.test.mjs',
  'tooling/scripts/fleet-tip-image.mjs',
  'tooling/scripts/journey-baseline-guard.test.mjs',
  'tooling/scripts/journey-fail-fast-retries.test.mjs',
  'tooling/scripts/journey-freeze-guard.test.mjs',
  'tooling/scripts/journey-reach.test.mjs',
  'tooling/scripts/journey-world.test.mjs',
  'tooling/scripts/local-founder-seed.test.mjs',
  'tooling/scripts/local-tester-seed.test.mjs',
  'tooling/scripts/main-journeys-time.mjs',
  'tooling/scripts/main-journeys-time.test.mjs',
  'tooling/scripts/matching-ledger-load-test.mjs',
  'tooling/scripts/mvn-run.test.mjs',
  'tooling/scripts/order-path-cx8-boot.test.mjs',
  'tooling/scripts/owner-settings.test.mjs',
  'tooling/scripts/pre-push-hook.test.mjs',
  'tooling/scripts/purge-charting-library-history.sh',
  'tooling/scripts/real-app-navigation.test.mjs',
  'tooling/scripts/real-app-services.test.mjs',
  'tooling/scripts/real-app-tool-error.test.mjs',
  'tooling/scripts/redesign-shots.mjs',
  'tooling/scripts/redesign-shots.test.mjs',
  'tooling/scripts/review-before-push.mjs',
  'tooling/scripts/review-before-push.test.mjs',
  'tooling/scripts/roadmap.test.mjs',
  'tooling/scripts/runtime-safety.test.mjs',
  'tooling/scripts/service-reach.test.mjs',
  'tooling/scripts/services-map.mjs',
  'tooling/scripts/services-map.test.mjs',
  'tooling/scripts/setup-github.mjs',
  'tooling/scripts/truth-check.mjs',
  'tooling/scripts/truth-check.test.mjs',
];

const FULL_RULES = [
  [
    /^tooling\/scripts\//,
    'a script under tooling/scripts (the stack, the TEST market maker, the seed, world-restore or a script journeys import)',
  ],
  [/^\.github\/workflows\/real-app-journeys\.yml$/, 'the journeys workflow'],
  [/^\.github\/actions\//, 'an action the journeys workflow uses'],
  [
    { test: (p) => DOCS_READ.some((d) => (d.endsWith('/') ? p.startsWith(d) : p === d)) },
    'a doc the journeys run, the stack or a service reads or names (DOCS_READ)',
  ],
  [/^tooling\/(profiles|infra)\//, 'the stack’s environment (tooling/profiles, tooling/infra)'],
  [
    /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig[^/]*\.json|\.npmrc|\.nvmrc|\.node-version|\.env\.example|docker-compose[^/]*\.ya?ml)$/,
    'a root build or environment file',
  ],
];

const NONE_RULES = [
  (p) => p.startsWith('.github/') && !/^\.github\/(workflows\/real-app-journeys\.yml|actions\/)/.test(p),
  // A git hook: git runs it on a commit or a push, and nothing the journeys run executes commits, pushes or reads it
  // (journey-touch.test.mjs).
  (p) => p.startsWith('.githooks/'),
  (p) => p.startsWith('tooling/ci/') && !JOURNEY_CI.includes(p),
  (p) => /^(apps|services|packages)\//.test(p) && /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) && !p.startsWith('apps/customer/tests/real-app/'),
  // Markdown at the repository root (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, README.md): no journey, stack script or
  // harness file reads it (U6 on project-state#1574: an AGENTS.md-only PR paid for a full run, 42547155694).
  (p) => /^[^/]+\.md$/.test(p),
  // A doc outside DOCS_READ (that list is full, and is checked first).
  (p) => p.startsWith('docs/'),
  // The linter's config and plugins (.oxlintrc.json, tooling/lint) and the agents' skills and rules (`.claude/`): CI's lint
  // and the agents read them; no journey, stack script or app build does (a journey helper names a lint rule only in a
  // comment). (Before 20 Nov 2026 each was "a path no rule places", so a full run: 15 of the 110 full picks on 19 Nov.)
  (p) => p === '.oxlintrc.json' || p.startsWith('tooling/lint/') || p.startsWith('.claude/'),
  // The published SDKs (sdks/python): no journey, stack script or service imports or reads them; the SDK's drift test
  // (packages/sdk-ts/src/drift.test.ts) and the generator (tooling/scripts/sdk-from-openapi.ts) are their judges.
  // (#8321 ran all 32 shards for sdks/python/openapi/payments.openapi.json, a path no rule placed, 14 Nov 2026.)
  (p) => p.startsWith('sdks/'),
];

const PRODUCT = 'product code, and no map recorded from real runs says which journeys reach it yet';

/** A Rust service's crate (`crates/svc-tax/src/wire.rs`): the same service as `services/svc-tax`, so the touched-journeys
 *  map reads it as that service's path. The workspace's shared files (Cargo.lock, crates/service-kit) are no one
 *  service's, so they stay unplaced and a pull request runs its bounded set (pullPick). */
export const CRATE = /^crates\/(svc-[a-z0-9-]+)\/(.+)$/;

/** A journey id as the seal reads one in a title (journey-seal.mjs JOURNEY_ID). */
const JOURNEY_ID = /\bJ-[a-z0-9]+(?:-[a-z0-9]+)*-\d+\b/gi;

/** The journey ids a pull request's title or branch names (`J-bank-13`, branch `j/j-bank-13` or `agents-j-agents-19`),
 *  in the seal's case (`J-` then lower case), sorted. */
export function namedJourneyIds({ title = '', branch = '' } = {}) {
  const ids = new Set();
  for (const t of [title, branch]) for (const m of String(t ?? '').matchAll(JOURNEY_ID)) ids.add(m[0].toLowerCase().replace(/^j-/, 'J-'));
  return [...ids].sort();
}

/**
 * What a named-journey pull request runs besides its changed journey files (journeyTouch's `named`), or null when it
 * names no journey with a file at its head (then the other rules decide). `journeyFiles`: the journey file names at the
 * head (a Set), or null when they can't be read (then null: fail to the other rules, never fewer). No always-run list:
 * the journeys no recorded run speaks for are judged by main's full run after the merge, and a red there is reverted.
 */
export function namedInputs({ ids, journeyFiles, importers = null }) {
  if (!ids?.length || !journeyFiles) return null;
  const want = new Set(ids);
  const files = [...journeyFiles].filter((f) => want.has(JOURNEY_TEST.exec(`apps/customer/tests/real-app/${f}`)?.[1])).sort();
  if (!files.length) return null;
  return { ids: [...ids], files, journeyFiles, ...(importers ? { importers } : {}) };
}

/**
 * Every journey file at the head of each journey `files` selects (`journeyFiles`, a Set; null: `files` as given). A
 * journey's steps may sit in more than one file (`J-home-ia-01.pw.mjs` and `J-home-ia-01-venue.pw.mjs`), and a targeted
 * run's verdict counts a step that passed in the baseline's run as missing when its file did not run, so a selection
 * that names one file of a journey runs them all. (Failure it prevents: on 14 Nov 2026 #8320's run took the canary's
 * J-home-ia-01.pw.mjs alone, and J-home-ia-01 #1 #2 #3, in J-home-ia-01-venue.pw.mjs since #8310, read as missing money
 * steps: red for a change that did not touch them.)
 */
export function withSiblings(files, journeyFiles) {
  const list = [...new Set(files)];
  if (!journeyFiles) return list.sort();
  const idOf = (f) => JOURNEY_TEST.exec(`apps/customer/tests/real-app/${f}`)?.[1];
  const ids = new Set(list.map(idOf).filter(Boolean));
  return [...new Set([...list, ...[...journeyFiles].filter((f) => ids.has(idOf(f)))])].sort();
}

/**
 * A run by hand's journeys input (journey file names, spaces or commas between) as the files it runs: every file of each
 * journey it names (withSiblings), as a pull request's run takes them. (Failure it prevents: on 14 Nov 2026 run
 * 43637111867 named J-derivatives-01.pw.mjs alone, and the steps in J-derivatives-01-venue.pw.mjs read as missing money
 * steps.) A bare journey id (`J-cex-spot-10`, which journey-shards.mjs runs as `J-cex-spot-10.pw.mjs`) is every file
 * of that journey too. (Failure it prevents: on 20 Nov 2026 run 44808167679 was given `J-cex-spot-10`, ran
 * J-cex-spot-10.pw.mjs alone, and #9286's seal read J-cex-spot-10 #1 #2 #3 #4 #6 #9, in J-cex-spot-10-venue.pw.mjs
 * since #8787, as missing.) A name that is not a journey file or id at the head stays as given, so the run still
 * refuses it.
 */
export function dispatchTarget(input, journeyFiles) {
  const idOf = (f) => JOURNEY_TEST.exec(`apps/customer/tests/real-app/${f}`)?.[1];
  const names = String(input ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .flatMap((f) => {
      if (!journeyFiles || JOURNEY_FILE_NAME.test(f)) return [f];
      const files = [...journeyFiles].filter((j) => idOf(j) === f);
      return files.length ? files : [f];
    });
  return withSiblings(names, journeyFiles).join(' ');
}

/** A service's own stack file: what `local:stack` starts that one service with. A test file beside them, or any other
 *  name, isn't one. */
export const STACK_FILE = /^tooling\/(?:scripts\/local-stack-services\/[a-z0-9-]+\.mjs|profiles\/test-owner-values\/[a-z0-9-]+\.json)$/;

/** A root deploy file the journeys stack never starts from: `pnpm local:stack` reads no compose file or .env.example
 *  (deploys and the tester profile do), and a journey that reads one names it (J-home-ia-11 reads both compose files and
 *  .env.example). The Dockerfile is not one: J-home-ia-11 builds the app image without naming it, so it stays full. A
 *  journey build adds its service's env here beside its stack file, and one of them was in 34 of 41 journey-build runs
 *  on 12-13 Nov 2026 that ran the full suite. So a named pull request treats it like a stack file: it runs the journeys
 *  that name it (stackImporters); without a name it stays full, and main's full run judges the rest
 *  (project-state#2344 row d55). */
export const ROOT_DEPLOY_FILE = /^(?:docker-compose[^/]*\.ya?ml|\.env\.example)$/;

/** A journey helper: a module directly in the real-app folder that is not a run file (`venue-reads.mjs`). */
export const HELPER = /^apps\/customer\/tests\/real-app\/([A-Za-z0-9._-]+\.mjs)$/;

/**
 * The helpers that code outside the journey files runs or names: the Playwright config and its reporter, and the
 * helpers a stack script, a script the journeys run starts, a CI file the run uses (JOURNEY_CI), the workflows or app
 * code reach. A change to one can break any journey or the stack, so it stays full. journey-touch.test.mjs finds every
 * helper such code names and fails when one is missing here. Any other helper, in a pull request that names a journey,
 * runs the journey files that import it (stackImporters), and is full when a run file that is not a journey, the config,
 * or one of these reaches it. (Failure it prevents: #8322 changed venue-reads.mjs, which two journeys import, and #8310
 * look-fixtures.mjs; each ran all 32 shards, 14 Nov 2026.)
 */
export const STACK_HELPERS = [
  'admin.mjs',
  'agents.mjs',
  'copy.mjs',
  'desk.mjs',
  'dex.mjs',
  'fail-fast-once.mjs',
  'journey.mjs',
  'market.mjs',
  'merchant.mjs',
  'notices.mjs',
  'p2p.mjs',
  'real-app.playwright.config.mjs',
  'services.mjs',
  'stack.mjs',
  'staff.mjs',
  'test-wallet.mjs',
  'venue.mjs',
  'world-line.mjs',
  'world-restore.mjs',
];

/** The stack every shard boots. A named pull request's change to it runs its named journeys and the CANARY journeys,
 *  and main's full run after the merge judges the rest (OWNER 249 (3); the lead's call, 14 Nov 2026). Its siblings
 *  (the TEST market maker, the seed, the world) stay full. */
export const STACK_CANARY = 'tooling/scripts/local-test-stack.mjs';

/**
 * The canary: journey files that run beside a named change to the stack, about one shard (some 10 minutes of journeys)
 * across sign-up and identity, spot trading on the TEST venue, P2P and Home's balances. Each passed every step in main's
 * 4 newest finished full runs (43577989116, 43579219442, 43582579196, 43586501223; 14 Nov 2026). J-home-ia-01 #1 to #3
 * live in J-home-ia-01-venue.pw.mjs since #8310 (fcd0249d60), and the verdict reads a step missing from a file that ran
 * as red (#8320), so a canary journey runs all its files; that file passed #1 to #3 in main's runs 5011, 5020 and 5049
 * (43586501223, 43589780896, 43596135637; 14 Nov 2026). Every shard boots the whole stack, so the named journey's own
 * shard proves it starts; these prove it still serves other areas. One missing at the head makes the change full.
 */
export const CANARY = [
  'J-cex-spot-01.pw.mjs',
  'J-home-ia-01-venue.pw.mjs',
  'J-home-ia-01.pw.mjs',
  'J-identity-01.pw.mjs',
  'J-p2p-01.pw.mjs',
];

/** Whether a changed path is a helper that may narrow (HELPER, and not on STACK_HELPERS). */
const narrowHelper = (p) => {
  const m = HELPER.exec(p);
  return Boolean(m) && !m[1].endsWith('.pw.mjs') && !STACK_HELPERS.includes(m[1]);
};

/** Text with a path split over `'a', 'b'` arguments or a line of comment joined up, so each spelling reads as one path. */
export const joinedPaths = (t) =>
  String(t)
    .replace(/['"`]\s*,\s*['"`]/g, '/')
    .replace(/\/[ \t]*\r?\n[ \t]*(?:\/\/|\*)[ \t]*/g, '/');

/**
 * The journey files whose tests use a changed stack file (OWNER 296; blueprint file 10 item 6), from `texts`: the head's
 * .mjs files in the real-app folder, name to text. A file uses it when it names it by path anywhere, in code or in a
 * comment (most journeys that lean on a stack value say so in a comment and restart the service, and never `import` it;
 * running one too many is safe), or imports a helper in that folder that does.
 */
export function stackImporters(paths, texts) {
  const all = [...new Set(paths)].map(String);
  // A helper is named by its file name (any import spelling, or a comment); the stack itself adds the canary instead.
  const helpers = all.filter(narrowHelper).map((p) => HELPER.exec(p)[1]);
  const canary = all.includes(STACK_CANARY);
  const names = all.filter((p) => !narrowHelper(p) && p !== STACK_CANARY).map((p) => p.replace(/^tooling\/(?:scripts|profiles)\//, ''));
  const sources = new Map([...texts].map(([f, t]) => [f, joinedPaths(t)]));
  const reaches = new Set(
    [...sources].filter(([f, t]) => names.some((n) => t.includes(n)) || helpers.some((h) => f !== h && t.includes(h))).map(([f]) => f),
  );
  const uses = new Map([...sources].map(([f, t]) => [f, [...t.matchAll(/(['"`])\.\/([A-Za-z0-9._-]+\.mjs)\1/g)].map((m) => m[2])]));
  for (let grew = true; grew;) {
    grew = false;
    for (const [f, deps] of uses)
      if (!reaches.has(f) && deps.some((d) => reaches.has(d))) {
        reaches.add(f);
        grew = true;
      }
  }
  const isJourney = (f) => JOURNEY_TEST.test(`apps/customer/tests/real-app/${f}`);
  if (helpers.length) {
    // A helper narrows only when journey files alone reach it: a run file that is not a journey (a look sweep, which no
    // report lists), a helper outside code reaches (STACK_HELPERS), or a module nothing in the folder names (the config,
    // an entry point Playwright or a script loads) among its importers makes the change full (null).
    const named = (f) => [...sources].some(([g, t]) => g !== f && t.includes(f));
    for (const f of reaches) {
      if (isJourney(f) || helpers.includes(f)) continue;
      if (f.endsWith('.pw.mjs') || STACK_HELPERS.includes(f) || !named(f)) return null;
    }
  }
  const out = [...reaches].filter(isJourney);
  if (canary) {
    if (!CANARY.every((f) => sources.has(f))) return null;
    out.push(...CANARY);
  }
  return [...new Set(out)].sort();
}

/** One path's kind: { kind: 'full', why, stack? } | { kind: 'file', file } | { kind: 'none' }. `stack`: a service's own
 *  stack file, which only a pull request that names a journey narrows (journeyTouch). */
export function pathKind(path) {
  const k = kindOf(String(path));
  const p = String(path);
  return STACK_FILE.test(p) || ROOT_DEPLOY_FILE.test(p) || narrowHelper(p) || p === STACK_CANARY ? { ...k, stack: true } : k;
}

function kindOf(p) {
  if (isSharedSetup(p)) return { kind: 'full', why: 'the journey stack’s shared setup (SHARED_SETUP)' };
  const run = RUN_FILE.exec(p);
  if (run && JOURNEY_TEST.test(p)) return { kind: 'file', file: run[1] };
  if (run)
    return {
      kind: 'full',
      why: 'a run file that holds no journey steps (a look sweep), which no report lists, so only a clean full run shows it broke nothing',
    };
  if (JOURNEY_CI.includes(p)) return { kind: 'full', why: 'a check the journeys run uses (JOURNEY_CI)' };
  if (FACTORY_SCRIPTS.includes(p)) return { kind: 'none' };
  for (const [re, why] of FULL_RULES) if (re.test(p)) return { kind: 'full', why };
  if (NONE_RULES.some((r) => r(p))) return { kind: 'none' };
  if (/^(apps|services|packages)\//.test(p)) return { kind: 'full', why: PRODUCT, product: true };
  // A Rust service's crate is that service: the map reads it as the service's own path (CRATE).
  const crate = CRATE.exec(p);
  if (crate) return { kind: 'full', why: PRODUCT, product: true, as: `services/${crate[1]}/${crate[2]}` };
  return { kind: 'full', why: UNPLACED };
}

/** Why a path no rule above places is full: the safe default. */
export const UNPLACED = 'a path no rule places, so the safe default';

/**
 * A tooling file no rule places that no journeys run reaches: `reach` is tooling-reach.mjs's `journeys` list for the
 * tree judged, the pull request's head (nothing the journeys workflow, its actions, the stack, the seed, tooling/scripts,
 * a journey file or any app, service, package or crate file names reads it). A change made only of these and of paths
 * that run no journeys runs no journeys (journeyTouch); beside any other path it stays the safe default, so a pull
 * request that touches product code, the stack or a journey keeps its pick. With no list (`null`: not scanned, or the
 * scan failed), or a path with a character no tracked path holds, nothing is quiet. (Failure it prevents: #9552,
 * tooling/design/RECIPE.md and a tooling script, ran 64 journey files on 18 shards, about 23 minutes a push, on 22 Nov
 * 2026.)
 */
export function quietTooling(path, reach = null) {
  const p = String(path);
  if (!reach || !/^tooling\/[A-Za-z0-9_.@/-]+$/.test(p) || kindOf(p).why !== UNPLACED) return false;
  return !reach.some((e) => (e.endsWith('/') || e.endsWith('*') ? p.startsWith(e.replace(/[*]$/, '')) : e === p));
}

/** Whether a change could be quiet (quietTooling), so a caller scans the tree only then: it holds tooling no rule places. */
export const mayBeQuiet = (paths) => [...(paths ?? [])].some((p) => String(p).startsWith('tooling/') && kindOf(String(p)).why === UNPLACED);

/**
 * What a pull request with these changed paths must run. `atHead(file)`: whether a journey test file still exists at
 * the head (a removed file runs nothing). `reach`: what the touched-journeys map needs (journey-reach-map.mjs
 * reachSelect: { map, behind, journeyFiles, subscribes, head }), or null: then every product path is full. With it, product
 * paths run only the journeys whose recorded reach touches them, when every other path allows it and the map can speak
 * for each of them; anything else is full. Returns { mode: 'full'|'files'|'none', full: [{ path, why }], files: [names],
 * reach?: [lines] }. `named`: what namedInputs gives for a pull request that names a journey, or null; with it, product
 * paths run the named journeys besides what the map selects for them (its always-run list included), or the named
 * journeys alone when `reach` is null, and `named` says why. With
 * it, a service's own stack file adds the journeys that use it, when nothing else is full (`stack` lists those paths,
 * `importers` those journeys); otherwise it is full like any other. `tooling`: the head's tooling reach (quietTooling),
 * or null.
 */
export function journeyTouch(paths, atHead = () => true, reach = null, named = null, tooling = null) {
  // Only tooling no journeys run reaches, beside paths that run none: no journeys (quietTooling).
  const all = [...new Set(paths ?? [])];
  const quiet = (p) => quietTooling(p, tooling);
  if (all.length && all.some(quiet) && all.every((p) => quiet(p) || pathKind(p).kind === 'none'))
    return { mode: 'none', full: [], files: [] };
  const full = [];
  const product = [];
  const stack = [];
  const files = new Set();
  // A crate's path as the pull request spells it, for the lines that name it (CRATE).
  const spelled = new Map();
  for (const p of [...new Set(paths ?? [])].sort()) {
    const k = pathKind(p);
    if (k.kind === 'full' && k.product) {
      product.push(k.as ?? p);
      if (k.as) spelled.set(k.as, p);
    } else if (k.stack) stack.push({ path: printable(p), why: k.why });
    else if (k.kind === 'full') full.push({ path: printable(p), why: k.why });
    else if (k.kind === 'file' && atHead(p)) files.add(k.file);
  }
  let because;
  let byName;
  if (product.length && named && !reach) {
    // Judged on the journeys it names (theo-01 part 1); another full path still makes the whole change full.
    if (full.length) for (const p of product) full.push({ path: printable(spelled.get(p) ?? p), why: PRODUCT });
    else {
      for (const f of named.files) files.add(f);
      byName = `it names ${named.ids.join(', ')}, so its ${product.length} product path(s) run ${named.files.join(', ')}, and main's full run judges the rest`;
    }
  } else if (product.length && !full.length && reach) {
    const sel = reachSelect({
      map: reach.map,
      paths: product,
      behind: reach.behind,
      atHead: reach.journeyFiles,
      subscribes: reach.subscribes,
      head: reach.head ?? null,
      ...(reach.mode ? { mode: reach.mode } : {}),
    });
    if (sel.mode === 'files') {
      for (const f of sel.files) files.add(f);
      because = sel.because.map(printable);
      // A named pull request runs its named journeys too, besides what its product paths reach.
      if (named) {
        for (const f of named.files) files.add(f);
        byName = `it names ${named.ids.join(', ')}, so its ${product.length} product path(s) run ${named.files.join(', ')} and the ${sel.files.length} journey file(s) the touched-journeys map says reach them`;
      }
    } else for (const p of product) full.push({ path: printable(spelled.get(p) ?? p), why: printable(sel.why) });
  } else for (const p of product) full.push({ path: printable(spelled.get(p) ?? p), why: PRODUCT });
  // Decided last, so any other full path, product code included, makes the stack files full with it.
  const importers = stack.length && !full.length ? (named?.importers?.(stack.map((x) => x.path)) ?? null) : null;
  if (importers) {
    for (const f of [...named.files, ...importers]) files.add(f);
    byName = `${byName ? `${byName}; ` : ''}it names ${named.ids.join(', ')}, so its ${stack.length} stack file(s) run ${named.files.join(', ')} and the ${importers.length} journey file(s) using them`;
  } else full.push(...stack);
  full.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Every file of each journey selected, when the head's journey files are known (withSiblings).
  const list = withSiblings(files, named?.journeyFiles ?? reach?.journeyFiles ?? null);
  const out = { mode: full.length ? 'full' : list.length ? 'files' : 'none', full, files: list };
  if (byName && !full.length)
    return {
      ...out,
      named: printable(byName),
      ...(because ? { reach: because } : {}),
      ...(importers ? { stack: stack.map((x) => x.path), importers } : {}),
    };
  return because && !full.length ? { ...out, reach: because } : out;
}

/**
 * The most journey files a pull request's own run takes. A pick past it runs the bounded set instead (pullPick). About
 * 100 files are about 240 minutes of journeys (main's full run: about 891 minutes over some 365 files), which
 * journey-shards.mjs packs into its PR_MAX_SHARDS of 30 at about 10 minutes a shard.
 */
export const PR_MAX_FILES = 100;

/**
 * What a pull request's own journeys run runs, from journeyTouch's answer `touch` for its changed `paths`: never the full
 * suite. A pick of PR_MAX_FILES journey files or fewer stands as it is. A change journeyTouch calls full (a path the
 * map can't narrow, shared setup, a script, the workflow, a path no rule places), or one whose pick is past the bound,
 * runs the bounded set: the journey files it changes (`atHead`, as journeyTouch reads them), the journeys it names
 * (`named`, namedInputs), the journeys the map can't speak for (alwaysRun, when the map in `reach` is usable) and the
 * CANARY, which boot the whole stack and the app and prove it still serves other areas; main's full run after the
 * merge judges the rest, and main-bisect reverts a red there (OWNER 249 (3): "a PR runs only the journeys it touches,
 * the full suite runs on main after a merge"). `mainJudges` lists the paths that put it there. (Failure it prevents:
 * in the 48 hours to 20 Nov 2026, 174 of 233 merged pull requests picked the full run, about 1,400 runner-minutes each,
 * and pull requests' journeys runs took about 317,000 of the repository's 400,000 runner-minutes a day; no full run on
 * a pull request in the 7 days before is on record catching a break outside its change's reach.)
 */
export function pullPick(paths, touch, { atHead = () => true, reach = null, named = null } = {}) {
  const over = touch.mode === 'files' && touch.files.length > PR_MAX_FILES;
  if (touch.mode !== 'full' && !over) return touch;
  const journeyFiles = named?.journeyFiles ?? reach?.journeyFiles ?? null;
  const known = journeyFiles instanceof Set;
  const mapOk = Boolean(reach) && known && !mapProblem(reach.map, reach.behind, reach.mode ?? REACH_MAP_MODE);
  // A change that draws a Customer room or kit part runs every journey the map records reaching what it changes, past
  // PR_MAX_FILES too (#9960: its `kit-ceilings.json` and render records made it full, so it ran 15 bounded files and
  // left out the 60 the map records reaching its OrderTables.tsx; J-home-ia-05 #2 broke on main, revert #10027).
  const room = mapOk ? roomReach(paths, reach) : null;
  if (room && over)
    return {
      ...touch,
      room: printable(
        `it draws a Customer room or kit part (${room.part}), so it runs all ${touch.files.length} journey files the map records reaching it, past a pull request's ${PR_MAX_FILES}`,
      ),
    };
  const always = mapOk ? alwaysRun(reach.map, journeyFiles) : [];
  const own = [...new Set(paths ?? [])]
    .map((p) => [p, pathKind(p)])
    .filter(([p, k]) => k.kind === 'file' && atHead(p))
    .map(([, k]) => k.file);
  // The CANARY is asked for whether or not the head holds it: a CANARY file gone from the head is a run that can't plan
  // and a seal that holds, never a bounded set that runs nothing.
  const files = withSiblings([...own, ...(named?.files ?? []), ...always, ...CANARY, ...(room?.files ?? [])], known ? journeyFiles : null);
  const cause = over
    ? `the journeys its paths reach are ${touch.files.length} journey files, past a pull request's ${PR_MAX_FILES}`
    : `${touch.full.length} path(s) no recorded run narrows (${touch.full
        .slice(0, 3)
        .map((x) => `${x.path}: ${x.why}`)
        .join('; ')}${touch.full.length > 3 ? `; ${touch.full.length - 3} more` : ''})`;
  const bounded = `${cause}, so it runs ${named ? `the journeys it names (${named.ids.join(', ')}), ` : ''}${own.length ? `the ${own.length} journey file(s) it changes, ` : ''}${room ? `the ${room.files.length} journey file(s) the map records reaching the ${room.paths} path(s) it can narrow (it draws a Customer room or kit part: ${room.part}), ` : ''}the ${always.length} journey file(s) the map can't speak for and the CANARY; main's full run after the merge judges the rest`;
  return { mode: 'files', full: [], files, bounded: printable(bounded), mainJudges: touch.full.map((x) => x.path) };
}

/**
 * For a change that draws a Customer room or kit part (look-paths.mjs reachesLook; a test draws none), the journey
 * files the map records reaching each product path it can narrow, one path at a time, so a path it can't narrow (a
 * render record, kit-ceilings.json) no longer drops the others' reach. Null for any other change, or one with no path
 * the map narrows. `reach` is pullPick's, with a usable map. Returns { files, paths, part }.
 */
export function roomReach(paths, reach) {
  const all = [...new Set(paths ?? [])];
  const drawn = all.filter((p) => reachesLook([p]) && pathKind(p).product);
  const part = drawn.find((p) => /\/src\//.test(p)) ?? drawn[0];
  if (!part) return null;
  const picked = new Set();
  let narrowed = 0;
  for (const p of all) {
    const k = pathKind(p);
    if (!k.product) continue;
    let r;
    try {
      r = pathReach(reach.map, k.as ?? p, reach.subscribes?.(k.as ?? p) ?? false, reach.head ?? null);
    } catch {
      continue;
    }
    if (r.full) continue;
    narrowed++;
    for (const i of r.journeys) picked.add(reach.map.journeys[i]);
  }
  const files = [...picked].filter((f) => reach.journeyFiles.has(f)).sort();
  return narrowed ? { files, paths: narrowed, part: printable(part) } : null;
}

/** A run by hand's title (real-app-journeys.yml `run-name`): the journeys it was given, or `full`. */
export const DISPATCH_TITLE = /^Real-app journeys by hand, (.+)$/;

/**
 * GitHub refuses to start a run whose concurrency group is longer than 400 characters: the run ends "failure" with no
 * jobs ("This run likely failed because of a workflow file issue"). real-app-journeys.yml's group for a run by hand
 * holds the branch and the whole journeys input (one group per branch and selection, workflow-concurrency.test.mjs
 * rule 3), and GitHub's expressions can neither measure nor hash a string, so a long input can't start: 63 files on
 * fix/ps-3298 (1556 characters) failed in run 44766798876. Measured on 20 Nov 2026 with the same group expression:
 * a 400-character group started (run 44768303533) and a 401-character one failed (run 44768324557).
 */
export const DISPATCH_GROUP_MAX = 400;
/** real-app-journeys.yml's concurrency group for a run by hand on `branch` given `journeys` (workflow-concurrency.test.mjs holds it to the workflow's expression). */
export const dispatchGroup = (branch, journeys) => `real-app-journeys-refs/heads/${branch}:${journeys}`;

/**
 * The runs by hand that run `files` on `branch`: the files in order, split into as few lists as keep each run's
 * concurrency group within DISPATCH_GROUP_MAX, so every one starts. A file whose group passes it on its own still gets
 * its own run (it can't start: the branch name is too long to dispatch any journey on). Returns [[file]].
 */
export function dispatchBatches(branch, files) {
  const batches = [];
  for (const f of files ?? []) {
    const last = batches.at(-1);
    if (last && dispatchGroup(branch, [...last, f].join(' ')).length <= DISPATCH_GROUP_MAX) last.push(f);
    else batches.push([f]);
  }
  return batches;
}

/** The `gh workflow run` commands that run `files` on `branch`, one a batch (dispatchBatches); `repo` adds `-R`. */
export const dispatchCommands = (branch, files, repo = '') =>
  dispatchBatches(branch, files).map(
    (b) => `gh workflow run real-app-journeys.yml${repo ? ` -R ${repo}` : ''} --ref ${branch} -f journeys="${b.join(' ')}"`,
  );
const JOURNEY_FILE_NAME = /^[A-Za-z0-9._-]+\.pw\.mjs$/;
/** A shard job of the journeys run (real-app-journeys.yml `journeys` job). */
export const SHARD_JOB = /^Journeys \(shard \d+ of \d+\)$/;

/**
 * One journeys run per head (project-state#2065 row d32 part (b)): the journey files that targeted runs by hand of this
 * workflow on the pull request's exact head (the builder's run before it opened the pull request) already run, so the
 * pull request's own run leaves them out. A run counts when it is this repository's, dispatched by hand on `sha`, and
 * targeted: its title (DISPATCH_TITLE) names journey files, each a journey file at the head (`journeyFiles`, a Set; null:
 * none counts). A full run by hand never counts: it may be deferred and run nothing for now (main-first.mjs), it fails
 * fast on unbuilt steps where a pull request's run keeps the ordinary limits, and one still going is cancelled by the
 * pull request's run, which shares its concurrency group. A targeted run still going counts (the seal waits for it); a
 * finished one counts only when its shards ran (`ranShards`, a Set of run ids with a finished shard job), never when it
 * was cancelled or skipped or stopped before its shards. The seal still reads every run on the head by its report
 * (journey-seal.mjs), so a red there stands. Returns Map(file → run id).
 */
export function reusableRuns(runs, { sha, repo, journeyFiles, ranShards, workflow = '.github/workflows/real-app-journeys.yml' }) {
  const files = new Map();
  for (const r of runs ?? []) {
    if (r?.event !== 'workflow_dispatch' || r?.head_sha !== sha || r?.path !== workflow) continue;
    if (r?.repository?.full_name !== repo || r?.head_repository?.full_name !== repo) continue;
    if (r.status === 'completed' && (['cancelled', 'skipped'].includes(r.conclusion) || !ranShards?.has(r.id))) continue;
    const m = DISPATCH_TITLE.exec(String(r.display_title ?? ''));
    if (!m || m[1] === 'full') continue;
    const names = m[1].split(/[\s,]+/).filter(Boolean);
    if (!journeyFiles || !names.length || !names.every((f) => JOURNEY_FILE_NAME.test(f) && journeyFiles.has(f))) continue;
    for (const f of names) if (!files.has(f)) files.set(f, r.id);
  }
  return files;
}

/**
 * What a pull request's run runs after leaving out the journey files `reused` (reusableRuns) already runs on its head.
 * `target`: the touch job's journey file names separated by spaces; '' (the full suite) is never narrowed. A journey's
 * files are left out together or not at all: the verdict reads only this run's report, so a step in a reused file of a
 * journey whose other file still runs here reads as missing. (Failure it prevents: #8835's run 44248303203 left out
 * the hand-run J-derivatives-01-venue.pw.mjs, still ran J-derivatives-01.pw.mjs, and its verdict went red on
 * "J-derivatives-01#1 #5 #6 #8 #9 #10 #11 (money): passed in run 1719, missing now"; project-state#3029.) Returns
 * { target, mode: 'run'|'none', why }.
 */
export function afterReuse(target, reused, how = 'by hand') {
  const want = String(target ?? '')
    .split(/\s+/)
    .filter(Boolean);
  const idOf = (f) => JOURNEY_TEST.exec(`apps/customer/tests/real-app/${f}`)?.[1] ?? f;
  const runsHere = new Set(want.filter((f) => !reused.has(f)).map(idOf));
  const rest = want.filter((f) => !reused.has(f) || runsHere.has(idOf(f)));
  if (!want.length || rest.length === want.length) return { target: want.join(' '), mode: 'run', why: '' };
  const ids = [...new Set(want.filter((f) => reused.has(f)).map((f) => reused.get(f)))];
  const why = `${want.length - rest.length} of its ${want.length} journey file(s) already run ${how} on this head (run ${ids.join(', ')}), so this run leaves them out`;
  return rest.length ? { target: rest.join(' '), mode: 'run', why } : { target: '', mode: 'none', why: `${why} and runs nothing` };
}

/** What a pull request's journeys run runs, kept with the run (real-app-journeys.yml "Keep what this run runs"): JSON
 *  { head, mode: 'run', target } in PICK_FILE, written only once the run is sure to run its shards (not deferred). */
export const PICK_ARTIFACT = 'real-app-journeys-pick';
export const PICK_FILE = 'pick.json';

/**
 * A draft runs its journeys from its first push (#8707), so marking it ready on the same head runs again only what that
 * run does not already run. Before this a draft ran nothing and its ready run started only after the draft round: on the
 * 20 builds to 16 Nov 2026 that held the pull request's journeys back 1 to 27 minutes on 5 of them (#8705, #8702, #8695).
 * An earlier run counts when it is this pull request's own (`pr`; event pull_request, this repository's, this workflow) on
 * this exact head, started before this run (`self`, its run id), not cancelled or skipped, and kept what it runs for its
 * current attempt (`picks`: Map(run id → the PICK_ARTIFACT's JSON); a run with none, an older run before this rule or a
 * deferred attempt, counts for nothing). A finished red one counts as a red run by hand does: its red stands for this head
 * and the seal reads it, so marking the pull request ready is not a second try. Its pick covers the full suite when its
 * target is empty, but only when it read the title's journey files and they hold every one this run's title names
 * (`named`: an array, or null when unread), since a full run's retries spare only the journeys it touches; else its
 * journey files, each a journey file at the head. The seal still reads every run on the head by its report
 * (journey-seal.mjs): one still going holds it, and a red stands. Returns { full: run id | null, files: Map(file → run id) }.
 */
export function pullRunsCover(
  runs,
  { sha, repo, pr, self, picks, journeyFiles, named = null, workflow = '.github/workflows/real-app-journeys.yml' },
) {
  let full = null;
  const files = new Map();
  for (const r of [...(runs ?? [])].sort((a, b) => Number(a?.id) - Number(b?.id))) {
    if (r?.event !== 'pull_request' || r?.head_sha !== sha || r?.path !== workflow) continue;
    if (r?.repository?.full_name !== repo || r?.head_repository?.full_name !== repo) continue;
    if (!(Number(r.id) < Number(self))) continue;
    if (r.status === 'completed' && ['cancelled', 'skipped'].includes(r.conclusion)) continue;
    const p = picks?.get(r.id);
    if (!p || p.head !== sha || p.pr !== Number(pr) || !Number(pr) || p.mode !== 'run' || typeof p.target !== 'string') continue;
    const names = p.target.split(/\s+/).filter(Boolean);
    if (!names.length) {
      const had = new Set(
        String(p.named ?? '')
          .split(/\s+/)
          .filter(Boolean),
      );
      if (p.named_read === true && Array.isArray(named) && named.every((f) => had.has(f))) full ??= r.id;
      continue;
    }
    if (!journeyFiles || !names.every((f) => JOURNEY_FILE_NAME.test(f) && journeyFiles.has(f))) continue;
    for (const f of names) if (!files.has(f)) files.set(f, r.id);
  }
  return { full, files };
}

/**
 * The PICK_ARTIFACT a run kept during its current attempt, or null: made at or after `touchStart`, when its latest
 * attempt's touch job (TOUCH_JOB) started, else the attempt's start, and not expired. A re-run of only the failed jobs
 * keeps the touch job and the pick it made; a re-run of every job, or a deferred attempt, starts the touch job again,
 * so an older pick counts for nothing. (Failure it prevents: a pick counted only when made after the attempt began,
 * so #9255's re-run of one failed shard, 20 Nov 2026, left its pick out, and its ready run ran 62 of its 63 journey
 * files again: 31 more minutes on a green head.)
 */
export function currentPickArtifact(run, artifacts, touchStart = null) {
  const start = Date.parse(touchStart ?? run?.run_started_at ?? run?.created_at ?? '');
  const fits = (artifacts ?? []).filter(
    (a) => a?.name === PICK_ARTIFACT && !a.expired && Number.isFinite(start) && Date.parse(a.created_at ?? '') >= start,
  );
  return fits.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
}

/** When the latest attempt's touch job of a run started (`jobs`: its jobs, filter=latest), or null. Pure. */
export function touchStarted(jobs) {
  const j = (jobs ?? []).find((x) => x?.name === TOUCH_JOB && x?.started_at);
  return j ? j.started_at : null;
}

/** The .mjs files directly in a checkout's real-app folder, name to text, or null when they can't be read. */
export function checkoutJourneyTexts(root = '.') {
  try {
    const dir = `${root}/apps/customer/tests/real-app`;
    return new Map(
      readdirSync(dir)
        .filter((f) => f.endsWith('.mjs'))
        .map((f) => [f, readFileSync(`${dir}/${f}`, 'utf8')]),
    );
  } catch {
    return null;
  }
}

/** The journey files in a checkout's real-app folder, or null when it can't be listed. */
export function checkoutJourneyFiles(root = '.') {
  try {
    return new Set(
      readdirSync(`${root}/apps/customer/tests/real-app`).filter((f) => JOURNEY_TEST.test(`apps/customer/tests/real-app/${f}`)),
    );
  } catch {
    return null;
  }
}

/**
 * Which changed service files, in a checkout of the head, can add a bus subscription (journey-reach-map.mjs
 * subscribesVia: they call the bus's subscribe, or a file of their service they import does; a removed file does not),
 * as reachSelect's `subscribes`.
 */
export async function subscribesIn(paths, root = '.') {
  const read = (p) => {
    const f = `${root}/${p}`;
    return existsSync(f) && statSync(f).isFile() ? readFileSync(f, 'utf8') : null;
  };
  const subs = new Set();
  for (const p of paths) if (p.startsWith('services/') && (await subscribesVia(p, read))) subs.add(p);
  return (p) => subs.has(p);
}

/**
 * What headWanted names, read from a checkout of the head (journey-reach-map.mjs readHead, loadersReach's `head`), with
 * `base()` (async): { mergeBase, atBase, compare }, the pull request's merge base, whether it holds a path, and GitHub's
 * compare. null when nothing is wanted; { } (read as unknown, full) when a read fails.
 */
export async function checkoutHead(map, paths, { root = '.', base }) {
  const want = headWanted(map, paths);
  if (!want) return null;
  try {
    return await readHead(map, want, {
      read: (p) => (existsSync(`${root}/${p}`) ? readFileSync(`${root}/${p}`, 'utf8') : null),
      list: (d) => readdirSync(`${root}/${d}`),
      ...(await base()),
    });
  } catch {
    return {};
  }
}

/** The pull request's merge base with its base branch, whether a path is on it, and GitHub's compare (gh), for
 *  checkoutHead. Throws when the merge base can't be told. */
async function mergeBaseReader() {
  const repo = process.env.GITHUB_REPOSITORY || 'INTAFACED/intafaced';
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const base = process.env.GITHUB_BASE_REF || 'main';
  const mb = JSON.parse(ghApi(`repos/${repo}/compare/${encodeURIComponent(base)}...${sha}?per_page=1`))?.merge_base_commit?.sha;
  if (!/^[0-9a-f]{40}$/.test(String(mb))) throw new Error('no merge base');
  const compare = async (a, b) => JSON.parse(ghApi(`repos/${repo}/compare/${a}...${b}`));
  const atBase = async (p) => {
    const res = await githubFetch(
      `https://api.github.com/repos/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${mb}`,
      {
        headers: {
          authorization: `Bearer ${githubToken()}`,
          accept: 'application/vnd.github.raw+json',
        },
      },
    );
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`contents: HTTP ${res.status}`);
    return true;
  };
  return { mergeBase: mb, atBase, compare };
}

/** How many of main's finished full runs came after the map's newest run, read with gh, or null. The same
 *  list the seal reads (journey-seal.mjs makeIo mainRuns: the newest 100, so a burst of cancelled runs can't hide the
 *  map's newest run and blank its age), so the two count the same age. */
function behindFromApi(map) {
  try {
    const repo = process.env.GITHUB_REPOSITORY || 'INTAFACED/intafaced';
    countCall();
    const out = execFileSync(
      'gh',
      ['api', `repos/${repo}/actions/workflows/real-app-journeys.yml/runs?branch=main&status=completed&per_page=100`],
      { encoding: 'utf8', maxBuffer: 64 * 2 ** 20, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return runsBehind(map, JSON.parse(out).workflow_runs, repo);
  } catch {
    return null;
  }
}

const ghApi = (path, encoding = 'utf8') => {
  countCall();
  return execFileSync('gh', ['api', path], { encoding, maxBuffer: 64 * 2 ** 20, stdio: ['ignore', 'pipe', 'ignore'] });
};

/**
 * When this journeys run reads main's touched-journeys map: the creation of the first pull request run of this workflow
 * on its head (this run's own, when it is the first), so a draft's run, its `ready_for_review` run and the seal
 * (journey-seal.mjs mapChosenAt) read one map build on one head; now when it can't be read (a run by hand). (Failure it
 * prevents: each run read the map at its own creation, so a map rebuilt between a draft's run and its ready run
 * widened the bounded set, and the ready run ran the extra journey files after the first run had finished: 18 to 25
 * more minutes on #9244, #9248 and #9251, 20 Nov 2026.)
 */
function mapTime() {
  try {
    const repo = process.env.GITHUB_REPOSITORY || 'INTAFACED/intafaced';
    const self = JSON.parse(ghApi(`repos/${repo}/actions/runs/${Number(process.env.GITHUB_RUN_ID)}`));
    const at = Date.parse(self.created_at);
    if (!process.env.GITHUB_RUN_ID || !Number.isFinite(at)) return Date.now();
    if (self.event !== 'pull_request' || !/^[0-9a-f]{40}$/.test(String(self.head_sha))) return at;
    try {
      return firstPullRunAt(pullRunsOnHead(repo, self.head_sha), self) ?? at;
    } catch {
      return at;
    }
  } catch {}
  return Date.now();
}

/** The creation time of the first of `runs` (this workflow's pull request runs on `self`'s head) and `self`, or null,
 *  as mapChosenAt reads the same runs. Pure. */
export function firstPullRunAt(runs, self, workflow = '.github/workflows/real-app-journeys.yml') {
  const made = [...(runs ?? []), self]
    .filter((r) => r?.event === 'pull_request' && r?.head_sha === self?.head_sha && (r?.path ?? workflow) === workflow)
    .map((r) => Date.parse(r?.created_at))
    .filter(Number.isFinite);
  return made.length ? Math.min(...made) : null;
}

/** --reuse: the pull request run's target after reusableRuns (env TARGET, HEAD_SHA, GITHUB_REPOSITORY, GH_TOKEN), as
 *  JSON { target, mode, why }. Any read that fails leaves the target as it was (never fewer journeys). */
function reuseMain() {
  const target = process.env.TARGET ?? '';
  const sha = process.env.HEAD_SHA ?? '';
  const repo = process.env.GITHUB_REPOSITORY || 'INTAFACED/intafaced';
  let out = { target, mode: 'run', why: '' };
  try {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('no head');
    const runs = JSON.parse(
      ghApi(`repos/${repo}/actions/workflows/real-app-journeys.yml/runs?head_sha=${sha}&event=workflow_dispatch&per_page=100`),
    ).workflow_runs;
    // A finished run counts only when a shard of it finished (reusableRuns); one jobs read per such run.
    const ranShards = new Set();
    for (const r of runs ?? [])
      if (
        r?.event === 'workflow_dispatch' &&
        r?.head_sha === sha &&
        r?.status === 'completed' &&
        DISPATCH_TITLE.test(String(r.display_title ?? ''))
      ) {
        const jobs = runJobsSync(`repos/${repo}/actions/runs/${Number(r.id)}/jobs`, (p) => JSON.parse(ghApi(p))) ?? [];
        if (jobs.some((j) => SHARD_JOB.test(String(j?.name)) && ['success', 'failure'].includes(j?.conclusion))) ranShards.add(r.id);
      }
    const journeyFiles = checkoutJourneyFiles();
    const reused = reusableRuns(runs, { sha, repo, journeyFiles, ranShards });
    // This pull request's earlier run on the same head (a draft's run, before `ready_for_review`; pullRunsCover). Any
    // read that fails leaves it out, so only the runs by hand count, as before.
    let how = 'by hand';
    try {
      const prRuns = pullRunsOnHead(repo, sha);
      const self = Number(process.env.GITHUB_RUN_ID);
      const named =
        process.env.NAMED_READ === '1'
          ? String(process.env.NAMED ?? '')
              .split(/\s+/)
              .filter(Boolean)
          : null;
      const pr = Number(process.env.PR_NUMBER);
      const picks = readPicks(repo, sha, prRuns, self);
      const cover = pullRunsCover(prRuns, { sha, repo, pr, self, picks, journeyFiles, named });
      if (cover.full) {
        console.log(
          JSON.stringify({
            target: '',
            mode: 'none',
            why: `run ${cover.full}, this pull request's own run on this exact head, already runs the full suite, so this run runs nothing`,
          }),
        );
        return;
      }
      for (const [f, id] of cover.files)
        if (!reused.has(f)) {
          reused.set(f, id);
          how = "by hand or by this pull request's earlier run";
        }
    } catch (e) {
      console.error(`this pull request's earlier runs on this head couldn't be read (${printable(e.message).slice(0, 200)})`);
    }
    out = afterReuse(target, reused, how);
  } catch (e) {
    out.why = `the runs by hand on this head couldn't be read (${printable(e.message).slice(0, 200)}), so nothing is left out`;
  }
  console.log(JSON.stringify(out));
}

/** This workflow's pull request runs on `sha` (GH_TOKEN). */
function pullRunsOnHead(repo, sha) {
  return (
    JSON.parse(ghApi(`repos/${repo}/actions/workflows/real-app-journeys.yml/runs?head_sha=${sha}&event=pull_request&per_page=100`))
      .workflow_runs ?? []
  );
}

/** Map(run id → kept pick) for this workflow's pull request runs on `sha` that could count (pullRunsCover's own filters
 *  come first, so no artifact is read for a run that can't). A pick that can't be read is left out. */
function readPicks(repo, sha, runs, self) {
  const picks = new Map();
  const dir = mkdtempSync(join(tmpdir(), 'pick-'));
  try {
    for (const r of runs) {
      if (r?.head_sha !== sha || !(Number(r.id) < self) || (r.status === 'completed' && ['cancelled', 'skipped'].includes(r.conclusion)))
        continue;
      try {
        const arts = JSON.parse(ghApi(`repos/${repo}/actions/runs/${Number(r.id)}/artifacts?name=${PICK_ARTIFACT}&per_page=20`)).artifacts;
        let touch = null;
        try {
          touch = touchStarted(runJobsSync(`repos/${repo}/actions/runs/${Number(r.id)}/jobs?filter=latest`, (p) => JSON.parse(ghApi(p))));
        } catch {}
        const art = currentPickArtifact(r, arts, touch);
        if (!art) continue;
        const zip = join(dir, `${Number(r.id)}.zip`);
        writeFileSync(zip, ghApi(`repos/${repo}/actions/artifacts/${Number(art.id)}/zip`, 'buffer'));
        picks.set(r.id, JSON.parse(execFileSync('unzip', ['-p', zip, PICK_FILE], { encoding: 'utf8' })));
      } catch {}
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return picks;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--reuse') return reuseMain();
  if (args[0] === '--dispatch') return console.log(dispatchTarget(process.env.JOURNEYS_TARGET, checkoutJourneyFiles()));
  // --fallback: the CANARY with every file of each of its journeys, for a pull request's run when its paths can't be
  // read or judged (real-app-journeys.yml's pick step): never the full suite.
  if (args[0] === '--fallback')
    return console.log(
      pullPick([], { mode: 'full', full: [], files: [] }, { named: null, reach: { journeyFiles: checkoutJourneyFiles() } }).files.join(' '),
    );
  let paths;
  let atHead = (p) => existsSync(p);
  const b = args.indexOf('--base');
  const f = args.indexOf('--files');
  const from = args.indexOf('--files-from');
  if (from >= 0 && args[from + 1]) {
    // One changed path a line (a pull request's files, from the API), judged against this checkout of its head: a
    // journey test file the head removed runs nothing.
    paths = readFileSync(args[from + 1], 'utf8')
      .split('\n')
      .filter(Boolean);
  } else if (b >= 0 && args[b + 1]) {
    paths = execFileSync('git', ['diff', '--name-only', '--no-renames', `${args[b + 1]}...HEAD`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } else if (f >= 0) {
    paths = args.slice(f + 1);
    atHead = () => true;
  } else {
    console.error('usage: journey-touch.mjs [--json] --base <ref> | --files <path>... | --files-from <file>');
    process.exit(2);
  }
  // --reach: product paths run only the journeys main's touched-journeys map says reach them, judged against this
  // checkout of the head. The map is the newest one main's map workflow built and verified before the head's first pull
  // request run was created (mapTime; journey-reach-map.mjs builtMap), or this file's own committed copy (the default branch's, in the journeys workflow)
  // when that one is newer or the build can't be read.
  const arg = (k) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : undefined);
  const ids = namedJourneyIds({
    title: arg('--title') ?? (args.includes('--reach') ? process.env.TITLE : ''),
    branch: arg('--branch') ?? (args.includes('--reach') ? process.env.GITHUB_HEAD_REF : ''),
  });
  let reach = null;
  if (args.includes('--reach')) {
    const repo = process.env.GITHUB_REPOSITORY || 'INTAFACED/intafaced';
    const built = await builtMap({
      get: (path) => JSON.parse(ghApi(path.replace(/^\//, ''))),
      raw: (path) => ghApi(path.replace(/^\//, ''), 'buffer'),
      before: mapTime(),
      repo,
    });
    const map = newerMap(built, loadMap());
    reach = {
      map,
      behind: behindFromApi(map),
      journeyFiles: checkoutJourneyFiles(),
      subscribes: await subscribesIn(paths),
      head: await checkoutHead(map, paths, { base: mergeBaseReader }),
    };
  }
  const texts = paths.some((p) => pathKind(p).stack) ? checkoutJourneyTexts() : null;
  const named = namedInputs({
    ids,
    journeyFiles: checkoutJourneyFiles(),
    importers: texts ? (stack) => stackImporters(stack, texts) : null,
  });
  // Tooling no journeys run reaches, by this checkout's tree (the pull request's head; tooling-reach.mjs), scanned only
  // when the change holds tooling no rule places. A scan that can't run or read leaves today's pick.
  let tooling = null;
  if (mayBeQuiet(paths))
    try {
      const { checkoutTree, reachOf } = await import('./tooling-reach.mjs');
      tooling = reachOf(checkoutTree(process.cwd()))?.journeys ?? null;
    } catch {}
  // What a pull request runs: never the full suite (pullPick).
  const t = pullPick(paths, journeyTouch(paths, atHead, reach, named, tooling), { atHead, reach, named });
  if (t.named && args.includes('--json')) console.error(`journey-touch: ${t.named}`);
  if (t.bounded && args.includes('--json')) console.error(`journey-touch: ${t.bounded}`);
  if (args.includes('--json')) return console.log(JSON.stringify(t));
  if (t.mode === 'files') {
    for (const l of t.reach ?? []) console.log(`  reach: ${l}`);
    if (t.named) console.log(`  named: ${t.named}`);
    if (t.bounded) console.log(`  bounded: ${t.bounded}`);
    for (const p of (t.mainJudges ?? []).slice(0, 20)) console.log(`  main's full run judges: ${printable(p)}`);
    let branch = '';
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {}
    for (const c of dispatchCommands(branch && branch !== 'HEAD' ? branch : '<branch>', t.files, 'INTAFACED/intafaced'))
      console.log(`files: ${c}`);
  } else console.log('none: no journeys run executes or reads what this change touches');
}

// Not awaited at the top level: main() imports tooling-reach.mjs, which imports this file, and that import would wait on
// this file's own evaluation, which would wait on main(), a cycle that never settles (node exits 13).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
