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
 *     when the run finishes (journey-seal-recheck.yml). A run dispatched after a green seal does not turn it red until it
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
 * journey-seal-recheck.yml re-runs the seal when a journeys run on a pull request's head finishes and when a title or
 * body that names steps is edited. On a merge queue's commit every queued pull request is judged on its own head the
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
 * hand. The seal now says exactly which run each pull request needs, and a builder runs that one.)
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
import {
  JOURNEYS_ARTIFACT,
  fetchInputs,
  isMainRun,
  judge,
  manifestsAt,
  moneyCodeDirs,
  readReport,
  rootInputs,
} from './journey-verdict.mjs';
import { RUN_FILE, journeyTouch, pathKind, printable } from './journey-touch.mjs';
import { groupPulls } from './review-marker.mjs';

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

/** The steps a pull request title names. */
export const titleSteps = (title) => (isRevert(title) ? [] : stepsIn(title));

/** Step ranges in a title that can't be read as steps (an end past STEP_MAX): each fails the seal closed. */
export function titleProblems(title) {
  const out = [];
  if (isRevert(title)) return out;
  for (const m of String(title ?? '').matchAll(STEP_RUN))
    for (const n of m[2].matchAll(NUMBER))
      if (n[2] !== undefined && (Number(n[1]) > STEP_MAX || Number(n[2]) > STEP_MAX)) out.push(`${m[1]} ${n[0]}`.replace(/\s+/g, ' '));
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
      lines: [`the title's ${unreadable.join(', ')} can't be read as steps (a step number past ${STEP_MAX}); name the steps it means`],
    };
  if (named.length === 0) return { ok: true, state: 'none', lines: ['the title names no journey step'] };
  const left = exemptions(body);
  if (left.problems.length)
    return {
      ok: false,
      state: 'fail',
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
        `Real-app journeys run ${ids} on this head has not finished; the seal reads the steps once it does (journey-seal-recheck.yml re-runs it)`,
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
  for (const k of needed) {
    let decided = null;
    for (const r of finished) {
      const rep = await report(r);
      const where = `run ${r.id} (attempt ${r.run_attempt ?? 1})`;
      if (rep.error) {
        decided = { green: false, why: `${where}'s report couldn't be read (${rep.error}), so a failure there can't be ruled out` };
        break;
      }
      const st = rep.states?.[k];
      if (st === undefined) continue;
      decided = st === 'passed' ? { green: true, why: `passed in ${where}` } : { green: false, why: `${st} in ${where}` };
      break;
    }
    if (!decided)
      decided = {
        green: false,
        why: finished.length
          ? `no finished Real-app journeys run on this head reports it (${finished.length} read)`
          : 'no finished Real-app journeys run on this head',
      };
    if (!decided.green) {
      ok = false;
      notGreen.push(k);
    }
    lines.push(`${k}: ${decided.why}`);
  }
  if (notGreen.length) lines.push(leaveLine(notGreen));
  return { ok, state: ok ? 'pass' : 'fail', lines };
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
        lines: [`full run: ${why}; ${where}'s report couldn't be read (${rep.error}), so the seal fails closed`],
      };
    let v;
    try {
      v = await verdictOf(rep, r);
    } catch (e) {
      return {
        ok: false,
        state: 'fail',
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
export async function judgeTouchedRun({ sha, repo, files, runs, reportOf, verdictOf, waitOnRunning = true, inherited = null }) {
  const why = `it touches ${files.length} journey file(s) (${files.slice(0, 5).join(', ')}${files.length > 5 ? `, ${files.length - 5} more` : ''})`;
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
        lines: [`touched journeys: ${why}; ${where}'s report couldn't be read (${rep.error}), so the seal fails closed`],
      };
    let v;
    try {
      v = await verdictOf(rep, r);
    } catch (e) {
      return {
        ok: false,
        state: 'fail',
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

async function api(path, token, { raw = false } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
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
    runs: (sha) =>
      listWhole(`/repos/${repo}/actions/workflows/${file}/runs?head_sha=${sha}`, 'workflow_runs', token, `${file} runs on ${sha}`),
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
    mainRuns: async () => {
      const r = await api(`/repos/${repo}/actions/workflows/${file}/runs?branch=main&status=completed&per_page=30`, token);
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
    async text(path, ref) {
      const url = `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`;
      const res = await fetch(`https://api.github.com${url}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github.raw+json' },
        redirect: 'follow',
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
      return res.text();
    },
    verdictOf: (report, run) => fullVerdict({ repo, report, run, inputs: baseInputs() }),
    // Whether a path is in money code, by the default branch's manifests (the base's copy this script runs from).
    moneyCode: async (paths) => {
      const dirs = moneyCodeDirs(manifestsAt(BASE_ROOT));
      return paths.some((f) => dirs.has(packageOf(f)));
    },
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
 * The part of the product a changed path can break journeys through: a journey test file breaks only its own journey
 * (`journey J-bank-13`); a path no journeys run executes or reads (journey-touch.mjs `none`: other workflows, CI checks
 * the run doesn't use, unit tests) breaks none (null); anything else breaks through its package, since a breaking commit
 * blocks merges into the packages it touches (AGENTS.md floor 5).
 */
export function areaOf(path) {
  const k = pathKind(path);
  if (k.kind === 'none') return null;
  const m = JOURNEY_TEST.exec(String(path));
  return m ? `journey ${m[1]}` : packageOf(path);
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
 *   - one whose paths share an area (areaOf) with a commit on main from where the step last passed to the newest main
 *     commit the head holds (`upTo`): the commits one of which broke it, and any that tried to fix it since
 *     (`rangeOf(from, to)` → { files, commits } from GitHub's compare).
 * A pull request that changes the journey stack's shared setup (`touches.shared`: it reaches every journey) or money
 * code (`touches.money`: AGENTS.md "How work flows" 8, "a red in a package your PR changes always blocks the merge, even
 * when main shares it") is in every red's area, so nothing it inherited is passed over.
 * A red that can't be bounded stops every pull request it reaches: an unreadable input, main's reference run with an
 * input problem, no reference run, or a break range that can't be read, is wider than RANGE_MAX commits or lists files
 * short, or a step that never passed on main (no commit bounds where it broke; council review G1). A step that last
 * passed on the commit it now fails on (a flake: no commit between) has its journey as its whole area. Every other red
 * (new on this head) stops it as before. Returns { blocking, passed, notes }.
 */
export async function splitInherited({ red, main, touches, upTo, rangeOf }) {
  if (!main) return { blocking: red, passed: [], notes: [`no finished full run on main is in this head's history, so every red counts`] };
  const at = `main's run ${main.run.id} on ${String(main.run.head_sha).slice(0, 10)}`;
  if (main.problems.length)
    return { blocking: red, passed: [], notes: [`${at} has unreadable inputs (${main.problems[0]}), so every red counts`] };
  if (touches.shared || touches.money)
    return {
      blocking: red,
      passed: [],
      notes: [
        `this pull request changes ${touches.shared ? "the journey stack's shared setup, which reaches every journey" : 'money code (AGENTS.md "How work flows" 8)'}, so every red counts, inherited or not`,
      ],
    };
  const mine = new Set([...touches.paths].map(areaOf).filter(Boolean));
  const blocking = [];
  const passed = [];
  const ranges = new Map();
  for (const x of red) {
    if (x.step === '(input)' || !main.red.has(x.step) || reasonOf(main.red.get(x.step)) !== reasonOf(x.why)) {
      blocking.push(x);
      continue;
    }
    const journey = journeyOf(x.step);
    const stop = (why) => blocking.push({ step: x.step, why: `${x.why}; inherited from ${at}, ${why}` });
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
    const broke = new Set(range.files.map(areaOf).filter(Boolean));
    const hit = [...touches.paths].find((f) => broke.has(areaOf(f)));
    if (hit)
      stop(
        `and this pull request changes ${printable(hit)} (${printable(areaOf(hit))}), which a commit in ${span} (where it broke) changed too`,
      );
    else
      passed.push({
        step: x.step,
        why: `${at} has it red too; its area is ${journey} and what ${range.commits} commit(s) in ${span} changed (${[...broke].slice(0, 5).map(printable).join(', ') || 'nothing a journey reads'}${broke.size > 5 ? `, ${broke.size - 5} more` : ''}), none of which this pull request touches`,
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

/** One pull request's head, judged. */
export async function sealPull({ repo, number, sha, io, requireOpen = true, waitOnRunning = true }) {
  const pull = await io.pull(number);
  const head = String(pull?.head?.sha ?? '');
  if (!SHA40.test(head)) return { ok: false, lines: [`#${number}: its head could not be read`] };
  if (sha && head !== sha)
    return { ok: false, lines: [`#${number}: its head is now ${head}, not ${sha}; the newer head gets its own seal run`] };
  if (requireOpen && pull.state !== 'open') return { ok: false, lines: [`#${number}: is ${pull.state}`] };
  const paths = await io.files(number);
  const shared = paths.filter(isSharedSetup);
  const texts = new Map();
  const text = (f, ref) => {
    const k = `${ref}:${f}`;
    if (!texts.has(k)) texts.set(k, Promise.resolve(io.text(f, ref)));
    return texts.get(k);
  };
  const touchedFiles = await touchedSteps({ paths, head, base: pull.base?.sha, text });
  const touched = judgeTouched({ repo, title: pull.title, body: pull.body, touched: touchedFiles });
  // The journeys this pull request can reach (journey-touch.mjs): a journey test file the head removed runs nothing.
  const atHead = new Map();
  for (const f of paths) if (RUN_FILE.test(f)) atHead.set(f, (await text(f, head)) !== null);
  // GitHub's Revert button (revertOf) undoes a change and adds none, so only shared setup still holds it to a run: a red
  // main is fixed or undone within 2 hours (project-state OWNER 180), as judgeSteps and judgeTouched let it.
  const reach = revertOf({ title: pull.title, body: pull.body, repo })
    ? { mode: 'none', full: [], files: [] }
    : journeyTouch(paths, (f) => atHead.get(f) ?? true);
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
    ]),
    paths: new Set(paths),
    shared: shared.length > 0,
    money: io.moneyCode ? await io.moneyCode(paths) : false,
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
        ? await judgeTouchedRun({ sha: head, repo, files: reach.files, runs, reportOf, verdictOf, waitOnRunning, inherited })
        : { ok: true, state: 'none', lines: [] };
  const v = {
    ok: steps.ok && full.ok && touched.ok,
    stepsOk: steps.ok && touched.ok,
    fullOk: full.ok,
    lines: [...steps.lines, ...touched.lines, ...full.lines],
  };
  return { ...v, lines: v.lines.map((l) => `#${number} (${head.slice(0, 10)}): ${l}`) };
}

export const SEAL = 'CI merge seal';
const SEAL_POLL_MS = 20_000;
const SEAL_POLLS = 75; // 25 minutes: a running seal may be waiting out the CI review (review-marker.mjs, 20 minutes)

/** The workflow file that holds the seal job. */
export const CI_WORKFLOW = 'ci.yml';

/**
 * What to do about a head's seal once its steps' inputs changed (a journeys run finished, a title or body was edited):
 * re-run it whatever its colour, since a newer run or an edit can turn a green seal red as well as a red one green.
 * Read through the Actions API with the workflow's own GITHUB_TOKEN (`actions: read` and `write`), not the Checks API:
 * `runs` are CI_WORKFLOW's pull_request runs on the head, and `jobs` the newest run's latest-attempt jobs, once read.
 * Pure, so the table is testable.
 */
export function recheckStep(runs, jobsByRun = new Map()) {
  const prs = (runs ?? []).filter((r) => r?.event === 'pull_request').sort((a, b) => b.id - a.id);
  if (!prs.length) return { act: 'done', msg: 'CI has not run on this head; its seal will read the steps itself' };
  // The newest run that has a seal job decides; a run that finished with none (cancelled before its jobs) is passed over.
  for (const run of prs) {
    const runId = String(run.id);
    if (!jobsByRun.has(runId)) return { act: 'jobs', runId, msg: `reading run ${runId}'s jobs` };
    const seal = (jobsByRun.get(runId) ?? []).filter((j) => j?.name === SEAL).sort((a, b) => b.id - a.id)[0];
    if (!seal || ['queued', 'waiting', 'pending', 'requested'].includes(seal.status)) {
      if (run.status === 'completed') continue;
      return { act: 'done', msg: 'the seal has not started; it will read the steps itself' };
    }
    if (seal.status !== 'completed')
      return { act: 'wait', runId, msg: 'the seal is running and may have read the steps before this change' };
    if (run.status !== 'completed') return { act: 'wait', runId, msg: `run ${runId} is still finishing` };
    return { act: 'rerun', runId, jobId: String(seal.id) };
  }
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
export function rerunBlocker({ sha, pulls, headRuns }) {
  for (const p of pulls ?? []) {
    if (p?.state !== 'open') return { act: 'skip', msg: `#${p?.number} is no longer open` };
    if (p?.head?.sha !== sha)
      return { act: 'skip', msg: `#${p.number}'s head moved to ${String(p?.head?.sha).slice(0, 10)}; its own CI seal reads the change` };
  }
  const going = (headRuns ?? [])
    .filter((r) => r?.event === 'pull_request' && r?.head_sha === sha && r?.status !== 'completed')
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
}) {
  let said = '';
  for (let poll = 1; ; poll++) {
    const runs = (await get(`/repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${sha}&event=pull_request&per_page=100`))
      ?.workflow_runs;
    if (!Array.isArray(runs)) throw new Error(`${CI_WORKFLOW} runs on ${sha}: not a list`);
    const jobsByRun = new Map();
    let step = recheckStep(runs, jobsByRun);
    while (step.act === 'jobs') {
      const jobs = (await get(`/repos/${repo}/actions/runs/${step.runId}/jobs?filter=latest&per_page=100`))?.jobs;
      if (!Array.isArray(jobs)) throw new Error(`run ${step.runId}'s jobs: not a list`);
      jobsByRun.set(step.runId, jobs);
      step = recheckStep(runs, jobsByRun);
    }
    if (step.act === 'done') return step.msg;
    if (step.act === 'fail') throw new Error(step.msg);
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

/**
 * journey-seal-recheck.yml: the open pull requests whose head is `sha` and whose title names steps now (or named them
 * before an edit, OLD_TITLE), each with its seal re-run. A head no open pull request names is left alone.
 */
async function recheck({ repo, token }) {
  const { SHA, PR_NUMBER, OLD_TITLE = '', OLD_BODY = '' } = process.env;
  if (!SHA40.test(SHA ?? '')) throw new Error('recheck needs SHA');
  const get = (path) => api(path, token);
  const post = async (path) => {
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
  const pulls = PR_NUMBER
    ? [await get(`/repos/${repo}/pulls/${PR_NUMBER}`)]
    : await get(`/repos/${repo}/commits/${SHA}/pulls?per_page=100`);
  const shared = await sharedPulls({ pulls, sha: SHA, repo, filesOf: (n) => pullFiles(get, repo, n) });
  const named = recheckPulls({ pulls, sha: SHA, repo, oldTitle: OLD_TITLE, oldBody: OLD_BODY, shared });
  if (!named.length)
    return console.log(`no open pull request on ${SHA} names journey steps or touches shared setup; the seal is left as it is`);
  // Read again just before a re-run: the head may have moved while a running seal was waited out (rerunBlocker).
  const blocker = async () => {
    const now = await Promise.all(named.map((p) => get(`/repos/${repo}/pulls/${p.number}`)));
    const headRuns = (await get(`/repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${SHA}&event=pull_request&per_page=100`))
      ?.workflow_runs;
    if (!Array.isArray(headRuns)) throw new Error(`${CI_WORKFLOW} runs on ${SHA}: not a list`);
    return rerunBlocker({ sha: SHA, pulls: now, headRuns });
  };
  const outcome = await rerunSealJob({ repo, sha: SHA, get, post, blocker });
  console.log(
    `${outcome.startsWith('not re-run') ? '::notice::' : ''}#${named.map((p) => p.number).join(', #')} on ${SHA} name journey steps or touch shared setup: ${outcome}`,
  );
}

function report({ ok, lines, stepsOk = ok, fullOk = true }, how) {
  for (const l of lines) console.log(l);
  if (ok) return console.log(`journey steps: ${how}`);
  if (!fullOk)
    console.error(
      `::error title=The journeys this pull request touches are not proven on this head::${lines
        .filter((l) => /: (full run|touched journeys): /.test(l))
        .join('; ')
        .slice(
          0,
          3000,
        )}. A pull request is held to the journeys it touches (tooling/ci/journey-touch.mjs): shared setup, product code and anything else that can reach any journey need the newest finished full Real-app journeys run on its exact head clean by the journeys verdict (dispatch real-app-journeys.yml on the branch with no journeys input); a change to journey test files only needs those files run clean (the journeys input naming them). Read with the default branch's baseline; the seal re-runs when the run finishes. \`node tooling/ci/journey-touch.mjs --base origin/main\` prints which.`,
    );
  if (stepsOk) process.exit(1);
  console.error(
    `::error title=Named journey steps not green on this head::${lines
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
  const io = makeIo(REPO, GH_TOKEN);
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
    const all = { ok: true, stepsOk: true, fullOk: true, lines: [] };
    for (const n of numbers) {
      const v = await sealPull({ repo: REPO, number: n, io, waitOnRunning: false });
      all.ok &&= v.ok;
      all.stepsOk &&= v.stepsOk ?? v.ok;
      all.fullOk &&= v.fullOk ?? true;
      all.lines.push(...v.lines);
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
