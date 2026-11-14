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
 *   node journeys-revert-probe.mjs --self-test
 *   (CI) CANDIDATES FILES STEPS PROBE_SH JOURNEY_REPORT node journeys-revert-probe.mjs   (writes GITHUB_OUTPUT culprit)
 *   (CI) CANDIDATES node journeys-revert-probe.mjs plan                                  (writes GITHUB_OUTPUT points)
 *   (CI) POINT CANDIDATES FILES STEPS PROBE_SH JOURNEY_REPORT RESULT_FILE node journeys-revert-probe.mjs leg
 *   (CI) CANDIDATES RESULTS_DIR node journeys-revert-probe.mjs decide                    (writes GITHUB_OUTPUT culprit)
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    console.log(`::group::probe ${sha.slice(0, 10)}`);
    const env = { ...process.env, JOURNEY_FILES: files.join(' '), JOURNEY_LEAVE_OUT_FILE: leaveOutFor(sha) };
    const r = spawnSync('bash', [PROBE_SH, sha], { stdio: 'inherit', env });
    console.log('::endgroup::');
    if (r.status !== 0) throw new Error(`the stack did not start on ${sha.slice(0, 10)} (exit ${r.status}), so the search stops`);
    const report = existsSync(JOURNEY_REPORT) ? JSON.parse(readFileSync(JOURNEY_REPORT, 'utf8')) : null;
    if (!report || !stepsRan(report, steps)) throw new Error(`the failing steps did not run on ${sha.slice(0, 10)}, so the search stops`);
    const bad = stepsFail(report, steps);
    console.log(`probe ${sha.slice(0, 10)}: ${bad ? 'fails' : 'passes'}`);
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

function selfTest() {
  const eq = (got, want, m) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  };
  const c = ['1', '2', '3', '4', '5'].map((d) => d.repeat(40));
  for (let k = 0; k < c.length; k++) {
    const calls = [];
    const r = firstBad(c, (s) => (calls.push(s), c.indexOf(s) >= k));
    eq(r.culprit, c[k], `culprit at ${k}`);
    eq(calls.length <= 3, true, `at most ceil(log2 5) probes for ${k}`);
  }
  const one = firstBad([c[0]], () => {
    throw new Error('a lone candidate needs no search');
  });
  eq([one.culprit, one.probed.has(c[0])], [c[0], false], 'a lone candidate is settled unprobed, so main() probes it before blaming it');
  eq([validCandidates([c[0]]), validCandidates([]), validCandidates(['x'])], [true, false, false], 'one or more full shas');
  const rep = (status) => ({ suites: [{ specs: [{ title: 'J-a-01 #2 y', tests: [{ status }] }] }] });
  eq(stepsFail(rep('unexpected'), ['J-a-01#2']), true, 'outright failure is bad');
  eq(stepsFail(rep('expected'), ['J-a-01#2']), false, 'a pass is good');
  eq(stepsFail(rep('unexpected'), ['J-a-01#3']), false, 'another step does not count');
  eq(stepsRan(rep('skipped'), ['J-a-01#2']), false, 'a skipped step did not run');
  eq(stepsRan(rep('expected'), ['J-a-01#2']), true, 'a step that ran');
  const many = Array.from({ length: MAX_LEGS + 1 }, (_, i) => String(i % 10).repeat(39) + 'abcdefghijklmnopq'[i]);
  eq([planPoints(c), planPoints(many)], [c, [SEARCH]], 'each candidate at once, or one search past MAX_LEGS');
  const res = (...xs) =>
    new Map(
      xs
        .map((x, i) => [c[i], x === 'F' ? { bad: true } : x === 'P' ? { bad: false } : x === 'E' ? { error: 'e' } : undefined])
        .filter(([, v]) => v),
    );
  eq(decideCulprit(c, res('P', 'P', 'F', 'F', 'F')).culprit, c[2], 'the oldest of the failing run that ends at the red commit');
  eq(decideCulprit(c, res('F', 'F', 'F', 'F', 'F')).culprit, c[0], 'all fail: the first candidate, after the last green commit');
  eq(decideCulprit(c, res('F', 'P', 'P', 'F', 'F')).culprit, c[3], 'an older fail followed by a pass is not the break that reaches main');
  eq(decideCulprit(c, res('P', 'P', 'F', 'F', 'P')).culprit, null, 'the newest passing: nothing reproduces');
  eq(decideCulprit(c, res('P', 'E', 'F', 'F', 'F')).culprit, null, 'the commit before the failing run could not run: no one is blamed');
  eq(decideCulprit(c, res('E', 'P', 'F', 'F', 'F')).culprit, c[2], 'a probe that could not run outside the deciding pair does not matter');
  eq(decideCulprit(c, res('P', 'P', 'F', 'F', 'E')).culprit, null, 'the red commit could not run: no one is blamed');
  eq(decideCulprit(c, res('P', 'P', 'F', 'F')).culprit, null, 'a missing result: no one is blamed');
  eq(decideCulprit([c[0]], res('F')).culprit, c[0], 'a lone candidate that fails is blamed');
  eq(decideCulprit([c[0]], res('P')).culprit, null, 'a lone candidate that passes is not');
  const wf = (planner) =>
    `jobs:\n  touch:\n    steps:\n      - run: |\n${planner ? '          node tooling/scripts/journey-leave-out.mjs --log x > y\n' : ''}          echo done\n`;
  eq(
    [leavesOut(wf(true)), leavesOut(wf(false)), leavesOut(''), leavesOut(null)],
    [true, false, false, false],
    'a commit leaves out only when its own run plans it',
  );
  // Planted: the paths list naming the planner's files is not the planner running.
  eq(leavesOut("paths:\n  - 'tooling/scripts/journey-leave-out*.mjs'\n"), false, 'a paths entry is not the planner');
  console.log('✓ journeys-revert-probe --self-test OK (32 fixtures)');
}

if (process.argv.includes('--self-test')) selfTest();
else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
