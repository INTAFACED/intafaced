#!/usr/bin/env node
/**
 * MERGE GATE: tests are the merge condition, enforced by script (Nitro's choice, 2026-10-13).
 *
 *   node tooling/scripts/merge-gate.mjs <pr> --head <full-sha> [--timeout-min 150] [--poll-sec 30] [--no-comment]
 *
 * It never merges. On PASS it posts a summary comment on the PR and prints the exact merge command; the caller runs
 * that command as its own step. On any failure it exits non-zero and prints why. Run it from a checkout of main, not from
 * the PR's branch: a PR that edits this file is a gate change (see gate-file-guard.mjs) and is flagged as one.
 *
 * WHAT "PASS" MEANS (a ratchet, not a green-main requirement)
 *
 *   1. The PR head is exactly --head, the PR is open, not a draft, and has no merge conflict.
 *   2. Every check on that head has FINISHED (bounded wait; nothing here can hang past --timeout-min).
 *   3. The required checks, Gitleaks and Dependency audit (both in workflow "PR checks"), ran and passed.
 *      Checks are identified by workflow AND name, so a same-named job in another workflow neither satisfies a required
 *      check nor gets excused by a job of that name on main.
 *   4. The PR adds no failing check that is not ALSO failing on main's latest completed push run of ci.yml that actually
 *      ran jobs (cancelled and superseded runs, 21 of the last 60 in the 2026-10-13 audit, are skipped).
 *   5. Inside a job that is already red on main the PR adds nothing new, at three levels:
 *        - STEPS: the failing step names of the PR job (from `gh run view --json jobs`) must be a subset of main's. This is
 *          what catches, say, "Every infrastructure-backed suite actually ran" going red on a PR when main's job failed
 *          only at "Run pnpm test --continue".
 *        - "Doctrine gates": the failing gate ids (the `✖ <id>` summary lines of the job log) must be a subset of main's.
 *        - "Tests (full)": the failing TESTS, per package, against a window of main's recent runs (below).
 *      If the failing ids cannot be read from a log, the failure counts as new.
 *      The PR test SHARDS ("Tests (protocol)", "(money)", "(trade)") run `pnpm --no-bail --filter ... test`, which prints no
 *      `Failed:` line, so there is nothing to compare: EVERY red shard blocks the PR, even while main's "Tests (full)" is
 *      red. ("Tests (pay-bank)" runs turbo but is treated the same way, on purpose, for one simple rule.)
 *
 *   6. The PR does not change gate files (tooling/ci, workflows, ...) unless its title says so (gate-file-guard.mjs).
 *
 * "TESTS (FULL)": A TEST-NAME RATCHET AGAINST A WINDOW OF MAIN (2026-10-14; replaces the package-level comparison)
 *
 *   Main's "Tests (full)" is flaky (timeouts under load, a shared anvil, about ten packages that come and go), so comparing
 *   packages with one single main run blocked every PR on whichever package happened to flake, while a NEW failing test
 *   inside an already-red package stayed invisible. Now:
 *     - The failing packages of a job are the tasks on the `Failed:    a#test, b#test` line (turbo).
 *     - What failed in a package is read as NAMES from vitest's summary: `FAIL  <file> > <suite> > <test>` is the name
 *       "<file> > <suite> > <test>"; `FAIL  <file> [ <file> ]` (a suite or hook that failed to load or run) is the file-level
 *       name "<file>"; each unhandled error ("Unhandled Error" / "Unhandled Rejection", also counted by the `Errors  N error`
 *       summary) is the name "(unhandled) <file>" when vitest says `This error originated in "<file>"`, else
 *       "(unhandled) <task>". Test names are compared exactly: the same file with another test name is a NEW failure.
 *     - Attribution. Turbo runs here with grouped log order, so FAIL lines carry NO package prefix: the log holds one block per
 *       package that starts with a header line `@intafaced/<pkg>:test` and ends at `##[endgroup]`. A line counts as a header
 *       only if its task is on the log's own `Failed:` line or it sits behind `##[group]`; anything else that merely looks
 *       like one (`Error:boom`) is ordinary text and does not switch the block. A per-line prefix
 *       (`@intafaced/<pkg>:test: ...`, turbo's stream mode) wins over the block. A FAIL line on the PR that has no package,
 *       belongs to a package that is not on the `Failed:` line, or cannot be read at all BLOCKS the PR ("belongs to no failing
 *       package"): the gate never ignores a failure it cannot place. On main's logs such lines only mean less is excused.
 *     - The window is the last MAIN_WINDOW (5) completed push runs of ci.yml on main in which "Tests (full)" actually ran
 *       (success, failure or timed_out; cancelled and skipped ones do not count). Their logs are fetched once per gate run
 *       and cached in a temp directory that is deleted afterwards.
 *     - A failing package of the PR is PRE-EXISTING only if (a) at least one name was read from the PR log, and (b) EVERY
 *       name of it also failed, in that same package, in at least one run of the window. Otherwise the PR is blocked and the
 *       verdict names the new tests. This holds inside packages that are red on main right now too.
 *     - A failing package with NO readable name (no FAIL line, no unhandled error: an exit code only) is excused only if that
 *       package is also on the `Failed:` line of main's LATEST run (the previous package-level behaviour), and the verdict
 *       says so. A new package with nothing readable blocks.
 *     - The verdict lists every excused name with the main run ids where it failed ("known flaky on main: <task> <name>
 *       (runs a, b)").
 *   The job-level rules above are unchanged: "Tests (full)" must still be red on main's latest run to be excused at all,
 *   and its failing steps must still be a subset of that run's.
 *
 * Known gaps that remain: a second finding in a doctrine gate that is already red (say "secrets") is invisible. The
 * ratchet sees only what vitest prints: a test that fails in a way vitest does not name (a runner that is not vitest, a crash)
 * is judged at package level only. A test whose name embeds something that changes every run (a timestamp, a random id) never
 * matches main and blocks. If main's latest "Tests (full)" run happens to be green, the job is not excused at all, flaky or not.
 *
 * Docs-only PRs run ci.yml. "Doctrine gates" is a required check, so a docs-only PR with no CI run does not pass.
 * Agent-rule files (AGENTS.md, CLAUDE.md, AGENT_PROTOCOL.md, SKILL.md, tooling/agent-protocol/**, .agents/**,
 * .cursor/rules/**) are never treated as an exception to that: ci.yml lists them, and ciWouldRun forces them on even if
 * the mirrored filter drifts. Test shards still skip docs and markdown via ci-affected.mjs.
 *
 * RUN IT FROM AN UP-TO-DATE origin/main CHECKOUT. A PR can edit this very file; the gate refuses to run unless
 * `git diff origin/main -- tooling/scripts tooling/ci` is empty (after fetching), so it is always main's copy that judges.
 * That is also the backstop for the one thing pr-checks.yml cannot stop: a PR editing the guard workflow itself.
 *
 * Exit codes: 0 pass, 1 gate failed (new failures, missing required check, undeclared gate change, conflict), 2 could not
 * decide (wrong head, timeout, bad arguments, no baseline), 3 GitHub refused with 403/429 (stop, never retried).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGateFileRule, RULE_TEXT } from './gate-file-guard.mjs';
import { GitHubRefusalError, ghJson, makeGh } from './gate-gh.mjs';

export const REPO = 'Phantom-X-007/intafaced';
export const MARKER = '<!-- merge-gate -->';

/**
 * Checks that must run and pass on every PR (branch protection requires the same two). Never excused by main.
 * Identified by workflow + name, which is the `workflow` and `name` that `gh pr checks --json` reports.
 */
export const REQUIRED = [
  { workflow: 'PR checks', name: 'Gitleaks' },
  { workflow: 'PR checks', name: 'Dependency audit' },
];

/** Identity of a check or job: "<workflow>/<job name>". */
export const keyOf = (c) => `${c.workflow ?? ''}/${c.name}`;
export const REQUIRED_KEYS = REQUIRED.map(keyOf);
export const CI_WORKFLOW_NAME = 'CI';
const ciKey = (name) => `${CI_WORKFLOW_NAME}/${name}`;

/**
 * PR-ONLY JOBS KNOWN TO BE RED, keyed "<workflow>/<job>". They never run on main, so the ratchet cannot compare them with
 * a main run. An entry is allowed to fail on a PR and is reported in the verdict. Every entry needs a reason and a way
 * out; delete the entry when the job is fixed. This list may only shrink: it is a gate file, so adding to it needs a `ci:`
 * title.
 */
export const KNOWN_PR_ONLY_RED = {
  // Has failed on every PR since 2026-08-24: the harness environment produces NaN. On the heal-main list.
  // Remove this entry when .github/workflows/order-path-cx8.yml is green on a clean PR.
  'Order-path CX-8/CX-8 assembled smoke': 'harness env NaN, red on every PR since 2026-08-24 (heal-main item)',
};

/**
 * Jobs whose failures are compared id by id inside the log, not only by name. `source` is the main job whose log is the
 * baseline. Test shards are deliberately absent: see the header (they print no ids, so a red shard always blocks).
 */
export const LOG_RATCHETS = {
  [ciKey('Doctrine gates')]: { source: ciKey('Doctrine gates'), parse: 'doctrine', what: 'doctrine gate' },
  [ciKey('Tests (full)')]: { source: ciKey('Tests (full)'), parse: 'turbo', what: 'test task' },
};

/**
 * Files whose change must run CI even though they are markdown.
 * ci.yml's `on.pull_request.paths` lists the same patterns after its markdown exclusion; merge-gate.test.mjs fails on drift.
 */
export const AGENT_RULE_PATTERNS = [
  '**/AGENTS.md',
  '**/CLAUDE.md',
  '**/AGENT_PROTOCOL.md',
  '**/SKILL.md',
  'tooling/agent-protocol/**',
  '.agents/**',
  '.cursor/rules/**',
];

/** Mirror of `on.pull_request.paths` in .github/workflows/ci.yml (merge-gate.test.mjs fails if they drift). */
export const CI_PR_PATHS = ['**', 'INTAFACED_DEFINITIVE_BUILD.md', ...AGENT_RULE_PATTERNS];

const FAIL_BUCKETS = new Set(['fail', 'cancel']);

/** How many of main's recent completed push runs (that ran "Tests (full)") the test-name ratchet looks back over. */
export const MAIN_WINDOW = 5;
/** The conclusions of a main job that count as "it ran" (a cancelled or skipped job proves nothing). */
const RAN = new Set(['success', 'failure', 'timed_out']);

export class GateError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

function pathGlob(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      re += '.*';
      i += 1;
    } else if (glob[i] === '*') re += '[^/]*';
    else re += glob[i].replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** GitHub path-filter semantics: patterns in order, the last one that matches decides; the workflow runs if any file is in. */
export function ciWouldRun(files, patterns = CI_PR_PATHS) {
  const agentRule = AGENT_RULE_PATTERNS.map(pathGlob);
  if (files.some((f) => agentRule.some((re) => re.test(f)))) return true; // never docs-only, whatever the mirror says
  const compiled = patterns.map((p) => ({ neg: p.startsWith('!'), re: pathGlob(p.replace(/^!/, '')) }));
  return files.some((f) => {
    let included = false;
    for (const p of compiled) if (p.re.test(f)) included = !p.neg;
    return included;
  });
}

/** One entry per workflow+name (a re-run leaves several): keep the latest by completedAt, a pending entry counts as latest. */
export function collapseChecks(checks) {
  const byName = new Map();
  for (const c of checks) {
    const prev = byName.get(keyOf(c));
    const stamp = (x) => (x.completedAt && !x.completedAt.startsWith('0001') ? Date.parse(x.completedAt) : Infinity);
    if (!prev || stamp(c) >= stamp(prev)) byName.set(keyOf(c), c);
  }
  return [...byName.values()];
}

/**
 * Pure verdict at the level of check names. Log-level refinement (refineWithLogs) runs after it.
 * @param {object} i
 * @param {Array<{name:string,workflow?:string,bucket:string,link?:string}>} i.checks collapsed checks of the PR head
 * @param {Set<string>|null} i.mainFailing keys ("workflow/name") failing on the compared main run (null: no baseline found)
 * @param {Set<string>} i.mainJobs keys of every job on the compared main run
 * @param {string[]} i.files changed files
 * @param {string} i.title PR title
 * @param {boolean} i.ciPresent a CI workflow run or check exists for this head
 */
export function evaluate({ checks, mainFailing, mainJobs = new Set(), files, title, ciPresent }) {
  const reasons = [];
  const byKey = new Map(checks.map((c) => [keyOf(c), c]));
  const required = {};
  for (const r of REQUIRED) {
    const c = byKey.get(keyOf(r));
    required[r.name] = c ? c.bucket : 'missing';
    if (!c) reasons.push(`required check "${r.name}" (workflow "${r.workflow}") never reported`);
    else if (c.bucket !== 'pass') reasons.push(`required check "${r.name}" is ${c.bucket}`);
  }

  const failing = checks.filter((c) => FAIL_BUCKETS.has(c.bucket) && !REQUIRED_KEYS.includes(keyOf(c)));
  const excusedOnMain = [];
  const knownRed = [];
  const newFailures = [];
  for (const c of failing) {
    const k = keyOf(c);
    // Excused only by the SAME job failing on main; refineWithLogs then compares steps and ids inside it.
    if (mainFailing?.has(k)) excusedOnMain.push(c);
    else if (k in KNOWN_PR_ONLY_RED && !mainJobs.has(k)) knownRed.push(c);
    else newFailures.push(c);
  }
  if (newFailures.length) {
    const why = mainFailing === null ? 'no main baseline could be found' : 'not failing on the main run compared';
    reasons.push(`new failing check(s), ${why}: ${newFailures.map((c) => c.name).join(', ')}`);
  }

  // What the verdict could not compare: jobs main ran that this PR skipped or did not run.
  const notCompared = [];
  for (const k of mainJobs) {
    const c = byKey.get(k);
    if (!c) notCompared.push(`${k.slice(k.indexOf('/') + 1)} (absent)`);
    else if (c.bucket === 'skipping' || c.bucket === 'cancel')
      notCompared.push(`${c.name} (${c.bucket === 'skipping' ? 'skipped' : 'cancelled'})`);
  }

  let docsOnly = false;
  if (!ciPresent) {
    if (ciWouldRun(files))
      reasons.push('CI never started although this PR changes paths that run it (code or agent-rule files), so its tests did not run');
    else docsOnly = true;
  }

  const gate = evaluateGateFileRule(title, files);
  if (!gate.ok) reasons.push(`changes gate files without saying so in the title: ${gate.gateFiles.map((g) => g.file).join(', ')}`);

  return {
    pass: reasons.length === 0,
    reasons,
    required,
    excusedOnMain,
    knownRed,
    newFailures,
    notCompared,
    docsOnly,
    gate,
    logChecks: [],
    flaky: [],
  };
}

/** Failing gate ids from a "Doctrine gates" job log: the `  ✖ <id>   123ms  doctrine` summary lines. */
export function parseDoctrineFailures(log) {
  const ids = new Set();
  for (const line of logLines(log)) {
    const m = /^\s*✖ (\S+)\s+\d+ms\b/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** Failing turbo tasks from a test job log: the `Failed:    a#test, b#test` line turbo prints. */
export function parseTurboFailures(log) {
  const ids = new Set();
  for (const line of logLines(log)) {
    const m = /^\s*Failed:\s+(.+?)\s*$/.exec(line);
    if (m) for (const t of m[1].split(/,\s*/)) if (t) ids.add(t);
  }
  return ids;
}

/** `gh run view --log` lines are "job<TAB>step<TAB>timestamp text". Strip the prefix and any colour codes. */
function* logLines(log) {
  for (const raw of String(log).split('\n')) {
    const parts = raw.split('\t');
    const text =
      parts.length >= 3
        ? parts
            .slice(2)
            .join('\t')
            .replace(/^\uFEFF/, '')
            .replace(/^\S+Z\s?/, '')
        : raw.replace(/^\uFEFF/, '');
    // Colour codes: a real ESC, or the caret form `^[[` that some log captures (and terminals' copy) leave behind.
    yield text.replace(/(?:\u001b|\^\[)\[[0-9;]*m/g, '').replace(/\r$/, '');
  }
}

/** A package block header in turbo's grouped log: `@intafaced/svc-ops:test` (optionally behind `##[group]`). */
const HEADER_RE = /^(##\[group\])?((?:@[\w.-]+\/)?[A-Za-z][\w.-]*):([A-Za-z][\w-]*)\s*$/;
/** Turbo's per-line prefix in stream mode: `@intafaced/svc-ops:test: <text>`. */
const PREFIX_RE = /^((?:@[\w.-]+\/)?[A-Za-z][\w.-]*):([a-z][\w-]*): (.*)$/;
/** vitest's summary line: ` FAIL  [|project| ]<file> > <suite> > <test>` or ` FAIL  <file> [ <file> ]` (suite/hook failure). */
const FAIL_RE = /^\s*FAIL\s+(?:\|[^|]*\|\s+)?(\S+\.[cm]?[jt]sx?)(?:\s+(>\s.*?|\[.*?))?\s*$/;
const ANY_FAIL_RE = /^\s*FAIL(\s|$)/;
/** One unhandled error of a vitest run: `Unhandled Error` / `Unhandled Rejection` heading (not the plural summary). */
const UNHANDLED_RE = /Unhandled (?:Error|Rejection)\s*(?:[^\w\s]|$)/;
const ORIGIN_RE = /This error originated in "([^"]+)"/;
const ERRORS_RE = /^\s*Errors\s+(\d+) errors?\b/;

/**
 * What failed in a test job log, per turbo task, as NAMES: Map<"@intafaced/svc-ops#test", Set<name>> where a name is
 *   - `<file> > <suite> > <test>`  for a failing test (vitest prints the whole path on its FAIL line),
 *   - `<file>`                     for a suite/hook that failed to load or run (`FAIL <file> [ <file> ]`): file-level,
 *   - `(unhandled) <file>`         for each unhandled error that vitest says originated in <file>, and
 *   - `(unhandled) <task>`         for an unhandled error with no file named (or more errors counted than described).
 * And `orphans`: every FAIL line that could not be given to a task on the `Failed:` line, or could not be read at all.
 *
 * Attribution (see the header): a package block starts at a header line `pkg:task` and ends at `##[endgroup]`. A header
 * counts only if its task is on the log's own `Failed:` line (`tasks`) or sits behind `##[group]`; any other line that merely
 * looks like one (`Error:boom`) is ordinary text and does NOT switch the block. A per-line prefix `pkg:task: ` wins.
 */
export function parseFailedTests(log, { tasks = parseTurboFailures(log) } = {}) {
  const byTask = new Map();
  const orphans = [];
  const add = (task, name) => {
    if (!byTask.has(task)) byTask.set(task, new Set());
    byTask.get(task).add(name);
  };
  let current = null;
  let pending = null; // an unhandled error being read: { task, file }
  let described = 0; // unhandled errors named in the current block
  const finish = () => {
    if (pending) {
      add(pending.task, pending.file ? `(unhandled) ${pending.file}` : `(unhandled) ${pending.task}`);
      described++;
    }
    pending = null;
  };
  const endBlock = () => {
    finish();
    current = null;
    described = 0;
  };
  for (const line of logLines(log)) {
    const trimmed = line.trim();
    if (trimmed === '##[endgroup]') {
      endBlock();
      continue;
    }
    const head = HEADER_RE.exec(line);
    if (head && (head[1] || tasks.has(`${head[2]}#${head[3]}`))) {
      endBlock();
      current = `${head[2]}#${head[3]}`;
      continue;
    }
    let task = current;
    let text = line;
    const pre = PREFIX_RE.exec(line);
    if (pre) {
      task = `${pre[1]}#${pre[2]}`;
      text = pre[3];
    }
    if (task && tasks.has(task)) {
      // unhandled errors (vitest: "Unhandled Errors" summary, then one "Unhandled Error|Rejection" section per error)
      if (/^\s*⎯/.test(text)) {
        finish();
        if (UNHANDLED_RE.test(text) && !/Unhandled Errors/.test(text)) pending = { task, file: null };
      } else if (pending) {
        const o = ORIGIN_RE.exec(text);
        if (o && !pending.file) pending.file = o[1];
      }
      const count = ERRORS_RE.exec(text);
      if (count) {
        finish();
        if (Number(count[1]) > described) add(task, `(unhandled) ${task}`);
      }
    }
    const m = FAIL_RE.exec(text);
    if (!m) {
      if (ANY_FAIL_RE.test(text)) orphans.push(text.trim());
      continue;
    }
    finish();
    if (!task || !tasks.has(task)) {
      orphans.push(text.trim());
      continue;
    }
    const rest = (m[2] ?? '').trim();
    add(task, rest.startsWith('>') ? `${m[1]} ${rest}`.replace(/\s+/g, ' ') : m[1]);
  }
  finish();
  return { byTask, orphans };
}

const PARSERS = { doctrine: parseDoctrineFailures, turbo: parseTurboFailures };
const jobIdOf = (c) => /\/job\/(\d+)/.exec(c.link ?? '')?.[1] ?? null;

const FAILED_STEP = new Set(['failure', 'timed_out']);
const failingSteps = (job) => new Set((job?.steps ?? []).filter((st) => FAILED_STEP.has(st.conclusion)).map((st) => st.name));
const runIdOf = (c) => /\/runs\/(\d+)\//.exec(c.link ?? '')?.[1] ?? null;

/**
 * For every check that name-level comparison excused because main fails the same job, look inside it:
 *   1. the failing STEP names of the PR job must be a subset of the main job's (and non-empty: a red job with no red step
 *      proves nothing);
 *   2. for the jobs in LOG_RATCHETS, the failing ids in the log (gate ids, turbo tasks) must be a subset of main's.
 * Anything new, or anything that cannot be read, turns the excuse into a new failure. Mutates and returns `ev`.
 */
export function refineWithLogs(ev, { gh, repo, main, logStore = makeLogStore(gh, repo) }) {
  if (!main || !ev.excusedOnMain.length) return ev;
  ev.flaky ??= [];
  const mainLogs = new Map();
  const prRuns = new Map();
  const readLog = logStore;
  const prJob = (c) => {
    const runId = runIdOf(c);
    const id = jobIdOf(c);
    if (!runId || !id) throw new Error('no run or job id in the check link');
    if (!prRuns.has(runId)) prRuns.set(runId, ghJson(gh, ['run', 'view', runId, '-R', repo, '--json', 'jobs']).jobs);
    const job = prRuns.get(runId).find((j) => String(j.databaseId) === id);
    if (!job) throw new Error(`job ${id} not found in run ${runId}`);
    return job;
  };
  const keep = [];
  for (const c of ev.excusedOnMain) {
    const k = keyOf(c);
    const ratchet = LOG_RATCHETS[k];
    let detail;
    try {
      const mainJob = main.byKey.get(k);
      if (!mainJob) throw new Error('the job is not on the main run');
      // 1. steps
      const prSteps = failingSteps(prJob(c));
      const mainSteps = failingSteps(mainJob);
      const newSteps = [...prSteps].filter((x) => !mainSteps.has(x)).sort();
      if (!prSteps.size) detail = 'no failing step is listed for this red job, so nothing proves it fails only where main does';
      else if (newSteps.length) detail = `new failing step(s) not failing on main: ${newSteps.join('; ')}`;
      else ev.logChecks.push(`${c.name}: failing step(s) ${[...prSteps].join('; ')} all also fail on main`);
      // 2. ids inside the log
      if (!detail && ratchet) {
        if (!mainLogs.has(ratchet.source)) mainLogs.set(ratchet.source, readLog(main.byKey.get(ratchet.source).databaseId));
        const prLog = readLog(jobIdOf(c));
        if (ratchet.parse === 'turbo') {
          detail = compareTests(ev, c, {
            gh,
            repo,
            main,
            readLog,
            prLog,
            mainLog: mainLogs.get(ratchet.source),
            source: ratchet.source,
          });
        } else {
          const parse = PARSERS[ratchet.parse];
          const prIds = parse(prLog);
          const mainIds = parse(mainLogs.get(ratchet.source));
          const added = [...prIds].filter((x) => !mainIds.has(x)).sort();
          if (!prIds.size) detail = `could not read the failing ${ratchet.what} ids from the log, so nothing proves they are all on main`;
          else if (added.length) detail = `new failing ${ratchet.what}(s) not failing on main: ${added.join(', ')}`;
          else ev.logChecks.push(`${c.name}: ${prIds.size} failing ${ratchet.what}(s), all also failing on main`);
        }
      }
    } catch (e) {
      if (e?.name === 'GitHubRefusalError') throw e;
      detail = `could not compare inside the job (${e.message})`;
    }
    if (detail) {
      ev.newFailures.push({ ...c, detail });
      ev.reasons.push(`${c.name}: ${detail}`);
    } else keep.push(c);
  }
  ev.excusedOnMain = keep;
  ev.pass = ev.reasons.length === 0;
  return ev;
}

/**
 * The test-name ratchet for "Tests (full)" (see the header). Returns a blocking detail string, or undefined when every
 * failing package of the PR is pre-existing; on success it appends to ev.flaky and ev.logChecks.
 */
function compareTests(ev, check, { gh, repo, main, readLog, prLog, mainLog, source }) {
  const prTasks = parseTurboFailures(prLog);
  if (!prTasks.size) return 'could not read the failing test task ids from the log, so nothing proves they are all on main';
  const pr = parseFailedTests(prLog, { tasks: prTasks });
  // A FAIL line that no package on the `Failed:` line owns could be anything: it blocks.
  if (pr.orphans.length)
    return `${pr.orphans.length} FAIL line(s) in the log belong to no failing package on the Failed: line, so their package cannot be compared: ${listCapped(pr.orphans, 5)}`;
  const mainLatestTasks = parseTurboFailures(mainLog);
  const window = loadMainWindow({ gh, repo, main, readLog, source });
  const blocked = [];
  const flaky = [];
  const unreadable = [];
  for (const task of [...prTasks].sort()) {
    const names = pr.byTask.get(task);
    if (names?.size) {
      const fresh = [];
      for (const name of [...names].sort()) {
        const runs = window.filter((w) => w.names.get(task)?.has(name)).map((w) => w.runId);
        if (runs.length) flaky.push({ task, name, runs });
        else fresh.push(name);
      }
      if (fresh.length)
        blocked.push(
          `${task}: ${fresh.length} new failing test(s) not failing on main in its last ${window.length} run(s): ${listCapped(fresh, 8)}`,
        );
    } else if (mainLatestTasks.has(task)) unreadable.push(task);
    else blocked.push(`${task}: no failing test could be read from the log, and the package is not failing on main's latest run`);
  }
  if (blocked.length) return blocked.join('; ');
  ev.flaky.push(...flaky);
  const runList = window.map((w) => w.runId).join(', ');
  ev.logChecks.push(
    `${check.name}: ${prTasks.size} failing package(s); all ${flaky.length} failing test(s) or suite(s) read from the log also failed on main in the last ${window.length} run(s) (${runList})`,
  );
  for (const task of unreadable)
    ev.logChecks.push(
      `${check.name}: ${task} has no readable FAIL line or unhandled error (exit code only); excused only because it also fails in main's latest run ${main.run.databaseId}`,
    );
  return undefined;
}

const listCapped = (items, n) => (items.length > n ? `${items.slice(0, n).join('; ')}; and ${items.length - n} more` : items.join('; '));

/**
 * The failing tests of the last MAIN_WINDOW main runs that ran `source`: [{ runId, names: Map<task, Set<name>> }], newest
 * first (names as in parseFailedTests). A run whose log cannot be read is skipped (a 403/429 is never skipped: it stops the gate).
 */
function loadMainWindow({ gh, repo, main, readLog, source }) {
  const name = source.slice(source.indexOf('/') + 1);
  const out = [];
  for (const { run, job } of selectMainWindow(gh, repo, { jobName: name, main })) {
    try {
      out.push({ runId: run.databaseId, names: parseFailedTests(readLog(job.databaseId)).byTask });
    } catch (e) {
      if (e?.name === 'GitHubRefusalError') throw e;
    }
  }
  if (!out.length) throw new Error('no log of a main "Tests (full)" run could be read for the window');
  return out;
}

/** `gh run view --job <id> --log`, kept once per gate run: in `dir` when given (deleted by the caller), else in memory. */
export function makeLogStore(gh, repo, dir) {
  const mem = new Map();
  return (id) => {
    const file = dir ? join(dir, `job-${id}.log`) : null;
    if (file && existsSync(file)) return readFileSync(file, 'utf8');
    if (!file && mem.has(id)) return mem.get(id);
    const text = gh(['run', 'view', '--job', String(id), '-R', repo, '--log']).stdout;
    if (file) writeFileSync(file, text);
    else mem.set(id, text);
    return text;
  };
}

const mainRunList = (gh, repo, cache) =>
  (cache.runs ??= ghJson(gh, [
    'run',
    'list',
    '-R',
    repo,
    '--branch',
    'main',
    '--workflow',
    'ci.yml',
    '--event',
    'push',
    '--status',
    'completed',
    '-L',
    '30',
    '--json',
    'databaseId,headSha,conclusion,createdAt,url',
  ]));
const mainRunJobs = (gh, repo, cache, run) => {
  if (!cache.jobs.has(run.databaseId))
    cache.jobs.set(run.databaseId, ghJson(gh, ['run', 'view', String(run.databaseId), '-R', repo, '--json', 'jobs']).jobs);
  return cache.jobs.get(run.databaseId);
};

/** The latest COMPLETED push run of ci.yml on main that really ran jobs. Cancelled and superseded runs are skipped. */
export async function selectMainRun(gh, repo, { maxCandidates = 12 } = {}) {
  const cache = { jobs: new Map() };
  let tried = 0;
  for (const run of mainRunList(gh, repo, cache)) {
    if (run.conclusion !== 'success' && run.conclusion !== 'failure') continue; // cancelled, skipped, neutral
    if (++tried > maxCandidates) break;
    const jobs = mainRunJobs(gh, repo, cache, run);
    if (!jobs.some((j) => j.conclusion === 'success' || j.conclusion === 'failure')) continue; // ran no jobs
    const keyed = jobs.map((j) => ({ ...j, workflow: CI_WORKFLOW_NAME }));
    return {
      run,
      jobs,
      cache,
      byKey: new Map(keyed.map((j) => [keyOf(j), j])),
      failing: new Set(keyed.filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out').map(keyOf)),
      names: new Set(keyed.map(keyOf)),
    };
  }
  return null;
}

/**
 * The last `k` completed push runs of ci.yml on main in which the job `jobName` actually ran (success, failure or timed_out),
 * newest first: [{ run, job }]. Looks at no more than `maxCandidates` runs; reuses what selectMainRun already fetched.
 */
export function selectMainWindow(gh, repo, { jobName = 'Tests (full)', main, k = MAIN_WINDOW, maxCandidates = 15 }) {
  const cache = main.cache;
  const out = [];
  let tried = 0;
  for (const run of mainRunList(gh, repo, cache)) {
    if (out.length >= k) break;
    if (run.conclusion !== 'success' && run.conclusion !== 'failure') continue; // cancelled, skipped, neutral
    if (++tried > maxCandidates) break;
    const job = mainRunJobs(gh, repo, cache, run).find((j) => j.name === jobName && RAN.has(j.conclusion));
    if (job) out.push({ run, job });
  }
  return out;
}

export function mergeCommand(pr, head, repo = REPO) {
  return `gh pr merge ${pr} --match-head-commit ${head} -R ${repo} --squash`;
}

const link = (c) => (c.link ? `[${c.name}](${c.link})` : c.name);

export function renderComment({ verdict, head, pr, main, checks, evalResult }) {
  const e = evalResult;
  const L = [`${MARKER}`, `**Merge gate: ${verdict}** for head \`${head.slice(0, 10)}\``, ''];
  L.push(`- **Required checks:** ${REQUIRED.map((r) => `${r.name} ${e.required[r.name]}`).join(', ')}.`);
  L.push(`- **Checks reported:** ${checks.length}.`);
  if (e.docsOnly) {
    const reported = checks.map((c) => c.name).join(', ') || 'none';
    L.push(
      verdict === 'PASS'
        ? `- **Docs-only PR:** CI is skipped by its path filter, so no tests ran. Passed on the checks that did report (${reported}); a failing one would have blocked it.`
        : `- **Docs-only PR:** CI is skipped by its path filter, so no tests ran. Checks that reported: ${reported}. See why it is blocked below.`,
    );
  }
  if (main) {
    L.push(
      `- **Compared against:** main CI push run [${main.run.databaseId}](${main.run.url}) at \`${main.run.headSha.slice(0, 10)}\` (${main.run.conclusion}).`,
    );
  } else if (!e.docsOnly) {
    L.push('- **Compared against:** no usable main run found.');
  }
  if (e.excusedOnMain.length)
    L.push(
      `- **Failing here and also failing on main (pre-existing red, not added by this PR):** ${e.excusedOnMain.map(link).join(', ')}.`,
    );
  for (const l of e.logChecks) L.push(`- **Log comparison:** ${l}.`);
  if (e.flaky?.length) {
    L.push('- **Excused as known flaky on main (each failed in the same package in a recent main run):**');
    for (const f of e.flaky) L.push(`  - known flaky on main: ${f.task} ${f.name} (runs ${f.runs.join(', ')})`);
  }
  if (e.knownRed.length) {
    L.push(`- **Known PR-only red, allowed:** ${e.knownRed.map((c) => `${link(c)} (${KNOWN_PR_ONLY_RED[keyOf(c)]})`).join('; ')}.`);
  }
  if (e.newFailures.length)
    L.push(`- **NEW failures (not on main):** ${e.newFailures.map((c) => `${link(c)}${c.detail ? ` (${c.detail})` : ''}`).join('; ')}.`);
  if (e.notCompared.length)
    L.push(`- **Not compared (main ran these; they were skipped or absent on this PR):** ${e.notCompared.join(', ')}.`);
  if (e.gate.gateFiles.length) {
    L.push(
      `- **Gate files changed:** ${e.gate.gateFiles.map((g) => `\`${g.file}\``).join(', ')}${e.gate.declared ? ' (declared in the title)' : ' (NOT declared)'}.`,
    );
  }
  if (e.reasons.length) L.push('', 'Blocked because:', ...e.reasons.map((r) => `- ${r}`));
  if (verdict === 'PASS') L.push('', `Merge command: \`${mergeCommand(pr, head)}\``);
  return L.join('\n') + '\n';
}

function parseArgs(argv) {
  const o = { repo: REPO, timeoutMin: 150, pollSec: 30, comment: true, ciGraceSec: 300 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--head') o.head = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--timeout-min') o.timeoutMin = Number(argv[++i]);
    else if (a === '--poll-sec') o.pollSec = Number(argv[++i]);
    else if (a === '--ci-grace-sec') o.ciGraceSec = Number(argv[++i]);
    else if (a === '--no-comment') o.comment = false;
    else if (a.startsWith('--')) throw new GateError(`unknown argument: ${a}`);
    else rest.push(a);
  }
  if (rest.length !== 1 || !/^\d+$/.test(rest[0])) throw new GateError('usage: merge-gate.mjs <pr-number> --head <full-sha>');
  if (!/^[0-9a-f]{40}$/.test(o.head ?? '')) throw new GateError('--head must be the full 40-character commit sha you reviewed');
  for (const k of ['timeoutMin', 'pollSec', 'ciGraceSec']) if (!(o[k] > 0)) throw new GateError(`${k} must be a positive number`);
  o.pr = Number(rest[0]);
  return o;
}

/**
 * The whole gate, with every side effect injected so tests drive it with fixtures.
 * @returns {Promise<{code:number, verdict:string, evalResult?:object, comment?:string, mergeCommand?:string}>}
 */
export async function runGate(o, { gh, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const { pr, head, repo } = o;
  const viewPr = () =>
    ghJson(gh, ['pr', 'view', String(pr), '-R', repo, '--json', 'number,state,isDraft,headRefOid,baseRefName,title,mergeable,url']);
  const first = viewPr();
  if (first.headRefOid !== head)
    throw new GateError(`PR #${pr} head is ${first.headRefOid}, not the reviewed ${head}. Nothing was checked.`);
  if (first.state !== 'OPEN') throw new GateError(`PR #${pr} is ${first.state}, not OPEN.`);
  if (first.baseRefName !== 'main') throw new GateError(`PR #${pr} targets ${first.baseRefName}, not main.`);
  if (first.isDraft) throw new GateError(`PR #${pr} is a draft.`);
  const title = first.title;

  const files = gh(['api', '--paginate', `repos/${repo}/pulls/${pr}/files`, '--jq', '.[].filename'])
    .stdout.split('\n')
    .filter(Boolean);
  if (!files.length) throw new GateError(`PR #${pr} lists no changed files.`);

  const start = now();
  const deadline = start + o.timeoutMin * 60_000;
  let stable = 0;
  let ciAbsentSince = null;
  let settled;
  for (;;) {
    const cur = viewPr();
    if (cur.headRefOid !== head)
      throw new GateError(`PR #${pr} head moved to ${cur.headRefOid} while waiting. Re-review and run the gate again.`);
    if (cur.state !== 'OPEN') throw new GateError(`PR #${pr} is ${cur.state}.`);

    const r = gh(['pr', 'checks', String(pr), '-R', repo, '--json', 'name,state,bucket,workflow,link,completedAt'], { allowFail: true });
    let rawChecks = [];
    if (r.stdout.trim()) rawChecks = JSON.parse(r.stdout);
    else if (!/no checks reported/i.test(r.stderr))
      throw new GateError(`gh pr checks returned nothing (${r.status}): ${r.stderr.trim().slice(0, 300)}`);
    const checks = collapseChecks(rawChecks);
    const runs = ghJson(gh, [
      'run',
      'list',
      '-R',
      repo,
      '--commit',
      head,
      '-L',
      '50',
      '--json',
      'databaseId,workflowName,status,conclusion',
    ]);

    const pending = checks.filter((c) => c.bucket === 'pending').map((c) => c.name);
    const active = runs.filter((x) => x.status !== 'completed').map((x) => x.workflowName);
    const missingRequired = REQUIRED.filter((r) => !checks.some((c) => keyOf(c) === keyOf(r))).map((r) => r.name);
    const ciPresent = checks.some((c) => c.workflow === CI_WORKFLOW_NAME) || runs.some((x) => x.workflowName === CI_WORKFLOW_NAME);

    let done = !pending.length && !active.length && !missingRequired.length;
    if (done && !ciPresent && ciWouldRun(files)) {
      // CI should exist but has not appeared yet. Give it a grace period, then judge (the verdict will say CI never started).
      ciAbsentSince ??= now();
      if (now() - ciAbsentSince < o.ciGraceSec * 1000) done = false;
    }
    const requiredOverdue = missingRequired.length && now() - start > o.ciGraceSec * 1000;
    stable = done ? stable + 1 : 0;
    if (stable >= 2 || requiredOverdue) {
      settled = { checks, ciPresent, mergeable: cur.mergeable };
      break;
    }
    if (now() > deadline) {
      throw new GateError(
        `checks not finished after ${o.timeoutMin} min. Still pending: ${[...pending, ...active].join(', ') || missingRequired.join(', ') || '(nothing listed)'}`,
      );
    }
    log(
      `waiting: ${pending.length} pending check(s), ${active.length} active run(s), missing required: ${missingRequired.join(', ') || 'none'}`,
    );
    await sleep(o.pollSec * 1000);
  }

  const failingNames = settled.checks.filter((c) => FAIL_BUCKETS.has(c.bucket) && !REQUIRED_KEYS.includes(keyOf(c)));
  let main = null;
  if (settled.ciPresent) {
    main = await selectMainRun(gh, repo);
    if (!main && failingNames.length)
      throw new GateError('no completed main push run of ci.yml with jobs was found, so there is no baseline to compare failures against.');
  }

  const evalResult = evaluate({
    checks: settled.checks,
    mainFailing: main ? main.failing : settled.ciPresent ? null : new Set(),
    mainJobs: main ? main.names : new Set(),
    files,
    title,
    ciPresent: settled.ciPresent,
  });
  const logDir = mkdtempSync(join(tmpdir(), 'merge-gate-logs-'));
  try {
    refineWithLogs(evalResult, { gh, repo, main, logStore: makeLogStore(gh, repo, logDir) });
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
  if (settled.mergeable === 'CONFLICTING') {
    evalResult.reasons.push('PR has merge conflicts with main');
    evalResult.pass = false;
  }
  const verdict = evalResult.pass ? 'PASS' : 'FAIL';
  let comment = renderComment({ verdict, head, pr, main, checks: settled.checks, evalResult });
  if (evalResult.gate.gateFiles.length && evalResult.gate.declared && evalResult.pass) {
    comment += `\nThis PR changes gate files. Run this gate from a checkout of main, not from this branch. Rule: ${RULE_TEXT}\n`;
  }
  if (o.comment) gh(['pr', 'comment', String(pr), '-R', repo, '--body-file', '-'], { input: comment });
  return {
    code: evalResult.pass ? 0 : 1,
    verdict,
    evalResult,
    comment,
    mergeCommand: evalResult.pass ? mergeCommand(pr, head, repo) : undefined,
  };
}

/**
 * The gate must be main's copy: a PR can edit this file. Returns a problem string, or null when tooling/scripts and
 * tooling/ci match origin/main exactly (after a fetch). `git` is injected for tests.
 */
export function mainCopyProblem(git) {
  const fetched = git(['fetch', '-q', 'origin', 'main']);
  if (fetched.status !== 0)
    return `could not fetch origin/main (${fetched.stderr.trim().slice(0, 200)}), so the gate cannot prove it is main's copy`;
  const d = git(['diff', '--quiet', 'origin/main', '--', 'tooling/scripts', 'tooling/ci']);
  if (d.status === 0) return null;
  if (d.status === 1) {
    return 'tooling/scripts or tooling/ci differ from origin/main in this checkout. Run the gate from an up-to-date origin/main checkout (not the PR branch), because a PR can edit the gate that judges it.';
  }
  return `git diff against origin/main failed (${d.stderr.trim().slice(0, 200)})`;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const git = (args) => {
      const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 120_000 });
      return { status: r.status ?? 2, stderr: String(r.stderr ?? '') };
    };
    const problem = mainCopyProblem(git);
    if (problem) throw new GateError(problem);
    const result = await runGate(o, { gh: makeGh(), log: (m) => console.error(`merge-gate: ${m}`) });
    console.log(result.comment.replace(MARKER, '').trim());
    if (result.mergeCommand) console.log(`\nMERGE COMMAND (run it yourself, as its own step):\n${result.mergeCommand}`);
    else console.error('\nmerge-gate: FAIL. Do not merge.');
    return result.code;
  } catch (e) {
    console.error(`merge-gate: ${e.message}`);
    if (e instanceof GitHubRefusalError) return 3;
    return e instanceof GateError ? e.code : 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}
