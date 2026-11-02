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
 * Nothing is skipped and no test is changed: a step that passes is a pass, and a step outside the baseline (built,
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

/** The unbuilt steps when this run fails fast (env JOURNEY_FAIL_FAST=1), else an empty set; an unreadable baseline fails fast on nothing. */
export function failFastSteps(env = process.env, read = () => fs.readFileSync(BASELINE_PATH, 'utf8')) {
  if (env.JOURNEY_FAIL_FAST !== '1') return new Set();
  try {
    return unbuiltSteps(JSON.parse(read()));
  } catch {
    return new Set();
  }
}

/** Whether the test titled `title` fails fast in this run. */
export const failsFast = (steps, title) => {
  const key = stepKey(title);
  return key !== null && steps.has(key);
};
