/**
 * Fail fast on the journey steps that are red by design (OWNER 154 point 8, W21): the steps W9's baseline on main
 * (docs/runbooks/journey-baseline.json) lists as `unbuilt`, which have never passed on main because what they ask for is
 * not built or its rail is not wired. Measured on run 1138 (1 Nov 2026): 525 such steps took 98 of the run's 483
 * journey-minutes; ten of them (J-agents) waited out the whole 90 s test limit each.
 *
 * Such a test still runs, every assertion unchanged, and still counts red; it only stops waiting sooner:
 *   - each wait (an action, or an `expect` from journey.mjs, which every journey and helper imports) with no timeout of its
 *     own gives up after FAIL_FAST.waitMs, the 5 s the journeys already give a part they know is unbuilt
 *     (`UNBUILT = { timeout: 5_000 }` in 10 journey files and agents.mjs). A wait with its own timeout keeps it. This
 *     reaches every page the test opens, its own browser.newContext() ones too;
 *   - a navigation waits up to FAIL_FAST.testMs, so it is never cut at the short wait, only by the test's own end;
 *   - the test ends after FAIL_FAST.testMs unless it has a limit other than the project's (describe.configure,
 *     test.use, test.slow or test.setTimeout), which wins.
 *
 * Which tests: the planner's plan (planFailFast). A test fails fast when its step is unbuilt in the baseline and that
 * exact test (by title) passed in none of the finished runs on main the planner read (its last three and the two newest
 * scheduled ones). A step key can name more than one test (J-merchant-07 has two `#2`s): one built test of an unbuilt
 * step is never cut short (run 1143 cut J-merchant-07 "#2 reads funds…", which takes 140 s and passes). Each shard keeps
 * only steps its own baseline still calls unbuilt. No report read, no plan: nothing fails fast.
 *
 * Nothing is skipped and no test is changed: a test that passes is a pass, and a test outside the plan (built, a
 * regression, or new) gets the ordinary limits. Only full runs of the Real-app journeys workflow on a push or by hand set
 * JOURNEY_FAIL_FAST=1. The daily scheduled run on main keeps the ordinary limits, so a test built since the baseline was
 * written passes on main under them, then leaves the plan, and the baseline's next rewrite (from a run on main) moves its
 * step out of `unbuilt` (docs/runbooks/regression-issue-state.md). A targeted run (a builder proving a step) and a local
 * run keep the ordinary limits too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** The titles of the tests a Playwright JSON report passed, as Main trust reads a test (every run expected or flaky). */
export function passedTitles(report) {
  const out = new Set();
  const walk = (suite) => {
    for (const spec of suite?.specs ?? []) {
      const tests = spec.tests ?? [];
      if (tests.length && tests.every((t) => t.status === 'expected' || t.status === 'flaky')) out.add(spec.title);
    }
    for (const child of suite?.suites ?? []) walk(child);
  };
  for (const suite of report?.suites ?? []) walk(suite);
  return out;
}

/**
 * The plan: { steps, passed }, the baseline's unbuilt step keys and the titles of their tests that passed in any report
 * read, which keep the ordinary limits. Null when no report was read.
 */
export function planFailFast(baseline, reports) {
  if (reports.length === 0) return null;
  const steps = unbuiltSteps(baseline);
  const passed = new Set();
  for (const r of reports) for (const title of passedTitles(r)) if (steps.has(stepKey(title))) passed.add(title);
  return { steps: [...steps].sort(), passed: [...passed].sort() };
}

const KEY = /^J-[a-z0-9-]+-\d+#\d+$/;
const NONE = { steps: new Set(), passed: new Set() };

/**
 * This run's plan, when it fails fast (env JOURNEY_FAIL_FAST=1): the planner's (env JOURNEY_FAIL_FAST_PLAN, JSON), its
 * steps narrowed to those this checkout's baseline still calls unbuilt. Otherwise, or with no plan, an unreadable plan
 * or an unreadable baseline, a plan with no steps: nothing fails fast.
 */
export function failFastSteps(env = process.env, read = () => fs.readFileSync(BASELINE_PATH, 'utf8')) {
  if (env.JOURNEY_FAIL_FAST !== '1') return NONE;
  try {
    const plan = JSON.parse(env.JOURNEY_FAIL_FAST_PLAN ?? '');
    const unbuilt = unbuiltSteps(JSON.parse(read()));
    const steps = (Array.isArray(plan?.steps) ? plan.steps : []).filter((k) => KEY.test(k) && unbuilt.has(k));
    const passed = (Array.isArray(plan?.passed) ? plan.passed : []).filter((t) => typeof t === 'string');
    return { steps: new Set(steps), passed: new Set(passed) };
  } catch {
    return NONE;
  }
}

/** Whether the test titled `title` fails fast under `plan`. */
export const failsFast = (plan, title) => {
  const key = stepKey(title);
  return key !== null && plan.steps.has(key) && !plan.passed.has(title);
};

// The planner: node tooling/scripts/journey-fail-fast.mjs --plan [--report <report.json>]... prints the plan as JSON, or
// nothing when no report was read.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
  const plan = planFailFast(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')), reports);
  if (!plan) console.error(`no report read: nothing fails fast`);
  else
    console.error(
      `${plan.steps.length} unbuilt steps fail fast, except ${plan.passed.length} of their tests that passed (${reports.length} reports read)`,
    );
  console.log(plan ? JSON.stringify(plan) : '');
}
