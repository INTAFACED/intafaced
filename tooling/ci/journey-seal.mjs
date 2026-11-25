#!/usr/bin/env node
/**
 * Merge-seal step: a pull request whose title names journey steps (`J-bank-13 #1 #2`, `J-ops-console-22 #1–#5`) is
 * sealed only when, for each named step, a finished Real-app journeys run (real-app-journeys.yml) on the pull request's
 * exact head shows it passing, or the body exempts it on a `Left-or-replaced:` line. A pull request whose title
 * names no step is unaffected. (Failure it prevents: #7202, the J-bank-13 trial, merged although its own branch run
 * 42162035136 on its exact head had failed all seven steps it named, because Real-app journeys is not a required check
 * and the seal never looked at the pull request's own steps; project-state research/trial-2026-11-06/J-bank-13-SCORE.md.
 * Owner decision 2026-11-06: "done" already means a journey's steps green in the running app on the PR's exact head.)
 *
 * What counts (judgeSteps), read from the Actions API, never from a comment or the pull request body's own claims:
 *   - runs of exactly JOURNEYS_WORKFLOW, from this repository, whose head is this exact sha (a run on an older head of the
 *     same branch counts for nothing, however green);
 *   - any such run not finished yet (a first attempt or a re-run) when the seal runs holds it: it fails then and is re-run
 *     when the run finishes (its last job, START_JOB, starts the seal). A run dispatched after a green seal does not turn it red until it
 *     finishes, so a merge in between rests on the finished run that sealed it. On a merge queue's commit nothing waits:
 *     only finished runs are read;
 *   - cancelled and skipped runs say nothing and are passed over, and so does a finished run that started no job
 *     (startedNoJob, read from the run's jobs list), each named on one line;
 *   - per step, the newest finished run (by its current attempt's start) whose merged report lists the step decides:
 *     passed is green; failed or skipped is red. A newer run that failed a step outranks an older pass, and an older run
 *     or an earlier attempt that failed it outranks a newer pass: a step that fails then passes on one commit is flaky
 *     and never counts as passing (project-state AGENTS.md "How work flows" 4; flakyWay). (Failure it prevents: #9827
 *     merged on 822aec16bd although run 45030979813 there failed J-cex-spot-21 #4, because run 45031001317, started 14
 *     seconds later on the same head, passed it and only the newest run was read; the step went flaky on main about 90
 *     minutes later, #9893. An earlier attempt counts too, so a re-run that passes, the first thing AGENTS.md "How work
 *     flows" 8 says to try on a red, can't hide a failed step the same way.);
 *   - a run's report is the `real-app-journeys` artifact uploaded during its current attempt (created at or after the
 *     attempt started), so a re-run's verdict is never read from an earlier attempt's report; an earlier attempt's report
 *     (earlierReportArtifacts) counts only for a step it failed. A finished run with no such report, or one that can't
 *     be read, is red for every step it could have decided (fail closed), whichever run is newer;
 *   - a step no finished run on the head reports is not green.
 * The exemption is one strict machine line, not Markdown: `Left-or-replaced: J-bank-13 #1 #3` (exemptions), at column 0,
 * outside any fenced code block and any HTML comment, holding only full step ids. Anything else that looks like one (a
 * line with `left-or-replaced:` in any case, indented, inside a list, or with anything but step ids after it) fails the
 * seal closed and is named. (Rounds 1 and 2 of the Codex read showed hand-parsed Markdown headings kept leaking: a setext
 * heading, an indented line, a fence inside a list. A `## Left or replaced` heading is prose and exempts nothing.)
 *
 * The title and body are read from the API at seal time, not from the event, so a re-run reads an edited title.
 * The last job of each seal input (START_JOB) re-runs the seal when its run on a pull request's head finishes, and
 * merge-seal.yml runs again on an edit. On a merge queue's commit every queued pull request is judged on its own head the
 * same way, without waiting.
 *
 * Every pull request is also held to the journeys its own run was given (journey-touch.mjs journeyTouch and pullPick,
 * from its changed paths), never to the full suite: its changed journey files, the journeys its title or branch names
 * (namedSealInputs, theo-01 part 1, OWNER 296), the journeys the touched-journeys map records reaching its product paths
 * and the map's always-run list, and the journeys that use a stack file it changes (theo-01 part 2); a change the map
 * can't narrow (shared setup, a script, the workflow, a path no rule places) or a pick past PR_MAX_FILES runs the
 * bounded set (its changed and named journeys, the always-run list and the CANARY). Each must be run on its exact head
 * and clean by the journeys verdict (judgeTouchedRun); a pull request touching nothing a journeys run executes or reads
 * needs no run. Main's full run after the merge judges the rest and a red main is reverted (OWNER 249 (3): "a PR runs
 * only the journeys it touches, the full suite runs on main after a merge"). (Until 20 Nov 2026 shared setup and every
 * path the map couldn't narrow needed a clean full run here: 174 of 233 merged pull requests in 48 hours, about 1,400
 * runner-minutes each, and no such run on record catching a break outside its change's reach in the 7 days before.)
 *
 * A red step a pull request's run inherited from main stops only a pull request in its area (splitInherited; owner
 * decision 180, "only the broken area stops"): inherited means main's newest finished full run that the head contains is
 * red on that step too, by the same verdict; its area is its journey (a test file of it, a step of it in the title or on
 * a Left-or-replaced line) and the packages the commits since it last passed on main changed. A red new on the head
 * always stops it, and a red that can't be bounded (no such main run, an unreadable input, a break range that can't be
 * read or is wider than RANGE_MAX commits) stops every pull request it reaches. (Failure it prevents: a red main
 * blocked every product pull request, so on 8 Nov 2026 20 of 29 ready pull requests sat BLOCKED; project-state
 * research/factory-2026-11-08 R3 C1.) Fixing or reverting a main red within 2 hours stays the owners' job.
 *
 *   REPO=owner/name HEAD_SHA=... PR_NUMBER=... node tooling/ci/journey-seal.mjs
 *   REPO=... MERGE_GROUP_BASE_SHA=... MERGE_GROUP_HEAD_SHA=... MERGE_GROUP_HEAD_REF=... node tooling/ci/journey-seal.mjs
 *   REPO=... node tooling/ci/journey-seal.mjs --dry-run <pr> [<sha>] [--main <sha>]   (any pull request, closed too; read only)
 *   REPO=... SHA=... [PR_NUMBER=...] [OLD_TITLE=...] [OLD_BODY=...] node tooling/ci/journey-seal.mjs --recheck   (re-runs the seal)
 * CI sets GH_TOKEN; run by hand, it reads through the logged-in gh (github-fetch.mjs).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { githubFetch, githubToken } from './github-fetch.mjs';
import { runJobs } from './run-jobs.mjs';
import {
  BASELINE_PATH,
  JOURNEYS_ARTIFACT,
  fetchInputs,
  isMainRun,
  judge,
  manifestsAt,
  moneyRule,
  readReport,
  rootInputs,
} from './journey-verdict.mjs';
import {
  DISPATCH_GROUP_MAX,
  RUN_FILE,
  dispatchCommands,
  journeyTouch,
  mayBeQuiet,
  namedInputs,
  namedJourneyIds,
  pathKind,
  printable,
  pullPick,
  stackImporters,
} from './journey-touch.mjs';
import { subscribesVia, builtMap, headWanted, loadMap, newerMap, readHead, runsBehind } from './journey-reach-map.mjs';
import { groupPulls, isJudgeDown, mergedNothingToSeal, requiredChecks, reviewRan } from './review-marker.mjs';
import { DEFER_MARK, TOUCH_JOB } from './main-first.mjs';
import { httpMessage, titleFor } from './api-budget.mjs';
import { redRunOf, spentWhy } from './journeys-revert.mjs';

export const JOURNEYS_WORKFLOW = '.github/workflows/real-app-journeys.yml';
const SHA40 = /^[0-9a-f]{40}$/;
/**
 * A journey id, then one or more `#n` or `#a–#b`, with or without a space before the first (`J-bank-13#1` is how the
 * report keys a step), separated by spaces, commas, `and`, `&` or `/`. A number of three digits or more is an issue or
 * pull request (`J-wallet-05 #2, #6650`), never a step: no journey comes near 100 steps (the longest has 12). A range
 * with such a number (`#1-#100`) can't be read as steps, and titleProblems names it so the seal fails closed.
 */
const STEP_RUN = /\b(J-[a-z0-9]+(?:-[a-z0-9]+)*-\d+)((?:(?:\s*(?:,|&|\/|\band\b)\s*|\s*)#\d+(?:\s*(?:[-–—]|\bto\b)\s*#?\d+)?)+)/gi;
const NUMBER = /#(\d+)(?:\s*(?:[-–—]|\bto\b)\s*#?(\d+))?/gi;
const STEP_MAX = 99;
/** The exemption line, exactly: column 0, this case, a colon, then step ids only. */
const EXEMPT_LINE = /^Left-or-replaced:(.*)$/;
/** Anything that looks like an exemption line, wherever it sits and however it is written. */
const LOOKS_EXEMPT = /left[ \t]*-[ \t]*or[ \t]*-[ \t]*replaced[ \t]*:/i;
const byStep = (a, b) => a.localeCompare(b, 'en', { numeric: true });

/** Step keys (`J-bank-13#1`, as readReport keys them) named in a piece of text. Journey ids are read in lower case. */
export function stepsIn(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(STEP_RUN)) {
    const id = m[1].toLowerCase().replace(/^j-/, 'J-');
    for (const n of m[2].matchAll(NUMBER)) {
      const a = Number(n[1]);
      const b = n[2] === undefined ? a : Number(n[2]);
      if (a > STEP_MAX || b > STEP_MAX) continue;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) out.add(`${id}#${i}`);
    }
  }
  return [...out].sort(byStep);
}

/**
 * A title GitHub's Revert button makes, `Revert "<old title>"`: it undoes those steps and names none of its own, so it
 * is judged as naming none and seals without a run (the floor: a break is fixed or undone fast). Only the whole title in
 * that form: `Revert "` at the start, the quote closed as its last character, nothing after it. A title with more after
 * the closing quote, or an unclosed one, is read as usual, so one that reverts and also builds a step needs its run.
 */
const REVERT_TITLE = /^Revert ".+"$/s;
const isRevert = (title) => REVERT_TITLE.test(String(title ?? '').trim());

const JOURNEY_ID = /\bJ-[a-z0-9]+(?:-[a-z0-9]+)*-\d+\b/gi;

/**
 * Step numbers a title writes away from its journey id, after the journey's words (`J-cex-spot-14 a trader … (#1 #5)`):
 * what is left of the title once every `J-x-NN #a #b` run is taken out, read with the same number rules (three digits or
 * more is a pull request, `(#7738)`, never a step). Builders wrote steps this way and the seal, the journeys run and the
 * step read all missed them (#7599 on 9 Nov, R0-5 on 10 Nov), so the run tested nothing the title claimed.
 */
function strayNumbers(title) {
  const rest = String(title ?? '').replace(STEP_RUN, ' ');
  return [...rest.matchAll(NUMBER)].map((n) => ({ text: n[0], a: Number(n[1]), b: n[2] === undefined ? Number(n[1]) : Number(n[2]) }));
}
const journeyIds = (title) => [
  ...new Set([...String(title ?? '').matchAll(JOURNEY_ID)].map((m) => m[0].toLowerCase().replace(/^j-/, 'J-'))),
];

/**
 * The steps a pull request title names: each `J-x-NN #a #b` run, and, when the title names exactly one journey, the step
 * numbers it writes after that journey's words. With two or more journeys, such numbers can't be placed, and
 * titleProblems names them so the seal fails closed.
 */
export function titleSteps(title) {
  if (isRevert(title)) return [];
  const out = new Set(stepsIn(title));
  const ids = journeyIds(title);
  if (ids.length === 1)
    for (const { a, b } of strayNumbers(title)) {
      if (a > STEP_MAX || b > STEP_MAX) continue;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) out.add(`${ids[0]}#${i}`);
    }
  return [...out].sort(byStep);
}

/**
 * What in a title can't be read as steps, each failing the seal closed: a step range with an end past STEP_MAX, and step
 * numbers written after the journeys' words when the title names two or more journeys (write each journey's steps right
 * after its id: `J-a-01 #1 #2, J-b-02 #3`).
 */
export function titleProblems(title) {
  const out = [];
  if (isRevert(title)) return out;
  for (const m of String(title ?? '').matchAll(STEP_RUN))
    for (const n of m[2].matchAll(NUMBER))
      if (n[2] !== undefined && (Number(n[1]) > STEP_MAX || Number(n[2]) > STEP_MAX)) out.push(`${m[1]} ${n[0]}`.replace(/\s+/g, ' '));
  const strays = strayNumbers(title).filter(({ a, b }) => a <= STEP_MAX && b <= STEP_MAX);
  if (strays.length && journeyIds(title).length > 1)
    out.push(
      `${strays.map((n) => n.text.replace(/\s+/g, ' ')).join(' ')}: step numbers after the words of a title that names more than one journey; write each journey's steps right after its id`,
    );
  for (const { a, b, text } of strayNumbers(title))
    if (journeyIds(title).length === 1 && a <= STEP_MAX !== b <= STEP_MAX) out.push(`${journeyIds(title)[0]} ${text}`.replace(/\s+/g, ' '));
  return out;
}

/**
 * A pull request body's lines that are neither inside a fenced code block nor inside an HTML comment, as written (not
 * trimmed). One fence tracker over the raw lines (a fence opens at any indent, so one inside a list counts); HTML comments
 * are blanked first. The strict body lines (`Left-or-replaced:` here, `Journey-retired:` in journey-list-guard.mjs) are
 * read only from these, so a line in code or hidden in a comment never counts.
 */
export function linesOutsideCode(body) {
  const out = [];
  let fence = null;
  for (const line of String(body ?? '')
    .replace(/\r/g, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, (c) => c.replace(/[^\n]/g, ''))
    .split('\n')) {
    const f = /^(`{3,}|~{3,})(.*)$/.exec(line.trimStart());
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      continue;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = f[1];
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * The steps a body exempts, and the exemption-like lines it can't accept: { steps: Set, problems: [line] }. One fence
 * tracker over the raw lines (a fence opens at any indent, so one inside a list counts) and HTML comments stripped; a
 * line inside either is code or hidden and exempts nothing. Outside them, a `Left-or-replaced:` line at column 0 whose
 * rest is only full step ids (`J-bank-13 #1 #3, J-bank-14 #2`) exempts those steps; every other line that looks like an
 * exemption is a problem, printed as a note and never a red, as is an exemption line with more after the colon or a bad range.
 */
export function exemptions(body) {
  const steps = new Set();
  const problems = [];
  for (const line of linesOutsideCode(body)) {
    if (!LOOKS_EXEMPT.test(line)) continue;
    const m = EXEMPT_LINE.exec(line);
    const rest = m ? m[1] : '';
    const named = m ? stepsIn(rest) : [];
    const leftover = rest.replace(STEP_RUN, '').replace(/[\s,;]+/g, '');
    if (!m || named.length === 0 || leftover || titleProblems(rest).length) {
      problems.push(line.trim());
      continue;
    }
    for (const k of named) steps.add(k);
  }
  return { steps, problems };
}

/**
 * The exact body line that exempts `keys` (`J-bank-13#2`, …): `Left-or-replaced: J-bank-13 #2 #3, J-bank-14 #2`, journeys
 * in order. A failing seal prints it for its steps that are not green, so a builder copies it rather than guessing the
 * format (AGENTS.md "How work flows" 6 and docs/agents/build-slice.md name it); exemptions() reads it back to the same keys.
 */
export function exemptionLine(keys) {
  const by = new Map();
  for (const k of [...keys].sort(byStep)) {
    const [id, n] = k.split('#');
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(`#${n}`);
  }
  return `Left-or-replaced: ${[...by].map(([id, ns]) => `${id} ${ns.join(' ')}`).join(', ')}`;
}
const notes = (left) => left.problems.map((l) => `note: "${l.slice(0, 80)}" exempts nothing; only step ids at a line's start do`);
const leaveLine = (keys) =>
  `to leave these steps instead, add this line to the body, at the start of a line and outside code: ${exemptionLine(keys)}`;

/**
 * The way forward for a step that failed in one run or attempt on a head and passed in another: it is flaky, and a
 * flaky step never counts as passing (project-state AGENTS.md "How work flows" 4: "A step that fails then passes on one
 * commit opens a flaky item; it stops only its own journeys and never counts as passing"). So a re-run that passes
 * does not clear it, and nothing a person does is needed: the builder opens the flaky item with the one command
 * (open-flaky.mjs, which labels it `flaky`, the pull's first pick), and the seal passes on a head whose every run
 * passes the step: its deterministic fix, made here or merged in from main. `key` is a report key (`J-x-01#3`).
 */
export const flakyWay = (key, sha, repo, runId) =>
  `a step that fails then passes on one commit is flaky and never counts as passing (project-state AGENTS.md "How work flows" 4), so a re-run that passes does not clear it; open its flaky item (node tooling/ci/open-flaky.mjs --step "${String(key).replace('#', ' #')}" --sha ${sha} --run https://github.com/${repo}/actions/runs/${runId} --title "<what fails>" --body-file <file>) and push a head on which every run passes it (its deterministic fix, made here or merged in from main)`;

/**
 * The verdict for one head. `runs`: every JOURNEYS_WORKFLOW run listed for this head (the caller lists by head_sha; this
 * filters again). `reportOf(run)`: { states } of the run's current-attempt report, or { error }. `derived`: the steps of
 * changed journey test files no name covers (judgeTouched), judged as if the title named them. Pure but for reportOf.
 * Returns { ok, state: 'none'|'pass'|'wait'|'fail', lines: [...] }.
 */
export async function judgeSteps({ sha, repo, title, body, runs, reportOf, waitOnRunning = true, derived = [] }) {
  const named = [...new Set([...titleSteps(title), ...derived])];
  const unreadable = titleProblems(title);
  if (unreadable.length)
    return {
      ok: false,
      state: 'fail',
      kinds: ['yours'],
      lines: [`the title's ${unreadable.join(', ')} can't be read as steps (a step number past ${STEP_MAX}); name the steps it means`],
    };
  if (named.length === 0) return { ok: true, state: 'none', lines: ['the title names no journey step'] };
  const left = exemptions(body);
  const lines = notes(left);
  const needed = [];
  for (const k of named) {
    if (left.steps.has(k)) lines.push(`${k}: exempted on a Left-or-replaced line`);
    else needed.push(k);
  }
  if (needed.length === 0) return { ok: true, state: 'pass', lines };
  const mine = (runs ?? []).filter(
    (r) =>
      r?.head_sha === sha && r?.path === JOURNEYS_WORKFLOW && r?.head_repository?.full_name === repo && r?.repository?.full_name === repo,
  );
  const running = mine.filter((r) => r.status !== 'completed');
  if (running.length && waitOnRunning) {
    const ids = running.map((r) => `${r.id} (attempt ${r.run_attempt ?? 1}, ${r.status})`).join(', ');
    return {
      ok: false,
      state: 'wait',
      lines: [
        ...lines,
        `Real-app journeys run ${ids} on this head has not finished; the seal reads the steps once it does (its last job, ${START_JOB}, starts it)`,
        leaveLine(needed),
      ],
    };
  }
  const { finished, noJob } = speaking(mine);
  lines.push(...noJob);
  const reports = new Map();
  const report = async (r) => {
    if (!reports.has(r.id)) {
      let rep;
      try {
        rep = await reportOf(r);
      } catch (e) {
        rep = { error: e.message };
      }
      reports.set(r.id, rep ?? { error: 'no report' });
    }
    return reports.get(r.id);
  };
  let ok = true;
  const notGreen = [];
  const kinds = new Set();
  for (const k of needed) {
    let decided = null;
    // Every finished run on the head is read, and every earlier attempt of one: a failure in any of them stands
    // against a pass in another (flakyWay).
    let unreadable = null;
    const failedIn = [];
    for (const r of finished) {
      const rep = await report(r);
      const where = `run ${r.id} (attempt ${r.run_attempt ?? 1})`;
      if (rep.error) {
        unreadable ??= `${where}'s report couldn't be read (${rep.error}), so a failure there can't be ruled out`;
        if (!decided) break;
        continue;
      }
      for (const e of rep.earlier ?? [])
        if (e.error)
          unreadable ??= `run ${r.id} (attempt ${e.attempt})'s report couldn't be read (${e.error}), so a failure there can't be ruled out`;
        else if (e.states?.[k] === 'failed') failedIn.push({ where: `run ${r.id} (attempt ${e.attempt})`, run: r.id });
      const st = rep.states?.[k];
      if (st === undefined) continue;
      if (!decided)
        decided = st === 'passed' ? { green: true, why: `passed in ${where}` } : { green: false, kind: 'yours', why: `${st} in ${where}` };
      else if (st === 'failed') failedIn.push({ where, run: r.id });
    }
    if (decided?.green && failedIn.length)
      decided = {
        green: false,
        kind: 'yours',
        why: `${decided.why}, but failed in ${failedIn.map((f) => f.where).join(', ')} on this same head: ${flakyWay(k, sha, repo, failedIn[0].run)}`,
      };
    if (unreadable && (!decided || decided.green)) decided = { green: false, kind: 'runner', why: unreadable };
    if (!decided)
      decided = {
        green: false,
        kind: 'runner',
        why: finished.length
          ? `no finished Real-app journeys run on this head reports it (${finished.length} read)`
          : 'no finished Real-app journeys run on this head',
      };
    if (!decided.green) {
      ok = false;
      notGreen.push(k);
      kinds.add(decided.kind);
    }
    lines.push(`${k}: ${decided.why}`);
  }
  if (notGreen.length) lines.push(leaveLine(notGreen));
  return { ok, state: ok ? 'pass' : 'fail', lines, kinds: [...kinds] };
}

/**
 * The journey stack's shared setup: a change here can break any journey, not only the ones a pull request names, so it
 * proves with a clean full journeys run on its exact head. Started from project-state BUILDER.md's list
 * (`local-stack-services/`, `local-test-world*`, `tests/real-app/lib/`) and widened in review round 1 of #7431 to every
 * stack input the repo already treats as one: the push trigger's `tooling/scripts/local-test-*.mjs` (the stack, the TEST
 * market maker, the seed, the compose env; #7191 changed the market maker), the stack's fixtures, the one-world scan and
 * the infra bootstrap. BUILDER.md's `lib/` is the shared journey helpers, which sit beside the journey files: every file
 * under apps/customer/tests/real-app that is not a test file (`*.pw.mjs`), the Playwright config among them.
 *
 * Each `glob` is written as GitHub's `paths:` filter writes it (`*` within a folder, `**` across folders), and
 * real-app-journeys.yml's push trigger holds each one verbatim, or `trigger`, the wider pattern that covers it, so a merge
 * touching only shared setup starts a run on main. journey-seal.test.mjs fails when the two drift. Edit this list and
 * the trigger together, never a third list.
 */
export const SHARED_SETUP = [
  { glob: 'tooling/scripts/local-stack-services/**' },
  { glob: 'tooling/scripts/local-stack-fixtures/**' },
  { glob: 'tooling/scripts/local-test-*.mjs' },
  { glob: 'tooling/scripts/journey-world.mjs' },
  { glob: 'apps/customer/tests/real-app/**', unless: /\.pw\.mjs$/, trigger: 'apps/**' },
];
/** A GitHub `paths:` glob as a regular expression: `**` any characters, `*` any but `/`. */
export const globRe = (glob) =>
  new RegExp(
    `^${String(glob)
      .split(/(\*\*|\*)/)
      .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
      .join('')}$`,
  );
export const isSharedSetup = (file) =>
  SHARED_SETUP.some(({ glob, unless }) => globRe(glob).test(String(file)) && !(unless && unless.test(String(file))));

/** The changed files of a pull request (GET /pulls/n/files, whole or thrown). A rename counts by both its names. */
export const pullFilePaths = (files) => (files ?? []).flatMap((f) => [f?.filename, f?.previous_filename].filter(Boolean));

/** Runs of JOURNEYS_WORKFLOW from this repository on exactly this head. */
const onHead = (runs, sha, repo) =>
  (runs ?? []).filter(
    (r) =>
      r?.head_sha === sha && r?.path === JOURNEYS_WORKFLOW && r?.head_repository?.full_name === repo && r?.repository?.full_name === repo,
  );
const newestFirst = (a, b) => Date.parse(b.run_started_at ?? b.created_at) - Date.parse(a.run_started_at ?? a.created_at) || b.id - a.id;

/**
 * Whether a finished run started no job: GitHub's jobs list for its current attempt is empty (`jobCount`, which io.runs
 * sets from that list, never from the run's title). Such a run ran no journey, so it can prove nothing and refuse
 * nothing. (Failure it prevents: #9253 on 4bf99e5d, 20 Nov 2026: dispatch 44785010056's concurrency group passed 400
 * characters, GitHub started no job, and the seal failed closed on its missing report although five other runs on the
 * head had run every needed journey clean.) A run whose jobs were never counted is not this, so it still fails closed
 * when its report is missing. Pure.
 */
export const startedNoJob = (r) => r?.status === 'completed' && r?.jobCount === 0;

/** The finished runs on a head that speak, newest first, and one line naming each that started no job (startedNoJob). */
function speaking(mine) {
  const done = mine.filter((r) => r.status === 'completed' && !['cancelled', 'skipped'].includes(r.conclusion));
  return {
    finished: done.filter((r) => !startedNoJob(r)).sort(newestFirst),
    noJob: done
      .filter(startedNoJob)
      .map(
        (r) =>
          `run ${r.id} (attempt ${r.run_attempt ?? 1}) started no job (GitHub lists none for its current attempt), so it ran no journey and is passed over`,
      ),
  };
}

/** `runs` with each finished one that is not cancelled or skipped given its `jobCount`, from `jobsOf(id)` (its
 *  latest-attempt jobs, listed whole or thrown, so a list that can't be read fails the seal closed). */
export async function countJobs(runs, jobsOf) {
  const out = [];
  for (const r of runs ?? [])
    out.push(
      r?.status === 'completed' && !['cancelled', 'skipped'].includes(r.conclusion) ? { ...r, jobCount: (await jobsOf(r.id)).length } : r,
    );
  return out;
}

/**
 * The touched-journeys verdict for a head whose pull request touches only journey test files (`files`: their names, as
 * a report's `ran` lists them). Every finished run on the head is read, newest first, and judged by the journeys
 * verdict on the files it has (`verdictOf`, the default branch's baseline): any red step in any of them fails the seal,
 * so a red run is never hidden behind a clean one, newer or older (#9827: run 45030979813's red J-cex-spot-21 #4 sat
 * behind run 45031001317's pass on the same head, and the seal stopped reading once the newer run covered every file).
 * An earlier attempt of a run counts the same way for each step it failed that a run on the head now passes (flakyWay).
 * A touched file no finished run on the head ran fails the seal and is named, with the runs by hand on `branch`
 * (the pull request's head branch) that run just those and each start (dispatchCommands). A run still going holds it, a
 * cancelled or skipped run says nothing, and a report or verdict that can't be read fails closed.
 */
export async function judgeTouchedRun({
  sha,
  repo,
  files,
  runs,
  reportOf,
  verdictOf,
  waitOnRunning = true,
  inherited = null,
  reach = null,
  named = null,
  branch = null,
}) {
  const why = `it touches ${files.length} journey file(s) (${files.slice(0, 5).join(', ')}${files.length > 5 ? `, ${files.length - 5} more` : ''})${reach?.length ? `, by the touched-journeys map (${reach.slice(0, 3).join('; ')}${reach.length > 3 ? `; ${reach.length - 3} more` : ''})` : ''}${named ? `, because ${named}` : ''}`;
  // Only the files no finished run on the head ran, in runs that each start (dispatchBatches: GitHub refuses a run whose
  // concurrency group passes 400 characters, and the whole touched list did on 20 Nov 2026, run 44766798876).
  const how = (left) => {
    const cmds = dispatchCommands(branch ?? '<branch>', left);
    return `${cmds.length > 1 ? `run them in these ${cmds.length} runs by hand (each within GitHub's ${DISPATCH_GROUP_MAX}-character concurrency group limit): ` : 'run them by hand: '}${cmds.join(' ; ')}; the seal re-runs when they finish`;
  };
  const mine = onHead(runs, sha, repo);
  const running = mine.filter((r) => r.status !== 'completed');
  if (running.length && waitOnRunning) {
    const ids = running.map((r) => `${r.id} (attempt ${r.run_attempt ?? 1}, ${r.status})`).join(', ');
    return {
      ok: false,
      state: 'wait',
      lines: [`touched journeys: ${why}; Real-app journeys run ${ids} on this head has not finished; the seal reads it once it does`],
    };
  }
  const { finished, noJob } = speaking(mine);
  const passedOver = noJob.map((l) => `touched journeys: ${l}`);
  const left = new Set(files);
  const read = [];
  // Every finished run's report first, so a red in one names the run on this head that passed the same step.
  const reps = [];
  for (const r of finished) {
    const where = `run ${r.id} (attempt ${r.run_attempt ?? 1})`;
    let rep;
    try {
      rep = (await reportOf(r)) ?? { error: 'no report' };
    } catch (e) {
      rep = { error: e.message };
    }
    const bad = rep.error
      ? { where, error: rep.error }
      : (rep.earlier ?? []).filter((e) => e.error).map((e) => ({ where: `run ${r.id} (attempt ${e.attempt})`, error: e.error }))[0];
    if (bad)
      return {
        ok: false,
        state: 'fail',
        kinds: ['runner'],
        lines: [`touched journeys: ${why}; ${bad.where}'s report couldn't be read (${bad.error}), so the seal fails closed`, ...passedOver],
      };
    reps.push({ r, rep, where });
  }
  // Where each step passed in a run's current attempt on this head (the first, newest, such run).
  const passedIn = new Map();
  for (const { rep, where } of reps)
    for (const [k, st] of Object.entries(rep.states ?? {})) if (st === 'passed' && !passedIn.has(k)) passedIn.set(k, where);
  const flaky = (x, where, r) =>
    passedIn.has(x.step) && passedIn.get(x.step) !== where
      ? `${x.step}: ${x.why}; it passed in ${passedIn.get(x.step)}: ${flakyWay(x.step, sha, repo, r.id)}`
      : `${x.step}: ${x.why}`;
  for (const { r, rep, where } of reps) {
    // Each earlier attempt of this run, judged as the run is, for the steps it failed that a run here now passes.
    for (const e of rep.earlier ?? []) {
      const at = `run ${r.id} (attempt ${e.attempt})`;
      let v;
      try {
        v = await verdictOf(e, r);
      } catch (err) {
        return {
          ok: false,
          state: 'fail',
          kinds: ['runner'],
          lines: [
            `touched journeys: ${why}; ${at}'s verdict couldn't be worked out (${err.message}), so the seal fails closed`,
            ...passedOver,
          ],
        };
      }
      const failed = (v.red ?? []).filter((x) => e.states?.[x.step] === 'failed' && passedIn.has(x.step));
      const split = await splitOrAll(inherited, failed, r);
      read.push(...inheritedLines(split));
      if (split.blocking.length)
        return {
          ok: false,
          state: 'fail',
          kinds: redKinds(split.blocking),
          lines: [
            `touched journeys: ${why}; ${at} failed ${split.blocking.length} step(s) a run on this head now passes: ${split.blocking
              .slice(0, 10)
              .map((x) => flaky(x, at, r))
              .join('; ')}${split.blocking.length > 10 ? `; ${split.blocking.length - 10} more` : ''}`,
            ...read.map((l) => `touched journeys: ${l}`),
            ...passedOver,
          ],
        };
    }
    let v;
    try {
      v = await verdictOf(rep, r);
    } catch (e) {
      return {
        ok: false,
        state: 'fail',
        kinds: ['runner'],
        lines: [
          `touched journeys: ${why}; ${where}'s verdict couldn't be worked out (${e.message}), so the seal fails closed`,
          ...passedOver,
        ],
      };
    }
    if (v.moneyByHead?.length)
      read.push(
        `${where}: main's money rule disagrees with the baseline on ${v.moneyByHead.join(', ')}, and this head's own rule agrees with the baseline, so each is read under the baseline's flag and any red there counts as money`,
      );
    // A red this head inherited from main outside this pull request's area stops no one.
    const split = await splitOrAll(inherited, v.red, r);
    read.push(...inheritedLines(split));
    const red = split.blocking;
    if (red.length)
      return {
        ok: false,
        state: 'fail',
        kinds: redKinds(red),
        lines: [
          `touched journeys: ${why}; ${where} has ${red.length} step(s) outside the list or against its rules: ${red
            .slice(0, 10)
            .map((x) => flaky(x, where, r))
            .join('; ')}${red.length > 10 ? `; ${red.length - 10} more` : ''}`,
          ...read.map((l) => `touched journeys: ${l}`),
          ...passedOver,
        ],
      };
    const covered = (rep.ran ?? []).filter((f) => left.has(f));
    for (const f of covered) left.delete(f);
    if (covered.length) read.push(`${where} ran ${covered.join(', ')} clean`);
  }
  if (!left.size) return { ok: true, state: 'pass', lines: [`touched journeys: ${why}; ${read.join('; ')}`, ...passedOver] };
  return {
    ok: false,
    state: 'fail',
    kinds: ['runner'],
    lines: [
      `touched journeys: ${why}, and no finished Real-app journeys run on this exact head ran ${[...left].join(', ')}; ${how([...left])}`,
      ...read.map((l) => `touched journeys: ${l}`),
      ...passedOver,
    ],
  };
}

/** The artifact that holds a run's current-attempt report: named JOURNEYS_ARTIFACT, not expired, made at or after the
 *  attempt started; the newest if more than one. Null when there is none. */
export function currentReportArtifact(run, artifacts) {
  const start = Date.parse(run?.run_started_at ?? run?.created_at ?? '');
  const fits = (artifacts ?? []).filter(
    (a) => a?.name === JOURNEYS_ARTIFACT && !a.expired && Number.isFinite(start) && Date.parse(a.created_at) >= start,
  );
  return fits.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0] ?? null;
}

/**
 * The artifact that holds each earlier attempt's report of `run` (attempts 1 to run_attempt - 1), for a step one of them
 * failed (flakyWay): for attempt k, the newest JOURNEYS_ARTIFACT made at or after it started (`starts`: Map(attempt →
 * its run_started_at)) and before the next attempt did (the current attempt's start is the run's own). An attempt with
 * none (it ran nothing, or stopped before its report) is left out: it reported no step. An attempt whose start is
 * unknown is { attempt, error }, so the seal fails closed. Returns [{ attempt, artifact } | { attempt, error }]. Pure.
 */
export function earlierReportArtifacts(run, artifacts, starts) {
  const current = Number(run?.run_attempt ?? 1);
  const at = (k) => Date.parse(k === current ? (run?.run_started_at ?? '') : (starts?.get(k) ?? ''));
  const out = [];
  for (let k = 1; k < current; k++) {
    const [from, to] = [at(k), at(k + 1)];
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      out.push({ attempt: k, error: `attempt ${k}'s start couldn't be read` });
      continue;
    }
    const fits = (artifacts ?? []).filter(
      (a) => a?.name === JOURNEYS_ARTIFACT && !a.expired && Date.parse(a.created_at) >= from && Date.parse(a.created_at) < to,
    );
    const art = fits.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0];
    if (art) out.push({ attempt: k, artifact: art });
  }
  return out;
}

// ---- GitHub reads (GET only; a refusal or an unreadable list fails the seal closed) ----

/** Statuses a GET is tried again on: GitHub's own short outages, never a refusal (a 403 or 429 stops at once). */
const TRANSIENT = new Set([502, 503, 504]);

/**
 * One GET, tried up to `tries` times when the request itself fails (Node's "fetch failed": a reset or a timeout on the
 * way) or GitHub answers 502, 503 or 504, `waitMs` apart, then the last answer or error as it is, so the seal still fails
 * closed. A thrown error keeps its cause's code, which Node's "fetch failed" alone hides (intafaced#7707, seal run
 * 42698308612: "which reds main already had couldn't be read (fetch failed)" on two attempts in a row).
 */
export async function getTried(
  url,
  init,
  { fetchImpl = githubFetch, tries = 3, waitMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  for (let n = 1; ; n++) {
    try {
      const res = await fetchImpl(url, init);
      if (!TRANSIENT.has(res.status) || n >= tries) return res;
    } catch (e) {
      if (n >= tries) {
        const code = e?.cause?.code ?? e?.cause?.message;
        throw new Error(`${e?.message ?? e}${code ? ` (${code})` : ''} after ${n} tries`, { cause: e });
      }
    }
    await sleep(waitMs * n);
  }
}

async function api(path, token, { raw = false } = {}) {
  const res = await getTried(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(httpMessage(path, res));
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

async function listWhole(path, key, token, what) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const r = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, token);
    if (!Array.isArray(r?.[key])) throw new Error(`${what}: not a list`);
    all.push(...r[key]);
    if (r[key].length < 100) {
      if (Number.isSafeInteger(r.total_count) && all.length < r.total_count)
        throw new Error(`${what}: ${all.length} of ${r.total_count} read`);
      return all;
    }
  }
  throw new Error(`${what}: more than 1,000 listed, not whole`);
}

export function makeIo(repo, token) {
  const file = JOURNEYS_WORKFLOW.split('/').pop();
  // One report artifact, downloaded and read: { states, files, ran, artifact }.
  const readArtifactReport = async (art) => {
    const dir = mkdtempSync(join(tmpdir(), 'journey-seal-'));
    try {
      const zip = join(dir, 'a.zip');
      writeFileSync(zip, await api(`/repos/${repo}/actions/artifacts/${art.id}/zip`, token, { raw: true }));
      const text = execFileSync('unzip', ['-p', zip, 'report.json'], { maxBuffer: 256 * 2 ** 20, encoding: 'utf8' });
      const { states, files, ran } = readReport(JSON.parse(text));
      return { states, files, ran, artifact: art.id };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return {
    // The head's tooling reach (journey-touch.mjs quietTooling), scanned by this script's own tooling-reach.mjs (the
    // default branch's) over the head commit's files, as the journeys run's planner scans its checkout of the head.
    toolingReach: async (sha) => {
      const { commitTree, reachOf } = await import('./tooling-reach.mjs');
      const tree = commitTree(BASE_ROOT, sha);
      try {
        return reachOf(tree)?.journeys ?? null;
      } finally {
        tree.cleanup();
      }
    },
    pull: (n) => api(`/repos/${repo}/pulls/${n}`, token),
    // The pull requests GitHub lists on a commit, open or not (mergedNothingToSeal).
    pullsOn: (sha) => api(`/repos/${repo}/commits/${sha}/pulls?per_page=100`, token),
    // An automatic revert's commits (it must hold one) and the commit it reverts (autoRevertScope).
    pullCommits: (n) => api(`/repos/${repo}/pulls/${n}/commits?per_page=2`, token),
    commit: (sha) => api(`/repos/${repo}/commits/${sha}?per_page=300`, token),
    // A run whose last job (START_JOB) is what started this seal is read as finished (settledRun).
    // Each finished one carries its job count (countJobs), so a run that started no job is passed over (startedNoJob).
    runs: async (sha) => {
      const jobsOf = async (id) => {
        const jobs = await runJobs(`/repos/${repo}/actions/runs/${id}/jobs?filter=latest`, (p) => api(p, token));
        if (!jobs) throw new Error(`run ${id}'s jobs: not a list`);
        return jobs;
      };
      return countJobs(
        await settleRuns(
          await listWhole(
            `/repos/${repo}/actions/workflows/${file}/runs?head_sha=${sha}`,
            'workflow_runs',
            token,
            `${file} runs on ${sha}`,
          ),
          jobsOf,
        ),
        jobsOf,
      );
    },
    async reportOf(run) {
      const arts = await listWhole(
        `/repos/${repo}/actions/runs/${run.id}/artifacts?name=${JOURNEYS_ARTIFACT}`,
        'artifacts',
        token,
        `run ${run.id}'s artifacts`,
      );
      const art = currentReportArtifact(run, arts);
      if (!art) return { error: `no ${JOURNEYS_ARTIFACT} artifact from its current attempt` };
      return readArtifactReport(art);
    },
    // Each earlier attempt's report of a re-run run on a pull request's head (earlierReportArtifacts), for the steps it
    // failed (flakyWay): one GET per earlier attempt for its start, one artifact list, one download each. A read that
    // fails is that attempt's { error }, so the seal fails closed.
    async earlierReports(run) {
      const current = Number(run?.run_attempt ?? 1);
      if (!(current > 1)) return [];
      try {
        const starts = new Map();
        for (let k = 1; k < current; k++)
          starts.set(k, (await api(`/repos/${repo}/actions/runs/${run.id}/attempts/${k}`, token))?.run_started_at);
        const arts = await listWhole(
          `/repos/${repo}/actions/runs/${run.id}/artifacts?name=${JOURNEYS_ARTIFACT}`,
          'artifacts',
          token,
          `run ${run.id}'s artifacts`,
        );
        const out = [];
        for (const e of earlierReportArtifacts(run, arts, starts))
          if (e.error) out.push(e);
          else
            try {
              out.push({ attempt: e.attempt, ...(await readArtifactReport(e.artifact)) });
            } catch (err) {
              out.push({ attempt: e.attempt, error: err.message });
            }
        return out;
      } catch (e) {
        return [{ attempt: 1, error: e.message }];
      }
    },
    compare: (base, head) => api(`/repos/${repo}/compare/${base}...${head}?per_page=250`, token),
    // The map the touch job used (journey-touch.mjs): the newest build main's map workflow verified no later than `before`,
    // else the committed copy beside this script.
    reachMap: async (before) =>
      newerMap(
        await builtMap({ get: (path) => api(path, token), raw: (path) => api(path, token, { raw: true }), before, repo }),
        loadMap(),
      ),
    // Main's open `regression` and `flaky` issues, for a red that is main's own (mainsOwn).
    mainIssues: async () =>
      (
        await Promise.all(
          ['regression', 'flaky'].map(async (label) => {
            const r = await api(`/repos/${repo}/issues?labels=${label}&state=open&per_page=100`, token);
            if (!Array.isArray(r)) throw new Error(`open ${label} issues: not a list`);
            return r;
          }),
        )
      ).flat(),
    mainRuns: async () => {
      const r = await api(`/repos/${repo}/actions/workflows/${file}/runs?branch=main&status=completed&per_page=100`, token);
      if (!Array.isArray(r?.workflow_runs)) throw new Error(`${file} runs on main: not a list`);
      return r.workflow_runs;
    },
    // Whether `head` holds `sha`: GitHub's compare says the head is ahead of it or the same commit.
    contains: async (sha, head) =>
      ['ahead', 'identical'].includes((await api(`/repos/${repo}/compare/${sha}...${head}?per_page=1`, token))?.status),
    // The files changed and the commit count from `from` to `to` on main; GitHub lists at most 300 files.
    // The newest commit of the base branch (its tip when the pull request was read) the head holds.
    mergeBase: async (base, head) =>
      (await api(`/repos/${repo}/compare/${base}...${head}?per_page=1`, token))?.merge_base_commit?.sha ?? null,
    rangeOf: (from, to) => rangeFromCommits((path) => api(path, token), repo, from, to),
    files: (n) => pullFiles((path) => api(path, token), repo, n),
    // A folder's entry names at a commit (journey-reach-map.mjs loadersReach): the contents API lists up to 1,000.
    dirNames: async (dir, ref) => {
      const list = await api(`/repos/${repo}/contents/${dir.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`, token);
      if (!Array.isArray(list) || list.length >= 1000) throw new Error(`${dir} could not be listed whole`);
      return list.map((e) => String(e?.name));
    },
    // The journey files in the head's real-app folder (the contents API lists up to 1,000 entries; there are ~270).
    journeyFiles: async (ref) => {
      const list = await api(`/repos/${repo}/contents/apps/customer/tests/real-app?ref=${ref}`, token);
      if (!Array.isArray(list) || list.length >= 1000) throw new Error('the real-app folder could not be listed whole');
      return new Set(
        list.filter((e) => e?.type === 'file' && JOURNEY_TEST.test(`apps/customer/tests/real-app/${e.name}`)).map((e) => e.name),
      );
    },
    async text(path, ref) {
      const url = `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`;
      const res = await getTried(`https://api.github.com${url}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github.raw+json' },
        redirect: 'follow',
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
      return res.text();
    },
    // The head's .mjs files in the real-app folder, name to text, for a change to a stack file (journey-touch.mjs
    // stackImporters): the folder's listing, then its files 100 to a GraphQL query (one REST read each would be 300 a seal).
    journeyTexts: async (ref) => {
      if (!SHA40.test(String(ref))) throw new Error('journeyTexts: a head sha is needed');
      const list = await api(`/repos/${repo}/contents/apps/customer/tests/real-app?ref=${ref}`, token);
      if (!Array.isArray(list) || list.length >= 1000) throw new Error('the real-app folder could not be listed whole');
      const names = list.filter((e) => e?.type === 'file' && e.name.endsWith('.mjs')).map((e) => e.name);
      const [owner, name] = repo.split('/');
      const out = new Map();
      for (let i = 0; i < names.length; i += 100) {
        const part = names.slice(i, i + 100);
        const fields = part.map(
          (f, k) =>
            `f${k}: object(expression: ${JSON.stringify(`${ref}:apps/customer/tests/real-app/${f}`)}) { ... on Blob { text isTruncated } }`,
        );
        const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`;
        const res = await getTried('https://api.github.com/graphql', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query, variables: { owner, name } }),
        });
        if (!res.ok) throw new Error(`GraphQL: HTTP ${res.status}`);
        const got = await res.json();
        if (got.errors?.length || !got.data?.repository) throw new Error('GraphQL: the journey files could not be read');
        part.forEach((f, k) => {
          const blob = got.data.repository[`f${k}`];
          if (typeof blob?.text !== 'string' || blob.isTruncated) throw new Error(`${f} could not be read whole`);
          out.set(f, blob.text);
        });
      }
      return out;
    },
    verdictOf: (report, run, { headMoney = null, headBaseline = null } = {}) =>
      fullVerdict({ repo, report, run, inputs: baseInputs(), headMoney, headBaseline }),
    // The money rule at a pull request's head (moneyAt), for a money-flag mismatch on its own run (sealPull).
    headMoney: (ref) => moneyVia(repo, token, ref),
  };
}

/** The default branch's checkout this script runs from (ci.yml runs the base's copy): its baseline and money rule. */
const BASE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
let base = null;
// `memo`: each GET fetchInputs makes is made once per seal step, for every run it judges (journey-verdict.mjs fetchInputs).
const baseInputs = () => (base ??= { ...rootInputs(BASE_ROOT), onMain: journeyFilesAt(BASE_ROOT), reports: new Map(), memo: new Map() });

/**
 * The journey files a checkout holds (`apps/customer/tests/real-app/*.pw.mjs`), as a set of names, or null when the
 * folder can't be read. The seal reads it from the default branch's checkout it runs from, never from the pull request's
 * head, so a pull request can't shorten what a full run must hold by deleting or renaming a file itself.
 */
export function journeyFilesAt(root) {
  try {
    return new Set(readdirSync(join(root, 'apps/customer/tests/real-app')).filter((f) => f.endsWith('.pw.mjs')));
  } catch {
    return null;
  }
}

/** One run's verdict, as journey-verdict.mjs would print it with the default branch's baseline, and the journey files
 *  of the full suite (the baseline's named run) its report lacks. GET only, through gh (GH_TOKEN). */
export function fullVerdict({ repo, report, run, inputs, read = fetchInputs, headMoney = null, headBaseline = null }) {
  const { baseline, money, reports, memo } = inputs;
  const got = read({ repo, baseline, thisRun: run, reports, memo, log: () => {} });
  const red = got.problems.map((why) => ({ step: '(input)', why }));
  if (!got.named) return { red, failing: 0, missing: [] };
  // The files each run ran, never the step-to-file map: that keeps one file a step, so a step id two files share
  // (J-wallet-04 #7) dropped one of them on both sides, and a clean full run read as short of it (#7492's seal,
  // run 42419894849 attempt 2). A report without its list is read as having run nothing: short, so never sealed full.
  if (!Array.isArray(got.named.ran))
    return { red: [...red, { step: '(input)', why: "the named run's report has no list of the files it ran" }], failing: 0, missing: [] };
  const have = new Set(report.ran ?? []);
  // A file the named run ran that the default branch no longer has (deleted or renamed there since, as #8485 deleted
  // J-home-ia-06-blocked.pw.mjs) can't run, so it is not missing (#8505: every full run after it read as short).
  // `inputs.onMain` is main's own file list (`journeyFilesAt`); without one, every file still counts, so the rule
  // fails closed.
  const onMain = inputs.onMain instanceof Set ? inputs.onMain : null;
  const missing = got.named.ran.filter((f) => !have.has(f) && (onMain === null || onMain.has(f)));
  // A run short of journey files (targeted, or a shard lost) is judged on the files it has, as a targeted run's own
  // verdict is: a red step there fails the seal; only a run clean on all it has is passed over.
  const target = missing.length ? have : null;
  const v = judge({
    newest: report,
    named: got.named,
    baseline,
    money,
    passedSince: got.passedSince,
    issues: got.issues,
    target,
    headMoney,
    // The baseline the merge would hold: the head's when the pull request changes it (sealPull), else main's.
    headBaseline: headMoney ? (headBaseline ?? baseline) : null,
  });
  // Where each red step last passed on main before this run (the newest history run that passed it, else the named run
  // when it passed there), or null when it never passed: the merge seal bounds an inherited red by the commits since.
  const lastPass = {};
  for (const { step } of v.red) {
    const n = got.passedSince?.[step];
    lastPass[step] =
      n !== undefined
        ? (got.shas?.[n] ?? '')
        : got.named.states?.[step] === 'passed' || got.named.tests?.[step] === 'passed'
          ? String(baseline?.run?.sha ?? '')
          : null;
  }
  return { red: [...red, ...v.red], failing: v.failing, missing, lastPass, moneyByHead: v.moneyByHead ?? [] };
}

/**
 * The money rule (journey-verdict.mjs moneyRule) as a pull request's head commit holds it, read the way manifestsAt
 * and rootInputs read a checkout: every package.json one folder under apps, services, packages and tooling, every
 * `crates/svc-<x>` with a Cargo.toml, and docs/roadmap's journeys.json and slices.json. `list(dir)` gives a folder's
 * entries ({ name, type }, null when it is not there), `blobs(paths)` each file's text (null when missing), `text(path)` one
 * file's text. Anything unreadable throws, so the seal keeps the red (judge, headMoney).
 */
export async function moneyAt({ list, blobs, text }) {
  const dirs = [];
  for (const parent of ['apps', 'services', 'packages', 'tooling'])
    for (const e of (await list(parent)) ?? []) if (e?.type === 'dir') dirs.push(`${parent}/${e.name}`);
  const crates = ((await list('crates')) ?? [])
    .filter((e) => e?.type === 'dir' && /^svc-[a-z0-9-]+$/.test(e.name))
    .map((e) => `crates/${e.name}`);
  const got = await blobs([...dirs.map((d) => `${d}/package.json`), ...crates.map((d) => `${d}/Cargo.toml`)]);
  const manifests = new Map();
  for (const d of dirs) {
    const t = got.get(`${d}/package.json`);
    if (typeof t === 'string') manifests.set(d, JSON.parse(t));
  }
  for (const d of crates)
    if (typeof got.get(`${d}/Cargo.toml`) === 'string') manifests.set(d, { name: d.slice('crates/'.length), rustService: true });
  const read = async (p) => {
    const t = await text(p);
    if (typeof t !== 'string') throw new Error(`${p} could not be read`);
    return JSON.parse(t);
  };
  return moneyRule({ journeys: await read('docs/roadmap/journeys.json'), slices: await read('docs/roadmap/slices.json'), manifests });
}

/** The money rule at `ref` (moneyAt) through GitHub: folder listings from the contents API, the manifests 100 to a
 *  GraphQL query, the two roadmap files raw. */
function moneyVia(repo, token, ref) {
  if (!SHA40.test(String(ref))) throw new Error('moneyVia: a head sha is needed');
  const [owner, name] = repo.split('/');
  return moneyAt({
    list: async (dir) => {
      const res = await getTried(`https://api.github.com/repos/${repo}/contents/${dir}?ref=${ref}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
        redirect: 'follow',
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(httpMessage(`/repos/${repo}/contents/${dir}`, res));
      const got = await res.json();
      if (!Array.isArray(got) || got.length >= 1000) throw new Error(`${dir} could not be listed whole`);
      return got;
    },
    blobs: async (paths) => {
      const out = new Map();
      for (let i = 0; i < paths.length; i += 100) {
        const part = paths.slice(i, i + 100);
        const fields = part.map(
          (p, k) => `f${k}: object(expression: ${JSON.stringify(`${ref}:${p}`)}) { ... on Blob { text isTruncated } }`,
        );
        const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`;
        const res = await getTried('https://api.github.com/graphql', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query, variables: { owner, name } }),
        });
        if (!res.ok) throw new Error(`GraphQL: HTTP ${res.status}`);
        const got = await res.json();
        if (got.errors?.length || !got.data?.repository) throw new Error("GraphQL: the head's manifests could not be read");
        part.forEach((p, k) => {
          const blob = got.data.repository[`f${k}`];
          if (blob === null) return out.set(p, null);
          if (typeof blob?.text !== 'string' || blob.isTruncated) throw new Error(`${p} could not be read whole`);
          out.set(p, blob.text);
        });
      }
      return out;
    },
    text: (p) => makeIo(repo, token).text(p, ref),
  });
}

/** A path the money rule or the baseline is read from (rootInputs, moneyAt): changing one can change a step's money flag. */
export const moneyInput = (path) =>
  ['docs/roadmap/journeys.json', 'docs/roadmap/slices.json', BASELINE_PATH].includes(path) ||
  /^(?:apps|services|packages|tooling)\/[^/]+\/package\.json$/.test(path) ||
  /^crates\/[^/]+\/Cargo\.toml$/.test(path);

/** A pull request's changed paths, whole: GitHub lists at most 3,000, so a longer list fails closed. */
export async function pullFiles(get, repo, n) {
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const r = await get(`/repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`);
    if (!Array.isArray(r)) throw new Error(`#${n}'s files: not a list`);
    all.push(...r);
    if (r.length < 100) return pullFilePaths(all);
  }
  throw new Error(`#${n} changes 3,000 files or more, which GitHub can't list whole`);
}

/**
 * A journey test file and its journey id: `J-bank-13.pw.mjs`, or one of a journey split across files
 * (`J-ops-console-02-documents.pw.mjs` holds J-ops-console-02's steps). Every journey id is letter-led segments and a
 * final number (all 472 in docs/roadmap/journeys.json on 7 Nov 2026), so the id ends at the first number. Only these hold
 * journey steps; the look sweeps and other `*.pw.mjs` files beside them do not.
 */
export const JOURNEY_TEST = /^apps\/customer\/tests\/real-app\/(J-[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-\d+)(?:-[a-z0-9-]+)?\.pw\.mjs$/;

/**
 * The step keys a journey test file holds: each `test(` whose title starts with its journey id, written out
 * (`'J-bank-13 #1 …'`) or as the file's `${J}` (`` `${J} #1 …` ``), keyed as readReport keys them.
 */
export function fileSteps(journey, text) {
  const out = new Set();
  const id = journey.replace(/[-]/g, '\\-');
  const re = new RegExp(`\\btest(?:\\.[a-z]+)*\\(\\s*[\`'"](?:\\$\\{J\\}|${id})\\s*#(\\d+)\\b`, 'g');
  for (const m of String(text ?? '').matchAll(re)) if (Number(m[1]) <= STEP_MAX) out.add(`${journey}#${Number(m[1])}`);
  return [...out].sort(byStep);
}

/**
 * The steps a pull request that changes a journey test file is judged on: for each changed file, the steps the title
 * names or a strict `Left-or-replaced:` line leaves, if any of them is the file's; otherwise every step the file holds,
 * returned as `derived` for judgeSteps to judge exactly as title steps (passing in a finished Real-app journeys run on
 * the exact head, or left on their own body line). A file with no readable `test(` titled `<journey> #n` at the head
 * or the base fails closed, unless another file of its journey holds its steps (`siblings`).
 * `touched`: [{ file, journey, steps, from?, siblings? }] from touchedSteps: the steps each file holds at the head (or
 * at the base, for a file the head removed or one whose head holds none). (Failure it prevents: #7434 and #7435 changed journey tests on 7 Nov 2026 with no `#n` in their titles, so
 * the seal judged none of their steps; project-state #1249 comment 6681706701. Until 21 Nov 2026 a file whose steps
 * were not named failed the seal, which cost a push for a line the seal could compute; the owner's "yes" of 21 Nov
 * 2026 made it derive them instead.)
 */
export function judgeTouched({ title, body, touched, repo }) {
  if (!touched.length) return { ok: true, lines: [] };
  // GitHub's Revert button (title `Revert "…"`, body line `Reverts owner/repo#n`) passes, as judgeSteps lets it: a red
  // main is fixed or undone within 2 hours (project-state OWNER 180), so a revert never waits on a body line.
  const reverts = revertOf({ title, body, repo });
  if (reverts) return { ok: true, lines: [`a revert of #${reverts} (GitHub's Revert form): its journey tests need no steps named`] };
  const left = exemptions(body);
  const named = new Set([...titleSteps(title), ...left.steps]);
  const lines = [];
  const derived = new Set();
  let ok = true;
  for (const { file, journey, steps, from, siblings = [] } of touched) {
    if (steps.some((k) => named.has(k))) continue;
    if (!steps.length && siblings.length) {
      // Its journey's steps live in another file; this one holds none to judge, and its journeys run must still be
      // clean on the head (judgeTouchedRun).
      lines.push(
        `${file} holds no \`test(\` titled \`${journey} #n\` at the head or the base; ${journey}'s steps live in ${siblings.join(', ')}, so it changes none, and its run on this head must still be clean`,
      );
      continue;
    }
    if (!steps.length) {
      ok = false;
      lines.push(
        `${file} changes a journey test, but no \`test(\` titled \`${journey} #n\` could be read in it, so the steps it touches can't be named; the seal fails closed`,
      );
      continue;
    }
    for (const k of steps) derived.add(k);
    lines.push(
      `${file} ${from === 'base' ? 'retitles out the last of its steps, ' : 'changes the tests of '}${steps.map((k) => k.replace('#', ' #')).join(', ')}, and neither the title nor a Left-or-replaced line names any of them, so the seal judges them all on this head`,
    );
  }
  return { ok, lines, derived: [...derived].sort(byStep) };
}

/**
 * judgeTouched before the push (`--before-push`, from .githooks/pre-push), with the title it needs: the seal judged it
 * only once every input had finished, so #8469 heard 42 minutes after its push and #8478 18. Since judgeTouched derives
 * the steps no name covers, only an unreadable title range or a journey file with no readable step is refused. `title`
 * null (no pull request yet): `need` names the steps the seal judges when the title names none. Otherwise ok, or `fix`:
 * the title with them added. Pure.
 */
export function titleBeforePush({ title, body, touched, repo }) {
  const runOf = ({ journey, steps }) => `${journey} ${steps.map((k) => `#${k.split('#')[1]}`).join(' ')}`;
  const need = touched.filter((t) => t.steps.length).map(runOf);
  if (title == null) return { ok: true, need };
  const pass = (t) => judgeTouched({ title: t, body, touched, repo }).ok && !titleProblems(t).length;
  if (pass(title)) return { ok: true, need };
  let fix = title;
  for (const t of touched.filter((t) => t.steps.length && !t.steps.some((k) => titleSteps(fix).includes(k)))) {
    const at = new RegExp(`\\b${t.journey}\\b(?!\\s*#)`, 'i');
    fix = at.test(fix) ? fix.replace(at, runOf(t)) : fix.replace(/( \(#\d+\))?\s*$/, (end) => `, ${runOf(t)}${end}`);
  }
  return {
    ok: false,
    need,
    lines: [...titleProblems(title), ...judgeTouched({ title, body, touched, repo }).lines],
    fix: pass(fix) ? fix : null,
  };
}

/** The pull request a GitHub revert undoes: the title is exactly `Revert "…"` and a body line, at column 0, is exactly
 *  `Reverts <this repo>#n`, as GitHub's Revert button writes them. Null for anything else. */
export function revertOf({ title, body, repo }) {
  if (!isRevert(title) || !repo) return null;
  const esc = String(repo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^Reverts ${esc}#(\\d+)[ \\t]*$`, 'm').exec(String(body ?? '').replace(/\r/g, ''));
  return m ? Number(m[1]) : null;
}

// ---- The revert main-bisect opens runs narrow (project-state #1786 item 5, the programme lead's ruling D2) ----

/** The branch and author of the revert main-bisect opens (journeys-revert.mjs revertBranch; the factory App). */
export const AUTO_REVERT_BRANCH = /^revert\/auto-([0-9a-f]{10})$/;
export const AUTO_REVERT_AUTHOR = 'intafaced-mac-agents[bot]';
const REVERTS_COMMIT = /^This reverts commit ([0-9a-f]{40})\.$/m;
const CULPRIT_PULL = /^Revert #(\d+), which turned the Real-app journeys red \(run \d+\)$/;

/**
 * The journey files the revert main-bisect opens runs: the journeys whose steps failed on main (its body's `- Failing:`
 * line) and the reverted pull request's own (the journey tests the revert changes and the steps the culprit's title
 * names), instead of everything the reverted code can reach. A revert restores code main's last green full run proved,
 * and main's full journeys run after the merge is what guards main afterwards (it bisects and reverts again if red).
 * Null when the pull request is not on a `revert/auto-<sha10>` branch; `{ ok: false, why }` when it is but any check
 * fails, so it gets the ordinary scope: opened by the factory App from this repository, exactly one commit whose message
 * says it reverts the commit the branch names, no file outside that commit's (shared journey setup included: its reverse
 * restores what main proved before that commit, intafaced #8149), and at least one
 * journey file named. `commits`: GET /pulls/n/commits; `culprit`: GET /commits/<sha> (or null); `culpritTitle`: the
 * culprit pull request's title (or ''); `journeyFiles`: the head's journey file names.
 */
export function autoRevertScope({ pull, repo, paths, commits, culprit, culpritTitle = '', journeyFiles }) {
  const origin = autoRevertOrigin({ pull, repo, commits });
  if (!origin) return null;
  const no = (why) => ({ ok: false, why: `an automatic revert's branch, but ${why}, so it runs the ordinary scope` });
  if (!origin.sha) return no(origin.why);
  const { sha } = origin;
  if (!Array.isArray(culprit?.files) || culprit.sha !== sha) return no(`the reverted commit ${sha.slice(0, 10)} could not be read`);
  const own = new Set(pullFilePaths(culprit.files));
  const outside = paths.filter((f) => !own.has(f));
  if (outside.length) return no(`it changes ${outside.length} file(s) the reverted commit didn't`);
  const failing = /^- Failing: (.+)$/m.exec(String(pull?.body ?? '').replace(/\r/g, ''))?.[1] ?? '';
  const journeys = new Set([
    ...[...failing.matchAll(/`(J-[a-z][a-z0-9-]*-\d+) #\d+`/g)].map((m) => m[1]),
    ...paths.map((f) => JOURNEY_TEST.exec(f)?.[1]).filter(Boolean),
    ...stepsIn(culpritTitle).map(journeyOf),
  ]);
  const dir = 'apps/customer/tests/real-app';
  const files = [...journeyFiles].filter((f) => journeys.has(JOURNEY_TEST.exec(`${dir}/${f}`)?.[1])).sort();
  if (!files.length) return no('it names no journey file');
  // Shared setup too: a pull request's run is never the full suite (journey-touch.mjs pullPick), and the seal holds the
  // revert to these files, as its run takes them.
  return {
    ok: true,
    sha,
    files,
    why: `the automatic revert of ${sha.slice(0, 10)} runs the journeys that failed on main and the reverted change's own (${files.length}); main's full journeys run after the merge guards main`,
  };
}

/**
 * Whether main-bisect opened this pull request: null off a `revert/auto-<sha10>` branch; else `{ sha }`, the commit it
 * reverts, or `{ why }` it is not: opened by the factory App from this repository, holding exactly one commit whose message
 * says it reverts the commit the branch names. `commits`: GET /pulls/n/commits.
 */
export function autoRevertOrigin({ pull, repo, commits }) {
  const branch = AUTO_REVERT_BRANCH.exec(String(pull?.head?.ref ?? ''));
  if (!branch) return null;
  if (pull?.head?.repo?.full_name !== repo) return { why: 'its head is not in this repository' };
  if (pull?.user?.login !== AUTO_REVERT_AUTHOR || pull?.user?.type !== 'Bot') return { why: `it was not opened by ${AUTO_REVERT_AUTHOR}` };
  if (!Array.isArray(commits) || commits.length !== 1) return { why: 'it does not hold exactly one commit' };
  const sha = REVERTS_COMMIT.exec(String(commits[0]?.commit?.message ?? ''))?.[1];
  if (!sha || !sha.startsWith(branch[1])) return { why: `its commit does not say it reverts ${branch[1]}` };
  return { sha };
}

/**
 * Whether main-bisect's revert is a pure revert: merged onto main now, it gives main's tree with the reverted commit's
 * files back as they were before it, a state main already accepted, and changes nothing else. Then the seal judges no
 * journeys for it and does not wait for its journeys run: it merges on main's other required checks, and main's full
 * journeys run after the merge judges it (it bisects and reverts again if red). Intafaced #9603, 22 Nov 2026: the revert
 * of #9539 waited 1 h 31 m on a seal that judged it like new code (8 steps red on a money-rule mismatch) while main stayed
 * red and four fix-forward pull requests raced. Null off main-bisect's branch; `{ ok: false, why }` when any proof fails,
 * and it is judged in full. Every proof, from GitHub (a compare lists up to 300 files, so a longer one fails):
 *   - opened by main-bisect (autoRevertOrigin), the reverted commit read whole with one parent;
 *   - the pull request changes exactly the reverted commit's files (`paths`, renames by both names);
 *   - the reverted commit is in main's history and main has not changed those files since (`sinceCulprit`: compare
 *     culprit...main): it is main's newest merge, or every merge after it touched other files;
 *   - its one commit's parent is in main's history (`parentOnMain`: parent...main) and holds the culprit with those files
 *     unchanged (`parentSince`: culprit...parent), so the merge base is that parent and it agrees with main on them;
 *   - at its head those files are the culprit's parent's (`restored`: culprit^...head lists none of them).
 * So a changed line anywhere fails: in another file, `paths`; in one of the culprit's, `restored`. Pure.
 */
export function pureRevert({ origin, culprit, parent, paths, sinceCulprit, parentOnMain, parentSince, restored }) {
  if (!origin) return null;
  const no = (why) => ({ ok: false, why: `not a pure revert: ${why}, so the seal judges it in full` });
  if (!origin.sha) return no(origin.why);
  const { sha } = origin;
  const short = sha.slice(0, 10);
  if (culprit?.sha !== sha || !Array.isArray(culprit?.files) || !culprit.files.length || culprit.files.length >= 300)
    return no(`the reverted commit ${short} could not be read whole`);
  if (!Array.isArray(culprit.parents) || culprit.parents.length !== 1 || !SHA40.test(String(culprit.parents[0]?.sha)))
    return no(`the reverted commit ${short} does not have exactly one parent`);
  if (!SHA40.test(String(parent ?? ''))) return no("its commit's parent could not be read");
  const own = new Set(pullFilePaths(culprit.files));
  const mine = new Set(paths ?? []);
  const extra = [...mine].filter((f) => !own.has(f));
  const missing = [...own].filter((f) => !mine.has(f));
  if (extra.length || missing.length)
    return no(
      `it changes ${extra.length ? `${extra.length} file(s) the reverted commit didn't (${extra.slice(0, 3).join(', ')})` : ''}${extra.length && missing.length ? ' and ' : ''}${missing.length ? `not ${missing.length} of its files (${missing.slice(0, 3).join(', ')})` : ''}`,
    );
  // A compare from `base` to a head that holds it, listed whole; the culprit's files it changes.
  const changed = (c) => {
    if (!['ahead', 'identical'].includes(c?.status) || !Array.isArray(c?.files) || c.files.length >= 300) return null;
    return pullFilePaths(c.files).filter((f) => own.has(f));
  };
  const since = changed(sinceCulprit);
  if (!since) return no(`main's history since ${short} could not be read whole, or does not hold it`);
  if (since.length) return no(`main changed ${since.length} of its files since ${short} (${since.slice(0, 3).join(', ')})`);
  if (!changed(parentOnMain)) return no("its commit's parent is not in main's history");
  const base = changed(parentSince);
  if (!base) return no(`its commit's parent does not hold ${short}`);
  if (base.length) return no(`its commit's parent has ${base.length} of the reverted files changed since ${short}`);
  const left = changed(restored);
  if (!left) return no("its head could not be compared with the reverted commit's parent");
  if (left.length) return no(`${left.length} of the reverted files differ from before ${short} (${left.slice(0, 3).join(', ')})`);
  return {
    ok: true,
    sha,
    why: `a pure revert of ${short}: merged, main's tree has its ${own.size} file(s) back as main held them before it and nothing else changed, so no journeys are judged here; main's full journeys run after the merge judges it`,
  };
}

/**
 * Reads what pureRevert needs through `io` (pullCommits, commit, compare(base, head)), only for main-bisect's branch.
 * `main`: the branch (or, for a dry run, the commit) the merge lands on. A read that fails is `{ ok: false }`.
 */
export async function readPureRevert({ io, repo, pull, number, paths, main = pull?.base?.ref }) {
  if (!AUTO_REVERT_BRANCH.test(String(pull?.head?.ref ?? ''))) return null;
  try {
    const commits = await io.pullCommits(number);
    const origin = autoRevertOrigin({ pull, repo, commits });
    if (!origin?.sha) return pureRevert({ origin });
    const head = String(pull.head.sha);
    const parents = commits[0]?.parents ?? [];
    const parent = parents.length === 1 ? parents[0]?.sha : null;
    const culprit = await io.commit(origin.sha);
    const before = culprit?.parents?.[0]?.sha;
    if (!SHA40.test(String(parent)) || !SHA40.test(String(before)) || !main) return pureRevert({ origin, culprit, parent, paths });
    const [sinceCulprit, parentOnMain, parentSince, restored] = await Promise.all([
      io.compare(origin.sha, main),
      io.compare(parent, main),
      io.compare(origin.sha, parent),
      io.compare(before, head),
    ]);
    return pureRevert({ origin, culprit, parent, paths, sinceCulprit, parentOnMain, parentSince, restored });
  } catch (e) {
    return { ok: false, why: `not a pure revert: it could not be read (${e.message}), so the seal judges it in full` };
  }
}

/** What the journeys run's planner (real-app-journeys.yml, `--auto-revert-scope`) reads: the narrow files, or null for
 *  the ordinary scope (journey-touch.mjs). Pure. */
export const autoRevertPlan = (scope) => (scope?.ok ? { files: scope.files, why: scope.why } : { files: null, why: scope?.why ?? '' });

/** The culprit pull request number an automatic revert's title names, or null. */
export const autoRevertCulprit = (title) => Number(CULPRIT_PULL.exec(String(title ?? ''))?.[1]) || null;

/** Reads what autoRevertScope needs through `io` (pullCommits, commit, pull, journeyFiles), only for a revert/auto- branch. */
export async function readAutoRevertScope({ io, repo, pull, number, paths }) {
  if (!AUTO_REVERT_BRANCH.test(String(pull?.head?.ref ?? ''))) return null;
  const commits = await io.pullCommits(number);
  const sha = REVERTS_COMMIT.exec(String(commits?.[0]?.commit?.message ?? ''))?.[1];
  const culprit = sha ? await io.commit(sha) : null;
  const n = autoRevertCulprit(pull.title);
  const culpritTitle = n ? String((await io.pull(n))?.title ?? '') : '';
  const journeyFiles = await io.journeyFiles(pull.head.sha);
  return autoRevertScope({ pull, repo, paths, commits, culprit, culpritTitle, journeyFiles });
}

/**
 * Why an automatic revert may no longer merge, or null: main's newest finished journeys run passed every step its body
 * names outright, on a head that holds the culprit and is past the red run's (journeys-revert.mjs spentWhy, the rule
 * `spent` closes it by). A fix forward landed, and the revert would undo a change that is no longer the cause (intafaced
 * #9482: its auto-merge stayed armed after #9483 fixed J-identity-10 #1 forward, until a person turned it off;
 * project-state#3637). Anything unread (no finished run, no report, a compare that can't say) leaves it to merge, as
 * `spent` leaves it open. `io`: mainRuns, reportOf ({ states } or { error }), contains(sha, head).
 */
export async function revertSpent({ io, repo, pull, culprit }) {
  if (!io.mainRuns || !io.reportOf || !io.contains) return null;
  const all = (await io.mainRuns()) ?? [];
  const newest = all
    .filter((r) => isMainRun(r, repo) && r?.path === JOURNEYS_WORKFLOW && r?.repository?.full_name === repo)
    .filter((r) => r.status === 'completed' && !['cancelled', 'skipped'].includes(r.conclusion))
    .sort(newestCreated)[0];
  if (!newest || !SHA40.test(String(newest.head_sha))) return null;
  const rep = await io.reportOf(newest);
  if (!rep || rep.error) return null;
  const redHead = all.find((r) => r.id === redRunOf(pull.body))?.head_sha;
  const d = spentWhy(pull, {
    repo,
    states: new Map(Object.entries(rep.states ?? {})),
    holdsCulprit: SHA40.test(String(culprit)) ? await io.contains(culprit, newest.head_sha) : false,
    pastRed: SHA40.test(String(redHead ?? '')) ? await io.contains(redHead, newest.head_sha) : false,
  });
  return d.close
    ? `main no longer needs this revert: main's journeys run ${newest.run_number ?? newest.id} on ${newest.head_sha.slice(0, 10)} ${d.why}, so it would undo a change that is not the cause (journeys-revert.mjs spent closes it)`
    : null;
}

/**
 * The changed journey test files of a pull request with the steps each holds, read at the head (the base for a removed
 * file). `text(path, ref)` is the file's text, or null when the ref has no such file. A file whose head holds no step
 * takes the steps its base held (`from: 'base'`): retitling a file's last `<journey> #n` out of it still touches those
 * steps, so they are judged on the head like any other (#10825 retitled J-derivatives-04.pw.mjs's custodial #1 and #2,
 * which J-derivatives-04-venue.pw.mjs holds, and the seal failed closed on a file with no step left). A file with no
 * step at the head or the base lists `siblings`: the other files of its journey at the head (`journeyFiles(ref)`, their
 * names, as io.journeyFiles gives them) that hold its numbered steps, so a journey's companion file of unnumbered checks
 * is not refused for holding none; without `journeyFiles` it lists none, and judgeTouched fails it closed.
 */
export async function touchedSteps({ paths, head, base, text, journeyFiles = null }) {
  const out = [];
  let names;
  const dir = 'apps/customer/tests/real-app';
  for (const file of [...new Set(paths)].sort()) {
    const m = JOURNEY_TEST.exec(file);
    if (!m) continue;
    const atHead = await text(file, head);
    const atBase = atHead === null || !fileSteps(m[1], atHead).length ? await text(file, base) : null;
    if (atHead === null && atBase === null) throw new Error(`${file} could not be read at the head or the base`);
    const steps = fileSteps(m[1], atHead ?? atBase);
    if (steps.length || atHead === null) {
      out.push({ file, journey: m[1], steps });
      continue;
    }
    const before = fileSteps(m[1], atBase);
    if (before.length) {
      out.push({ file, journey: m[1], steps: before, from: 'base' });
      continue;
    }
    const siblings = [];
    if (journeyFiles) {
      names ??= [...(await journeyFiles(head))].sort();
      for (const n of names) {
        const f = `${dir}/${n}`;
        if (f === file || JOURNEY_TEST.exec(f)?.[1] !== m[1]) continue;
        if (fileSteps(m[1], await text(f, head)).length) siblings.push(f);
      }
    }
    out.push({ file, journey: m[1], steps: [], siblings });
  }
  return out;
}

// ---- Reds inherited from main (owner decision 180: only the broken area stops) ----

/** How many of main's newest runs the seal reads to find the one this head's history holds. */
export const MAIN_LOOKBACK = 10;
/** A break range wider than this many commits (or one GitHub's compare can't list whole) can't be bounded; each commit
 *  in it is read on its own (rangeFromCommits), so this also caps the seal's reads. */
export const RANGE_MAX = 40;
export const journeyOf = (step) => String(step).split('#')[0];
/** The package a path is in (`services/svc-wallet`), or the path itself outside one. */
export const packageOf = (path) => /^(?:apps|services|packages|tooling)\/[^/]+(?=\/)/.exec(String(path))?.[0] ?? String(path);
/**
 * The areas a changed path is in: always its package (a breaking commit blocks merges into the packages it touches,
 * AGENTS.md floor 5; REVIEW.md's record of owner decision 180, "the packages the commits on main since the step last
 * passed there changed"), and for a journey test file its journey too (`journey J-bank-13`). Every path counts, a unit
 * test or a CI file included (CI review on e288d257: dropping them narrowed the area past the decision).
 */
export function areasOf(path) {
  const m = JOURNEY_TEST.exec(String(path));
  return m ? [packageOf(path), `journey ${m[1]}`] : [packageOf(path)];
}
/** A verdict line without its run numbers, so the same red read from two runs compares equal. */
const reasonOf = (why) => String(why).replace(/\d+/g, 'N');
/** Main's runs in creation order, newest first: a re-run attempt of an older run is not newer than a later run. */
const newestCreated = (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.run_number - a.run_number || b.id - a.id;

/**
 * The finished full Real-app journeys run on main that a pull request's red steps are compared with: of main's own
 * runs (journey-verdict.mjs isMainRun) whose commit the head contains (`contains(sha)`), the newest by creation that
 * finished, read with the same verdict as the head's run. A run short of journey files (a shard lost) can't say what
 * main had and is passed over; so is a cancelled or skipped one. Returns { run, red: Map(step → verdict line), lastPass,
 * problems } or null when none of main's newest MAIN_LOOKBACK runs is in the head's history.
 */
export async function mainReference({ repo, mainRuns, contains, reportOf, verdictOf }) {
  const mine = (mainRuns ?? [])
    .filter((r) => isMainRun(r, repo) && r?.path === JOURNEYS_WORKFLOW && r?.repository?.full_name === repo)
    .filter((r) => r.status === 'completed' && !['cancelled', 'skipped'].includes(r.conclusion))
    .sort(newestCreated)
    .slice(0, MAIN_LOOKBACK);
  for (const r of mine) {
    if (!SHA40.test(String(r.head_sha)) || !(await contains(r.head_sha))) continue;
    const rep = (await reportOf(r)) ?? { error: 'no report' };
    if (rep.error) throw new Error(`main's run ${r.id} report couldn't be read (${rep.error})`);
    const v = await verdictOf(rep, r);
    if (v.missing?.length) continue;
    const problems = v.red.filter((x) => x.step === '(input)').map((x) => x.why);
    return { run: r, red: new Map(v.red.map((x) => [x.step, x.why])), lastPass: v.lastPass ?? {}, problems };
  }
  return null;
}

/**
 * Which of a head's red steps (`red`: [{ step, why }]) stop this pull request. A red step is inherited when main's
 * reference run (mainReference) is red on it too, with the same verdict line (run numbers aside: the verdict names the
 * kind of red, "failing, not in the baseline", not the failure itself). An inherited red stops only a pull request in
 * its area (owner decision 180: "the failing steps' journeys and the code paths the bisected PR touched"):
 *   - one that touches its journey: a journey test file of it, or a step of it in the title or on a Left-or-replaced
 *     line (`touches.journeys`);
 *   - one whose paths share an area (areasOf) with a commit on main from where the step last passed to the newest main
 *     commit the head holds (`upTo`): the commits one of which broke it, and any that tried to fix it since
 *     (`rangeOf(from, to)` → { files, commits } from GitHub's compare).
 * With no such run in the head's history, main's newest finished full run (`latest`) is the reference run instead.
 * A pull request that changes the journey stack's shared setup (`touches.shared`: it reaches every journey) is in every
 * red's area, so nothing it inherited is passed over. A money step's red (the verdict's
 * money rule) is never passed over, for any pull request. (A pass on the retry is no longer a red at all: the lead's
 * decision of 12 Nov 2026 under OWNER 296 and 297, journey-verdict.mjs.)
 * A red that can't be bounded stops every pull request it reaches: an unreadable input, main's reference run with an
 * input problem, no finished full run on main at all, or a break range that can't be read, is wider than RANGE_MAX commits or lists files
 * short, or a step that never passed on main (no commit bounds where it broke; council review G1). A step that last
 * passed on the commit it now fails on (a flake: no commit between) has its journey as its whole area. Every other red
 * (new on this head) stops it as before. Returns { blocking, passed, notes }.
 */
/** Whether main's reference run is red on this step with the same verdict line (run numbers aside). */
const sameOnMain = (main, x) => x.step !== '(input)' && main.red.has(x.step) && reasonOf(main.red.get(x.step)) === reasonOf(x.why);

/**
 * What kind of red a seal is, for its title (project-state OWNER 289; `10-D-one-verdict.md` item 8: "a builder can tell
 * from the PR page alone"): "yours" (a step red on this head and not on main, or a named step that failed), "main's"
 * (every blocking red is one main's reference run shares), "runner" (no result: no finished run, or a report or verdict
 * that can't be read). The kind names the title only; what blocks is unchanged.
 */
export const redKinds = (red) => (red.length && red.every((x) => x.onMain) ? ["main's"] : ['yours']);
export const KIND_ORDER = ['yours', "main's", 'runner'];
export const kindTitle = (kinds, title) => {
  const k = KIND_ORDER.filter((x) => (kinds ?? []).includes(x));
  return k.length ? `${k.join(' + ')}: ${title}` : title;
};

export async function splitInherited({ red, main: inHistory, latest, touches, upTo, rangeOf }) {
  // No finished full run on main in the head's history: main's newest finished full run (`latest`, mainReference read
  // whatever the head holds) stands in, so a red main already has is not counted against this pull request (project-state
  // #3754: 5 of 24 sampled seal holds were this case). Its commit is outside the head, so the break range below reaches
  // past it and the area only widens. With neither, every red counts.
  const main = inHistory ?? latest ?? null;
  if (!main) return { blocking: red, passed: [], notes: [`no finished full run on main is in this head's history, so every red counts`] };
  const at = `main's ${inHistory ? '' : 'newest '}run ${main.run.id} on ${String(main.run.head_sha).slice(0, 10)}${inHistory ? '' : " (none is in this head's history)"}`;
  if (main.problems.length)
    return { blocking: red, passed: [], notes: [`${at} has unreadable inputs (${main.problems[0]}), so every red counts`] };
  if (touches.shared)
    return {
      blocking: red.map((x) => (sameOnMain(main, x) ? { ...x, onMain: true } : x)),
      passed: [],
      notes: [
        `this pull request changes the journey stack's shared setup, which reaches every journey, so every red counts, inherited or not`,
      ],
    };
  const mine = new Set([...touches.paths].flatMap(areasOf));
  const blocking = [];
  const passed = [];
  const ranges = new Map();
  for (const x of red) {
    if (!sameOnMain(main, x)) {
      blocking.push(x);
      continue;
    }
    const journey = journeyOf(x.step);
    const stop = (why) => blocking.push({ step: x.step, why: `${x.why}; inherited from ${at}, ${why}`, onMain: true });
    // A money step is never passed over (REVIEW.md item 3: setting a money step aside is a quarantine); a red the verdict
    // didn't mark either way counts as money.
    if (x.money !== false) {
      stop(`but it is a money step, so it stops every pull request`);
      continue;
    }
    if (touches.journeys.has(journey) || mine.has(`journey ${journey}`)) {
      stop(`and this pull request touches ${journey}`);
      continue;
    }
    const from = main.lastPass[x.step];
    if (from === null || from === undefined) {
      stop(`but it never passed on main, so no commit bounds where it broke and it can't be bounded`);
      continue;
    }
    if (!SHA40.test(String(from))) {
      stop(`but where it last passed can't be read, so it can't be bounded`);
      continue;
    }
    if (!SHA40.test(String(upTo))) {
      stop(`but the newest main commit this head holds can't be read, so it can't be bounded`);
      continue;
    }
    // The commits from where it last passed to main's reference run (one of them broke it), and on to the newest main
    // commit the head holds (any fix tried since); the base read for the latter may be older than the run, so both.
    const one = (to) => {
      const key = `${from}...${to}`;
      if (!ranges.has(key))
        ranges.set(
          key,
          from === to
            ? Promise.resolve({ files: [], commits: 0, short: false })
            : Promise.resolve()
                .then(() => rangeOf(from, to))
                .catch((e) => ({ error: e.message })),
        );
      return ranges.get(key);
    };
    const ends = [...new Set([main.run.head_sha, upTo])];
    const parts = await Promise.all(ends.map(one));
    const bad = parts.find((r) => r?.error || !Array.isArray(r?.files) || !Number.isSafeInteger(r?.commits));
    const range = bad
      ? bad.error
        ? bad
        : {}
      : {
          files: [...new Set(parts.flatMap((r) => r.files))],
          commits: Math.max(...parts.map((r) => r.commits)),
          short: parts.some((r) => r.short),
        };
    const span = `${from.slice(0, 10)}..${ends.map((e) => e.slice(0, 10)).join('/')}`;
    const wide =
      range?.error ??
      (!Array.isArray(range?.files) || !Number.isSafeInteger(range?.commits)
        ? 'not readable'
        : range.commits > RANGE_MAX
          ? `${range.commits} commits, more than ${RANGE_MAX}`
          : range.short
            ? 'its files are not listed whole'
            : null);
    if (wide) {
      stop(`but its break range ${span} can't be bounded (${wide})`);
      continue;
    }
    const broke = new Set(range.files.flatMap(areasOf));
    const hit = [...touches.paths].find((f) => areasOf(f).some((x) => broke.has(x)));
    if (hit)
      stop(
        `and this pull request changes ${printable(hit)} (${printable(areasOf(hit).find((x) => broke.has(x)))}), which a commit in ${span} (where it broke) changed too`,
      );
    else
      passed.push({
        step: x.step,
        why: `${at} has it red too; its area is ${journey} and what ${range.commits} commit(s) in ${span} changed (${[...broke].slice(0, 5).map(printable).join(', ') || 'nothing'}${broke.size > 5 ? `, ${broke.size - 5} more` : ''}), none of which this pull request touches`,
      });
  }
  return { blocking, passed, notes: passed.length ? [`reds inherited from main are read against ${at}`] : [] };
}

/**
 * The lead's decision of 12 Nov 2026 under OWNER 296 and 297, for a pull request that runs its bounded set (journey-touch.mjs
 * pullPick), which stands where a full run stood: "a PR whose seal needs a full journeys run is not held
 * by a step that is already red on main. Such a step is main's, tracked by main's own open issue (`regression` or
 * `flaky`) and repaired there; the PR must still pass every other step. The excuse never applies when the PR changes
 * that step's journey, its test or anything the step's shard reads as a test file; then the step is the PR's."
 * Each red splitInherited still holds (`blocking`) is main's when main's newest finished full run (`latest`, read by
 * mainReference whatever the head holds) is red on it with the same verdict line, an open issue tracks it (labelled
 * `regression` and titled "Journey broken on main: <journey>", or labelled `flaky` and titled "Flaky step on main:
 * <journey> #<n>…"), and the pull request touches neither its journey nor any test file
 * (MAINS_TEST_PATHS). A money step's red (or one the verdict didn't mark either way) is never main's here: as in
 * splitInherited, a money step is never passed over (REVIEW.md item 3). Anything else stays as it was. Never for a pull request that changes the journey stack's shared
 * setup (every red counts there). Returns { blocking, passed }.
 */
export const MAINS_TEST_PATHS = ['apps/customer/tests/', 'apps/customer/playwright'];
const FLAKY_TITLE = /^Flaky (?:money )?step on main: (J-[\w-]+)((?: #\d+)+)\s*$/;
export function trackingIssue(issues, step) {
  const journey = journeyOf(step);
  const n = String(step).split('#')[1];
  return (issues ?? []).find((i) => {
    if (i?.state !== 'open' || i?.pull_request) return false;
    const labels = (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
    if (labels.includes('regression') && i.title === `Journey broken on main: ${journey}`) return true;
    const m = labels.includes('flaky') ? FLAKY_TITLE.exec(String(i.title)) : null;
    return Boolean(m && m[1] === journey && m[2].trim().split(/\s+/).includes(`#${n}`));
  });
}
export function mainsOwn({ blocking, latest, issues, touches }) {
  if (touches.shared || !latest || latest.problems.length) return { blocking, passed: [] };
  const tests = [...touches.paths].find((p) => MAINS_TEST_PATHS.some((t) => p.startsWith(t)));
  const at = `main's newest finished run ${latest.run.id} on ${String(latest.run.head_sha).slice(0, 10)}`;
  const out = { blocking: [], passed: [] };
  for (const x of blocking) {
    const journey = journeyOf(x.step);
    const issue = x.money === false && sameOnMain(latest, x) ? trackingIssue(issues, x.step) : null;
    if (!issue) out.blocking.push(x);
    else if (touches.journeys.has(journey) || tests)
      out.blocking.push({
        ...x,
        why: `${x.why}; ${at} has it red too (#${issue.number}), but this pull request changes ${tests ? printable(tests) : journey}, so it is this pull request's`,
      });
    else out.passed.push({ step: x.step, why: `it is main's: ${at} has it red too and #${issue.number} tracks it there` });
  }
  return out;
}

/** `inherited(red, run)` split, failing closed: when it can't be worked out, every red stops the pull request. */
async function splitOrAll(inherited, red, run) {
  if (!red.length || !inherited) return { blocking: red, passed: [], notes: [] };
  try {
    return await inherited(red, run);
  } catch (e) {
    return { blocking: red, passed: [], notes: [`which reds main already had couldn't be read (${e.message}), so every red counts`] };
  }
}
/** The lines that name each red passed over as inherited, and the main run it was read against. */
const inheritedLines = (split) => [...split.notes, ...split.passed.map((x) => `${x.step} is red on this head and inherited: ${x.why}`)];

/**
 * The paths each commit from `from` (exclusive) to `to` on main changed, unioned, renames by both names: what the
 * commits one of which broke a step touched. Each commit is read on its own, not the net diff, so a package a breaking
 * commit changed and a later one restored still counts (council review G2). `get(path)` is a GitHub GET. A range wider
 * than RANGE_MAX commits is returned with its count and no reads; a commit list or a commit's files GitHub lists short
 * (250 commits, 300 files) marks it short.
 */
export async function rangeFromCommits(get, repo, from, to) {
  const c = await get(`/repos/${repo}/compare/${from}...${to}?per_page=100`);
  if (c?.status === 'identical') return { files: [], commits: 0, short: false };
  if (c?.status !== 'ahead') throw new Error(`${String(to).slice(0, 10)} is ${c?.status} of ${String(from).slice(0, 10)}`);
  const commits = c.total_commits;
  if (!Number.isSafeInteger(commits)) throw new Error('the compare has no commit count');
  if (commits > RANGE_MAX) return { files: [], commits, short: true };
  const list = Array.isArray(c.commits) ? c.commits : [];
  if (list.length !== commits) return { files: [], commits, short: true };
  const files = new Set();
  let short = false;
  for (const { sha } of list) {
    if (!SHA40.test(String(sha))) throw new Error('a commit in the range has no sha');
    const one = await get(`/repos/${repo}/commits/${sha}`);
    if (!Array.isArray(one?.files)) throw new Error(`commit ${String(sha).slice(0, 10)}'s files: not a list`);
    if (one.files.length >= 300) short = true;
    for (const f of pullFilePaths(one.files)) files.add(f);
  }
  return { files: [...files], commits, short };
}

/**
 * What the touched-journeys map needs at seal time (journey-touch.mjs journeyTouch's `reach`), or null when the pull
 * request changes no product path or the seal can't read main's runs or the head's journey files (then product code is
 * full). The map is this script's own copy (the default branch's); its age is counted from main's runs; the journey
 * files and whether a changed service file subscribes to bus events are read at the head. A read that fails leaves
 * the input unknown, which the map reads as full. The map is the build the head's journeys runs chose (mapChosenAt), so
 * the seal holds the runs to the journeys they were told to run.
 */
/**
 * When the map was chosen for `runs` (the head's journeys runs): the head's first pull request run, which every later
 * run on the same head reads its map at too (journey-touch.mjs mapTime), else the newest run, else null. (Failure it
 * prevents: the seal read the map at the head's newest run, so a map rebuilt between a draft's run and its
 * `ready_for_review` widened the bounded set; the ready run then ran the extra journey files after the first had
 * finished: 18 to 25 more minutes on #9244, #9248 and #9251, 20 Nov 2026.) Pure.
 */
export function mapChosenAt(runs) {
  const made = (rs) => rs.map((r) => Date.parse(r?.created_at)).filter(Number.isFinite);
  const pulls = made((runs ?? []).filter((r) => r?.event === 'pull_request'));
  if (pulls.length) return Math.min(...pulls);
  const any = made(runs ?? []);
  return any.length ? Math.max(...any) : null;
}

/** The map the head's journeys runs chose (mapChosenAt, io.reachMap(before)), else this script's copy. */
async function runMap(io, head) {
  let before = Date.now();
  try {
    before = mapChosenAt((io.runs ? await io.runs(head) : []) ?? []) ?? before;
  } catch {}
  return io.reachMap ? await io.reachMap(before) : loadMap();
}

/**
 * What a pull request that names a journey runs (journey-touch.mjs namedInputs, theo-01 part 1), as its journeys run
 * worked it out: the journeys its title or branch names, with a file at the head. Null when it names none, or when the head's journey files can't be read (then the other rules decide,
 * which never ask fewer journeys).
 */
export async function namedSealInputs({ io, pull, head }) {
  const ids = namedJourneyIds({ title: pull?.title, branch: pull?.head?.ref });
  if (!ids.length || !io.journeyFiles) return null;
  let journeyFiles = null;
  try {
    journeyFiles = await io.journeyFiles(head);
  } catch {
    return null;
  }
  // The journeys using a changed stack file, from the head's own text, as the run read them. Unreadable: no narrowing,
  // so the stack file needs the full run.
  let texts = null;
  if (pull?.stack?.length && io.journeyTexts) {
    try {
      texts = await io.journeyTexts(head);
    } catch {
      texts = null;
    }
  }
  return namedInputs({
    ids,
    journeyFiles,
    importers: texts ? (stack) => stackImporters(stack, texts) : null,
  });
}

export async function reachInputs({ io, paths, head, base, text }) {
  const kinds = paths.map((p) => [p, pathKind(p)]);
  const product = kinds.filter(([, k]) => k.product).map(([p]) => p);
  // Read for every change that runs journeys, as the touch job reads it: the map's always-run list goes into a bounded
  // set (journey-touch.mjs pullPick) whatever made the change full.
  if (!kinds.some(([, k]) => k.kind !== 'none') || !io.mainRuns || !io.journeyFiles) return null;
  const map = await runMap(io, head);
  let behind = null;
  try {
    behind = runsBehind(map, await io.mainRuns());
  } catch {
    behind = null;
  }
  let journeyFiles = null;
  try {
    journeyFiles = await io.journeyFiles(head);
  } catch {
    journeyFiles = null;
  }
  const subs = new Map();
  for (const p of product.filter((f) => f.startsWith('services/'))) {
    let t;
    try {
      t = await text(p, head);
    } catch {
      t = undefined; // unreadable: counts as subscribing, so full
    }
    // It, or a file of its service it imports, calls the bus's subscribe (subscribesVia); a file that can't be read is full.
    subs.set(p, t === undefined ? true : t !== null && (await subscribesVia(p, (f) => (f === p ? t : text(f, head)))));
  }
  // What a customer file no run recorded is judged by (journey-reach-map.mjs loadersReach), read as the touch job reads
  // it from its checkout of the head (journey-touch.mjs checkoutHead); a read that fails leaves it unknown, which is full.
  const want = headWanted(map, paths);
  let headIn = null;
  if (want)
    try {
      const mb = await io.mergeBase(base, head);
      if (!SHA40.test(String(mb))) throw new Error('no merge base');
      headIn = await readHead(map, want, {
        read: (p) => text(p, head),
        list: (d) => io.dirNames(d, head),
        mergeBase: mb,
        atBase: async (u) => (await text(u, mb)) !== null,
        compare: io.compare,
      });
    } catch {
      headIn = {};
    }
  // io.reachMode: a test's stand-in for REACH_MAP_MODE; the seal itself never sets it.
  return {
    map,
    behind,
    journeyFiles,
    subscribes: (p) => subs.get(p) ?? false,
    head: headIn,
    ...(io.reachMode ? { mode: io.reachMode } : {}),
  };
}

/** One pull request's head, judged. */
export async function sealPull({ repo, number, sha, io: given, requireOpen = true, waitOnRunning = true, mainAt }) {
  // Main's runs are read once: for the map's age (reachInputs) and for inherited reds (mainReference).
  let mainRuns;
  const headRuns = new Map();
  const io = {
    ...given,
    ...(given.mainRuns ? { mainRuns: () => (mainRuns ??= Promise.resolve().then(() => given.mainRuns())) } : {}),
    // The head's journeys runs are read once: for the map's build (reachInputs) and for the steps (judgeSteps).
    ...(given.runs
      ? {
          runs: (h) =>
            headRuns.has(h)
              ? headRuns.get(h)
              : headRuns
                  .set(
                    h,
                    Promise.resolve().then(() => given.runs(h)),
                  )
                  .get(h),
        }
      : {}),
  };
  const pull = await io.pull(number);
  const head = String(pull?.head?.sha ?? '');
  if (!SHA40.test(head)) return { ok: false, lines: [`#${number}: its head could not be read`] };
  if (sha && head !== sha)
    return { ok: false, lines: [`#${number}: its head is now ${head}, not ${sha}; the newer head gets its own seal run`] };
  if (requireOpen && pull.merged_at && io.pullsOn) {
    const merged = mergedNothingToSeal(pull, head, await io.pullsOn(head));
    if (merged) return { ok: true, lines: [merged] };
  }
  if (requireOpen && pull.state !== 'open') return { ok: false, lines: [`#${number}: is ${pull.state}`] };
  const paths = await io.files(number);
  const texts = new Map();
  const text = (f, ref) => {
    const k = `${ref}:${f}`;
    if (!texts.has(k)) texts.set(k, Promise.resolve(io.text(f, ref)));
    return texts.get(k);
  };
  const touchedFiles = await touchedSteps({ paths, head, base: pull.base?.sha, text, journeyFiles: io.journeyFiles });
  // The revert main-bisect opens (autoRevertScope): it undoes the culprit's journey tests with it, so it names no steps,
  // and it runs the journeys that failed on main and the culprit's own. Anything else on its branch is ordinary.
  const auto = await readAutoRevertScope({ io, repo, pull, number, paths });
  // A pure revert of it (pureRevert) returns main to a tree main accepted: no journeys are judged here, and main's full
  // journeys run after the merge judges it. `pure.ok` takes the GitHub-revert route below, shared setup included.
  const pure = io.compare ? await readPureRevert({ io, repo, pull, number, paths, main: mainAt }) : null;
  const touched = pure?.ok
    ? { ok: true, lines: [pure.why] }
    : auto?.ok
      ? { ok: true, lines: [`${auto.why}: its journey tests need no steps named`] }
      : judgeTouched({ repo, title: pull.title, body: pull.body, touched: touchedFiles });
  // The journeys this pull request can reach (journey-touch.mjs): a journey test file the head removed runs nothing.
  const atHead = new Map();
  for (const f of paths) if (RUN_FILE.test(f)) atHead.set(f, (await text(f, head)) !== null);
  // GitHub's Revert button (revertOf) undoes a change and adds none, so only shared setup still holds it to a run: a red
  // main is fixed or undone within 2 hours (project-state OWNER 180), as judgeSteps and judgeTouched let it.
  // A revert that touches shared setup takes the ordinary scope, as its run does (real-app-journeys.yml's pick step).
  const reverting = (revertOf({ title: pull.title, body: pull.body, repo }) && !paths.some(isSharedSetup)) || Boolean(pure?.ok);
  // A pull request that names a journey is judged on it and its changed journey files, as its run
  // was given them (namedSealInputs), and its product code goes to the map like any other's. What it must run is what its
  // run was given: never the full suite (journey-touch.mjs pullPick), the same bounded set where the map can't narrow it.
  const stack = paths.filter((p) => pathKind(p).stack);
  const named = reverting || auto?.ok ? null : await namedSealInputs({ io, pull: { ...pull, stack }, head });
  const touchAt = (f) => atHead.get(f) ?? true;
  const inputs = reverting || auto?.ok ? null : await reachInputs({ io, paths, head, base: pull.base?.sha, text });
  // Tooling no journeys run reaches, by the head's tree (journey-touch.mjs quietTooling), as the run's planner reads it.
  // A seal that can't scan it judges by today's rules.
  let tooling = null;
  if (!reverting && !auto?.ok && io.toolingReach && mayBeQuiet(paths))
    try {
      tooling = (await io.toolingReach(head)) ?? null;
    } catch {
      tooling = null;
    }
  const reach = reverting
    ? { mode: 'none', full: [], files: [] }
    : auto?.ok
      ? { mode: 'files', full: [], files: auto.files, reach: [auto.why] }
      : pullPick(paths, journeyTouch(paths, touchAt, inputs, named, tooling), { atHead: touchAt, reach: inputs, named });
  // A stack file narrowed to the journeys using it (theo-01 part 2) no longer needs the full run as shared setup.
  const narrowed = new Set(reach.stack ?? []);
  const shared = reverting ? [] : paths.filter((p) => isSharedSetup(p) && !narrowed.has(p));
  const derived = touched.derived ?? [];
  const runs = titleSteps(pull.title).length || derived.length || shared.length || reach.mode !== 'none' ? await io.runs(head) : [];
  const reports = new Map();
  const reportOf = (r) => {
    if (!reports.has(r.id)) reports.set(r.id, io.reportOf(r));
    return reports.get(r.id);
  };
  // A run on this head carries its earlier attempts' reports too (`earlier`), so a step one of them failed is never
  // hidden by a re-run that passed it (flakyWay). Main's runs, read for inherited reds, keep reportOf alone.
  const headReports = new Map();
  const headReportOf = (r) => {
    if (!headReports.has(r.id))
      headReports.set(
        r.id,
        Promise.resolve(reportOf(r)).then(async (rep) =>
          rep && !rep.error && io.earlierReports && Number(r.run_attempt ?? 1) > 1 ? { ...rep, earlier: await io.earlierReports(r) } : rep,
        ),
      );
    return headReports.get(r.id);
  };
  const steps = await judgeSteps({
    sha: head,
    repo,
    title: pull.title,
    body: pull.body,
    runs,
    reportOf: headReportOf,
    waitOnRunning,
    derived,
  });
  const verdictOf = (rep, r) => io.verdictOf(rep, r);
  // This head's own runs: a step whose baseline money flag main's money rule disagrees with (`mismatch`) is judged again
  // with this head's money rule too, read once and only then (journey-verdict.mjs judge, headMoney). Main's runs keep
  // main's rule alone. The flag a pull request can change for itself is only ever read the stricter way.
  // A pull request that changes a file the rule or the baseline is read from (moneyInput) is always judged with its head's
  // rule and the baseline it would merge, so it can't make a baselined step money unseen (#9539); unreadable, it fails closed.
  const changesMoney = paths.filter(moneyInput);
  let headMoney;
  const ownVerdictOf = async (rep, r) => {
    const v = await verdictOf(rep, r);
    if (!io.headMoney || !(changesMoney.length || (v?.red ?? []).some((x) => x?.mismatch))) return v;
    let got;
    try {
      got = await (headMoney ??= Promise.resolve().then(async () => {
        const rule = await io.headMoney(head);
        if (!paths.includes(BASELINE_PATH)) return { headMoney: rule };
        const t = await text(BASELINE_PATH, head);
        if (typeof t !== 'string') throw new Error(`${BASELINE_PATH} is not on this head`);
        return { headMoney: rule, headBaseline: JSON.parse(t) };
      }));
    } catch (e) {
      const why = `; this head's own money rule couldn't be read (${e.message}), so it stays red`;
      const red = v.red.map((x) => (x?.mismatch ? { ...x, why: x.why + why } : x));
      if (changesMoney.length)
        red.push({
          step: '(input)',
          why: `this pull request changes ${changesMoney.slice(0, 3).join(', ')}${changesMoney.length > 3 ? `, ${changesMoney.length - 3} more` : ''}, which the money rule or the baseline is read from, and its head's couldn't be read (${e.message}), so the seal fails closed`,
        });
      return { ...v, red };
    }
    return io.verdictOf(rep, r, got);
  };
  // The area of this pull request, for reds it inherited from main (splitInherited): the journeys it touches and its paths.
  const touches = {
    journeys: new Set([
      ...touchedFiles.map((t) => t.journey),
      ...[...titleSteps(pull.title), ...exemptions(pull.body).steps].map(journeyOf),
      // The journeys a narrowed stack file can break: a red there is this pull request's area, inherited or not.
      ...(reach.importers ?? []).map((f) => JOURNEY_TEST.exec(`apps/customer/tests/real-app/${f}`)?.[1]).filter(Boolean),
    ]),
    paths: new Set(paths),
    shared: shared.length > 0,
  };
  let main;
  let upTo;
  let latest;
  let issues;
  // `full`: the pull request runs its bounded set (pullPick's `bounded`, where a full run stood before 20 Nov 2026), the
  // only case where a red main tracks as its own is passed (mainsOwn).
  const inheritedFor = (full) =>
    io.mainRuns
      ? async (red) =>
          splitInherited({
            red,
            main: await (main ??= mainReference({
              repo,
              mainRuns: await io.mainRuns(),
              contains: (sha) => io.contains(sha, head),
              reportOf,
              verdictOf,
            })),
            // Only when none of main's runs is in the head's history (splitInherited).
            latest: (await main)
              ? null
              : await (latest ??= mainReference({
                  repo,
                  mainRuns: await io.mainRuns(),
                  contains: async () => true,
                  reportOf,
                  verdictOf,
                })),
            touches,
            upTo: await (upTo ??= Promise.resolve()
              .then(() => io.mergeBase(pull.base?.sha, head))
              .catch(() => null)),
            rangeOf: io.rangeOf,
          }).then(async (split) => {
            // A red main already has on its newest run and tracks in an open issue is main's (mainsOwn).
            if (!full || !io.mainIssues || touches.shared || !split.blocking.length) return split;
            const own = mainsOwn({
              blocking: split.blocking,
              latest: await (latest ??= mainReference({
                repo,
                mainRuns: await io.mainRuns(),
                contains: async () => true,
                reportOf,
                verdictOf,
              })),
              issues: await (issues ??= io.mainIssues()),
              touches,
            });
            return { ...split, blocking: own.blocking, passed: [...split.passed, ...own.passed] };
          })
      : null;
  const inherited = inheritedFor(Boolean(reach.bounded));
  const full =
    reach.mode === 'files'
      ? await judgeTouchedRun({
          sha: head,
          repo,
          files: reach.files,
          runs,
          reportOf: headReportOf,
          verdictOf: ownVerdictOf,
          waitOnRunning,
          inherited,
          reach: reach.bounded ? [reach.bounded] : reach.reach,
          named: reach.named,
          branch: pull.head?.ref ?? null,
        })
      : { ok: true, state: 'none', lines: [] };
  // An automatic revert merges only while main still needs it (revertSpent), whatever its own runs say.
  const culprit = pure?.ok ? pure.sha : auto?.ok ? auto.sha : null;
  const spent = culprit ? await revertSpent({ io, repo, pull, culprit }).catch(() => null) : null;
  const v = {
    ok: steps.ok && full.ok && touched.ok && !spent,
    stepsOk: steps.ok && touched.ok && !spent,
    fullOk: full.ok,
    // The kind of each red, for its title (redKinds); a touched-step problem is the pull request's own.
    stepsKinds: [
      ...(steps.ok ? [] : (steps.kinds ?? ['yours'])),
      ...(touched.ok ? [] : (touched.kinds ?? ['yours'])),
      ...(spent ? ['yours'] : []),
    ],
    fullKinds: full.ok ? [] : (full.kinds ?? []),
    lines: [...steps.lines, ...touched.lines, ...full.lines, ...(pure && !pure.ok ? [pure.why] : []), ...(spent ? [spent] : [])],
  };
  return { ...v, lines: v.lines.map((l) => `#${number} (${head.slice(0, 10)}): ${l}`) };
}

export const SEAL = 'CI merge seal';
const SEAL_POLL_MS = 20_000;
// 4 minutes, inside the 6-minute limit of each input's START_JOB. A seal still running when the last input ends has
// nothing left to wait for (the CI review is one of the inputs, so review-marker.mjs's wait is over): seconds.
const SEAL_POLLS = 12;

/** The workflow file that holds the seal job a pull request runs in its own version. */
export const CI_WORKFLOW = 'ci.yml';

/**
 * Every workflow that holds a `CI merge seal` job, with the event it runs on. ci.yml's runs in the pull request's own
 * version; merge-seal.yml's runs on pull_request_target from the default branch, so its job and scripts are main's
 * whatever a pull request changes (R3 C3 piece 2, OWNER 242). Each workflow's newest run on a head counts, and each
 * must pass (probe #7547, 8 Nov 2026: a red ci.yml job blocked beside a green probe workflow's), so the default branch's
 * seal decides even when a pull request edits its own; an older run of the same workflow is not read (probe #8246).
 */
export const SEAL_WORKFLOWS = [
  { workflow: CI_WORKFLOW, event: 'pull_request' },
  { workflow: 'merge-seal.yml', event: 'pull_request_target' },
];

/**
 * The seal gives one verdict once its inputs have finished (INTAFACED/project-state#1574, 9 Nov 2026). On a push, open,
 * reopen or edit, merge-seal.yml's first attempt skips its seal job, whose check run then carries the raw text of the
 * job's name expression, never `CI merge seal` (probe intafaced#7679), so it neither passes nor fails anything: the
 * required check is simply not there yet, and a missing required check blocks the merge. When the last input finishes
 * (CI, the CI review, and the journeys run when the change needs one), the re-check re-runs that run, and its next
 * attempt is the verdict. Before this, the seal was red from every push until a re-run (375 of 510 runs in a day).
 *
 * A pull request could add its own job named `CI merge seal` and pass it while the real seal waits. So the first attempt
 * seals at once, as before, whenever the change touches `.github/` or its head's ci.yml still names its seal job
 * `CI merge seal` on a pull request (sealNow); on a pull request ci.yml's job is named `CI jobs` (CI_JOBS_NAME).
 */
export const CI_JOBS_NAME = "${{ github.event_name == 'merge_group' && 'CI merge seal' || 'CI jobs' }}";

/** A skipped first attempt of merge-seal.yml's seal job: the check run's name is its expression's raw text. */
export const isWaitingSeal = (j) =>
  j?.name !== SEAL && j?.status === 'completed' && j?.conclusion === 'skipped' && String(j?.name ?? '').includes("'CI merge seal'");

/** The workflows whose runs on a head are the seal's inputs, with the event their pull request runs carry. */
export const SEAL_INPUTS = [
  // Runs on every pull request (`always`), so none on the head is one still to come, never a finished input: GitHub starts
  // no pull_request run while the pull request conflicts with its base, and may start one a minute or two after this
  // asks. Before 25 Nov 2026 the seal read "nothing going" there and judged at once, red on "no CI ran" (ci-jobs-seal.mjs
  // judgeCiJobs, whose own answer is `wait`): 42 of the 82 heads red on the seal alone in the 48 h to 25 Nov 00:43 UTC,
  // 36 conflicting with main and 6 sealed before their CI run was created (INTAFACED/project-state#4047).
  { workflow: 'ci.yml', event: 'pull_request', what: 'CI', always: true },
  { workflow: 'ci-review.yml', event: 'pull_request_target', what: 'the CI review', judge: true },
  { workflow: 'real-app-journeys.yml', event: null, what: 'Real-app journeys', journeys: true },
  // Runs only when the pull request touches its paths (#8708); with no run on the head nothing waits for it, and
  // ci-jobs-seal.mjs moneyVerdict fails the seal when its paths were touched and no green run is there.
  { workflow: 'customer-money-browser.yml', event: 'pull_request', what: 'the money browser checks' },
  // Runs on every pull request; its `Model check` job checks the TLA+ models when the change touches what they cover
  // (project-state#2962), and ci-jobs-seal.mjs modelVerdict requires its pass. A run that could not check (MODEL_DOWN_STEP)
  // counts as still going, so the seal waits as for a down judge, never red on the change.
  { workflow: 'model-check.yml', event: 'pull_request', what: 'the Model check', down: true },
];

/** model-check.yml's verdict job, and its step that runs, instead of the Verdict step, when TLC could not check. */
export const MODEL_JOB = 'Model check';
export const MODEL_DOWN_STEP = 'Judge down';
export const MODEL_VERDICT_STEP = 'Verdict';
/** Whether a model-check.yml `Model check` job ended without a verdict because a model could not be checked. Pure. */
export const isModelDown = (job) =>
  job?.name === MODEL_JOB &&
  job?.status === 'completed' &&
  (job.steps ?? []).some((s) => s?.name === MODEL_DOWN_STEP && s?.conclusion === 'success') &&
  !(job.steps ?? []).some((s) => s?.name === MODEL_VERDICT_STEP && ['success', 'failure'].includes(s?.conclusion));

/**
 * The job each seal input ends with (ci.yml, ci-review.yml, real-app-journeys.yml): it needs every other job of its
 * run, and runs `--recheck` from the default branch, which starts or re-runs the seal once the last input on the head
 * has finished. Before 9 Nov 2026 a separate workflow did this on each input's `workflow_run`, and each of those was a
 * run of its own whether it did anything or not: 129 in the 53 minutes after 13:51 UTC that day, 50 of them skipped
 * (INTAFACED/project-state#1574). The seal reads an input run whose only job still going is this one as finished
 * (settledRun), since this job is what starts it.
 */
export const START_JOB = 'Start the seal';

/**
 * `run` as the seal reads it, given its latest-attempt `jobs`: a run still going only because its START_JOB is (queued
 * or running, so every job it needs has ended) is read as finished, with the conclusion its other jobs give; any other
 * run is returned as it is. Pure.
 */
export function settledRun(run, jobs) {
  if (run?.status === 'completed' || !Array.isArray(jobs)) return run;
  const start = jobs.filter((j) => j?.name === START_JOB);
  const rest = jobs.filter((j) => j?.name !== START_JOB);
  if (!start.length || !start.every((j) => ['queued', 'in_progress'].includes(j?.status))) return run;
  if (!rest.length || rest.some((j) => j?.status !== 'completed')) return run;
  const c = rest.map((j) => j?.conclusion);
  const conclusion = c.some((x) => ['failure', 'timed_out', 'startup_failure'].includes(x))
    ? 'failure'
    : c.includes('cancelled')
      ? 'cancelled'
      : 'success';
  return { ...run, status: 'completed', conclusion, settled: true };
}

/** `runs` with each one still going read through settledRun; `jobsOf(id)` lists a run's latest-attempt jobs. */
export async function settleRuns(runs, jobsOf) {
  const out = [];
  for (const r of runs ?? []) out.push(r?.status === 'completed' ? r : settledRun(r, await jobsOf(r.id)));
  return out;
}

/** inputsGoing's words for an `always` input with no run on the head (waitStep reads them). */
export const NO_RUN = 'no run on this head yet';

/**
 * The input runs still going on `sha` (`runsOf[workflow]`, each workflow's runs on the head), as lines; [] when every
 * input has finished. An `always` input with no run on the head counts as going (NO_RUN). Journeys count only when the change needs them (`needJourneys`: it names steps, or its paths reach
 * a journey, journey-touch.mjs); a change that reaches none never waits for a journeys run. A CI review run that ended
 * with the judge down (`judgeDown`, set by readGoing on the head's newest run: review-marker.mjs isJudgeDown) counts as
 * still going when `needJudge` (readGoing sets it when a pull request's change needs the review's verdict), so its seal waits for the judge exactly as for a review
 * still running, and is started when a review on the head next finishes (project-state OWNER 289 point 11: "A judge
 * that stops shows as 'judge down' ... never as red PRs. No PR merges without its judge."). `unstarted` false (the
 * re-check, readGoing): a CI review run not yet started (UNSTARTED) is not counted, since only a run whose review job runs
 * starts the seal at its end (ci-review.yml's seal-start skips with it), and the seal the re-check starts waits for that
 * run in WAIT_STEP all the same. Pure.
 */
export function inputsGoing({ sha, runsOf, needJourneys, needJudge = false, unstarted = true }) {
  const out = [];
  for (const { workflow, event, what, journeys, judge, down, always } of SEAL_INPUTS) {
    if (journeys && !needJourneys) continue;
    const onHead = (runsOf?.[workflow] ?? []).filter((r) => r?.head_sha === sha && (!event || r?.event === event));
    if (always && !onHead.length)
      out.push(`${what}: ${NO_RUN} (GitHub starts none while the pull request conflicts with its base: merge main)`);
    for (const r of onHead) {
      if (judge && !unstarted && UNSTARTED.includes(r?.status)) continue;
      if (r?.status !== 'completed') out.push(`${what} run ${r.id} (${r.status})`);
      else if (journeys && r?.deferred === true)
        out.push(`${what} run ${r.id} (deferred behind main's journeys; it is re-run once main's shards are queued)`);
      else if (judge && needJudge && r?.judgeDown === true)
        out.push(`${what} run ${r.id} (judge down: no verdict; it re-runs when the judge is back)`);
      else if (down && r?.judgeDown === true)
        out.push(`${what} run ${r.id} (judge down: a model could not be checked, no verdict; re-run it once the cause in its log is gone)`);
    }
  }
  return out;
}

/**
 * A run's statuses before any of its jobs starts. A CI review run waits as `pending` in its head's concurrency group behind
 * the run already reviewing that head; a title or body edit's run then skips every job, its Start the seal too. The
 * re-check that left the seal for such a run's end left it for good: intafaced #8574's seal never ran on 363a0e9b, 16 Nov
 * 2026, after `gh pr ready` and its edit at 02:03:59 UTC started runs 43789888663 and 43789888130 (project-state #2548).
 */
export const UNSTARTED = ['requested', 'queued', 'pending', 'waiting'];

/** Whether the change needs a journeys run: its title names steps, or its paths reach a journey (journey-touch.mjs). */
export const needsJourneys = (pull, files) => namesSteps(pull?.title ?? '') || journeyTouch(files).mode !== 'none';

/**
 * Whether merge-seal.yml's first attempt seals at once rather than waiting for its inputs (see CI_JOBS_NAME), with why.
 * `files` are the change's paths; `headCi` the text of ci.yml at the head (null when it has none); `going` what
 * inputsGoing returns. Pure.
 */
export function sealNow({ files, headCi, going, verdict = false }) {
  const gh = (files ?? []).filter((f) => f.startsWith('.github/'));
  if (gh.length)
    return {
      now: true,
      why: `the change touches ${gh[0]}${gh.length > 1 ? ` and ${gh.length - 1} more under .github/` : ''}, which could add its own seal`,
    };
  if (!String(headCi ?? '').includes(`name: ${CI_JOBS_NAME}`))
    return { now: true, why: "the head's ci.yml still names its seal job `CI merge seal` on a pull request" };
  if (!going.length) return { now: true, why: 'every input on this head has finished' };
  // A verdict already on the head (an edit, a reopen): judge again at once, so the old verdict never stands while an
  // input is re-running (CI review on e1ba6699: an edit naming a red step must never merge on the earlier green).
  if (verdict) return { now: true, why: 'a seal verdict is already on this head, so this change re-judges it now' };
  return { now: false, why: `waiting for ${going.join(', ')}; the re-check starts the seal when the last one finishes` };
}

/**
 * ci.yml's seal steps that read what a re-check or the CI review changes (the named steps, the review). Since 9 Nov 2026
 * ci.yml runs them only on a merge queue's commit; on a pull request they are merge-seal.yml's alone, the default
 * branch's copy (INTAFACED/project-state#1574). A head whose own ci.yml predates that still runs them in ci.yml's seal.
 */
export const PR_READ_STEPS = new Set(['Require the named journey steps on this exact head', 'Require the CI review on this exact head']);

/**
 * Whether a re-check or the CI review re-runs ci.yml's seal job `job` (its jobs-API object, with `steps`): only when it
 * is red on a PR_READ_STEPS step, which only an older ci.yml on the head runs. Red on CI's own jobs, a re-run reads the
 * same jobs, and as a new attempt of the CI run it would start another re-check when it ends (the loop of #1574). Green,
 * merge-seal.yml's re-run decides. Pure.
 */
export const ciSealReads = (job) =>
  job?.conclusion !== 'success' && (job?.steps ?? []).some((s) => PR_READ_STEPS.has(s?.name) && s?.conclusion === 'failure');

/**
 * What to do about a head's seal once its steps' inputs changed (a journeys run finished, a title or body was edited):
 * re-run it whatever its colour, since a newer run or an edit can turn a green seal red as well as a red one green.
 * Read through the Actions API with the workflow's own GITHUB_TOKEN (`actions: read` and `write`), not the Checks API:
 * `runs` are CI_WORKFLOW's pull_request runs on the head, and `jobs` the newest run's latest-attempt jobs, once read.
 * Pure, so the table is testable.
 */
export function recheckStep(runs, jobsByRun = new Map(), event = 'pull_request') {
  const prs = (runs ?? []).filter((r) => r?.event === event).sort((a, b) => b.id - a.id);
  if (!prs.length) return { act: 'done', msg: 'CI has not run on this head; its seal will read the steps itself' };
  // merge-seal.yml: its newest run decides (below). ci.yml: the newest run that has a seal job decides; a run that
  // finished with none (cancelled before its jobs) is passed over.
  for (const run of prs) {
    const runId = String(run.id);
    if (!jobsByRun.has(runId)) return { act: 'jobs', runId, msg: `reading run ${runId}'s jobs` };
    const seal = (jobsByRun.get(runId) ?? []).filter((j) => j?.name === SEAL).sort((a, b) => b.id - a.id)[0];
    // merge-seal.yml: GitHub reads the required check from the newest run of a workflow on the head alone (probe
    // intafaced#8246, 13 Nov 2026; #8225 stopped every merge for an hour by leaving its verdict on an older run). So the
    // newest run decides: one that finished without its seal (it waited for its inputs, or was cancelled before its jobs)
    // is started, never passed over for an older run's verdict, which GitHub no longer reads.
    if (event === 'pull_request_target' && run.status === 'completed' && (!seal || seal.conclusion === 'skipped'))
      return { act: 'start', runId, msg: `run ${runId}, the newest seal run on this head, has no verdict` };
    // ci.yml: a skipped seal holds no verdict, so the run before it decides.
    if (seal?.status === 'completed' && seal?.conclusion === 'skipped') continue;
    if (!seal || ['queued', 'waiting', 'pending', 'requested'].includes(seal.status)) {
      if (run.status === 'completed') continue;
      // merge-seal.yml's run deciding whether to seal now (sealNow, seconds): wait, so a seal it skips is then started.
      if (event === 'pull_request_target' && run.status === 'in_progress')
        return { act: 'wait', runId, msg: `run ${runId} is deciding whether its seal waits for its inputs` };
      return { act: 'done', msg: 'the seal has not started; it will read the steps itself' };
    }
    // A seal still waiting for its inputs (WAIT_STEP, or judge-repair.mjs's REPAIR_STEP) reads them all once they finish:
    // re-running it would be a second verdict.
    if (
      seal.status !== 'completed' &&
      (seal.steps ?? []).some((s) => [WAIT_STEP, REPAIR_STEP].includes(s?.name) && s?.status !== 'completed')
    )
      return { act: 'done', msg: `the seal in run ${runId} is waiting for its inputs and judges once they finish` };
    if (seal.status !== 'completed')
      return { act: 'wait', runId, msg: 'the seal is running and may have read the steps before this change' };
    if (run.status !== 'completed') return { act: 'wait', runId, msg: `run ${runId} is still finishing` };
    return { act: 'rerun', runId, jobId: String(seal.id) };
  }
  // No verdict yet: the newest run whose first attempt waits for its inputs is started (re-run whole), once they have.
  const read = prs.filter((r) => jobsByRun.has(String(r.id)));
  const waiting = read.find((r) => r.status === 'completed' && jobsByRun.get(String(r.id)).some(isWaitingSeal));
  if (waiting) return { act: 'start', runId: String(waiting.id), msg: `run ${waiting.id} waits for its inputs` };
  if (read.some((r) => jobsByRun.get(String(r.id)).some((j) => j?.name === 'CI jobs')))
    return { act: 'done', msg: "ci.yml's job on this head is `CI jobs`, not a seal; merge-seal.yml's seal decides" };
  return { act: 'fail', msg: `no CI run on this head has a ${SEAL} job (${prs.map((r) => r.id).join(', ')} finished with none)` };
}

/**
 * Whether a re-run of the seal on `sha` may be posted now. A job re-run is a new attempt of its CI run, and a new
 * attempt joins ci.yml's concurrency group (`CI-refs/pull/<n>/merge`, cancel-in-progress off main), so it cancels
 * whatever CI run of that pull request is still in flight. On 7 Nov 2026 a re-check that had waited out the run on
 * 26f9c60d re-ran its seal after the pull request's head had moved to 7ce4bf86f: the old run's attempt 2 started at
 * 14:35:27 UTC and the new head's jobs were cancelled from 14:35:28. Read just before the re-run, never earlier:
 * `pulls` are the named pull requests as they are now; `headRuns` are ci.yml's pull_request runs on `sha`.
 * - `skip`: a pull request closed or its head moved. The new head's own CI seal reads the change; the re-check is green.
 * - `wait`: another CI run on `sha` itself is still going (a reopen, a re-run by hand). Wait it out, as a running seal
 *   is waited out, then re-run; at the bound the re-check goes red. A run on another SHA is not counted: cancelling it
 *   cancels no check the head is judged by, and `?branch=` would also match a fork's branch of the same name.
 * - null: post the re-run.
 * Pure, so the table is testable.
 */
export function rerunBlocker({ sha, pulls, headRuns, event = 'pull_request' }) {
  for (const p of pulls ?? []) {
    if (p?.state !== 'open') return { act: 'skip', msg: `#${p?.number} is no longer open` };
    if (p?.head?.sha !== sha)
      return { act: 'skip', msg: `#${p.number}'s head moved to ${String(p?.head?.sha).slice(0, 10)}; its own CI seal reads the change` };
  }
  const going = (headRuns ?? [])
    .filter((r) => r?.event === event && r?.head_sha === sha && r?.status !== 'completed')
    .sort((a, b) => b.id - a.id);
  if (going.length)
    return {
      act: 'wait',
      msg: `CI run ${going.map((r) => `${r.id} (${r.status})`).join(', ')} on this head is still going; a re-run now would join its concurrency group and cancel it`,
    };
  return null;
}

/**
 * Re-run the seal job on `sha` (recheckStep). `post`/`get` are the API (tests pass their own). `blocker` is read just
 * before each re-run (rerunBlocker): `skip` returns its reason and posts nothing; `wait` polls on inside SEAL_POLLS.
 */
export async function rerunSealJob({
  repo,
  sha,
  get,
  post,
  blocker = async () => null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.log,
  workflow = CI_WORKFLOW,
  event = 'pull_request',
}) {
  let said = '';
  for (let poll = 1; ; poll++) {
    const runs = (await get(`/repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&event=${event}&per_page=100`))
      ?.workflow_runs;
    if (!Array.isArray(runs)) throw new Error(`${workflow} runs on ${sha}: not a list`);
    const jobsByRun = new Map();
    let step = recheckStep(runs, jobsByRun, event);
    while (step.act === 'jobs') {
      const jobs = await runJobs(`/repos/${repo}/actions/runs/${step.runId}/jobs?filter=latest`, get);
      if (!Array.isArray(jobs)) throw new Error(`run ${step.runId}'s jobs: not a list`);
      jobsByRun.set(step.runId, jobs);
      step = recheckStep(runs, jobsByRun, event);
    }
    if (step.act === 'done') return step.msg;
    if (step.act === 'fail') throw new Error(step.msg);
    if (step.act === 'start') {
      const held = await blocker();
      if (held?.act === 'skip') return `not started: ${held.msg}`;
      if (held?.act !== 'wait') {
        const { status, message = '' } = await post(`/repos/${repo}/actions/runs/${step.runId}/rerun`);
        if (status === 403 && /already running/i.test(message)) return `run ${step.runId} is already starting (${message})`;
        if (status !== 201) throw new Error(`could not start the seal run ${step.runId}: HTTP ${status} ${message}`);
        return `started the seal: run ${step.runId}, whose first attempt waited for its inputs`;
      }
      step = { act: 'wait', runId: step.runId, msg: held.msg };
    }
    if (step.act === 'rerun' && workflow === CI_WORKFLOW) {
      const job = (jobsByRun.get(step.runId) ?? []).find((j) => String(j?.id) === step.jobId);
      if (!ciSealReads(job))
        return `not re-run: ci.yml's seal job ${step.jobId} reads only CI's own jobs on this head (${job?.conclusion}); merge-seal.yml's reads the steps and the review`;
    }
    if (step.act === 'rerun') {
      const held = await blocker();
      if (held?.act === 'skip') return `not re-run: ${held.msg}`;
      if (held?.act === 'wait') step = { act: 'wait', runId: step.runId, msg: held.msg };
    }
    if (step.act === 'rerun') {
      const { status, message = '' } = await post(`/repos/${repo}/actions/jobs/${step.jobId}/rerun`);
      // AGENTS.md "Check, then merge" 6: the one 403 that only means wait. Any other 403 or 429 stops and is reported.
      if (status === 403 && /already running/i.test(message)) return `run ${step.runId} is already re-running (${message})`;
      if (status !== 201) throw new Error(`could not re-run the seal job ${step.jobId} of run ${step.runId}: HTTP ${status} ${message}`);
      return `re-ran the seal job ${step.jobId} of run ${step.runId}`;
    }
    if (poll >= SEAL_POLLS)
      throw new Error(`${step.msg} after ${(SEAL_POLLS * SEAL_POLL_MS) / 60_000} min; re-run the seal once it finishes`);
    if (step.msg !== said) log(`${(said = step.msg)}; checking every ${SEAL_POLL_MS / 1000}s`);
    await sleep(SEAL_POLL_MS);
  }
}

/** A title the seal judges: it names steps, or holds a range that can't be read as steps (which fails the seal). */
export const namesSteps = (title) => titleSteps(title).length > 0 || titleProblems(title).length > 0;

/**
 * The open pull requests on `sha` whose seal a re-check re-runs: the title judged now, or before an edit (`oldTitle`),
 * and a body that has an exemption-like line now or had one before the edit (`oldBody`), so removing a line re-runs it.
 * A title edited from "fix J-bank-13" to "J-bank-13 #1-#100" is judged, so its green seal turns red.
 */
export const recheckPulls = ({ pulls, sha, repo, oldTitle = '', oldBody = '', shared = new Set() }) =>
  (pulls ?? [])
    .filter((p) => p?.state === 'open' && p?.head?.sha === sha && p?.base?.repo?.full_name === repo)
    .filter(
      (p) =>
        namesSteps(p.title) ||
        namesSteps(oldTitle) ||
        LOOKS_EXEMPT.test(p.body ?? '') ||
        LOOKS_EXEMPT.test(oldBody ?? '') ||
        shared.has(p.number),
    );

/** The open pull requests on `sha` that `recheckPulls` would not take by their title: their numbers whose changed paths
 *  (`filesOf(n)`) need a journeys run, the full suite or the journey files they touch (journey-touch.mjs). */
export async function sharedPulls({ pulls, sha, repo, filesOf }) {
  const out = new Set();
  for (const p of pulls ?? [])
    if (p?.state === 'open' && p?.head?.sha === sha && p?.base?.repo?.full_name === repo && !namesSteps(p.title))
      if (journeyTouch(await filesOf(p.number)).mode !== 'none') out.add(p.number);
  return out;
}

/** The seals a re-check re-runs: after CI finished (`finished` = 'CI'), only the default branch's (see recheck). */
export const sealsToRecheck = (finished) =>
  SEAL_WORKFLOWS.filter((w) => !['CI', REVIEWED, MONEY, MODEL_JOB].includes(finished) || w.workflow !== CI_WORKFLOW);

/** `finished` after the money browser checks' run on the head ended (#8708): like CI, every armed pull request there is re-sealed. */
export const MONEY = 'Money browser checks';

/** `finished` after the CI review's run on the head ended: like CI, every armed pull request on the head is re-sealed. */
export const REVIEWED = 'CI review';

/**
 * Whether a re-check touches this pull request: only one with auto-merge armed (GitHub's `auto_merge`, set on the pull
 * request objects both the commit's pull request list and the pull request read return). Only an armed pull request
 * merges on its seal, so only its seal is read when it turns; arming runs merge-seal.yml afresh (`auto_merge_enabled`),
 * and so does every push and edit. (Failure it prevents: at 02:45 UTC on
 * 9 Nov 2026, 29 re-checks were queued, each of which can hold a runner up to 25 minutes waiting out a running seal,
 * for pull requests that no merge was waiting on; INTAFACED/project-state#1574 item 4.) One exception, sealedOnReview.
 */
export const armed = (p) => p?.auto_merge !== null && p?.auto_merge !== undefined;

/**
 * After the CI review, a ready pull request is sealed armed or not: a journey build arms only once its proof read is in
 * (project-state BUILDER.md), and that read lands after every check T3's PR watch was waiting for, so nothing woke the
 * builder; the required `CI merge seal` appearing is a wake. One seal per reviewed head, as the review runs only on a
 * ready one. (Failure it prevents: 10 builds sat green and unarmed 12 to 62 minutes until the owed-work check woke
 * them, 23 to 24 Nov 2026, #10625 among them; INTAFACED/project-state#3978.)
 */
export const sealedOnReview = (finished, p) => finished === REVIEWED && p?.draft !== true;

/**
 * The open pull requests a re-check re-seals, of those with auto-merge armed (armed): after CI or the CI review finished
 * (`finished` = 'CI' or REVIEWED), every open pull request into this repository on `sha`, since the default branch's
 * seal reads both; otherwise those recheckPulls takes (named steps, an exemption line, or a change the journeys run
 * judges).
 */
export async function recheckTargets({ finished, pulls, sha, repo, oldTitle = '', oldBody = '', filesOf }) {
  const live = (pulls ?? []).filter((p) => armed(p) || sealedOnReview(finished, p));
  if (finished === 'CI' || finished === REVIEWED || finished === MONEY)
    return live.filter((p) => p?.state === 'open' && p?.head?.sha === sha && p?.base?.repo?.full_name === repo);
  return recheckPulls({ pulls: live, sha, repo, oldTitle, oldBody, shared: await sharedPulls({ pulls: live, sha, repo, filesOf }) });
}

/**
 * Whether merge-seal.yml already gave a verdict on `sha`, and whether one is green: the latest-attempt `CI merge seal`
 * jobs of its finished pull_request_target runs there.
 */
export async function readVerdicts({ get, repo, sha }) {
  const runs = (await get(`/repos/${repo}/actions/workflows/merge-seal.yml/runs?head_sha=${sha}&event=pull_request_target&per_page=100`))
    ?.workflow_runs;
  if (!Array.isArray(runs)) throw new Error(`merge-seal.yml runs on ${sha}: not a list`);
  const out = { any: false, green: false };
  for (const r of runs.filter((x) => x?.head_sha === sha)) {
    const jobs = await runJobs(`/repos/${repo}/actions/runs/${r.id}/jobs?filter=latest`, get);
    if (!Array.isArray(jobs)) throw new Error(`run ${r.id}'s jobs: not a list`);
    for (const j of jobs.filter((x) => x?.name === SEAL)) {
      out.any = true;
      if (j.status === 'completed' && j.conclusion === 'success') out.green = true;
    }
  }
  return out;
}

/**
 * What a re-check does with merge-seal.yml's seal while an input on the head is still going: leave it (the input's own
 * end starts the re-check again), unless a green verdict is on the head, which is re-run now so it can't stand while its
 * inputs change (CI review on e1ba6699). A red one already blocks. Pure.
 */
export const whileGoing = ({ going, green }) => (!going.length ? 'seal' : green ? 'rerun-green' : 'leave');

/** The most CI review runs on one head whose jobs readGoing reads to find the newest that reviewed: one GET each. */
export const REVIEW_RUNS_READ = 5;

/** What readPureRevert reads, through a GET (makeIo's same paths). */
const pureIo = (get, repo) => ({
  pullCommits: (n) => get(`/repos/${repo}/pulls/${n}/commits?per_page=2`),
  commit: (sha) => get(`/repos/${repo}/commits/${sha}?per_page=300`),
  compare: (base, head) => get(`/repos/${repo}/compare/${base}...${head}?per_page=1`),
});

/**
 * inputsGoing on `sha` read through the API (each run read through settledRun unless `settle` is false), journeys counted when any of `pulls` needs them (needsJourneys), and a down
 * judge for every pull request: the head's finished CI review runs' jobs are read, newest first, until one actually
 * reviewed (review-marker.mjs reviewRan).
 */
export async function readGoing({ get, repo, sha, pulls, settle = true, unstarted = true }) {
  const runsOf = {};
  for (const { workflow, event } of SEAL_INPUTS) {
    const runs = (
      await get(`/repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}${event ? `&event=${event}` : ''}&per_page=100`)
    )?.workflow_runs;
    if (!Array.isArray(runs)) throw new Error(`${workflow} runs on ${sha}: not a list`);
    const onHead = runs.filter((r) => r?.head_sha === sha);
    // settle false (the seal's WAIT_STEP): a run counts as going until its START_JOB has ended too, so that job's re-check
    // finds the seal still waiting and leaves it (recheckStep), and the seal gives the one verdict.
    runsOf[workflow] = !settle
      ? onHead
      : await settleRuns(onHead, async (id) => {
          const jobs = await runJobs(`/repos/${repo}/actions/runs/${id}/jobs?filter=latest`, get);
          if (!Array.isArray(jobs)) throw new Error(`run ${id}'s jobs: not a list`);
          return jobs;
        });
  }
  // A deferred journeys run ran nothing and is re-run later (main-first.mjs): the newest on the head, finished with its
  // touch job's DEFER_MARK, counts as going (inputsGoing), never as a finished run that reports no step (intafaced #7996).
  {
    const { workflow } = SEAL_INPUTS.find((i) => i.journeys);
    const newest = [...runsOf[workflow]].sort((a, b) => b.id - a.id)[0];
    if (newest?.status === 'completed') {
      const jobs = await runJobs(`/repos/${repo}/actions/runs/${newest.id}/jobs?filter=latest`, get);
      if (!Array.isArray(jobs)) throw new Error(`run ${newest.id}'s jobs: not a list`);
      const touch = jobs.find((j) => j?.name === TOUCH_JOB);
      newest.deferred = (touch?.steps ?? []).some((st) => st?.name === DEFER_MARK && st?.conclusion === 'success');
    }
  }
  let needJourneys = false;
  // A down judge holds only a pull request whose change needs its verdict (review-marker.mjs requiredChecks: a gate
  // file, a look baseline, a journey test or shared test code). Any other merges on its tests and its journeys, and the
  // judge reads it when it is back (judge-down.mjs catchUpTargets; project-state OWNER 302, 12 Nov 2026: "While the
  // reviewer is down, a product pull request that it can only advise on merges on its tests and its journey; the
  // reviewer reads it when it is back and anything it finds becomes a fix. Pull requests it can stop (factory files,
  // journey tests) still wait."). A list of files that can't be read is empty, and requiredChecks fails it closed.
  let needJudge = false;
  for (const p of pulls ?? []) {
    if (needJourneys && needJudge) break;
    const files = await pullFiles(get, repo, p.number);
    // A pure revert (pureRevert) is judged on no journeys, so the seal does not wait for its journeys run.
    needJourneys ||=
      needsJourneys(p, files) && !(await readPureRevert({ io: pureIo(get, repo), repo, pull: p, number: p.number, paths: files }))?.ok;
    needJudge ||= requiredChecks(files).length > 0;
  }
  {
    const { workflow, event } = SEAL_INPUTS.find((i) => i.judge);
    // The newest finished run that actually reviewed: a title or body edit's run, whose job is skipped (reviewRan), is
    // passed over, so it neither hides a down run nor stands for one. At most REVIEW_RUNS_READ runs' jobs are read.
    const finished = runsOf[workflow]
      .filter((r) => r?.head_sha === sha && r?.event === event && r?.status === 'completed')
      .sort((a, b) => b.id - a.id);
    for (const run of finished.slice(0, REVIEW_RUNS_READ)) {
      const jobs = await runJobs(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest`, get);
      if (!Array.isArray(jobs)) throw new Error(`run ${run.id}'s jobs: not a list`);
      const job = jobs.find(reviewRan);
      if (!job) continue;
      run.judgeDown = isJudgeDown(job);
      break;
    }
  }
  // The Model check's newest finished run on the head: one that could not check (isModelDown) is no verdict.
  for (const { workflow, event } of SEAL_INPUTS.filter((i) => i.down)) {
    const newest = runsOf[workflow]
      .filter((r) => r?.head_sha === sha && r?.event === event && r?.status === 'completed')
      .sort((a, b) => b.id - a.id)[0];
    if (!newest) continue;
    const jobs = await runJobs(`/repos/${repo}/actions/runs/${newest.id}/jobs?filter=latest`, get);
    if (!Array.isArray(jobs)) throw new Error(`run ${newest.id}'s jobs: not a list`);
    newest.judgeDown = jobs.some(isModelDown);
  }
  return inputsGoing({ sha, runsOf, needJourneys, needJudge, unstarted });
}

/**
 * merge-seal.yml's first job: whether this attempt seals now or waits for its inputs (sealNow), written to
 * GITHUB_OUTPUT as `now=true|false`. Only a first attempt asks; any error fails this job, and the seal then runs at once.
 */
async function sealNowStep({ repo, token }) {
  const { HEAD_SHA, PR_NUMBER, GITHUB_OUTPUT } = process.env;
  if (!SHA40.test(HEAD_SHA ?? '') || !/^\d+$/.test(PR_NUMBER ?? '')) throw new Error('--seal-now needs HEAD_SHA and PR_NUMBER');
  const get = (path) => api(path, token);
  const pull = await get(`/repos/${repo}/pulls/${PR_NUMBER}`);
  const files = await pullFiles(get, repo, Number(PR_NUMBER));
  let headCi = null;
  try {
    const c = await get(`/repos/${repo}/contents/.github/workflows/ci.yml?ref=${HEAD_SHA}`);
    headCi = Buffer.from(String(c?.content ?? ''), 'base64').toString('utf8');
  } catch (e) {
    if (!/HTTP 404/.test(e.message)) throw e;
  }
  const going = await readGoing({ get, repo, sha: HEAD_SHA, pulls: [pull] });
  const v = sealNow({ files, headCi, going, verdict: going.length ? (await readVerdicts({ get, repo, sha: HEAD_SHA })).any : false });
  console.log(`${v.now ? 'seals now' : 'waits'}: ${v.why}`);
  if (GITHUB_OUTPUT) writeFileSync(GITHUB_OUTPUT, `now=${v.now}\n`, { flag: 'a' });
}

/**
 * The seal job's first step (`--wait-inputs`, WAIT_STEP): while an input on the head is still going, the seal waits in
 * its job, a running check that blocks the merge as a missing one does, and judges once they have all finished, so it
 * is never red only because it is waiting (project-state OWNER 262 part 2, 9 Nov 2026: "no red while waiting"). Before
 * this, a seal that ran at once (sealNow: a change under .github/, or a verdict already on the head) or a green re-run
 * while an input ran (whileGoing) failed with "has not finished": 23 of the 70 red seals from 12:00 UTC on 11 Nov to
 * 00:01 UTC on 12 Nov. Given the pull request as it is now and inputsGoing's lines: `wait` while one is going on its
 * head; `judge` once none is, or when the pull request closed or its head moved (the judging steps then say so). Pure.
 */
export function waitStep({ pull, sha, going }) {
  if (pull?.state !== 'open') return { act: 'judge', msg: `#${pull?.number} is no longer open` };
  if (pull?.head?.sha !== sha) return { act: 'judge', msg: `#${pull.number}'s head moved to ${String(pull?.head?.sha).slice(0, 10)}` };
  // GitHub runs no CI on a pull request that conflicts with its base (inputsGoing `always`), so a seal that runs at once
  // judges it now, as before, rather than waiting out WAIT_POLLS for a run that never starts.
  // A draft: the CI review skips drafts, so this seal (one that runs at once: a change under .github/) waits as a running
  // check, which blocks a merge as the seal must, and judges once `gh pr ready` has started the review. Before 25 Nov
  // 2026 it judged at once, red on the missing review: 6 of the 82 heads red on the seal alone in the 48 h to 25 Nov
  // 00:43 UTC (INTAFACED/project-state#4047). It never stops holding a check: a pull request's own job named `CI merge
  // seal` could stand alone in the gap.
  if (pull?.draft === true) return { act: 'wait', msg: `#${pull.number} is a draft, which the CI review skips: \`gh pr ready\` starts it` };
  if (pull?.mergeable === false && going.some((g) => g.includes(NO_RUN)))
    return { act: 'judge', msg: `#${pull.number} conflicts with its base, so no CI runs on it` };
  if (going.length) return { act: 'wait', msg: `waiting for ${going.join(', ')}` };
  return { act: 'judge', msg: 'every input on this head has finished' };
}

/** The seal job's step that waits for its inputs (waitStep); a re-check leaves a seal still in it alone (recheckStep). */
export const WAIT_STEP = 'Wait for CI, the CI review and the journeys this change needs';
/**
 * The seal job's step that judges a change to the judges alone (judge-repair.mjs REPAIR_STEP, which this must equal:
 * judge-repair.test.mjs). Written here, not imported, so the journeys run, which reads this file, never reads that one.
 */
export const REPAIR_STEP = 'A change to the judges alone: every other check green, and a PASS from the CI review';
/**
 * How long the seal waits in WAIT_STEP: 12 checks 5 minutes apart, beyond the slowest journeys run seen (43 min, 11 Nov).
 * Each check is about 8 API calls on the repository's installation limit, which the other seals and checks share (on
 * 12 Nov at 02:59 UTC seals failed on "API rate limit exceeded for installation"), so a waiting seal spends about 100
 * calls an hour, not 480.
 */
export const WAIT_POLLS = 12;
export const WAIT_POLL_MS = 300_000;

async function waitInputsStep({ repo, token, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const { HEAD_SHA, PR_NUMBER } = process.env;
  if (!SHA40.test(HEAD_SHA ?? '') || !/^\d+$/.test(PR_NUMBER ?? '')) throw new Error('--wait-inputs needs HEAD_SHA and PR_NUMBER');
  const get = (path) => api(path, token);
  let said = '';
  for (let poll = 1; ; poll++) {
    const pull = await get(`/repos/${repo}/pulls/${PR_NUMBER}`);
    const step = waitStep({ pull, sha: HEAD_SHA, going: await readGoing({ get, repo, sha: HEAD_SHA, pulls: [pull], settle: false }) });
    if (step.act === 'judge') return console.log(`judging now: ${step.msg}`);
    if (poll >= WAIT_POLLS)
      throw new Error(`${step.msg} after ${(WAIT_POLLS * WAIT_POLL_MS) / 60_000} min; the seal fails closed (re-run it once they finish)`);
    if (step.msg !== said) console.log(`${(said = step.msg)}; checking every ${WAIT_POLL_MS / 1000}s`);
    await sleep(WAIT_POLL_MS);
  }
}

/** A POST to the API that returns { status, message } and never throws on an HTTP error, so the caller decides. */
const poster = (token) => async (path) => {
  const res = await githubFetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  const text = await res.text();
  let message = text;
  try {
    message = JSON.parse(text)?.message ?? text;
  } catch {}
  return { status: res.status, message: String(message).slice(0, 200) };
};

/**
 * `--recheck`, the last job of each seal input (START_JOB, `FINISHED` naming the input): the open pull requests with
 * auto-merge armed on `SHA` that the input judges (recheckTargets), each with its seal started or re-run once every input
 * on the head has finished. A head no such pull request is on is left alone.
 */
async function recheck({ repo, token }) {
  const { SHA, PR_NUMBER, OLD_TITLE = '', OLD_BODY = '', FINISHED = '' } = process.env;
  if (!SHA40.test(SHA ?? '')) throw new Error('recheck needs SHA');
  const get = (path) => api(path, token);
  const post = poster(token);
  const pulls = PR_NUMBER
    ? [await get(`/repos/${repo}/pulls/${PR_NUMBER}`)]
    : await get(`/repos/${repo}/commits/${SHA}/pulls?per_page=100`);
  // CI or the CI review finished: the default branch's seal reads both (ci-jobs-seal.mjs, review-marker.mjs), so every
  // open pull request with auto-merge armed on the head is re-sealed, whatever it names (recheckTargets).
  const named = await recheckTargets({
    finished: FINISHED,
    pulls,
    sha: SHA,
    repo,
    oldTitle: OLD_TITLE,
    oldBody: OLD_BODY,
    filesOf: (n) => pullFiles(get, repo, n),
  });
  if (!named.length)
    return console.log(
      `no open pull request with auto-merge armed on ${SHA} needs its seal re-run (${FINISHED || 'an edit'}); the seal is left as it is`,
    );
  // Each seal on the head, ci.yml's and the default branch's (SEAL_WORKFLOWS); each workflow's newest run must pass, so each
  // workflow's newest seal is re-run.
  // Read again just before a re-run: the head may have moved while a running seal was waited out (rerunBlocker).
  const outcomes = [];
  // After CI finished, ci.yml's own seal ran in that same run after its needs, so only the default branch's seal is
  // re-run: re-running ci.yml's would start a new attempt of that CI run, the default branch's seal would read CI as
  // running, and the next CI completion would start it all again (the CI review on 7a7eb9a0, 8 Nov 2026).
  // The seal's inputs on this head (SEAL_INPUTS): while one is still going, merge-seal.yml's seal is left alone, since
  // that input's own end starts this re-check again; so the seal gives one verdict, once they have all finished.
  // A CI review run not yet started is not waited for (inputsGoing `unstarted`): its end may start nothing, and the seal
  // started now waits for it in WAIT_STEP.
  const going = await readGoing({ get, repo, sha: SHA, pulls: named, unstarted: false });
  for (const { workflow, event } of sealsToRecheck(FINISHED)) {
    if (
      workflow !== CI_WORKFLOW &&
      whileGoing({ going, green: going.length ? (await readVerdicts({ get, repo, sha: SHA })).green : false }) === 'leave'
    ) {
      outcomes.push(`${workflow}: not re-run: waiting for ${going.join(', ')}; its end starts the seal`);
      continue;
    }
    const blocker = async () => {
      const now = await Promise.all(named.map((p) => get(`/repos/${repo}/pulls/${p.number}`)));
      const headRuns = (await get(`/repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${SHA}&event=${event}&per_page=100`))
        ?.workflow_runs;
      if (!Array.isArray(headRuns)) throw new Error(`${workflow} runs on ${SHA}: not a list`);
      return rerunBlocker({ sha: SHA, pulls: now, headRuns, event });
    };
    outcomes.push(`${workflow}: ${await rerunSealJob({ repo, sha: SHA, get, post, blocker, workflow, event })}`);
  }
  const outcome = outcomes.join('; ');
  console.log(
    `${outcomes.every((o) => o.includes(': not re-run')) ? '::notice::' : ''}#${named.map((p) => p.number).join(', #')} on ${SHA}: ${outcome}`,
  );
}

function report({ ok, lines, stepsOk = ok, fullOk = true, stepsKinds = [], fullKinds = [] }, how) {
  for (const l of lines) console.log(l);
  if (ok) return console.log(`journey steps: ${how}`);
  if (!fullOk)
    console.error(
      `::error title=${kindTitle(fullKinds, 'The journeys this pull request touches are not proven on this head')}::${lines
        .filter((l) => /: (full run|touched journeys): /.test(l))
        .join('; ')
        .slice(
          0,
          3000,
        )}. A pull request is held to the journeys its own run was given (tooling/ci/journey-touch.mjs pullPick), never the full suite: each must be run clean on its exact head by the journeys verdict (its pull request run does it; or dispatch real-app-journeys.yml on the branch with the journeys input naming them). Read with the default branch's baseline; the seal re-runs when the run finishes. \`node tooling/ci/journey-touch.mjs --base origin/main\` prints which.`,
    );
  if (stepsOk) process.exit(1);
  // A review the judge left without a verdict (review-marker.mjs ciReviewVerdict) says so in the title: judge down, never
  // a red that reads as the change's own (OWNER 289 point 11). A seal that runs at once (sealNow) can meet one.
  const down = lines.some((l) => /the judge was down in run/.test(l));
  console.error(
    `::error title=${down ? 'judge down: CI review (no verdict yet; the review re-runs when the judge is back)' : kindTitle(stepsKinds, 'Named journey steps not green on this head')}::${lines
      .filter(
        (l) => !/on a Left-or-replaced line$/.test(l) && !/add this line to the body/.test(l) && !/: (full run|touched journeys): /.test(l),
      )
      .join('; ')
      .slice(
        0,
        3000,
      )}. A pull request whose title names journey steps needs each one passing in a finished Real-app journeys run on its exact head (dispatch real-app-journeys.yml on the branch with the journeys input naming the journey files, e.g. J-bank-13.pw.mjs, so they run with the ordinary limits rather than a full run's fail-fast; the seal re-runs when it finishes), or the step exempted on its own body line: copy the Left-or-replaced line printed above, at column 0 outside code.`,
  );
  // The exact line to copy, alone in its own annotation, with nothing after it.
  for (const l of lines) {
    const m = /(Left-or-replaced: .*)$/.exec(l);
    if (/add this line to the body/.test(l) && m)
      console.error(`::error title=To leave these steps, add this line to the body (column 0, outside code)::${m[1]}`);
  }
  process.exit(1);
}

/** `--before-push`: titleBeforePush on this branch against origin/main and its open pull request (gh), if any. */
async function beforePushStep() {
  const sh = (...a) => execFileSync(a[0], a.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 });
  const base = sh('git', 'merge-base', 'HEAD', 'origin/main').trim();
  const paths = sh('git', 'diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
  const text = (f, ref) => { try { return sh('git', 'show', `${ref}:${f}`); } catch { return null; } }; // prettier-ignore
  const dir = 'apps/customer/tests/real-app';
  const journeyFiles = () => sh('git', 'ls-tree', '--name-only', 'HEAD', `${dir}/`).split('\n').filter(Boolean).map((f) => f.slice(dir.length + 1)); // prettier-ignore
  const touched = await touchedSteps({ paths, head: 'HEAD', base, text, journeyFiles });
  if (!touched.length) return;
  let pull = null;
  try {
    pull = process.env.CI ? null : JSON.parse(sh('gh', 'pr', 'view', '--json', 'number,title,body,state,url'));
  } catch {}
  if (pull?.state !== 'OPEN') pull = null;
  const repo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pull?.url ?? '')?.[1];
  const v = titleBeforePush({ title: pull?.title ?? null, body: pull?.body, touched, repo });
  if (v.ok)
    return console.log(
      `journey seal: the changed journey tests hold ${v.need.join(', ')}; a file none of whose steps the title names or a line leaves is judged on all of them`,
    );
  console.error([`✖ #${pull.number}'s title fails the merge seal's step rule — push refused.`, ...v.lines].join('\n  '));
  console.error(v.fix ? `  Fix: gh pr edit ${pull.number} --title '${v.fix.replace(/'/g, `'\\''`)}'` : `  Fix: name ${v.need.join(', ')}`);
  process.exit(1);
}

async function main() {
  if (process.argv.includes('--before-push')) return beforePushStep();
  const { REPO } = process.env;
  const GH_TOKEN = githubToken();
  if (!REPO) {
    console.error('::error::journey-seal needs REPO');
    process.exit(1);
  }
  if (process.argv.includes('--recheck')) return recheck({ repo: REPO, token: GH_TOKEN });
  if (process.argv.includes('--seal-now')) return sealNowStep({ repo: REPO, token: GH_TOKEN });
  if (process.argv.includes('--wait-inputs')) return waitInputsStep({ repo: REPO, token: GH_TOKEN });
  const io = makeIo(REPO, GH_TOKEN);
  // The journeys run's planner (real-app-journeys.yml) reads an automatic revert's narrow scope from the same rule.
  const scopeAt = process.argv.indexOf('--auto-revert-scope');
  if (scopeAt > 0) {
    const n = Number(process.argv[scopeAt + 1]);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('--auto-revert-scope needs a pull request number');
    const pull = await io.pull(n);
    const scope = await readAutoRevertScope({ io, repo: REPO, pull, number: n, paths: await io.files(n) });
    return console.log(JSON.stringify(autoRevertPlan(scope)));
  }
  const dry = process.argv.indexOf('--dry-run');
  if (dry > 0) {
    const [n, sha] = process.argv.slice(dry + 1).filter((a, i, all) => a !== '--main' && all[i - 1] !== '--main');
    // `--main <sha>`: judge a pure revert against main as it was then (readPureRevert), for a closed pull request.
    const at = process.argv.indexOf('--main');
    const mainAt = at > 0 ? process.argv[at + 1] : undefined;
    return report(await sealPull({ repo: REPO, number: Number(n), sha: sha || undefined, io, requireOpen: false, mainAt }), 'dry run');
  }
  // The factory switch (factory-switch.mjs): this step runs the default branch's copy on every seal since 2026-11-06, so a
  // re-run of a seal whose own workflow predates the switch's step still reads it. Imported here, not at the top, to keep
  // the two files free of an import cycle.
  if (process.env.MERGE_GROUP_HEAD_SHA || process.env.PR_NUMBER) {
    const { switchProblem } = await import('./factory-switch.mjs');
    const problem = await switchProblem({ repo: REPO, token: GH_TOKEN });
    if (problem) {
      console.error(`::error title=${problem.title}::${problem.why}`);
      process.exit(1);
    }
  }
  if (process.env.MERGE_GROUP_HEAD_SHA) {
    const { MERGE_GROUP_BASE_SHA: base, MERGE_GROUP_HEAD_SHA: head, MERGE_GROUP_HEAD_REF: headRef } = process.env;
    const commits = (await io.compare(base, head))?.commits;
    const numbers = groupPulls(commits, headRef);
    if (!numbers) return report({ ok: false, lines: [`the merge group ${headRef} could not be read whole`] }, '');
    const all = { ok: true, stepsOk: true, fullOk: true, lines: [], stepsKinds: [], fullKinds: [] };
    for (const n of numbers) {
      const v = await sealPull({ repo: REPO, number: n, io, waitOnRunning: false });
      all.ok &&= v.ok;
      all.stepsOk &&= v.stepsOk ?? v.ok;
      all.fullOk &&= v.fullOk ?? true;
      all.lines.push(...v.lines);
      all.stepsKinds.push(...(v.stepsKinds ?? []));
      all.fullKinds.push(...(v.fullKinds ?? []));
    }
    return report(all, 'every queued pull request that names steps has them green or left on its own head');
  }
  const { HEAD_SHA, PR_NUMBER } = process.env;
  if (!PR_NUMBER) return console.log('not a pull request: no journey steps to read');
  if (!SHA40.test(HEAD_SHA ?? '')) {
    console.error('::error::journey-seal needs HEAD_SHA on a pull request');
    process.exit(1);
  }
  return report(
    await sealPull({ repo: REPO, number: Number(PR_NUMBER), sha: HEAD_SHA, io }),
    'each named step is green or left on this head',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch((e) => {
    console.error(`::error title=${titleFor(e.message, 'Named journey steps unreadable')}::${e.message}; the seal fails closed`);
    process.exit(1);
  });
