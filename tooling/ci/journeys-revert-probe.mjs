#!/usr/bin/env node
/**
 * JOURNEYS REVERT PROBE: which of the candidate commits broke the failing journey steps (main-bisect.yml, the
 * `Journeys revert: probe` job; journeys-revert.mjs `find` names the candidates). A binary search over the candidates
 * (oldest first; the commit before the first is the last green one): at each probe it checks the commit out, starts the
 * local test stack on it the way a Real-app journeys shard does (journeys-revert-probe.sh) and runs only the failing
 * journey files, with no retry. A probe is bad when any of the failing steps fails outright. The commit it settles on
 * is probed too when the search never ran it, and a culprit that passes there is not blamed (nothing reproduces).
 *
 * It runs from a copy outside the checkout, with no imports, because it checks out older commits; old commits run as
 * code here, so the job gives it no GitHub token.
 *
 *   node journeys-revert-probe.mjs --self-test
 *   (CI) CANDIDATES FILES STEPS PROBE_SH JOURNEY_REPORT node journeys-revert-probe.mjs   (writes GITHUB_OUTPUT culprit)
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const FILE = /^J-[a-z0-9-]+\.pw\.mjs$/;
const STEP = /^J-[a-z0-9-]+-\d+#\d+$/;
const STEP_TITLE = /^(J-[a-z0-9-]+-\d+)\s+#(\d+)\b/;

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

function main() {
  const { CANDIDATES, FILES, STEPS, PROBE_SH, JOURNEY_REPORT } = process.env;
  const commits = String(CANDIDATES ?? '')
    .split(/\s+/)
    .filter(Boolean);
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
    const r = spawnSync('bash', [PROBE_SH, sha], { stdio: 'inherit', env: { ...process.env, JOURNEY_FILES: files.join(' ') } });
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
  console.log('✓ journeys-revert-probe --self-test OK (17 fixtures)');
}

if (process.argv.includes('--self-test')) selfTest();
else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(`✖ journeys-revert-probe: ${e.message}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'culprit=\n');
    process.exit(1);
  }
}
