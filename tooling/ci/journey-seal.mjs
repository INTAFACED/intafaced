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
 *   - cancelled and skipped runs say nothing and are passed over;
 *   - per step, the newest finished run (by its current attempt's start) whose merged report lists the step decides:
 *     passed is green; failed or skipped is red. A newer run that failed a step outranks an older pass;
 *   - a run's report is the `real-app-journeys` artifact uploaded during its current attempt (created at or after the
 *     attempt started), so a re-run's verdict is never read from an earlier attempt's report. A run with no such report,
 *     or one that can't be read, is red for every step it could have decided (fail closed), unless a newer run decides;
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
 * A pull request whose diff touches the journey stack's shared setup (SHARED_SETUP) also needs a clean full run: the
 * newest finished full Real-app journeys run on its exact head, judged here by journeys verdict's own rules
 * (journey-verdict.mjs judge) with the default branch's baseline and money rule, has 0 steps outside the list or against
 * its rules (judgeFullRun). Any title, naming steps or not. (Failure it prevents: on 7 Nov 2026 a pull request that
 * changed shared stack setup merged on its own named steps and turned main's journeys red for about 2.5 hours; the
 * pilot lead then asked builders by message not to arm such pull requests until a full run was clean. Rule 3 of
 * project-state AGENTS.md: a red main means a regression.) A run is full when its report holds a step from every journey
 * file the baseline's named run reported; a run short of files is judged on the files it has, fails the seal when any
 * of them is red, and is passed over only when all are clean, never read as a full run.
 *
 * Every pull request is also held to the journeys it touches (journey-touch.mjs journeyTouch, from its changed paths):
 * a path that can reach any journey (product code with no recorded map of what reaches it yet, every script under
 * tooling/scripts, the journeys workflow, this seal, the verdict, docs, build and environment files) needs the same
 * clean full run as shared setup (judgeFullRun); a pull request whose only such paths are journey test files needs
 * those files run on its exact head and clean by the journeys verdict (judgeTouchedRun); a pull request touching nothing
 * a journeys run executes or reads needs no run. (Failure it prevents: #7415 changed product code, merged on its own
 * steps and broke J-copy-bots-otc-01 #1 on main on 7 Nov 2026, so builders ran the full suite on nearly every branch by
 * hand. The seal now says exactly which run each pull request needs, and a builder runs that one.) A pull request whose
 * title or branch names a journey with a file at its head is held, for its product code, to that journey, its changed
 * journey files and the map's always-run list (namedSealInputs, journey-touch.mjs namedInputs: theo-01 part 1,
 * project-state#2065, OWNER 296), the same list its journeys run was given; main's full run after the merge judges the
 * rest and a red main is reverted (OWNER 249 (3)). A service's own stack file in such a pull request adds the journeys
 * that use it, to the run and to this list (theo-01 part 2, OWNER 296). Every other full path still needs the full run.
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
 *   GH_TOKEN=... REPO=owner/name HEAD_SHA=... PR_NUMBER=... node tooling/ci/journey-seal.mjs
 *   GH_TOKEN=... REPO=... MERGE_GROUP_BASE_SHA=... MERGE_GROUP_HEAD_SHA=... MERGE_GROUP_HEAD_REF=... node tooling/ci/journey-seal.mjs
 *   GH_TOKEN=... REPO=... node tooling/ci/journey-seal.mjs --dry-run <pr> [<sha>]   (any pull request, closed too; read only)
 *   GH_TOKEN=... REPO=... SHA=... [PR_NUMBER=...] [OLD_TITLE=...] [OLD_BODY=...] node tooling/ci/journey-seal.mjs --recheck   (re-runs the seal)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JOURNEYS_ARTIFACT, fetchInputs, isMainRun, judge, manifestsAt, readReport, rootInputs } from './journey-verdict.mjs';
import { RUN_FILE, journeyTouch, namedInputs, namedJourneyIds, pathKind, printable, stackImporters } from './journey-touch.mjs';
import { SUBSCRIBES, builtMap, loadMap, newerMap, runsBehind } from './journey-reach-map.mjs';
import { groupPulls, isJudgeDown, reviewRan } from './review-marker.mjs';
import { DEFER_MARK, TOUCH_JOB } from './main-first.mjs';

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
 * exemption is a problem, and so is an exemption line with anything else after the colon or a range that can't be read.
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
const leaveLine = (keys) =>
  `to leave these steps instead, add this line to the body, at the start of a line and outside code: ${exemptionLine(keys)}`;

/**
 * The verdict for one head. `runs`: every JOURNEYS_WORKFLOW run listed for this head (the caller lists by head_sha; this
 * filters again). `reportOf(run)`: { states } of the run's current-attempt report, or { error }. Pure but for reportOf.
 * Returns { ok, state: 'none'|'pass'|'wait'|'fail', lines: [...] }.
 */
export async function judgeSteps({ sha, repo, title, body, runs, reportOf, waitOnRunning = true }) {
  const named = titleSteps(title);
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
  if (left.problems.length)
    return {
      ok: false,
      state: 'fail',
      kinds: ['yours'],
      lines: left.problems.map(
        (l) =>
          `"${l.slice(0, 160)}" looks like an exemption but isn't one: write \`Left-or-replaced: J-bank-13 #1 #3\` at the start of a line, outside code, with step ids only`,
      ),
    };
  const lines = [];
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
  const finished = mine
    .filter((r) => r.status === 'completed' && !['cancelled', 'skipped'].includes(r.conclusion))
    .sort((a, b) => Date.parse(b.run_started_at ?? b.created_at) - Date.parse(a.run_started_at ?? a.created_at) || b.id - a.id);
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
    for (const r of finished) {
      const rep = await report(r);
      const where = `run ${r.id} (attempt ${r.run_attempt ?? 1})`;
      if (rep.error) {
        decided = {
          green: false,
          kind: 'runner',
          why: `${where}'s report couldn't be read (${rep.error}), so a failure there can't be ruled out`,
        };
        break;
      }
      const st = rep.states?.[k];
      if (st === undefined) continue;
      decided = st === 'passed' ? { green: true, why: `passed in ${where}` } : { green: false, kind: 'yours', why: `${st} in ${where}` };
      break;
    }
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
  { glob: 'tooling/scripts/local-infra-bootstrap.sh' },
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
 * The full-run verdict for a head whose pull request touches shared setup (`shared`: those files). `reportOf(run)` is
 * { states, files } of the run's current-attempt report, or { error }; `verdictOf(report, run)` is
 * { red: [{ step, why }], failing, missing: [journey files the full suite has and this report lacks] }, judged with the
 * default branch's baseline (makeIo). Newest first: a full run decides (0 red passes, anything else fails); a run whose
 * report lacks journey files (targeted, or a shard lost) is judged on the files it has (fullVerdict), fails the seal if
 * any is red, and is passed over only when all it has is clean. A run still going holds it (as judgeSteps), a cancelled
 * or skipped run says nothing, and a report that can't be read fails closed.
 */
export async function judgeFullRun({
  sha,
  repo,
  shared,
  runs,
  reportOf,
  verdictOf,
  waitOnRunning = true,
  because = null,
  inherited = null,
}) {
  const why =
    because ??
    `it changes the journey stack's shared setup (${shared.slice(0, 5).join(', ')}${shared.length > 5 ? `, ${shared.length - 5} more` : ''})`;
  const how = 'dispatch real-app-journeys.yml on the branch with no journeys input (the full suite); the seal re-runs when it finishes';
  const mine = onHead(runs, sha, repo);
  const running = mine.filter((r) => r.status !== 'completed');
  if (running.length && waitOnRunning) {
    const ids = running.map((r) => `${r.id} (attempt ${r.run_attempt ?? 1}, ${r.status})`).join(', ');
    return {
      ok: false,
      state: 'wait',
      lines: [`full run: ${why}; Real-app journeys run ${ids} on this head has not finished; the seal reads it once it does`],
    };
  }
  const finished = mine.filter((r) => r.status === 'completed' && !['cancelled', 'skipped'].includes(r.conclusion)).sort(newestFirst);
  const passed = [];
  for (const r of finished) {
    const where = `run ${r.id} (attempt ${r.run_attempt ?? 1})`;
    let rep;
    try {
      rep = (await reportOf(r)) ?? { error: 'no report' };
    } catch (e) {
      rep = { error: e.message };
    }
    if (rep.error)
      return {
        ok: false,
        state: 'fail',
        kinds: ['runner'],
        lines: [`full run: ${why}; ${where}'s report couldn't be read (${rep.error}), so the seal fails closed`],
      };
    let v;
    try {
      v = await verdictOf(rep, r);
    } catch (e) {
      return {
        ok: false,
        state: 'fail',
        kinds: ['runner'],
        lines: [`full run: ${why}; ${where}'s verdict couldn't be worked out (${e.message}), so the seal fails closed`],
      };
    }
    // Reds this head inherited from main, outside this pull request's area, stop no one but their owner (owner decision
    // 180, the affected-area stop); every other red still fails the seal (splitInherited).
    const split = await splitOrAll(inherited, v.red, r);
    const kept = inheritedLines(split).map((l) => `full run: ${l}`);
    const red = split.blocking;
    if (v.missing?.length && red.length === 0) {
      passed.push(
        `${where} is not a full run (no step from ${v.missing.length} journey file(s), e.g. ${v.missing.slice(0, 3).join(', ')}) and is clean on the files it has${split.passed.length ? ' but for reds inherited from main outside its area' : ''}`,
        ...inheritedLines(split),
      );
      continue;
    }
    if (red.length === 0)
      return {
        ok: true,
        state: 'pass',
        lines: [
          `full run: ${why}; ${where} is clean: ${v.failing} failing or missing step(s), 0 outside the list or against its rules${split.passed.length ? ` but ${split.passed.length} inherited from main outside this pull request's area` : ''}`,
          ...kept,
        ],
      };
    return {
      ok: false,
      state: 'fail',
      kinds: redKinds(red),
      lines: [
        `full run: ${why}; ${where}${v.missing?.length ? `, short of ${v.missing.length} journey file(s),` : ''} has ${red.length} step(s) outside the list or against its rules: ${red
          .slice(0, 10)
          .map((x) => `${x.step}: ${x.why}`)
          .join('; ')}${red.length > 10 ? `; ${red.length - 10} more` : ''}`,
        ...kept,
      ],
    };
  }
  return {
    ok: false,
    state: 'fail',
    kinds: ['runner'],
    lines: [
      `full run: ${why}, so it needs a clean full Real-app journeys run on this exact head, and none has finished; ${how}`,
      ...passed.map((l) => `full run: ${l}`),
    ],
  };
}

/**
 * The touched-journeys verdict for a head whose pull request touches only journey test files (`files`: their names, as
 * a report's `ran` lists them). Newest finished run first, as judgeFullRun: every run read is judged by the journeys
 * verdict on the files it has (`verdictOf`, the default branch's baseline), and any red step there fails the seal, so a
 * newer red run is never hidden behind an older clean one; runs are read until every touched file has been run by one
 * of them. A touched file no finished run on the head ran fails the seal and is named. A run still going holds it, a
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
}) {
  const why = `it touches ${files.length} journey file(s) (${files.slice(0, 5).join(', ')}${files.length > 5 ? `, ${files.length - 5} more` : ''})${reach?.length ? `, by the touched-journeys map (${reach.slice(0, 3).join('; ')}${reach.length > 3 ? `; ${reach.length - 3} more` : ''})` : ''}${named ? `, because ${named}` : ''}`;
  const how = `dispatch real-app-journeys.yml on the branch with -f journeys="${files.join(' ')}" (or no journeys input, the full suite); the seal re-runs when it finishes`;
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
  const finished = mine.filter((r) => r.status === 'completed' && !['cancelled', 'skipped'].includes(r.conclusion)).sort(newestFirst);
  const left = new Set(files);
  const read = [];
  for (const r of finished) {
    if (!left.size) break;
    const where = `run ${r.id} (attempt ${r.run_attempt ?? 1})`;
    let rep;
    try {
      rep = (await reportOf(r)) ?? { error: 'no report' };
    } catch (e) {
      rep = { error: e.message };
    }
    if (rep.error)
      return {
        ok: false,
        state: 'fail',
        kinds: ['runner'],
        lines: [`touched journeys: ${why}; ${where}'s report couldn't be read (${rep.error}), so the seal fails closed`],
      };
    let v;
    try {
      v = await verdictOf(rep, r);
    } catch (e) {
      return {
        ok: false,
        state: 'fail',
        kinds: ['runner'],
        lines: [`touched journeys: ${why}; ${where}'s verdict couldn't be worked out (${e.message}), so the seal fails closed`],
      };
    }
    // As judgeFullRun: a red this head inherited from main outside this pull request's area stops no one.
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
            .map((x) => `${x.step}: ${x.why}`)
            .join('; ')}${red.length > 10 ? `; ${red.length - 10} more` : ''}`,
          ...read.map((l) => `touched journeys: ${l}`),
        ],
      };
    const covered = (rep.ran ?? []).filter((f) => left.has(f));
    for (const f of covered) left.delete(f);
    if (covered.length) read.push(`${where} ran ${covered.join(', ')} clean`);
  }
  if (!left.size) return { ok: true, state: 'pass', lines: [`touched journeys: ${why}; ${read.join('; ')}`] };
  return {
    ok: false,
    state: 'fail',
    kinds: ['runner'],
    lines: [
      `touched journeys: ${why}, and no finished Real-app journeys run on this exact head ran ${[...left].join(', ')}; ${how}`,
      ...read.map((l) => `touched journeys: ${l}`),
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
  { fetchImpl = fetch, tries = 3, waitMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
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
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
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
  return {
    pull: (n) => api(`/repos/${repo}/pulls/${n}`, token),
    // An automatic revert's commits (it must hold one) and the commit it reverts (autoRevertScope).
    pullCommits: (n) => api(`/repos/${repo}/pulls/${n}/commits?per_page=2`, token),
    commit: (sha) => api(`/repos/${repo}/commits/${sha}?per_page=300`, token),
    // A run whose last job (START_JOB) is what started this seal is read as finished (settledRun).
    runs: async (sha) =>
      settleRuns(
        await listWhole(`/repos/${repo}/actions/workflows/${file}/runs?head_sha=${sha}`, 'workflow_runs', token, `${file} runs on ${sha}`),
        (id) => listWhole(`/repos/${repo}/actions/runs/${id}/jobs?filter=latest`, 'jobs', token, `run ${id}'s jobs`),
      ),
    async reportOf(run) {
      const arts = await listWhole(
        `/repos/${repo}/actions/runs/${run.id}/artifacts?name=${JOURNEYS_ARTIFACT}`,
        'artifacts',
        token,
        `run ${run.id}'s artifacts`,
      );
      const art = currentReportArtifact(run, arts);
      if (!art) return { error: `no ${JOURNEYS_ARTIFACT} artifact from its current attempt` };
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
    },
    compare: (base, head) => api(`/repos/${repo}/compare/${base}...${head}?per_page=250`, token),
    // The map the touch job used (journey-touch.mjs): the newest build main's map workflow verified no later than `before`,
    // else the committed copy beside this script.
    reachMap: async (before) =>
      newerMap(
        await builtMap({ get: (path) => api(path, token), raw: (path) => api(path, token, { raw: true }), before, repo }),
        loadMap(),
      ),
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
    verdictOf: (report, run) => fullVerdict({ repo, report, run, inputs: baseInputs() }),
  };
}

/** The default branch's checkout this script runs from (ci.yml runs the base's copy): its baseline and money rule. */
const BASE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
let base = null;
const baseInputs = () => (base ??= { ...rootInputs(BASE_ROOT), reports: new Map() });

/** One run's verdict, as journey-verdict.mjs would print it with the default branch's baseline, and the journey files
 *  of the full suite (the baseline's named run) its report lacks. GET only, through gh (GH_TOKEN). */
export function fullVerdict({ repo, report, run, inputs, read = fetchInputs }) {
  const { baseline, money, reports } = inputs;
  const got = read({ repo, baseline, thisRun: run, reports, log: () => {} });
  const red = got.problems.map((why) => ({ step: '(input)', why }));
  if (!got.named) return { red, failing: 0, missing: [] };
  // The files each run ran, never the step-to-file map: that keeps one file a step, so a step id two files share
  // (J-wallet-04 #7) dropped one of them on both sides, and a clean full run read as short of it (#7492's seal,
  // run 42419894849 attempt 2). A report without its list is read as having run nothing: short, so never sealed full.
  if (!Array.isArray(got.named.ran))
    return { red: [...red, { step: '(input)', why: "the named run's report has no list of the files it ran" }], failing: 0, missing: [] };
  const have = new Set(report.ran ?? []);
  const missing = got.named.ran.filter((f) => !have.has(f));
  // A run short of journey files (targeted, or a shard lost) is judged on the files it has, as a targeted run's own
  // verdict is: a red step there fails the seal; only a run clean on all it has is passed over (judgeFullRun).
  const target = missing.length ? have : null;
  const v = judge({ newest: report, named: got.named, baseline, money, passedSince: got.passedSince, issues: got.issues, target });
  // Where each red step last passed on main before this run (the newest history run that passed it, else the named run
  // when it passed there), or null when it never passed: the merge seal bounds an inherited red by the commits since.
  const lastPass = {};
  for (const { step } of v.red) {
    const n = got.passedSince?.[step];
    lastPass[step] =
      n !== undefined ? (got.shas?.[n] ?? '') : got.named.states?.[step] === 'passed' ? String(baseline?.run?.sha ?? '') : null;
  }
  return { red: [...red, ...v.red], failing: v.failing, missing, lastPass };
}

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
 * A pull request that changes a journey test file says which steps it touches: for each changed file, at least one of
 * the steps it holds is named in the title (then judged by judgeSteps) or on a strict `Left-or-replaced:` line. A
 * title naming another journey's steps, or none, fails, and so does an exemption-like line that isn't one. `touched`:
 * [{ file, journey, steps }], the steps each file holds at the head (or at the base, for a file the head removed).
 * (Failure it prevents: #7434 and #7435 changed journey tests on 7 Nov 2026 with no `#n` in their titles, so the seal
 * judged none of their steps; project-state #1249 comment 6681706701.)
 */
export function judgeTouched({ title, body, touched, repo }) {
  if (!touched.length) return { ok: true, lines: [] };
  // GitHub's Revert button (title `Revert "…"`, body line `Reverts owner/repo#n`) passes, as judgeSteps lets it: a red
  // main is fixed or undone within 2 hours (project-state OWNER 180), so a revert never waits on a body line.
  const reverts = revertOf({ title, body, repo });
  if (reverts) return { ok: true, lines: [`a revert of #${reverts} (GitHub's Revert form): its journey tests need no steps named`] };
  const left = exemptions(body);
  if (left.problems.length)
    return {
      ok: false,
      lines: left.problems.map(
        (l) =>
          `"${l.slice(0, 160)}" looks like an exemption but isn't one: write \`Left-or-replaced: J-bank-13 #1 #3\` at the start of a line, outside code, with step ids only`,
      ),
    };
  const named = new Set([...titleSteps(title), ...left.steps]);
  const lines = [];
  for (const { file, journey, steps } of touched) {
    const hit = steps.filter((k) => named.has(k));
    if (hit.length) continue;
    lines.push(
      steps.length
        ? `${file} changes the tests of ${steps.map((k) => k.replace('#', ' #')).join(', ')}, and neither the title nor a Left-or-replaced line names any of them: name the steps it touches in the title (\`${journey} ${steps
            .map((k) => `#${k.split('#')[1]}`)
            .join(' ')}\`), or leave them on a body line: ${exemptionLine(steps)}`
        : `${file} changes a journey test, but no \`test(\` titled \`${journey} #n\` could be read in it, so the steps it touches can't be named; the seal fails closed`,
    );
  }
  return { ok: lines.length === 0, lines };
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
 * says it reverts the commit the branch names, no file outside that commit's, no shared journey setup, and at least one
 * journey file named. `commits`: GET /pulls/n/commits; `culprit`: GET /commits/<sha> (or null); `culpritTitle`: the
 * culprit pull request's title (or ''); `journeyFiles`: the head's journey file names.
 */
export function autoRevertScope({ pull, repo, paths, commits, culprit, culpritTitle = '', journeyFiles }) {
  const branch = AUTO_REVERT_BRANCH.exec(String(pull?.head?.ref ?? ''));
  if (!branch) return null;
  const no = (why) => ({ ok: false, why: `an automatic revert's branch, but ${why}, so it runs the ordinary scope` });
  if (pull?.head?.repo?.full_name !== repo) return no('its head is not in this repository');
  if (pull?.user?.login !== AUTO_REVERT_AUTHOR || pull?.user?.type !== 'Bot') return no(`it was not opened by ${AUTO_REVERT_AUTHOR}`);
  if (!Array.isArray(commits) || commits.length !== 1) return no('it does not hold exactly one commit');
  const sha = REVERTS_COMMIT.exec(String(commits[0]?.commit?.message ?? ''))?.[1];
  if (!sha || !sha.startsWith(branch[1])) return no(`its commit does not say it reverts ${branch[1]}`);
  if (!Array.isArray(culprit?.files) || culprit.sha !== sha) return no(`the reverted commit ${branch[1]} could not be read`);
  const own = new Set(pullFilePaths(culprit.files));
  const outside = paths.filter((f) => !own.has(f));
  if (outside.length) return no(`it changes ${outside.length} file(s) the reverted commit didn't`);
  if (paths.some(isSharedSetup)) return no('it changes shared journey setup');
  const failing = /^- Failing: (.+)$/m.exec(String(pull?.body ?? '').replace(/\r/g, ''))?.[1] ?? '';
  const journeys = new Set([
    ...[...failing.matchAll(/`(J-[a-z][a-z0-9-]*-\d+) #\d+`/g)].map((m) => m[1]),
    ...paths.map((f) => JOURNEY_TEST.exec(f)?.[1]).filter(Boolean),
    ...stepsIn(culpritTitle).map(journeyOf),
  ]);
  const dir = 'apps/customer/tests/real-app';
  const files = [...journeyFiles].filter((f) => journeys.has(JOURNEY_TEST.exec(`${dir}/${f}`)?.[1])).sort();
  if (!files.length) return no('it names no journey file');
  return {
    ok: true,
    sha,
    files,
    why: `the automatic revert of ${sha.slice(0, 10)} runs the journeys that failed on main and the reverted change's own (${files.length}); main's full journeys run after the merge guards main`,
  };
}

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

/** The changed journey test files of a pull request with the steps each holds, read at the head (the base for a removed
 *  file). `text(path, ref)` is the file's text, or null when the ref has no such file. */
export async function touchedSteps({ paths, head, base, text }) {
  const out = [];
  for (const file of [...new Set(paths)].sort()) {
    const m = JOURNEY_TEST.exec(file);
    if (!m) continue;
    let t = await text(file, head);
    if (t === null) t = await text(file, base);
    if (t === null) throw new Error(`${file} could not be read at the head or the base`);
    out.push({ file, journey: m[1], steps: fileSteps(m[1], t) });
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
 * A pull request that changes the journey stack's shared setup (`touches.shared`: it reaches every journey) is in every
 * red's area, so nothing it inherited is passed over. A money step's red (the verdict's
 * money rule) is never passed over, for any pull request, except one that failed, then passed on its retry both on this
 * head and in main's run (project-state OWNER 278: it "stops only its own journeys"), which stops only the pull
 * requests in its area like any other inherited red.
 * A red that can't be bounded stops every pull request it reaches: an unreadable input, main's reference run with an
 * input problem, no reference run, or a break range that can't be read, is wider than RANGE_MAX commits or lists files
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

export async function splitInherited({ red, main, touches, upTo, rangeOf }) {
  if (!main) return { blocking: red, passed: [], notes: [`no finished full run on main is in this head's history, so every red counts`] };
  const at = `main's run ${main.run.id} on ${String(main.run.head_sha).slice(0, 10)}`;
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
    // didn't mark either way counts as money. The one exception is OWNER 278: a money step that failed, then passed on
    // its retry, here and in main's run (the same verdict line, so main's was a retry pass too), stops only the pull
    // requests in its area, by the rules below; shared setup still puts a pull request in every area.
    if (x.money !== false && x.retryFlaky !== true) {
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
 * the input unknown, which the map reads as full. The map is the build the head's newest journeys run chose when it
 * was created (io.reachMap(before)), so the seal holds the run to the journeys it was told to run.
 */
/** The map the head's newest journeys run chose when it was created (io.reachMap(before)), else this script's copy. */
async function runMap(io, head) {
  let before = Date.now();
  try {
    const made = ((io.runs ? await io.runs(head) : []) ?? []).map((r) => Date.parse(r?.created_at)).filter(Number.isFinite);
    if (made.length) before = Math.max(...made);
  } catch {}
  return io.reachMap ? await io.reachMap(before) : loadMap();
}

/**
 * What a pull request that names a journey runs (journey-touch.mjs namedInputs, theo-01 part 1), as its journeys run
 * worked it out: the journeys its title or branch names, with a file at the head, and the always-run list of the map
 * that run chose. Null when it names none, or when the head's journey files can't be read (then the other rules decide,
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
    map: await runMap(io, head),
    importers: texts ? (stack) => stackImporters(stack, texts) : null,
  });
}

export async function reachInputs({ io, paths, head, text }) {
  const kinds = paths.map((p) => [p, pathKind(p)]);
  const product = kinds.filter(([, k]) => k.product).map(([p]) => p);
  // Any other full path makes the whole change full, so nothing below would be used: read nothing.
  if (!product.length || kinds.some(([, k]) => k.kind === 'full' && !k.product) || !io.mainRuns || !io.journeyFiles) return null;
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
    subs.set(p, t === undefined ? true : t !== null && SUBSCRIBES.test(t));
  }
  // io.reachMode: a test's stand-in for REACH_MAP_MODE; the seal itself never sets it.
  return { map, behind, journeyFiles, subscribes: (p) => subs.get(p) ?? false, ...(io.reachMode ? { mode: io.reachMode } : {}) };
}

/** One pull request's head, judged. */
export async function sealPull({ repo, number, sha, io: given, requireOpen = true, waitOnRunning = true }) {
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
  if (requireOpen && pull.state !== 'open') return { ok: false, lines: [`#${number}: is ${pull.state}`] };
  const paths = await io.files(number);
  const texts = new Map();
  const text = (f, ref) => {
    const k = `${ref}:${f}`;
    if (!texts.has(k)) texts.set(k, Promise.resolve(io.text(f, ref)));
    return texts.get(k);
  };
  const touchedFiles = await touchedSteps({ paths, head, base: pull.base?.sha, text });
  // The revert main-bisect opens (autoRevertScope): it undoes the culprit's journey tests with it, so it names no steps,
  // and it runs the journeys that failed on main and the culprit's own. Anything else on its branch is ordinary.
  const auto = await readAutoRevertScope({ io, repo, pull, number, paths });
  const touched = auto?.ok
    ? { ok: true, lines: [`${auto.why}: its journey tests need no steps named`] }
    : judgeTouched({ repo, title: pull.title, body: pull.body, touched: touchedFiles });
  // The journeys this pull request can reach (journey-touch.mjs): a journey test file the head removed runs nothing.
  const atHead = new Map();
  for (const f of paths) if (RUN_FILE.test(f)) atHead.set(f, (await text(f, head)) !== null);
  // GitHub's Revert button (revertOf) undoes a change and adds none, so only shared setup still holds it to a run: a red
  // main is fixed or undone within 2 hours (project-state OWNER 180), as judgeSteps and judgeTouched let it.
  const reverting = revertOf({ title: pull.title, body: pull.body, repo });
  // A pull request that names a journey is judged on it, its changed journey files and the always-run list, as its run
  // was given them (namedSealInputs); else product code goes to the map or the full run.
  const stack = paths.filter((p) => pathKind(p).stack);
  const named =
    reverting || !(stack.length || paths.some((p) => pathKind(p).product))
      ? null
      : await namedSealInputs({ io, pull: { ...pull, stack }, head });
  const reach = reverting
    ? { mode: 'none', full: [], files: [] }
    : auto?.ok
      ? { mode: 'files', full: [], files: auto.files, reach: [auto.why] }
      : journeyTouch(paths, (f) => atHead.get(f) ?? true, named ? null : await reachInputs({ io, paths, head, text }), named);
  // A stack file narrowed to the journeys using it (theo-01 part 2) no longer needs the full run as shared setup.
  const narrowed = new Set(reach.stack ?? []);
  const shared = paths.filter((p) => isSharedSetup(p) && !narrowed.has(p));
  const runs = titleSteps(pull.title).length || shared.length || reach.mode !== 'none' ? await io.runs(head) : [];
  const reports = new Map();
  const reportOf = (r) => {
    if (!reports.has(r.id)) reports.set(r.id, io.reportOf(r));
    return reports.get(r.id);
  };
  const steps = await judgeSteps({ sha: head, repo, title: pull.title, body: pull.body, runs, reportOf, waitOnRunning });
  const verdictOf = (rep, r) => io.verdictOf(rep, r);
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
  const inherited = io.mainRuns
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
          touches,
          upTo: await (upTo ??= Promise.resolve()
            .then(() => io.mergeBase(pull.base?.sha, head))
            .catch(() => null)),
          rangeOf: io.rangeOf,
        })
    : null;
  const notShared = reach.full.filter((x) => !isSharedSetup(x.path));
  const full = shared.length
    ? await judgeFullRun({ sha: head, repo, shared, runs, reportOf, verdictOf, waitOnRunning, inherited })
    : reach.mode === 'full'
      ? await judgeFullRun({
          sha: head,
          repo,
          shared: [],
          runs,
          reportOf,
          verdictOf,
          waitOnRunning,
          inherited,
          because: `it changes what can reach any journey (${notShared
            .slice(0, 3)
            .map((x) => `${x.path}: ${x.why}`)
            .join('; ')}${notShared.length > 3 ? `; ${notShared.length - 3} more` : ''})`,
        })
      : reach.mode === 'files'
        ? await judgeTouchedRun({
            sha: head,
            repo,
            files: reach.files,
            runs,
            reportOf,
            verdictOf,
            waitOnRunning,
            inherited,
            reach: reach.reach,
            named: reach.named,
          })
        : { ok: true, state: 'none', lines: [] };
  const v = {
    ok: steps.ok && full.ok && touched.ok,
    stepsOk: steps.ok && touched.ok,
    fullOk: full.ok,
    // The kind of each red, for its title (redKinds); a touched-step problem is the pull request's own.
    stepsKinds: [...(steps.ok ? [] : (steps.kinds ?? ['yours'])), ...(touched.ok ? [] : (touched.kinds ?? ['yours']))],
    fullKinds: full.ok ? [] : (full.kinds ?? []),
    lines: [...steps.lines, ...touched.lines, ...full.lines],
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
 * whatever a pull request changes (R3 C3 piece 2, OWNER 242). Every Actions job named `CI merge seal` on a head must
 * pass (probe #7547, 8 Nov 2026: a red one blocked though a green one finished last), so the default branch's seal
 * decides even when a pull request edits its own; and each seal is re-run in place, since an older red run blocks.
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
  { workflow: 'ci.yml', event: 'pull_request', what: 'CI' },
  { workflow: 'ci-review.yml', event: 'pull_request_target', what: 'the CI review', judge: true },
  { workflow: 'real-app-journeys.yml', event: null, what: 'Real-app journeys', journeys: true },
];

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

/**
 * The input runs still going on `sha` (`runsOf[workflow]`, each workflow's runs on the head), as lines; [] when every
 * input has finished. Journeys count only when the change needs them (`needJourneys`: it names steps, or its paths reach
 * a journey, journey-touch.mjs); a change that reaches none never waits for a journeys run. A CI review run that ended
 * with the judge down (`judgeDown`, set by readGoing on the head's newest run: review-marker.mjs isJudgeDown) counts as
 * still going when `needJudge` (readGoing sets it for every pull request), so its seal waits for the judge exactly as for a review
 * still running, and is started when a review on the head next finishes (project-state OWNER 289 point 11: "A judge
 * that stops shows as 'judge down' ... never as red PRs. No PR merges without its judge."). Pure.
 */
export function inputsGoing({ sha, runsOf, needJourneys, needJudge = false }) {
  const out = [];
  for (const { workflow, event, what, journeys, judge } of SEAL_INPUTS) {
    if (journeys && !needJourneys) continue;
    for (const r of runsOf?.[workflow] ?? []) {
      if (r?.head_sha !== sha || (event && r?.event !== event)) continue;
      if (r?.status !== 'completed') out.push(`${what} run ${r.id} (${r.status})`);
      else if (journeys && r?.deferred === true)
        out.push(`${what} run ${r.id} (deferred behind main's journeys; it is re-run once main's shards are queued)`);
      else if (judge && needJudge && r?.judgeDown === true)
        out.push(`${what} run ${r.id} (judge down: no verdict; it re-runs when the judge is back)`);
    }
  }
  return out;
}

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
 * merge-seal.yml's re-run decides: every `CI merge seal` on the head must pass (probe #7547). Pure.
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
  // The newest run that has a seal job decides; a run that finished with none (cancelled before its jobs) is passed over.
  for (const run of prs) {
    const runId = String(run.id);
    if (!jobsByRun.has(runId)) return { act: 'jobs', runId, msg: `reading run ${runId}'s jobs` };
    const seal = (jobsByRun.get(runId) ?? []).filter((j) => j?.name === SEAL).sort((a, b) => b.id - a.id)[0];
    // A skipped seal holds no verdict, so the run before it decides (merge-seal.yml's job is never skipped; this guards an
    // older run or a future skip).
    if (seal?.status === 'completed' && seal?.conclusion === 'skipped') continue;
    if (!seal || ['queued', 'waiting', 'pending', 'requested'].includes(seal.status)) {
      if (run.status === 'completed') continue;
      // merge-seal.yml's run deciding whether to seal now (sealNow, seconds): wait, so a seal it skips is then started.
      if (event === 'pull_request_target' && run.status === 'in_progress')
        return { act: 'wait', runId, msg: `run ${runId} is deciding whether its seal waits for its inputs` };
      return { act: 'done', msg: 'the seal has not started; it will read the steps itself' };
    }
    // A seal still waiting for its inputs (WAIT_STEP) reads them all once they finish: re-running it would be a second verdict.
    if (seal.status !== 'completed' && (seal.steps ?? []).some((s) => s?.name === WAIT_STEP && s?.status !== 'completed'))
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
 * The seal jobs of the other finished runs of one workflow on a head (`runs`, the newest `skip`ped): a close and reopen,
 * or the same head pushed twice, leaves an older seal run beside the newest, and every `CI merge seal` on a head must
 * pass (probe #7547), so each red one is re-run too (review 7552-R2). The newest seal job per run.
 */
export async function otherSeals({ repo, runs, skip, event, get }) {
  const out = [];
  for (const run of (runs ?? []).filter((r) => r?.event === event && r?.status === 'completed' && String(r.id) !== String(skip))) {
    const jobs = (await get(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`))?.jobs;
    if (!Array.isArray(jobs)) throw new Error(`run ${run.id}'s jobs: not a list`);
    const seal = jobs.filter((j) => j?.name === SEAL && j?.status === 'completed').sort((a, b) => b.id - a.id)[0];
    if (seal && seal.conclusion !== 'skipped') out.push({ runId: String(run.id), seal });
  }
  return out;
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
      const jobs = (await get(`/repos/${repo}/actions/runs/${step.runId}/jobs?filter=latest&per_page=100`))?.jobs;
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
      let said2 = `re-ran the seal job ${step.jobId} of run ${step.runId}`;
      for (const o of await otherSeals({ repo, runs, skip: step.runId, event, get })) {
        if (o.seal.conclusion === 'success') continue;
        if (workflow === CI_WORKFLOW && !ciSealReads(o.seal)) continue;
        const r = await post(`/repos/${repo}/actions/jobs/${o.seal.id}/rerun`);
        if (r.status === 403 && /already running/i.test(r.message ?? '')) continue;
        if (r.status !== 201)
          throw new Error(`could not re-run the older red seal job ${o.seal.id} of run ${o.runId}: HTTP ${r.status} ${r.message ?? ''}`);
        said2 += `; and the older red seal job ${o.seal.id} of run ${o.runId}`;
      }
      return said2;
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
  SEAL_WORKFLOWS.filter((w) => !['CI', REVIEWED].includes(finished) || w.workflow !== CI_WORKFLOW);

/** `finished` after the CI review's run on the head ended: like CI, every armed pull request on the head is re-sealed. */
export const REVIEWED = 'CI review';

/**
 * Whether a re-check touches this pull request: only one with auto-merge armed (GitHub's `auto_merge`, set on the pull
 * request objects both the commit's pull request list and the pull request read return). Only an armed pull request
 * merges on its seal, so only its seal is read when it turns; arming runs merge-seal.yml afresh (`auto_merge_enabled`),
 * and so does every push and edit. (Failure it prevents: at 02:45 UTC on
 * 9 Nov 2026, 29 re-checks were queued, each of which can hold a runner up to 25 minutes waiting out a running seal,
 * for pull requests that no merge was waiting on; INTAFACED/project-state#1574 item 4.)
 */
export const armed = (p) => p?.auto_merge !== null && p?.auto_merge !== undefined;

/**
 * The open pull requests a re-check re-seals, of those with auto-merge armed (armed): after CI or the CI review finished
 * (`finished` = 'CI' or REVIEWED), every open pull request into this repository on `sha`, since the default branch's
 * seal reads both; otherwise those recheckPulls takes (named steps, an exemption line, or a change the journeys run
 * judges).
 */
export async function recheckTargets({ finished, pulls, sha, repo, oldTitle = '', oldBody = '', filesOf }) {
  const live = (pulls ?? []).filter(armed);
  if (finished === 'CI' || finished === REVIEWED)
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
    const jobs = (await get(`/repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`))?.jobs;
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

/**
 * inputsGoing on `sha` read through the API (each run read through settledRun unless `settle` is false), journeys counted when any of `pulls` needs them (needsJourneys), and a down
 * judge for every pull request: the head's finished CI review runs' jobs are read, newest first, until one actually
 * reviewed (review-marker.mjs reviewRan).
 */
export async function readGoing({ get, repo, sha, pulls, settle = true }) {
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
          const jobs = (await get(`/repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`))?.jobs;
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
      const jobs = (await get(`/repos/${repo}/actions/runs/${newest.id}/jobs?filter=latest&per_page=100`))?.jobs;
      if (!Array.isArray(jobs)) throw new Error(`run ${newest.id}'s jobs: not a list`);
      const touch = jobs.find((j) => j?.name === TOUCH_JOB);
      newest.deferred = (touch?.steps ?? []).some((st) => st?.name === DEFER_MARK && st?.conclusion === 'success');
    }
  }
  let needJourneys = false;
  for (const p of pulls ?? []) {
    if (needJourneys) break;
    needJourneys ||= needsJourneys(p, await pullFiles(get, repo, p.number));
  }
  // No PR merges without its judge (project-state OWNER 289 point 11): a down judge holds every pull request it was asked
  // to review, not only one whose change needs the review's verdict (CI review on 0cef53f9b, item 3).
  const needJudge = true;
  {
    const { workflow, event } = SEAL_INPUTS.find((i) => i.judge);
    // The newest finished run that actually reviewed: a title or body edit's run, whose job is skipped (reviewRan), is
    // passed over, so it neither hides a down run nor stands for one. At most REVIEW_RUNS_READ runs' jobs are read.
    const finished = runsOf[workflow]
      .filter((r) => r?.head_sha === sha && r?.event === event && r?.status === 'completed')
      .sort((a, b) => b.id - a.id);
    for (const run of finished.slice(0, REVIEW_RUNS_READ)) {
      const jobs = (await get(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`))?.jobs;
      if (!Array.isArray(jobs)) throw new Error(`run ${run.id}'s jobs: not a list`);
      const job = jobs.find(reviewRan);
      if (!job) continue;
      run.judgeDown = isJudgeDown(job);
      break;
    }
  }
  return inputsGoing({ sha, runsOf, needJourneys, needJudge });
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
  if (going.length) return { act: 'wait', msg: `waiting for ${going.join(', ')}` };
  return { act: 'judge', msg: 'every input on this head has finished' };
}

/** The seal job's step that waits for its inputs (waitStep); a re-check leaves a seal still in it alone (recheckStep). */
export const WAIT_STEP = 'Wait for CI, the CI review and the journeys this change needs';
/** How long the seal waits in WAIT_STEP: 60 polls a minute apart, beyond the slowest journeys run seen (43 min, 11 Nov). */
export const WAIT_POLLS = 60;
const WAIT_POLL_MS = 60_000;

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
  const res = await fetch(`https://api.github.com${path}`, {
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
 * The older red seals a green verdict on `sha` re-runs (merge-seal.yml's last step, `--clear-older`): every
 * `CI merge seal` on a head must pass (probe #7547), so a red left by an earlier run on the same head (an edit, a reopen,
 * a push before the title named the right steps) would block a head that now passes. Each such job of merge-seal.yml's
 * other runs there is re-run, and judges again what this one just judged. A re-run that also passes re-runs no other
 * green, and one that fails re-runs nothing, so it ends. ci.yml's own red seals on a branch cut before 9 Nov 2026 13:50
 * UTC are left to the inputs' re-check (ciSealReads): re-running one starts that CI run again. Returns the lines said.
 */
export async function clearOlderReds({ repo, sha, self, get, post }) {
  const runs = (await get(`/repos/${repo}/actions/workflows/merge-seal.yml/runs?head_sha=${sha}&event=pull_request_target&per_page=100`))
    ?.workflow_runs;
  if (!Array.isArray(runs)) throw new Error(`merge-seal.yml runs on ${sha}: not a list`);
  const out = [];
  const mine = runs.filter((r) => r?.head_sha === sha);
  for (const o of await otherSeals({ repo, runs: mine, skip: self, event: 'pull_request_target', get })) {
    if (o.seal.conclusion === 'success') continue;
    const r = await post(`/repos/${repo}/actions/jobs/${o.seal.id}/rerun`);
    if (r.status === 403 && /already running/i.test(r.message ?? '')) {
      out.push(`run ${o.runId}'s seal is already re-running`);
      continue;
    }
    if (r.status !== 201)
      throw new Error(`could not re-run the older red seal job ${o.seal.id} of run ${o.runId}: HTTP ${r.status} ${r.message ?? ''}`);
    out.push(`re-ran the older red seal job ${o.seal.id} of run ${o.runId}`);
  }
  return out.length ? out : ['no older red seal on this head'];
}

async function clearOlderStep({ repo, token }) {
  const { HEAD_SHA, RUN_ID } = process.env;
  if (!SHA40.test(HEAD_SHA ?? '') || !/^\d+$/.test(RUN_ID ?? '')) throw new Error('--clear-older needs HEAD_SHA and RUN_ID');
  for (const l of await clearOlderReds({ repo, sha: HEAD_SHA, self: RUN_ID, get: (path) => api(path, token), post: poster(token) }))
    console.log(l);
}

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
  // Each seal on the head, ci.yml's and the default branch's (SEAL_WORKFLOWS); every one must pass, so each is re-run.
  // Read again just before a re-run: the head may have moved while a running seal was waited out (rerunBlocker).
  const outcomes = [];
  // After CI finished, ci.yml's own seal ran in that same run after its needs, so only the default branch's seal is
  // re-run: re-running ci.yml's would start a new attempt of that CI run, the default branch's seal would read CI as
  // running, and the next CI completion would start it all again (the CI review on 7a7eb9a0, 8 Nov 2026).
  // The seal's inputs on this head (SEAL_INPUTS): while one is still going, merge-seal.yml's seal is left alone, since
  // that input's own end starts this re-check again; so the seal gives one verdict, once they have all finished.
  const going = await readGoing({ get, repo, sha: SHA, pulls: named });
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
        )}. A pull request is held to the journeys it touches (tooling/ci/journey-touch.mjs): shared setup, product code and anything else that can reach any journey need the newest finished full Real-app journeys run on its exact head clean by the journeys verdict (dispatch real-app-journeys.yml on the branch with no journeys input); a change to journey test files only needs those files run clean (the journeys input naming them). Read with the default branch's baseline; the seal re-runs when the run finishes. \`node tooling/ci/journey-touch.mjs --base origin/main\` prints which.`,
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

async function main() {
  const { GH_TOKEN, REPO } = process.env;
  if (!GH_TOKEN || !REPO) {
    console.error('::error::journey-seal needs GH_TOKEN and REPO');
    process.exit(1);
  }
  if (process.argv.includes('--recheck')) return recheck({ repo: REPO, token: GH_TOKEN });
  if (process.argv.includes('--seal-now')) return sealNowStep({ repo: REPO, token: GH_TOKEN });
  if (process.argv.includes('--clear-older')) return clearOlderStep({ repo: REPO, token: GH_TOKEN });
  if (process.argv.includes('--wait-inputs')) return waitInputsStep({ repo: REPO, token: GH_TOKEN });
  const io = makeIo(REPO, GH_TOKEN);
  // The journeys run's planner (real-app-journeys.yml) reads an automatic revert's narrow scope from the same rule.
  const scopeAt = process.argv.indexOf('--auto-revert-scope');
  if (scopeAt > 0) {
    const n = Number(process.argv[scopeAt + 1]);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('--auto-revert-scope needs a pull request number');
    const pull = await io.pull(n);
    const scope = await readAutoRevertScope({ io, repo: REPO, pull, number: n, paths: await io.files(n) });
    return console.log(JSON.stringify(scope?.ok ? { files: scope.files, why: scope.why } : { files: null, why: scope?.why ?? '' }));
  }
  const dry = process.argv.indexOf('--dry-run');
  if (dry > 0) {
    const [n, sha] = process.argv.slice(dry + 1);
    return report(await sealPull({ repo: REPO, number: Number(n), sha: sha || undefined, io, requireOpen: false }), 'dry run');
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
    console.error(`::error title=Named journey steps unreadable::${e.message}; the seal fails closed`);
    process.exit(1);
  });
