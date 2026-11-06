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
 *   GH_TOKEN=... REPO=owner/name HEAD_SHA=... PR_NUMBER=... node tooling/ci/journey-seal.mjs
 *   GH_TOKEN=... REPO=... MERGE_GROUP_BASE_SHA=... MERGE_GROUP_HEAD_SHA=... MERGE_GROUP_HEAD_REF=... node tooling/ci/journey-seal.mjs
 *   GH_TOKEN=... REPO=... node tooling/ci/journey-seal.mjs --dry-run <pr> [<sha>]   (any pull request, closed too; read only)
 *   GH_TOKEN=... REPO=... SHA=... [PR_NUMBER=...] [OLD_TITLE=...] node tooling/ci/journey-seal.mjs --recheck   (re-runs the seal)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JOURNEYS_ARTIFACT, readReport } from './journey-verdict.mjs';
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

/**
 * Journey ids a title names with no step numbers anywhere in it (`J-charts-desk-15 place and move orders`). Each names
 * every step of that journey (journeyStepsFor), so a title can't skip the seal by leaving its numbers out: #7265 merged
 * at 09:25:36 UTC 6 Nov with J-charts-desk-15 #1 red in full run 42189311428, because its title named the journey with
 * no steps and the seal read that as naming none (seal job 127800080421). A Revert-button title names none.
 */
export function bareJourneys(title) {
  if (isRevert(title)) return [];
  const withSteps = new Set(stepsIn(title).map((k) => k.split('#')[0]));
  const ids = [...String(title ?? '').matchAll(/\bJ-[a-z0-9]+(?:-[a-z0-9]+)*-\d+\b/gi)].map((m) => m[0].toLowerCase().replace(/^j-/, 'J-'));
  return [...new Set(ids)].filter((id) => !withSteps.has(id)).sort(byStep);
}

/**
 * Every journey's step numbers, from docs/roadmap/journeys.json beside this script: in CI that is the default branch's
 * copy (the seal runs main's script from its own worktree), so a pull request can't shrink the list it is judged by.
 * Map of id → [n]. Unreadable: throws, and the seal fails closed.
 */
export function loadJourneys(file = fileURLToPath(new URL('../../docs/roadmap/journeys.json', import.meta.url))) {
  if (!existsSync(file)) throw new Error(`${file} is missing, so a journey named without step numbers can't be read`);
  const list = JSON.parse(readFileSync(file, 'utf8'));
  return new Map((Array.isArray(list) ? list : (list.journeys ?? [])).map((j) => [j.id, (j.steps ?? []).map((st) => st.n)]));
}

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
 * The steps a body exempts, and the exemption-like lines it can't accept: { steps: Set, problems: [line] }. One fence
 * tracker over the raw lines (a fence opens at any indent, so one inside a list counts) and HTML comments stripped; a
 * line inside either is code or hidden and exempts nothing. Outside them, a `Left-or-replaced:` line at column 0 whose
 * rest is only full step ids (`J-bank-13 #1 #3, J-bank-14 #2`) exempts those steps; every other line that looks like an
 * exemption is a problem, and so is an exemption line with anything else after the colon or a range that can't be read.
 */
export function exemptions(body) {
  const steps = new Set();
  const problems = [];
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
export async function judgeSteps({ sha, repo, title, body, runs, reportOf, waitOnRunning = true, journeys }) {
  const bare = bareJourneys(title);
  const book = bare.length ? (journeys ?? loadJourneys()) : new Map();
  const unknown = bare.filter((id) => !(book.get(id) ?? []).length);
  if (unknown.length)
    return {
      ok: false,
      state: 'fail',
      lines: unknown.map(
        (id) =>
          `${id} is named with no step numbers and docs/roadmap/journeys.json on main has no such journey: name the steps it delivers (\`${id} #1 #2\`)`,
      ),
    };
  const named = [...new Set([...titleSteps(title), ...bare.flatMap((id) => book.get(id).map((n) => `${id}#${n}`))])].sort(byStep);
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
        return { states: readReport(JSON.parse(text)).states, artifact: art.id };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    compare: (base, head) => api(`/repos/${repo}/compare/${base}...${head}?per_page=250`, token),
  };
}

/** One pull request's head, judged. */
export async function sealPull({ repo, number, sha, io, requireOpen = true, waitOnRunning = true }) {
  const pull = await io.pull(number);
  const head = String(pull?.head?.sha ?? '');
  if (!SHA40.test(head)) return { ok: false, lines: [`#${number}: its head could not be read`] };
  if (sha && head !== sha)
    return { ok: false, lines: [`#${number}: its head is now ${head}, not ${sha}; the newer head gets its own seal run`] };
  if (requireOpen && pull.state !== 'open') return { ok: false, lines: [`#${number}: is ${pull.state}`] };
  const v = await judgeSteps({
    sha: head,
    repo,
    title: pull.title,
    body: pull.body,
    runs: namesSteps(pull.title) ? await io.runs(head) : [],
    reportOf: (r) => io.reportOf(r),
    waitOnRunning,
  });
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

/** Re-run the seal job on `sha` (recheckStep). `post`/`get` are the API (tests pass their own). */
export async function rerunSealJob({ repo, sha, get, post, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log }) {
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
      const { status, message = '' } = await post(`/repos/${repo}/actions/jobs/${step.jobId}/rerun`);
      // AGENTS.md "Check, then merge" 6: the one 403 that only means wait. Any other 403 or 429 stops and is reported.
      if (status === 403 && /already running/i.test(message)) return `run ${step.runId} is already re-running (${message})`;
      if (status !== 201) throw new Error(`could not re-run the seal job ${step.jobId} of run ${step.runId}: HTTP ${status} ${message}`);
      return `re-ran the seal job ${step.jobId} of run ${step.runId}`;
    }
    if (poll >= SEAL_POLLS)
      throw new Error(`${step.msg} after ${(SEAL_POLLS * SEAL_POLL_MS) / 60_000} min; re-run the seal once it finishes`);
    if (poll === 1) log(`${step.msg}; checking every ${SEAL_POLL_MS / 1000}s`);
    await sleep(SEAL_POLL_MS);
  }
}

/** A title the seal judges: it names steps, or holds a range that can't be read as steps (which fails the seal). */
export const namesSteps = (title) => titleSteps(title).length > 0 || titleProblems(title).length > 0 || bareJourneys(title).length > 0;

/**
 * The open pull requests on `sha` whose seal a re-check re-runs: the title judged now, or before an edit (`oldTitle`).
 * A title edited from "fix J-bank-13" to "J-bank-13 #1-#100" is judged, so its green seal turns red.
 */
export const recheckPulls = ({ pulls, sha, repo, oldTitle = '' }) =>
  (pulls ?? [])
    .filter((p) => p?.state === 'open' && p?.head?.sha === sha && p?.base?.repo?.full_name === repo)
    .filter((p) => namesSteps(p.title) || namesSteps(oldTitle));

/**
 * journey-seal-recheck.yml: the open pull requests whose head is `sha` and whose title names steps now (or named them
 * before an edit, OLD_TITLE), each with its seal re-run. A head no open pull request names is left alone.
 */
async function recheck({ repo, token }) {
  const { SHA, PR_NUMBER, OLD_TITLE = '' } = process.env;
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
  const named = recheckPulls({ pulls, sha: SHA, repo, oldTitle: OLD_TITLE });
  if (!named.length) return console.log(`no open pull request on ${SHA} names journey steps; the seal is left as it is`);
  console.log(
    `#${named.map((p) => p.number).join(', #')} on ${SHA} name journey steps: ${await rerunSealJob({ repo, sha: SHA, get, post })}`,
  );
}

function report({ ok, lines }, how) {
  for (const l of lines) console.log(l);
  if (ok) return console.log(`journey steps: ${how}`);
  console.error(
    `::error title=Named journey steps not green on this head::${lines
      .filter((l) => !/on a Left-or-replaced line$/.test(l) && !/add this line to the body/.test(l))
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
  if (process.env.MERGE_GROUP_HEAD_SHA) {
    const { MERGE_GROUP_BASE_SHA: base, MERGE_GROUP_HEAD_SHA: head, MERGE_GROUP_HEAD_REF: headRef } = process.env;
    const commits = (await io.compare(base, head))?.commits;
    const numbers = groupPulls(commits, headRef);
    if (!numbers) return report({ ok: false, lines: [`the merge group ${headRef} could not be read whole`] }, '');
    const all = { ok: true, lines: [] };
    for (const n of numbers) {
      const v = await sealPull({ repo: REPO, number: n, io, waitOnRunning: false });
      all.ok &&= v.ok;
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
