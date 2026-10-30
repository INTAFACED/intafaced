#!/usr/bin/env node
/**
 * The tester profile's seed service (HM-desks-03): runs the founder seed and the TEST content seed, in the order it is
 * given, once, and ends with what the TEST content seed reports it made.
 *
 *   APP_ENV=dev node tooling/scripts/local-tester-seed.mjs [step ...] [--state <dir>] [--notice-minutes <n>]
 *
 * A step is one of STEPS below, written as the compose file writes it ('local-founder-seed.mjs init'). With no step it
 * runs DEFAULT_STEPS. The compose `seed` service (docker-compose.apps.yml, profile `tester`) names its steps itself.
 * --notice-minutes goes to the `home` step alone (the TEST content seed checks the value); the compose service passes
 * none, so the tester's notice stays open for its default 30 days. A journey passes a short one.
 *
 * WHAT IT REFUSES. Before it runs anything, it exits 2 unless APP_ENV is exactly "dev" or "test" and NODE_ENV is not
 * "production": the same image started as staging or production seeds nothing. Each step then keeps its own guards
 * (the founder seed's INTAFACED_LOCAL_FOUNDER flag and loopback edge, the TEST content seed's LOCAL_TEST flag and stack
 * marker); this file sets those flags only after its own check passed, and never loosens them. A step that fails stops
 * the run with that step's exit code, so nothing after it runs.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

/** Each step the seed service may run: its script, its arguments, and the flag that script asks for. */
export const STEPS = Object.freeze({
  'local-founder-seed.mjs init': { script: 'local-founder-seed.mjs', args: ['init'], flag: 'INTAFACED_LOCAL_FOUNDER' },
  'local-founder-seed.mjs enrol': { script: 'local-founder-seed.mjs', args: ['enrol'], flag: 'INTAFACED_LOCAL_FOUNDER' },
  'local-test-seed.mjs apply': { script: 'local-test-seed.mjs', args: ['apply'], flag: 'LOCAL_TEST', state: true },
  'local-test-seed.mjs home': { script: 'local-test-seed.mjs', args: ['home'], flag: 'LOCAL_TEST', state: true, notice: true },
  'local-test-seed.mjs status': { script: 'local-test-seed.mjs', args: ['status'], flag: 'LOCAL_TEST', state: true },
});
export const DEFAULT_STEPS = Object.freeze(Object.keys(STEPS));

export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardError';
  }
}

/** Throws unless this is a dev or test build. Reads nothing but the two variables. */
export function assertTesterBuild(env) {
  if (env.NODE_ENV === 'production')
    throw new GuardError('refusing: NODE_ENV is "production". The tester seed runs on dev or test builds only.');
  if (env.APP_ENV !== 'dev' && env.APP_ENV !== 'test') {
    const shown = env.APP_ENV === undefined || env.APP_ENV === '' ? 'not set' : `"${env.APP_ENV}"`;
    throw new GuardError(
      `refusing [seed.app_env_not_local]: APP_ENV is ${shown}; the tester seed runs only when it is exactly "dev" or "test", and seeded nothing.`,
    );
  }
}

/** Takes `flag <value>` out of `args`; null when absent. A missing value refuses. */
function takeOption(args, flag, what) {
  const at = args.indexOf(flag);
  if (at === -1) return null;
  const value = args[at + 1];
  if (!value || value.startsWith('--')) throw new GuardError(`refusing: ${flag} needs ${what}`);
  args.splice(at, 2);
  return value;
}

/** The steps to run, the state folder and the notice window, from the command line; an unknown step or argument refuses. */
export function parseArgs(argv) {
  const args = [...argv];
  const state = takeOption(args, '--state', 'a directory');
  const noticeMinutes = takeOption(args, '--notice-minutes', 'a number of minutes');
  for (const step of args) if (!Object.hasOwn(STEPS, step)) throw new GuardError(`refusing: unknown seed step "${step}"`);
  const steps = args.length > 0 ? args : [...DEFAULT_STEPS];
  if (noticeMinutes !== null && !steps.some((name) => STEPS[name].notice))
    throw new GuardError('refusing: --notice-minutes is for the home step, which this run does not include');
  return { steps, state, noticeMinutes };
}

/** Runs the steps in order; returns the exit code (0 when every step passed). `spawn` is how tests watch the calls. */
export function main(argv, env = process.env, { spawn = spawnSync, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  let plan;
  try {
    assertTesterBuild(env);
    plan = parseArgs(argv);
  } catch (err) {
    log(err.message);
    return err instanceof GuardError ? 2 : 1;
  }
  for (const name of plan.steps) {
    const step = STEPS[name];
    const args = [
      ...step.args,
      ...(step.notice && plan.noticeMinutes ? ['--notice-minutes', plan.noticeMinutes] : []),
      ...(step.state && plan.state ? ['--state', plan.state] : []),
    ];
    log(`seed: ${name}`);
    const res = spawn(process.execPath, [path.join(SCRIPTS, step.script), ...args], {
      env: { ...env, [step.flag]: '1' },
      stdio: 'inherit',
    });
    const code = res.status ?? 1;
    if (code !== 0) {
      log(`seed: ${name} exited ${code}; the steps after it did not run`);
      return code;
    }
  }
  log(`seed: done (${plan.steps.length} steps)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
