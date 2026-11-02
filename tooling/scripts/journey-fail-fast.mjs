/**
 * Fail fast on the journey steps that are red by design (OWNER 154 point 8, W21): the steps W9's baseline on main
 * (docs/runbooks/journey-baseline.json) lists as `unbuilt`, which have never passed on main because what they ask for is
 * not built or its rail is not wired. Measured on run 1138 (1 Nov 2026): 525 such steps took 98 of the run's 483
 * journey-minutes; ten of them (J-agents) waited out the whole 90 s test limit each.
 *
 * Such a step still runs, every assertion unchanged, and still counts red; it only stops waiting sooner:
 *   - each wait (an action, or an `expect` from journey.mjs, which every journey and helper imports) with no timeout of its
 *     own gives up after FAIL_FAST.waitMs, the 5 s the journeys already give a part they know is unbuilt
 *     (`UNBUILT = { timeout: 5_000 }` in 10 journey files and agents.mjs). A wait with its own timeout keeps it. This
 *     reaches every page the step opens, its own browser.newContext() ones too;
 *   - a navigation waits up to FAIL_FAST.testMs, so it is never cut at the short wait, only by the step's own end;
 *   - the step ends after FAIL_FAST.testMs unless it names its own limit (describe.configure, test.use, test.slow or
 *     test.setTimeout), which wins.
 *
 * Which steps: the planner's list (planFailFast), the baseline's unbuilt steps less any that passed in a finished run on
 * main it read (its last runs and the newest scheduled one), so a step built since the baseline was written is never cut
 * short. Each shard keeps only listed steps that its own baseline still calls unbuilt.
 *
 * Nothing is skipped and no test is changed: a step that passes is a pass, and a step outside the list (built,
 * a regression, or new) gets the ordinary limits. Only full runs of the Real-app journeys workflow on a push or by hand
 * set JOURNEY_FAIL_FAST=1. The daily scheduled run on main keeps the ordinary limits, so a step that is built since the
 * baseline was written passes on main under them at least once a day, and the baseline's next rewrite (from a run on
 * main) moves it out of `unbuilt` (docs/runbooks/regression-issue-state.md). A targeted run (a builder proving a step)
 * and a local run keep the ordinary limits too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAIL_FAST = { waitMs: 5_000, testMs: 30_000 };

export const BASELINE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'runbooks',
  'journey-baseline.json',
);

/** A step's key as Main trust keys it (STEP_TITLE in tooling/ci/post-merge-trust.mjs): "J-agents-03 #5 …" → "J-agents-03#5". */
export function stepKey(title) {
  const m = /^(J-[a-z0-9-]+-\d+)\s+#(\d+)\b/.exec(String(title ?? ''));
  return m ? `${m[1]}#${Number(m[2])}` : null;
}

/** The keys of the baseline's `unbuilt` steps. Only `unbuilt`: a `regression` passed once and gets the ordinary limits. */
export function unbuiltSteps(baseline) {
  return new Set((baseline?.steps ?? []).filter((s) => s?.state === 'unbuilt' && typeof s.step === 'string').map((s) => s.step));
}

const KEY = /^J-[a-z0-9-]+-\d+#\d+$/;

/** The step keys with a passing result in a Playwright JSON report. */
export function passedSteps(report) {
  const out = new Set();
  const walk = (suite) => {
    for (const spec of suite?.specs ?? [])
      for (const t of spec.tests ?? [])
        if ((t.results ?? []).some((r) => r?.status === 'passed')) {
          const key = stepKey(spec.title);
          if (key) out.add(key);
        }
    for (const child of suite?.suites ?? []) walk(child);
  };
  for (const suite of report?.suites ?? []) walk(suite);
  return out;
}

/**
 * The plan's list: the baseline's unbuilt steps that did not pass in any of the finished runs on main read (the planner's
 * last runs and the newest scheduled one). A step built since the baseline was written has passed in one of them, so it
 * gets the ordinary limits even before the baseline is rewritten (run 1143: J-merchant-07 #2 and #5, built since, failed
 * under the short limits, and the step after them with them). No report read, no list: nothing fails fast.
 */
export function planFailFast(baseline, reports) {
  if (reports.length === 0) return [];
  const passed = new Set(reports.flatMap((r) => [...passedSteps(r)]));
  return [...unbuiltSteps(baseline)].filter((k) => !passed.has(k)).sort();
}

/**
 * The steps that fail fast in this run: those the plan listed (env JOURNEY_FAIL_FAST_STEPS, separated by spaces) that are
 * still unbuilt in this checkout's baseline, when the run fails fast (env JOURNEY_FAIL_FAST=1); else none. An unreadable
 * baseline or an empty plan fails fast on nothing.
 */
export function failFastSteps(env = process.env, read = () => fs.readFileSync(BASELINE_PATH, 'utf8')) {
  if (env.JOURNEY_FAIL_FAST !== '1') return new Set();
  const planned = String(env.JOURNEY_FAIL_FAST_STEPS ?? '')
    .split(/\s+/)
    .filter((k) => KEY.test(k));
  try {
    const unbuilt = unbuiltSteps(JSON.parse(read()));
    return new Set(planned.filter((k) => unbuilt.has(k)));
  } catch {
    return new Set();
  }
}

/** Whether the test titled `title` fails fast in this run. */
export const failsFast = (steps, title) => {
  const key = stepKey(title);
  return key !== null && steps.has(key);
};

// The planner: node tooling/scripts/journey-fail-fast.mjs --plan [--report <report.json>]... prints the plan's list.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] !== '--plan') {
    console.error('usage: journey-fail-fast.mjs --plan [--report <report.json>]...');
    process.exit(2);
  }
  const reports = [];
  for (let i = 1; i < args.length; i++)
    if (args[i] === '--report') {
      try {
        reports.push(JSON.parse(fs.readFileSync(args[++i], 'utf8')));
      } catch (e) {
        console.error(`skipping ${args[i]}: ${e.message}`);
      }
    }
  const steps = planFailFast(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')), reports);
  console.error(`${steps.length} unbuilt steps fail fast (${reports.length} reports read)`);
  console.log(steps.join(' '));
}
