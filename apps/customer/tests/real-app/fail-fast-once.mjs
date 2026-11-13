import fs from 'node:fs';
import {
  SERIAL_FILE,
  failFastSteps,
  noRetryForFailFast,
  noRetryForOwn,
  ownFiles,
  retryPlanEnv,
} from '../../../../tooling/scripts/journey-fail-fast.mjs';

/**
 * A reporter that only takes the retry off each test that fails fast, before the run starts (noRetryForFailFast in
 * tooling/scripts/journey-fail-fast.mjs). Playwright schedules each retry from the test's own `retries`, which a
 * reporter's onBegin sees before the first test runs; the tests, their files and their order stay exactly as written.
 * Off a fail-fast run (JOURNEY_FAIL_FAST unset or 0) it does nothing, except on a pull request's run, which retries:
 * there it takes the retry off the pull request's own journey files (JOURNEY_NO_RETRY_FILES) and, with
 * JOURNEY_NO_RETRY_UNBUILT=1, off the plan's tests, without their shorter waits (retryPlanEnv, noRetryForOwn in
 * journey-fail-fast.mjs). Option `baseline`: a baseline file other than
 * docs/runbooks/journey-baseline.json (its own test, journey-fail-fast-retries.test.mjs).
 */
export default class FailFastRetries {
  constructor(options = {}) {
    this.read = options.baseline ? () => fs.readFileSync(options.baseline, 'utf8') : undefined;
  }

  onBegin(_config, suite) {
    const own = noRetryForOwn(suite.allTests(), ownFiles(process.env));
    if (own > 0) process.stdout.write(`no retry: ${own} test(s) of this pull request's own journey files run once\n`);
    const plan = failFastSteps(retryPlanEnv(process.env), this.read);
    if (plan.steps.size === 0) return;
    const serial = new Map();
    const isSerialFile = (file) => {
      if (!serial.has(file)) {
        let yes = true; // a file it cannot read keeps its retries
        try {
          yes = SERIAL_FILE.test(fs.readFileSync(file, 'utf8'));
        } catch {
          /* kept */
        }
        serial.set(file, yes);
      }
      return serial.get(file);
    };
    const n = noRetryForFailFast(suite.allTests(), plan, isSerialFile);
    // Off main no test has a retry (JOURNEY_RETRIES), so there is nothing to take off and nothing to say.
    if (n > 0) process.stdout.write(`fail fast: ${n} test(s) of steps the plan expects to fail run once, with no retry\n`);
  }

  printsToStdio() {
    return false;
  }
}
