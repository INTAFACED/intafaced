#!/usr/bin/env node
/**
 * JOURNEYS REVERT PROBE: which of the candidate commits broke the failing journey steps (main-bisect.yml, the
 * `Journeys revert: probe` job; journeys-revert.mjs `find` names the candidates). A binary search over the candidates
 * (oldest first; the commit before the first is the last green one): at each probe it checks the commit out, starts the
 * local test stack on it the way a Real-app journeys shard does (journeys-revert-probe.sh) and runs only the failing
 * journey files, with no retry. A probe is bad when any of the failing steps fails outright. The commit it settles on
 * is probed too when the search never ran it, and a culprit that passes there is not blamed (nothing reproduces).
 *
 * In parallel (13 Nov 2026: a 7-candidate search took 3 probes of about 20 minutes each, plus one on the culprit, against a
 * 120-minute time to restore): with at most MAX_LEGS candidates, main-bisect.yml probes each one on its own runner at
 * once (`plan`, then one `leg` per candidate), and `decide` names the culprit from all the results: the oldest commit of
 * the unbroken run of failing commits that ends at the red one, whose commit before passes (or is the last green one).
 * The newest candidate passing means nothing reproduces; a probe that couldn't run inside or next to that run blames
 * no one. More candidates than MAX_LEGS: one leg runs the binary search above, as before.
 *
 * It runs from a copy outside the checkout, with no imports, because it checks out older commits; old commits run as
 * code here, so the job gives it no GitHub token.
 *
 *   (CI) CANDIDATES FILES STEPS PROBE_SH JOURNEY_REPORT node journeys-revert-probe.mjs   (writes GITHUB_OUTPUT culprit)
 *   (CI) CANDIDATES node journeys-revert-probe.mjs plan                                  (writes GITHUB_OUTPUT points)
 *   (CI) POINT CANDIDATES FILES STEPS PROBE_SH JOURNEY_REPORT RESULT_FILE node journeys-revert-probe.mjs leg
 *   (CI) CANDIDATES RESULTS_DIR node journeys-revert-probe.mjs decide                    (writes GITHUB_OUTPUT culprit)
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const FILE = /^J-[a-z0-9-]+\.pw\.mjs$/;
const STEP = /^J-[a-z0-9-]+-\d+#\d+$/;
const STEP_TITLE = /^(J-[a-z0-9-]+-\d+)\s+#(\d+)\b/;

/**
 * Whether a commit's own Real-app journeys run leaves tests out (`workflowText`: its .github/workflows/real-app-journeys.yml):
 * it runs the leave-out planner. A probe of such a commit leaves out what the red run left out (JOURNEY_LEAVE_OUT_FILE,
 * main-bisect.yml's step "The red run's leave-out list"), as that run did: on 13 Nov 2026 run 4788 left out
 * J-copy-bots-otc-06 #1 and #3, its #2, #4, #5 and #6 failed for want of them, and the probes, which ran the file whole,
 * found that 233e1c4 "passes: nothing reproduces", so #8225 was never reverted. A commit before the planner runs every
 * test, as its push runs did. Pure.
 */
export const leavesOut = (workflowText) => /\bnode tooling\/scripts\/journey-leave-out\.mjs\b/.test(String(workflowText ?? ''));

/** The leave-out list file for a probe of `sha`, or '' (no list, an empty one, or a commit whose run left nothing out). */
function leaveOutFor(sha) {
  const file = process.env.JOURNEY_LEAVE_OUT_FILE;
  if (!file || !existsSync(file) || !readFileSync(file, 'utf8').trim()) return '';
  const r = spawnSync('git', ['show', `${sha}:.github/workflows/real-app-journeys.yml`], { encoding: 'utf8' });
  const on = r.status === 0 && leavesOut(r.stdout);
  const n = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim()).length;
  console.log(
    `probe ${sha.slice(0, 10)}: ${on ? `leaves out the red run's ${n} tests, as its own push run would` : 'runs every test: its journeys run had no leave-out'}`,
  );
  return on ? file : '';
}

/** First bad index (oldest first) with commits[last] assumed bad; returns the culprit and whether it was probed. */
export function firstBad(commits, isBad) {
  let lo = -1;
  let hi = commits.length - 1;
  const probed = new Map();
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const bad = isBad(commits[mid]);
    probed.set(commits[mid], bad);
    if (bad) hi = mid;
    else lo = mid;
  }
  return { culprit: commits[hi], probed };
}

/** Whether any of `steps` failed outright (a test "unexpected") in a Playwright report. */
export function stepsFail(report, steps) {
  const want = new Set(steps);
  let failed = false;
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const m = STEP_TITLE.exec(spec.title ?? '');
      if (m && want.has(`${m[1]}#${Number(m[2])}`) && (spec.tests ?? []).some((t) => t.status === 'unexpected')) failed = true;
    }
    for (const c of suite.suites ?? []) walk(c);
  };
  for (const s of report?.suites ?? []) walk(s);
  return failed;
}

/** Whether `steps` ran at all in the report (a probe whose stack never started says nothing). */
export function stepsRan(report, steps) {
  const want = new Set(steps);
  let ran = false;
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const m = STEP_TITLE.exec(spec.title ?? '');
      if (m && want.has(`${m[1]}#${Number(m[2])}`) && (spec.tests ?? []).some((t) => t.status !== 'skipped')) ran = true;
    }
    for (const c of suite.suites ?? []) walk(c);
  };
  for (const s of report?.suites ?? []) walk(s);
  return ran;
}

/** Whether a spec titled for each step is in the report at all, step by step. Pure. */
export function stepsPresent(report, steps) {
  const seen = new Set();
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const m = STEP_TITLE.exec(spec.title ?? '');
      if (m) seen.add(`${m[1]}#${Number(m[2])}`);
    }
    for (const c of suite.suites ?? []) walk(c);
  };
  for (const s of report?.suites ?? []) walk(s);
  return steps.filter((s) => seen.has(s));
}

/** Whether the probe's journey files loaded: the report lists at least one test and no load error. Pure. */
export function filesLoaded(report) {
  if (report?.errors?.length) return false;
  let any = false;
  const walk = (suite) => {
    if ((suite.specs ?? []).length) any = true;
    for (const c of suite.suites ?? []) walk(c);
  };
  for (const s of report?.suites ?? []) walk(s);
  return any;
}

/**
 * One probe's verdict from its report: 'bad' (a failing step fails outright), 'good', or 'error' (it says nothing). A
 * step that is not in the commit yet (its files loaded and listed tests, but none titled for it) does not reproduce
 * there, so the merge that brought a new step that breaks on main is named (14 Nov 2026: J-algo-dev-04 #3, new in
 * #8371). Pure.
 */
export function probeVerdict(report, steps) {
  if (!report) return 'error';
  const present = stepsPresent(report, steps);
  if (!present.length) return filesLoaded(report) ? 'good' : 'error';
  if (!stepsRan(report, present)) return 'error';
  return stepsFail(report, present) ? 'bad' : 'good';
}

/** One or more full commit shas: a lone candidate is run too, so a red that was the stack's blames no one. */
export const validCandidates = (commits) => commits.length > 0 && commits.every((c) => SHA.test(c));

/** At most this many candidates are probed at once, one runner each; more run the binary search on one runner. */
export const MAX_LEGS = 16;
export const SEARCH = 'search';

/** The matrix of probe legs: each candidate, or the one `search` leg when there are more than MAX_LEGS. Pure. */
export const planPoints = (commits) => (commits.length <= MAX_LEGS ? [...commits] : [SEARCH]);

/**
 * The culprit from every candidate's result (oldest first; `results` maps a sha to { bad } or { error }), or a reason
 * no one is blamed. The newest candidate must fail; the culprit is the oldest of the unbroken failing run that ends at
 * it, and the commit before it must pass (the first candidate's commit before is the last green one). Pure.
 */
export function decideCulprit(commits, results) {
  const at = (i) => results.get(commits[i]);
  const last = commits.length - 1;
  if (!at(last) || at(last).error) return { culprit: null, why: `\`${commits[last].slice(0, 10)}\` was not probed` };
  if (!at(last).bad) return { culprit: null, why: `\`${commits[last].slice(0, 10)}\` passes: nothing reproduces` };
  let i = last;
  while (i > 0 && at(i - 1) && !at(i - 1).error && at(i - 1).bad) i--;
  if (i > 0 && (!at(i - 1) || at(i - 1).error))
    return { culprit: null, why: `\`${commits[i - 1].slice(0, 10)}\` was not probed, so the first failing commit is not known` };
  return { culprit: commits[i], why: null };
}

const writeOutput = (line) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
const writeSummary = (text) => {
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
};
const candidatesOf = (env) =>
  String(env.CANDIDATES ?? '')
    .split(/\s+/)
    .filter(Boolean);

function plan() {
  const commits = candidatesOf(process.env);
  if (!validCandidates(commits)) throw new Error('CANDIDATES: one or more full shas');
  const points = planPoints(commits);
  console.log(`${commits.length} candidate(s): ${points[0] === SEARCH ? 'one binary search' : `${points.length} probes at once`}`);
  writeOutput(`points=${JSON.stringify(points)}`);
}

function decide() {
  const commits = candidatesOf(process.env);
  if (!validCandidates(commits)) throw new Error('CANDIDATES: one or more full shas');
  const dir = process.env.RESULTS_DIR;
  if (!dir) throw new Error('RESULTS_DIR is required');
  const found = existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.json')) : [];
  const rows = found.map((f) => JSON.parse(readFileSync(join(dir, String(f)), 'utf8')));
  const search = rows.find((r) => r.point === SEARCH);
  let culprit = null;
  let lines;
  if (search) {
    culprit = search.culprit || null;
    lines = [search.error ? `The search stopped: ${search.error}` : `The binary search ran on one runner (${commits.length} candidates).`];
  } else {
    const results = new Map(rows.map((r) => [r.point, r.error ? { error: r.error } : { bad: r.bad === true }]));
    const d = decideCulprit(commits, results);
    culprit = d.culprit;
    lines = commits.map((c) => {
      const r = results.get(c);
      return `- \`${c.slice(0, 10)}\`: ${!r ? 'no result' : r.error ? `could not run (${r.error})` : r.bad ? 'fails' : 'passes'}`;
    });
    if (d.why) lines.push(`No culprit: ${d.why}.`);
  }
  writeSummary(['### Journeys revert: probe', '', ...lines, culprit ? `Culprit: \`${culprit.slice(0, 10)}\`` : '', ''].join('\n'));
  writeOutput(`culprit=${culprit ?? ''}`);
}

function main(mode = null) {
  const { CANDIDATES, FILES, STEPS, PROBE_SH, JOURNEY_REPORT } = process.env;
  const commits = candidatesOf({ CANDIDATES });
  const files = String(FILES ?? '')
    .split(/\s+/)
    .filter(Boolean);
  const steps = String(STEPS ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!validCandidates(commits)) throw new Error('CANDIDATES: one or more full shas');
  if (!files.length || !files.every((f) => FILE.test(f))) throw new Error('FILES: journey file names');
  if (!steps.length || !steps.every((s) => STEP.test(s))) throw new Error('STEPS: journey steps');
  if (!PROBE_SH || !JOURNEY_REPORT) throw new Error('PROBE_SH and JOURNEY_REPORT are required');
  const isBad = (sha) => {
    rmSync(JOURNEY_REPORT, { force: true });
    // A journey file the commit doesn't hold yet is not run there: its steps don't exist, so they don't reproduce.
    const there = files.filter(
      (f) => spawnSync('git', ['cat-file', '-e', `${sha}:apps/customer/tests/real-app/${f}`], { stdio: 'ignore' }).status === 0,
    );
    if (!there.length) {
      console.log(`probe ${sha.slice(0, 10)}: passes (${files.join(', ')} not there yet, so the steps don't exist)`);
      return false;
    }
    console.log(`::group::probe ${sha.slice(0, 10)}`);
    const env = { ...process.env, JOURNEY_FILES: there.join(' '), JOURNEY_LEAVE_OUT_FILE: leaveOutFor(sha) };
    const r = spawnSync('bash', [PROBE_SH, sha], { stdio: 'inherit', env });
    console.log('::endgroup::');
    if (r.status !== 0) throw new Error(`the stack did not start on ${sha.slice(0, 10)} (exit ${r.status}), so the search stops`);
    const report = existsSync(JOURNEY_REPORT) ? JSON.parse(readFileSync(JOURNEY_REPORT, 'utf8')) : null;
    const verdict = probeVerdict(report, steps);
    if (verdict === 'error') throw new Error(`the failing steps did not run on ${sha.slice(0, 10)}, so the search stops`);
    const bad = verdict === 'bad';
    const absent = steps.filter((x) => !stepsPresent(report, steps).includes(x));
    console.log(`probe ${sha.slice(0, 10)}: ${bad ? 'fails' : 'passes'}${absent.length ? ` (${absent.join(', ')} not there yet)` : ''}`);
    return bad;
  };
  // Confirm (main-bisect.yml, after the automatic revert merged): the failing journeys alone on main's head. Back when
  // the steps pass.
  if (process.env.CONFIRM === 'true') {
    if (commits.length !== 1) throw new Error("CONFIRM: exactly one commit, main's head");
    const back = !isBad(commits[0]);
    const text = `### Journeys revert: confirm\n\n${steps.join(', ')} ${back ? 'pass' : 'still fail'} on \`${commits[0].slice(0, 10)}\`, run alone.\n`;
    process.stdout.write(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `back=${back}\n`);
    return;
  }
  // One leg of the parallel probe: this candidate alone, or the whole search on one runner. Its result goes to
  // RESULT_FILE for `decide`; a probe that can't run is written as an error, never as a pass or a fail.
  if (mode === 'leg') {
    const point = process.env.POINT;
    const out = process.env.RESULT_FILE;
    if (!out) throw new Error('RESULT_FILE is required');
    mkdirSync(dirname(out), { recursive: true });
    const save = (row) => writeFileSync(out, JSON.stringify({ point, ...row }));
    if (point !== SEARCH && !commits.includes(point)) throw new Error('POINT: one of the candidates, or search');
    try {
      if (point === SEARCH) {
        const { culprit, probed } = firstBad(commits, isBad);
        const confirmed = probed.has(culprit) ? probed.get(culprit) : isBad(culprit);
        save({ culprit: confirmed ? culprit : '' });
      } else save({ bad: isBad(point) });
    } catch (e) {
      save({ error: e.message });
      throw e;
    }
    return;
  }
  const { culprit, probed } = firstBad(commits, isBad);
  const confirmed = probed.has(culprit) ? probed.get(culprit) : isBad(culprit);
  const lines = [...probed].map(([s, b]) => `- \`${s.slice(0, 10)}\`: ${b ? 'fails' : 'passes'}`);
  const text = [
    '### Journeys revert: probe',
    '',
    ...lines,
    confirmed
      ? `Culprit: \`${culprit.slice(0, 10)}\``
      : `\`${culprit.slice(0, 10)}\` passes too: nothing reproduces, so nothing is reverted.`,
    '',
  ].join('\n');
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `culprit=${confirmed ? culprit : ''}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const mode = process.argv[2];
    if (mode === 'plan') plan();
    else if (mode === 'decide') decide();
    else main(mode === 'leg' ? 'leg' : null);
  } catch (e) {
    console.error(`✖ journeys-revert-probe: ${e.message}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'culprit=\n');
    process.exit(1);
  }
}
