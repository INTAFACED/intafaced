// World: stack
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { HOME_NOTICE_TITLE } from '../../../../tooling/scripts/local-test-home.mjs';
import { ROOT } from './stack.mjs';
import { COMPOSE, composeSteps, run, seedService } from './tester-compose.mjs';

// J-home-ia-11 #1, the fresh compose up, in the running app (docs/roadmap/journeys.json): I bring up a test build with the
// `tester` profile and its seed service runs once and reports what it made. Split from J-home-ia-11.pw.mjs so no one file
// holds the whole journey's time: the build of every image and the compose up took 8.2 of that file's 14.4 minutes
// (run 44963812809), so the run waited on its shard. The same step, unchanged, on its own compose project and state folder,
// which nothing else in the shard shares.
const J = 'J-home-ia-11';

test.describe.configure({ mode: 'default' });

/**
 * `docker compose` on the repo's compose files under the tester profile, as a person runs it: { status, out }.
 * The env file compose-env wrote into the step's own state folder (`testerEnvFile`) layers what `pnpm local:stack` runs
 * with, and this stack's generated keys, over the documented example env, which keeps them blank for a real deployment.
 * It is never the repo's `.env.tester.local`, which a person may hold for their own state folder.
 */
const testerEnvFile = (env) => path.join(env.LOCAL_STACK_STATE, 'tester.env.local');
function compose(args, env, { timeout = 120_000 } = {}) {
  const files = COMPOSE.flatMap((name) => ['-f', name]);
  const res = spawnSync(
    'docker',
    [
      'compose',
      '-p',
      'intafaced-tester-journey',
      '--env-file',
      '.env.example',
      '--env-file',
      testerEnvFile(env),
      ...files,
      '--profile',
      'tester',
      ...args,
    ],
    { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout },
  );
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ? `\n${res.error.message}` : ''}`;
  return { status: res.status ?? 1, out };
}

/**
 * The last log lines of every compose service that failed on its own or never turned healthy (a service compose gave up
 * waiting on still reads `starting`): neither running healthy, nor exited 0, nor stopped
 * by compose's abort (137 or 143, the signals `--abort-on-container-exit` sends), so the red names the culprit.
 */
function notHealthyLogs(env) {
  const ps = compose(['ps', '-a', '--format', '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}'], env);
  const bad = ps.out
    .trim()
    .split('\n')
    .map((line) => line.split('|'))
    .filter(
      ([svc, state, health, code]) =>
        svc &&
        !(state === 'running' && (health === '' || health === 'healthy')) &&
        !(state === 'exited' && ['0', '137', '143'].includes(code)),
    )
    .map(([svc, state, health]) => ({ svc, state: health ? `${state}, ${health}` : state }));
  return bad
    .map(
      ({ svc, state }) =>
        `\n\n--- ${svc} (${state}), last 60 lines ---\n${compose(['logs', '--no-color', '--tail', '60', svc], env).out.trim()}`,
    )
    .join('');
}

// The step's own start: a fresh compose up with the tester profile, from the documented example env and the values
// `compose-env` writes for this state directory (LOCAL TEST settings and generated keys), on a state directory nothing
// else has written. The real-app run seeds the `pnpm local:stack` stack too (#1 in J-home-ia-11.pw.mjs); this one
// passes only when a fresh compose up starts and its seed service runs once and reports what it made.
test(`${J} #1 a fresh compose up with the tester profile seeds`, () => {
  test.setTimeout(30 * 60_000);
  const state = mkdtempSync(path.join(tmpdir(), 'compose-tester-'));
  const env = { APP_ENV: 'test', LOCAL_STACK_STATE: state };
  const seed = seedService();
  expect(seed, `no compose file (${COMPOSE.join(', ')}) has a seed service`).not.toBeNull();
  try {
    const generated = run('tooling/scripts/local-test-compose-env.mjs', ['--out', testerEnvFile(env)], env);
    expect(generated.status, `BLOCKED compose_seed: compose-env could not write the tester profile's values:\n${generated.out}`).toBe(0);
    const config = compose(['config', '--quiet'], env);
    // Red by name only for the outside blocker: compose refusing a blank value the tester profile has not set yet.
    if (config.status !== 0) expect(config.out).toMatch(/required variable [A-Z_]+ is missing a value/);
    expect(config.status, `BLOCKED compose_seed: a fresh compose up with the tester profile refuses to start:\n${config.out}`).toBe(0);
    // Healthy services first: what the seed waits for (its `depends_on ... service_healthy`) comes up on its own and compose
    // waits until each is healthy; then every service compose started reads running (healthy where it has a health check)
    // or, for a one-shot job (migrate, nats-streams), exited 0.
    const needs = [...seed.block.matchAll(/^ {6}([a-z0-9-]+):\n {8}condition: service_healthy$/gm)].map((m) => m[1]);
    expect(needs.length, `the seed service waits for no healthy service:\n${seed.block}`).toBeGreaterThan(0);
    const deps = compose(['up', '--build', '--detach', '--wait', ...needs], env, { timeout: 25 * 60_000 });
    const depsWhy = deps.status === 0 ? '' : notHealthyLogs(env);
    const depsTail = deps.out.trim().split('\n').slice(-40).join('\n');
    expect(deps.status, `BLOCKED compose_seed: the services the seed needs did not turn healthy:\n${depsTail}${depsWhy}`).toBe(0);
    const states = compose(['ps', '-a', '--format', '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}'], env);
    expect(states.status, states.out).toBe(0);
    const services = states.out
      .trim()
      .split('\n')
      .map((line) => line.split('|'));
    expect(services.map(([svc]) => svc)).toEqual(expect.arrayContaining(needs));
    for (const [svc, state, health, code] of services) {
      const fine = state === 'running' ? health === '' || health === 'healthy' : state === 'exited' && code === '0';
      expect(fine, `${svc}: ${state}${health ? `, ${health}` : ''}, exit ${code}`).toBe(true);
    }
    for (const svc of needs) expect(services.find(([name]) => name === svc)?.[2], `${svc} health`).toBe('healthy');
    const up = compose(['up', '--build', '--abort-on-container-exit', '--exit-code-from', 'seed', 'seed'], env, {
      timeout: 25 * 60_000,
    });
    // Compose names only the service that stopped the run; that service's own last lines say why, so the red carries them.
    const why = up.status === 0 ? '' : notHealthyLogs(env);
    const tail = up.out.trim().split('\n').slice(-40).join('\n');
    expect(up.status, `BLOCKED compose_seed: the tester profile's seed service did not seed a fresh compose stack:\n${tail}${why}`).toBe(0);
    const ran = [...up.out.matchAll(/seed: (local-[a-z-]+\.mjs [a-z]+)$/gm)].map((m) => m[1]);
    expect(ran).toEqual(composeSteps(seed.block));
    expect(up.out).toMatch(new RegExp(`seed: done \\(${ran.length} steps\\)$`, 'm'));
    // What it made, as its run reports it and its closing status reads it back from the compose stack's services.
    expect(up.out).toContain(`home notice: ${HOME_NOTICE_TITLE} published`);
    expect(up.out).toMatch(new RegExp(`home inbox: 1 transfer-received row for \\S+$`, 'm'));
    expect(up.out).toMatch(/ {2}wallet {2}0x[0-9a-f]{40}$/m);
    expect(up.out).toContain(`  notice  ${HOME_NOTICE_TITLE}  published`);
    expect(up.out).toContain(`  inbox  1 transfer-received row  `);
    // Once: the seed service has exactly one container, exited 0.
    const runs = compose(['ps', '-a', '--format', '{{.Service}} {{.State}} {{.ExitCode}}', 'seed'], env);
    expect(runs.out.trim().split('\n')).toEqual(['seed exited 0']);
    // The same image, started as staging or production, exits 2 with the typed refusal and seeds nothing.
    for (const appEnv of ['staging', 'production']) {
      const refused = compose(['run', '--rm', '-e', `APP_ENV=${appEnv}`, 'seed'], env);
      expect(refused.status, refused.out).toBe(2);
      expect(refused.out).toContain(`refusing [seed.app_env_not_local]: APP_ENV is "${appEnv}"`);
    }
  } finally {
    compose(['down', '--volumes', '--remove-orphans'], env);
    // The seed container writes into the folder as its own user; a folder left behind must not hide the step's result.
    try {
      rmSync(state, { recursive: true, force: true });
    } catch (error) {
      console.warn(`compose state ${state} not removed: ${error.message}`);
    }
  }
});
